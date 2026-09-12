import type { BbPluginApi } from "@get-bb/plugin-sdk";

export interface InvalidBaseSuppression {
  rootThreadId: string;
  itemId: string;
  repository: string;
  requestedRef: string;
  diagnostic: string;
  suppressedAt: number;
}

interface SuppressionRow {
  root_thread_id: string;
  item_id: string;
  repository: string;
  requested_ref: string;
  diagnostic: string;
  suppressed_at: number;
}

/** Durable invalid-input gate, scoped to the exact scheduling request tuple. */
export function createInvalidBaseSuppressionStore(
  db: ReturnType<BbPluginApi["storage"]["database"]>,
) {
  // As with staffing holds, this table owns its migration. Appending to the
  // shared positional migration list has skipped statements in older installs.
  db.exec(`
    CREATE TABLE IF NOT EXISTS invalid_base_suppressions (
      root_thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      repository TEXT NOT NULL,
      requested_ref TEXT NOT NULL,
      diagnostic TEXT NOT NULL,
      suppressed_at INTEGER NOT NULL,
      PRIMARY KEY (root_thread_id, item_id, repository, requested_ref)
    )
  `);
  const upsert = db.prepare(`
    INSERT INTO invalid_base_suppressions (
      root_thread_id, item_id, repository, requested_ref, diagnostic, suppressed_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(root_thread_id, item_id, repository, requested_ref)
    DO UPDATE SET diagnostic = excluded.diagnostic
  `);
  const exact = db.prepare(`
    SELECT * FROM invalid_base_suppressions
    WHERE root_thread_id = ? AND item_id = ? AND repository = ? AND requested_ref = ?
  `);
  const byItem = db.prepare(`
    SELECT * FROM invalid_base_suppressions
    WHERE root_thread_id = ? AND item_id = ?
    ORDER BY suppressed_at DESC, repository, requested_ref
  `);
  const byRoot = db.prepare(`
    SELECT * FROM invalid_base_suppressions
    WHERE root_thread_id = ?
    ORDER BY suppressed_at DESC, item_id, repository, requested_ref
  `);
  const removeItem = db.prepare(
    "DELETE FROM invalid_base_suppressions WHERE root_thread_id = ? AND item_id = ?",
  );
  const removeRoot = db.prepare(
    "DELETE FROM invalid_base_suppressions WHERE root_thread_id = ?",
  );

  const decode = (row: SuppressionRow): InvalidBaseSuppression => ({
    rootThreadId: row.root_thread_id,
    itemId: row.item_id,
    repository: row.repository,
    requestedRef: row.requested_ref,
    diagnostic: row.diagnostic,
    suppressedAt: row.suppressed_at,
  });

  return {
    suppress(input: InvalidBaseSuppression): boolean {
      const inserted = exact.get(
        input.rootThreadId,
        input.itemId,
        input.repository,
        input.requestedRef,
      ) === undefined;
      upsert.run(
        input.rootThreadId,
        input.itemId,
        input.repository,
        input.requestedRef,
        input.diagnostic.trim(),
        input.suppressedAt,
      );
      return inserted;
    },
    get(
      rootThreadId: string,
      itemId: string,
      repository: string,
      requestedRef: string,
    ): InvalidBaseSuppression | null {
      const row = exact.get(rootThreadId, itemId, repository, requestedRef) as
        | SuppressionRow
        | undefined;
      return row ? decode(row) : null;
    },
    listForItem(rootThreadId: string, itemId: string): InvalidBaseSuppression[] {
      return (byItem.all(rootThreadId, itemId) as SuppressionRow[]).map(decode);
    },
    list(rootThreadId: string): InvalidBaseSuppression[] {
      return (byRoot.all(rootThreadId) as SuppressionRow[]).map(decode);
    },
    /** Explicit operator revalidation clears this item's remembered tuples. */
    revalidate(rootThreadId: string, itemId: string): number {
      return removeItem.run(rootThreadId, itemId).changes;
    },
    clear(rootThreadId: string): number {
      return removeRoot.run(rootThreadId).changes;
    },
  };
}

export type InvalidBaseSuppressionStore = ReturnType<
  typeof createInvalidBaseSuppressionStore
>;
