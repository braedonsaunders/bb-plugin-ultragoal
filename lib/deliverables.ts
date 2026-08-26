import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { normalizeFindingFile } from "./scheduler.js";

/**
 * Declared outputs a slice must account for before it can close.
 *
 * A work item's `files` is a CEILING — the scope a worker may touch, and what
 * the scheduler serializes on. Nothing was a FLOOR: a slice closed once its
 * linked defects were attested, whether or not it produced the artifacts it was
 * scoped to produce. A credential-audit script was declared, never written, and
 * the slice closed clean because the defect it accompanied was genuinely fixed.
 *
 * Requirements are that floor, and deliberately opt-in: an item with none
 * behaves exactly as before, so adding this cannot retroactively block work
 * already in flight.
 */
export interface DeliverableClaim {
  path: string;
  proof: string;
}

export function createItemRequirementStore(
  db: ReturnType<BbPluginApi["storage"]["database"]>,
) {
  // Owned here rather than in the shared migration list, which records progress
  // by array index and has silently skipped an appended statement before.
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_item_requirements (
      thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      path TEXT NOT NULL,
      PRIMARY KEY (thread_id, item_id, path)
    )
  `);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO goal_item_requirements (thread_id, item_id, path) VALUES (?, ?, ?)",
  );
  const listFor = db.prepare(
    "SELECT path FROM goal_item_requirements WHERE thread_id = ? AND item_id = ? ORDER BY path",
  );
  const clearFor = db.prepare(
    "DELETE FROM goal_item_requirements WHERE thread_id = ? AND item_id = ?",
  );
  const replace = db.transaction((threadId: string, itemId: string, paths: readonly string[]) => {
    clearFor.run(threadId, itemId);
    for (const path of paths) insert.run(threadId, itemId, path);
  });
  return {
    /** Replaces the item's requirements. Returns the normalized paths stored. */
    set(threadId: string, itemId: string, paths: readonly string[]): string[] {
      const clean = [
        ...new Set(paths.map((path) => normalizeFindingFile(path)).filter(Boolean)),
      ].sort();
      replace.immediate(threadId, itemId, clean);
      return clean;
    },
    list(threadId: string, itemId: string): string[] {
      return (listFor.all(threadId, itemId) as Array<{ path: string }>).map((row) => row.path);
    },
    clear(threadId: string, itemId: string): boolean {
      return clearFor.run(threadId, itemId).changes > 0;
    },
  };
}

export type ItemRequirementStore = ReturnType<typeof createItemRequirementStore>;

/**
 * Parse the documented deliverable contract out of a slice report.
 *
 * Same shape and same strictness as `DEFECT_COVERAGE`: one machine-readable
 * line per declared output, exact path, nonempty proof. Prose describing what
 * was built counts for nothing, because prose is what let the last omission
 * through.
 */
export function parseDeliverableEvidence(output: string | null | undefined): DeliverableClaim[] {
  const byPath = new Map<string, DeliverableClaim>();
  const invalid = new Set<string>();
  for (const line of (output ?? "").split(/\r?\n/)) {
    const match = /^\s*DELIVERABLE:\s*(\{.*\})\s*$/i.exec(line);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]!) as Record<string, unknown>;
      const path = typeof parsed.path === "string" ? normalizeFindingFile(parsed.path) : "";
      const proof = typeof parsed.proof === "string" ? parsed.proof.trim() : "";
      if (!path) continue;
      if (byPath.has(path) || invalid.has(path) || !proof) {
        // A conflicting or proofless repeat invalidates the earlier pass rather
        // than leaving the permissive one standing.
        byPath.delete(path);
        invalid.add(path);
        continue;
      }
      byPath.set(path, { path, proof });
    } catch {
      const named = /["']path["']\s*:\s*["']([^"']+)["']/i.exec(match[1]!)?.[1];
      if (named) {
        const path = normalizeFindingFile(named);
        byPath.delete(path);
        invalid.add(path);
      }
    }
  }
  return [...byPath.values()];
}

/** Declared outputs the report did not account for. */
export function missingDeliverables(
  claims: readonly DeliverableClaim[] | null | undefined,
  required: readonly string[],
): string[] {
  const proven = new Set((claims ?? []).map((claim) => claim.path));
  return required.map((path) => normalizeFindingFile(path)).filter((path) => !proven.has(path));
}
