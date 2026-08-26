import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * Slices held out of scheduling while their contract is being rewritten.
 *
 * Releasing a slice returns it to the queue, and the scheduler picks it up
 * within seconds — under the SAME brief that was wrong. Three times in one
 * session an orchestrator released a mis-scoped item to fix it and a fresh
 * worker was already burning tokens on the impossible contract before the edit
 * landed. The workaround was to pause the whole goal, which stops every other
 * slice too, to edit one.
 *
 * A hold is that pause, scoped to one item. Editing the item lifts it, because
 * the edit is the thing the hold was waiting for and a hold nobody remembers to
 * lift is just a lost slice.
 */
export function createStaffingHoldStore(
  db: ReturnType<BbPluginApi["storage"]["database"]>,
) {
  // Owned here rather than in the shared migration list, which records progress
  // by array index and has silently skipped an appended statement before.
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_item_staffing_holds (
      thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      reason TEXT,
      held_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, item_id)
    )
  `);
  const insert = db.prepare(`
    INSERT INTO goal_item_staffing_holds (thread_id, item_id, reason, held_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(thread_id, item_id) DO UPDATE SET reason = excluded.reason
  `);
  const remove = db.prepare(
    "DELETE FROM goal_item_staffing_holds WHERE thread_id = ? AND item_id = ?",
  );
  const one = db.prepare(
    "SELECT item_id FROM goal_item_staffing_holds WHERE thread_id = ? AND item_id = ?",
  );
  const all = db.prepare(
    "SELECT item_id, reason FROM goal_item_staffing_holds WHERE thread_id = ? ORDER BY item_id",
  );
  return {
    hold(threadId: string, itemId: string, reason: string | null, now: number): void {
      insert.run(threadId, itemId, reason?.trim() || null, now);
    },
    /** True when a hold was actually lifted, so callers can say so. */
    lift(threadId: string, itemId: string): boolean {
      return remove.run(threadId, itemId).changes > 0;
    },
    isHeld(threadId: string, itemId: string): boolean {
      return one.get(threadId, itemId) !== undefined;
    },
    list(threadId: string): Array<{ itemId: string; reason: string | null }> {
      return (all.all(threadId) as Array<{ item_id: string; reason: string | null }>).map(
        (row) => ({ itemId: row.item_id, reason: row.reason }),
      );
    },
  };
}

export type StaffingHoldStore = ReturnType<typeof createStaffingHoldStore>;
