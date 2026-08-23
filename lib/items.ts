import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GoalItem, GoalItemStatus } from "../contract.js";
import { currentSliceTitle } from "./titles.js";

export { currentSliceTitle };

interface ItemRow {
  id: string;
  thread_id: string;
  step: string;
  status: GoalItemStatus;
  sort_order: number;
  created_at: number;
  updated_at: number;
  origin: string | null;
  deps: string | null;
  files: string | null;
  check_cmd: string | null;
}

/** DAG metadata a planner can attach to an item. Undefined = leave as-is. */
export interface ItemMeta {
  deps?: string[];
  files?: string[];
  check?: string | null;
}

function parseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}


function normalizedStep(step: string): string {
  return step.trim().toLowerCase().replace(/\s+/g, " ");
}

function rowToItem(row: ItemRow): GoalItem {
  return {
    id: row.id,
    step: currentSliceTitle(row.step),
    status: row.status,
    deps: parseList(row.deps),
    files: parseList(row.files),
    check: row.check_cmd?.trim() || null,
  };
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
    INSERT INTO goal_items (id, thread_id, step, status, sort_order, created_at, updated_at, origin, deps, files, check_cmd)
    VALUES (@id, @thread_id, @step, @status, @sort_order, @created_at, @updated_at, @origin, @deps, @files, @check_cmd)
  `);
  const updateStmt = db.prepare(`
    UPDATE goal_items
    SET step = @step, status = @status, sort_order = @sort_order, updated_at = @updated_at,
        deps = @deps, files = @files, check_cmd = @check_cmd
    WHERE id = @id AND thread_id = @thread_id
  `);
  const setStatusStmt = db.prepare(`
    UPDATE goal_items SET status = @status, updated_at = @updated_at
    WHERE id = @id AND thread_id = @thread_id
  `);
  const removeStmt = db.prepare("DELETE FROM goal_items WHERE id = ? AND thread_id = ?");
  const clearStmt = db.prepare("DELETE FROM goal_items WHERE thread_id = ?");

  return {
    list(threadId: string): GoalItem[] {
      return (listStmt.all(threadId) as ItemRow[]).map(rowToItem);
    },

    updatedAt(threadId: string, itemId: string): number | null {
      const row = (listStmt.all(threadId) as ItemRow[]).find((entry) => entry.id === itemId);
      return row?.updated_at ?? null;
    },

    clear(threadId: string): void {
      clearStmt.run(threadId);
    },

    replace(
      threadId: string,
      plan: Array<{ id?: string; step: string; status: GoalItemStatus } & ItemMeta>,
    ): GoalItem[] {
      const existing = listStmt.all(threadId) as ItemRow[];
      const byId = new Map(existing.map((row) => [row.id, row]));
      const byStep = new Map(
        existing.map((row) => [row.step.trim().toLowerCase(), row]),
      );
      const claimed = new Set<string>();
      const slots: Array<{
        step: string;
        status: GoalItemStatus;
        index: number;
        prior: ItemRow | null;
        meta: ItemMeta;
      }> = [];

      for (const [index, item] of plan.entries()) {
        const step = currentSliceTitle(item.step);
        if (!step) continue;
        let prior: ItemRow | null = null;
        const id = item.id?.trim();
        if (id && byId.has(id) && !claimed.has(id)) {
          prior = byId.get(id) ?? null;
        } else {
          const viaStep = byStep.get(step.toLowerCase());
          if (viaStep && !claimed.has(viaStep.id)) prior = viaStep;
        }
        if (prior) claimed.add(prior.id);
        slots.push({
          step,
          status: item.status,
          index,
          prior,
          meta: { deps: item.deps, files: item.files, check: item.check },
        });
      }

      const unused = existing.filter((row) => !claimed.has(row.id));
      for (const slot of slots) {
        if (slot.prior) continue;
        const found = unused.findIndex((row) => row.status === slot.status);
        if (found < 0) continue;
        const prior = unused.splice(found, 1)[0];
        if (!prior) continue;
        slot.prior = prior;
        claimed.add(prior.id);
      }

      const now = Date.now();
      const next: ItemRow[] = slots.map((slot, order) => ({
        id: slot.prior?.id ?? newId(),
        thread_id: threadId,
        step: slot.step,
        status: slot.status,
        sort_order: order,
        created_at: slot.prior?.created_at ?? now,
        updated_at: now,
        origin: slot.prior?.origin ?? null,
        deps: slot.prior?.deps ?? null,
        files: slot.prior?.files ?? null,
        check_cmd: slot.prior?.check_cmd ?? null,
      }));

      // Resolve DAG metadata after ids exist. A dep may reference an item_id
      // or "#N" (1-based position in this same plan list). Omitted fields keep
      // the prior item's metadata; provided fields overwrite it. Deps that
      // point outside the new plan (or at the item itself) are dropped so a
      // typo cannot deadlock a slice.
      const planIds = new Set(next.map((row) => row.id));
      for (const [position, slot] of slots.entries()) {
        const row = next[position]!;
        if (slot.meta.deps !== undefined) {
          const resolved = slot.meta.deps
            .map((ref) => {
              const trimmed = ref.trim();
              const positional = /^#(\d+)$/.exec(trimmed);
              if (positional) return next[Number.parseInt(positional[1]!, 10) - 1]?.id ?? "";
              return trimmed;
            })
            .filter((id) => id && id !== row.id && planIds.has(id));
          row.deps = JSON.stringify([...new Set(resolved)]);
        }
        if (slot.meta.files !== undefined) {
          row.files = JSON.stringify(
            [...new Set(slot.meta.files.map((file) => file.trim()).filter(Boolean))],
          );
        }
        if (slot.meta.check !== undefined) {
          row.check_cmd = slot.meta.check?.trim() || null;
        }
      }

      clearStmt.run(threadId);
      for (const row of next) insertStmt.run(row);
      return next.map(rowToItem);
    },

    updateStep(threadId: string, itemId: string, step: string): GoalItem | null {
      const text = currentSliceTitle(step);
      if (!text) return null;
      const existing = (listStmt.all(threadId) as ItemRow[]).find((row) => row.id === itemId);
      if (!existing) return null;
      const next = { ...existing, step: text, updated_at: Date.now() };
      updateStmt.run(next);
      return rowToItem(next);
    },

    add(
      threadId: string,
      step: string,
      status: GoalItemStatus = "pending",
      meta?: ItemMeta,
    ): GoalItem | null {
      const text = currentSliceTitle(step);
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
        origin: null,
        deps: meta?.deps ? JSON.stringify(meta.deps) : null,
        files: meta?.files ? JSON.stringify(meta.files) : null,
        check_cmd: meta?.check?.trim() || null,
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
