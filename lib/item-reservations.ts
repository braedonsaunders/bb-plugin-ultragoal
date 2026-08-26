import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

export const ITEM_RESERVATION_TTL_MS = 10 * 60_000;

/**
 * Cross-generation scheduler lock. The row is acquired before BB is asked to
 * create a child thread, so overlapping old/new plugin instances cannot both
 * pass a process-local availability check and spawn the same work item.
 */
export function createItemReservationStore(db: PluginDatabase) {
  const acquireStmt = db.prepare(`
    INSERT OR IGNORE INTO collab_item_reservations (
      root_thread_id, item_id, claim_token, created_at, expires_at, slot_limit
    )
    SELECT @root_thread_id, @item_id, @claim_token, @created_at, @expires_at, @slot_limit
    WHERE NOT EXISTS (
      SELECT 1 FROM collab_agents
      WHERE root_thread_id = @root_thread_id
        AND item_id = @item_id
        AND retired_at IS NULL
        AND COALESCE(role, 'worker') != 'verifier'
    )
      AND (
        SELECT COUNT(*) FROM collab_agents
        WHERE root_thread_id = @root_thread_id
          AND retired_at IS NULL
          AND COALESCE(role, 'worker') != 'verifier'
      ) + (
        SELECT COUNT(*) FROM collab_item_reservations
        WHERE root_thread_id = @root_thread_id
          AND expires_at > @created_at
      ) < @slot_limit
  `);
  const releaseStmt = db.prepare(`
    DELETE FROM collab_item_reservations
    WHERE root_thread_id = ? AND item_id = ? AND claim_token = ?
  `);
  const reservation = db.prepare(`
    SELECT claim_token, expires_at, slot_limit FROM collab_item_reservations
    WHERE root_thread_id = ? AND item_id = ?
  `);
  const liveWorker = db.prepare(`
    SELECT 1 FROM collab_agents
    WHERE root_thread_id = ? AND item_id = ? AND retired_at IS NULL
      AND COALESCE(role, 'worker') != 'verifier'
    LIMIT 1
  `);
  const purgeExpired = db.prepare(
    "DELETE FROM collab_item_reservations WHERE expires_at <= ?",
  );
  const writeRootCap = db.prepare(`
    INSERT INTO collab_root_worker_caps (root_thread_id, max_workers, updated_at)
    VALUES (@root_thread_id, @max_workers, @updated_at)
    ON CONFLICT(root_thread_id) DO UPDATE SET
      max_workers = CASE
        WHEN EXISTS (
          SELECT 1 FROM collab_item_reservations
          WHERE root_thread_id = excluded.root_thread_id
            AND expires_at > excluded.updated_at
        ) THEN MIN(collab_root_worker_caps.max_workers, excluded.max_workers)
        ELSE excluded.max_workers
      END,
      updated_at = excluded.updated_at
  `);
  const rootCap = db.prepare(
    "SELECT max_workers FROM collab_root_worker_caps WHERE root_thread_id = ?",
  );
  const rootOccupancy = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM collab_agents
       WHERE root_thread_id = @root_thread_id
         AND retired_at IS NULL
         AND COALESCE(role, 'worker') != 'verifier')
      +
      (SELECT COUNT(*) FROM collab_item_reservations
       WHERE root_thread_id = @root_thread_id
         AND expires_at > @now) AS n
  `);

  return {
    setCap(rootThreadId: string, maxWorkers: number): boolean {
      if (!Number.isFinite(maxWorkers) || maxWorkers < 0) return false;
      const now = Date.now();
      const txn = db.transaction(() => {
        purgeExpired.run(now);
        writeRootCap.run({
          root_thread_id: rootThreadId,
          max_workers: Math.floor(maxWorkers),
          updated_at: now,
        });
      });
      txn.immediate();
      return true;
    },

    acquire(rootThreadId: string, itemId: string, maxWorkers: number): string | null {
      if (!Number.isFinite(maxWorkers) || maxWorkers < 1) return null;
      const slotLimit = Math.floor(maxWorkers);
      const token = `claim_${randomUUID()}`;
      const now = Date.now();
      const txn = db.transaction(() => {
        purgeExpired.run(now);
        writeRootCap.run({
          root_thread_id: rootThreadId,
          max_workers: slotLimit,
          updated_at: now,
        });
        const result = acquireStmt.run({
          root_thread_id: rootThreadId,
          item_id: itemId,
          claim_token: token,
          created_at: now,
          expires_at: now + ITEM_RESERVATION_TTL_MS,
          slot_limit: slotLimit,
        });
        return result.changes === 1 ? token : null;
      });
      return txn.immediate();
    },

    release(rootThreadId: string, itemId: string, token: string): boolean {
      return releaseStmt.run(rootThreadId, itemId, token).changes === 1;
    },

    /** Insert the durable worker row and consume its reservation atomically. */
    commit(
      rootThreadId: string,
      itemId: string,
      token: string,
      insertWorker: () => void,
    ): boolean {
      const txn = db.transaction(() => {
        const held = reservation.get(rootThreadId, itemId) as
          | { claim_token: string; expires_at: number; slot_limit: number }
          | undefined;
        if (!held || held.claim_token !== token || held.expires_at <= Date.now()) return false;
        // Recheck under the same IMMEDIATE writer lock that will persist the
        // child row. A worker inserted after acquisition (for example by an
        // old generation finishing a prior spawn) wins; this spawn fails
        // closed instead of becoming a second owner.
        if (liveWorker.get(rootThreadId, itemId)) return false;
        // The reservation already occupies one root slot, so replacing it
        // with the durable worker must not increase this total. Rechecking
        // under the writer lock catches a legacy/overlapping generation that
        // inserted a different worker after this reservation was acquired.
        const occupancy = rootOccupancy.get({
          root_thread_id: rootThreadId,
          now: Date.now(),
        }) as { n: number };
        const cap = rootCap.get(rootThreadId) as { max_workers: number } | undefined;
        if (!cap || occupancy.n > cap.max_workers) return false;
        insertWorker();
        if (releaseStmt.run(rootThreadId, itemId, token).changes !== 1) {
          throw new Error("scheduler item reservation disappeared during commit");
        }
        return true;
      });
      return txn.immediate();
    },

    isHeld(rootThreadId: string, itemId: string, exceptToken?: string): boolean {
      if (liveWorker.get(rootThreadId, itemId)) return true;
      const held = reservation.get(rootThreadId, itemId) as
        | { claim_token: string; expires_at: number; slot_limit: number }
        | undefined;
      return Boolean(
        held && held.expires_at > Date.now() && (!exceptToken || held.claim_token !== exceptToken),
      );
    },

    claimants(rootThreadId: string, itemId: string): string[] {
      const held = reservation.get(rootThreadId, itemId) as
        | { claim_token: string; expires_at: number; slot_limit: number }
        | undefined;
      return held && held.expires_at > Date.now() ? [held.claim_token] : [];
    },
  };
}

export type ItemReservationStore = ReturnType<typeof createItemReservationStore>;
