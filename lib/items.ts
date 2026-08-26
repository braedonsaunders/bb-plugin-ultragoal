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

export type PlanPatchItem = {
  id?: string;
  step: string;
  status: GoalItemStatus;
} & ItemMeta;

export interface ItemPatchResult {
  items: GoalItem[];
  removed: number;
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
  const creationOrderStmt = db.prepare(
    "SELECT id FROM goal_items WHERE thread_id = ? ORDER BY created_at ASC, id ASC",
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

  const removeRows = (threadId: string, itemIds: readonly string[]): number => {
    const ids = new Set(itemIds.map((id) => id.trim()).filter(Boolean));
    if (ids.size === 0) return 0;
    const existing = listStmt.all(threadId) as ItemRow[];
    let removed = 0;
    db.transaction(() => {
      for (const id of ids) removed += removeStmt.run(id, threadId).changes;
      // A removed completed dependency must not deadlock every preserved
      // descendant. Purge deleted ids from the remaining DAG atomically.
      for (const row of existing) {
        if (ids.has(row.id)) continue;
        const deps = parseList(row.deps);
        const nextDeps = deps.filter((dep) => !ids.has(dep));
        if (nextDeps.length === deps.length) continue;
        updateStmt.run({ ...row, deps: JSON.stringify(nextDeps), updated_at: Date.now() });
      }
    })();
    return removed;
  };

  const applyPatch = (
    threadId: string,
    plan: readonly PlanPatchItem[],
    removeItemIds: readonly string[],
  ): ItemPatchResult => {
    const existing = listStmt.all(threadId) as ItemRow[];
    const byId = new Map(existing.map((row) => [row.id, row]));
    const removalIds = new Set(removeItemIds.map((id) => id.trim()).filter(Boolean));
    const unknownRemovals = [...removalIds].filter((id) => !byId.has(id));
    if (unknownRemovals.length > 0) {
      throw new Error(`unknown remove_item_ids: ${unknownRemovals.join(", ")}`);
    }
    const suppliedIds = plan.flatMap((item) => {
      const id = item.id?.trim();
      return id ? [id] : [];
    });
    const unknownUpdates = [...new Set(suppliedIds.filter((id) => !byId.has(id)))];
    if (unknownUpdates.length > 0) {
      throw new Error(`unknown plan item id(s): ${unknownUpdates.join(", ")}`);
    }
    const contradictory = [...new Set(suppliedIds.filter((id) => removalIds.has(id)))];
    if (contradictory.length > 0) {
      throw new Error(`cannot patch and remove the same slice(s): ${contradictory.join(", ")}`);
    }

    const remaining = existing.filter((row) => !removalIds.has(row.id));
    const remainingById = new Map(remaining.map((row) => [row.id, row]));
    const byStep = new Map(remaining.map((row) => [normalizedStep(row.step), row]));
    const claimed = new Set<string>();
    let nextSortOrder = existing.reduce((max, row) => Math.max(max, row.sort_order), -1) + 1;
    const now = Date.now();

    const slots = plan.map((item) => {
      const step = currentSliceTitle(item.step);
      if (!step) throw new Error("plan patch contains an empty step");
      const requestedId = item.id?.trim();
      let prior = requestedId ? remainingById.get(requestedId) : undefined;
      if (prior && claimed.has(prior.id)) {
        throw new Error(`plan patch contains duplicate item id: ${prior.id}`);
      }
      if (!prior && !requestedId) {
        const viaStep = byStep.get(normalizedStep(step));
        if (viaStep && !claimed.has(viaStep.id)) prior = viaStep;
      }
      if (prior) claimed.add(prior.id);
      const priorDeps = prior
        ? parseList(prior.deps).filter((dep) => !removalIds.has(dep))
        : [];
      return {
        item,
        row: {
          id: prior?.id ?? newId(),
          thread_id: threadId,
          step,
          status: item.status,
          sort_order: prior?.sort_order ?? nextSortOrder++,
          created_at: prior?.created_at ?? now,
          updated_at: now,
          origin: prior?.origin ?? null,
          deps: priorDeps.length > 0 ? JSON.stringify(priorDeps) : null,
          files: prior?.files ?? null,
          check_cmd: prior?.check_cmd ?? null,
        } satisfies ItemRow,
        prior: Boolean(prior),
      };
    });

    const validIds = new Set([...remaining.map((row) => row.id), ...slots.map((slot) => slot.row.id)]);
    for (const slot of slots) {
      const { item, row } = slot;
      if (item.deps !== undefined) {
        const deps = item.deps
          .map((ref) => {
            const trimmed = ref.trim();
            const positional = /^#(\d+)$/.exec(trimmed);
            if (positional) return slots[Number.parseInt(positional[1]!, 10) - 1]?.row.id ?? "";
            return trimmed;
          })
          .filter((id) => id && id !== row.id && validIds.has(id));
        row.deps = deps.length > 0 ? JSON.stringify([...new Set(deps)]) : null;
      }
      if (item.files !== undefined) {
        const files = [...new Set(item.files.map((file) => file.trim()).filter(Boolean))];
        row.files = files.length > 0 ? JSON.stringify(files) : null;
      }
      if (item.check !== undefined) row.check_cmd = item.check?.trim() || null;
    }

    const patchedIds = new Set(slots.map((slot) => slot.row.id));
    const repairedRows = remaining.flatMap((row) => {
      if (patchedIds.has(row.id)) return [];
      const deps = parseList(row.deps);
      const nextDeps = deps.filter((dep) => !removalIds.has(dep));
      if (nextDeps.length === deps.length) return [];
      return [{ ...row, deps: nextDeps.length > 0 ? JSON.stringify(nextDeps) : null, updated_at: now }];
    });

    db.transaction(() => {
      for (const id of removalIds) removeStmt.run(id, threadId);
      for (const row of repairedRows) updateStmt.run(row);
      for (const slot of slots) {
        if (slot.prior) updateStmt.run(slot.row);
        else insertStmt.run(slot.row);
      }
    })();
    return { items: slots.map((slot) => rowToItem(slot.row)), removed: removalIds.size };
  };

  return {
    list(threadId: string): GoalItem[] {
      return (listStmt.all(threadId) as ItemRow[]).map(rowToItem);
    },

    /** Stable durable age ordering for conservative remediation repair. */
    creationOrder(threadId: string): string[] {
      return (creationOrderStmt.all(threadId) as Array<{ id: string }>).map((row) => row.id);
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

    /**
     * Patch a bounded batch into the durable plan. Unlike replace(), omitted
     * rows are preserved, so routine orchestration does not have to resend a
     * 1,000-item DAG just to close or retitle one slice.
     */
    upsert(
      threadId: string,
      plan: PlanPatchItem[],
    ): GoalItem[] {
      return applyPatch(threadId, plan, []).items;
    },

    patch(threadId: string, plan: PlanPatchItem[], removeItemIds: readonly string[]): ItemPatchResult {
      return applyPatch(threadId, plan, removeItemIds);
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
      return removeRows(threadId, [itemId]) > 0;
    },

    removeMany(threadId: string, itemIds: readonly string[]): number {
      return removeRows(threadId, itemIds);
    },
  };
}

export type ItemStore = ReturnType<typeof createItemStore>;
