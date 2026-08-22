import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GoalItem, GoalItemStatus } from "../contract.js";

interface ItemRow {
  id: string;
  thread_id: string;
  step: string;
  status: GoalItemStatus;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

function rowToItem(row: ItemRow): GoalItem {
  return { id: row.id, step: row.step, status: row.status };
}

function newId(): string {
  return `itm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createItemStore(bb: BbPluginApi) {
  const db = bb.storage.database();

  const listStmt = db.prepare(
    "SELECT * FROM goal_items WHERE thread_id = ? ORDER BY sort_order ASC, created_at ASC",
  );
  const insertStmt = db.prepare(`
    INSERT INTO goal_items (id, thread_id, step, status, sort_order, created_at, updated_at)
    VALUES (@id, @thread_id, @step, @status, @sort_order, @created_at, @updated_at)
  `);
  const updateStmt = db.prepare(`
    UPDATE goal_items
    SET step = @step, status = @status, sort_order = @sort_order, updated_at = @updated_at
    WHERE id = @id AND thread_id = @thread_id
  `);
  const removeStmt = db.prepare("DELETE FROM goal_items WHERE id = ? AND thread_id = ?");
  const clearStmt = db.prepare("DELETE FROM goal_items WHERE thread_id = ?");

  return {
    list(threadId: string): GoalItem[] {
      return (listStmt.all(threadId) as ItemRow[]).map(rowToItem);
    },

    clear(threadId: string): void {
      clearStmt.run(threadId);
    },

    replace(
      threadId: string,
      plan: Array<{ step: string; status: GoalItemStatus }>,
    ): GoalItem[] {
      const existing = listStmt.all(threadId) as ItemRow[];
      const unused = new Map(existing.map((row) => [row.step.trim().toLowerCase(), row]));
      const now = Date.now();
      const next: ItemRow[] = [];

      for (const [index, item] of plan.entries()) {
        const step = item.step.trim();
        if (!step) continue;
        const prior = unused.get(step.toLowerCase());
        unused.delete(step.toLowerCase());
        next.push({
          id: prior?.id ?? newId(),
          thread_id: threadId,
          step,
          status: item.status,
          sort_order: index,
          created_at: prior?.created_at ?? now,
          updated_at: now,
        });
      }

      clearStmt.run(threadId);
      for (const row of next) insertStmt.run(row);
      return next.map(rowToItem);
    },

    merge(
      threadId: string,
      plan: Array<{ step: string; status: GoalItemStatus }>,
    ): GoalItem[] {
      const existing = listStmt.all(threadId) as ItemRow[];
      const seen = new Set(existing.map((row) => row.step.trim().toLowerCase()));
      const now = Date.now();
      let order = existing.length;
      for (const item of plan) {
        const step = item.step.trim();
        if (!step || seen.has(step.toLowerCase())) continue;
        seen.add(step.toLowerCase());
        insertStmt.run({
          id: newId(),
          thread_id: threadId,
          step,
          status: item.status,
          sort_order: order,
          created_at: now,
          updated_at: now,
        });
        order += 1;
      }
      return (listStmt.all(threadId) as ItemRow[]).map(rowToItem);
    },

    add(threadId: string, step: string, status: GoalItemStatus = "pending"): GoalItem | null {
      const text = step.trim();
      if (!text) return null;
      const existing = listStmt.all(threadId) as ItemRow[];
      const now = Date.now();
      const row: ItemRow = {
        id: newId(),
        thread_id: threadId,
        step: text,
        status,
        sort_order: existing.length,
        created_at: now,
        updated_at: now,
      };
      insertStmt.run(row);
      return rowToItem(row);
    },

    setStatus(threadId: string, itemId: string, status: GoalItemStatus): GoalItem | null {
      const existing = (listStmt.all(threadId) as ItemRow[]).find((row) => row.id === itemId);
      if (!existing) return null;
      const next = { ...existing, status, updated_at: Date.now() };
      updateStmt.run(next);
      return rowToItem(next);
    },

    remove(threadId: string, itemId: string): boolean {
      return removeStmt.run(itemId, threadId).changes > 0;
    },
  };
}

export type ItemStore = ReturnType<typeof createItemStore>;
