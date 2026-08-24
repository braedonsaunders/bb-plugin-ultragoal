import type { GoalAgent, GoalItem } from "../contract.js";

export const DEFAULT_MAX_OPEN_FINDINGS = 50;

export function globPrefix(path: string): string {
  return path.trim().replace(/\*+.*$/, "").replace(/\/+$/, "");
}

export function filesOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const rawA of a) {
    const na = globPrefix(rawA);
    for (const rawB of b) {
      const nb = globPrefix(rawB);
      if (!na || !nb) return true;
      if (na === nb || na.startsWith(`${nb}/`) || nb.startsWith(`${na}/`)) return true;
    }
  }
  return false;
}

export function normalizeFindingFile(file: string): string {
  return file.trim().replace(/[:#]\d+([-:]\d+)?$/, "");
}

const LIVE: ReadonlySet<string> = new Set(["running", "starting"]);
const DEAD: ReadonlySet<string> = new Set(["error", "stopped"]);

/** A worker occupies a slot until its open slice is released — not merely
 * while the provider turn is active. Codex workers idle between short turns;
 * counting only running/starting is how a 5-slot goal grew a 35-agent crew. */
export function occupyingWorkerIds(
  agents: readonly Pick<GoalAgent, "role" | "status" | "itemId" | "threadId">[],
  openItemIds: ReadonlySet<string>,
): string[] {
  const ids = new Set<string>();
  for (const agent of agents) {
    if (agent.role === "verifier") continue;
    const live = LIVE.has(agent.status);
    const holding =
      Boolean(agent.itemId) &&
      openItemIds.has(agent.itemId!) &&
      !DEAD.has(agent.status);
    if (live || holding) ids.add(agent.threadId);
  }
  return [...ids];
}

export function liveVerifierCount(
  agents: readonly Pick<GoalAgent, "role" | "status">[],
): number {
  return agents.filter(
    (agent) => agent.role === "verifier" && LIVE.has(agent.status),
  ).length;
}

export function freeSlots(maxWorkers: number, occupied: number): number {
  if (maxWorkers <= 0) return 0;
  return Math.max(0, maxWorkers - occupied);
}

export type FindingAction =
  | { action: "mint" }
  | { action: "attach"; attachItemId: string }
  | { action: "record-only" };

/** Same-file findings join the existing slice. Past the open-finding cap,
 * new distinct files are recorded but do not mint another auto-staffed slice. */
export function findingAction(input: {
  file: string;
  openFindingCount: number;
  maxOpenFindings: number;
  openItems: readonly Pick<GoalItem, "id" | "status" | "files">[];
}): FindingAction {
  const file = normalizeFindingFile(input.file);
  const attach = input.openItems.find(
    (item) =>
      item.status !== "completed" &&
      item.files.length > 0 &&
      filesOverlap(item.files, [file]),
  );
  if (attach) return { action: "attach", attachItemId: attach.id };
  if (input.openFindingCount >= input.maxOpenFindings) return { action: "record-only" };
  return { action: "mint" };
}

export function threadAcceptsSteer(thread: {
  status?: string | null;
  archivedAt?: number | null;
  deletedAt?: number | null;
}): boolean {
  if (thread.archivedAt || thread.deletedAt) return false;
  const status = thread.status ?? "";
  return status !== "error" && status !== "stopping" && status !== "stopped";
}

export function orphanInProgressIds(
  items: readonly Pick<GoalItem, "id" | "status">[],
  heldItemIds: ReadonlySet<string>,
): string[] {
  return items
    .filter((item) => item.status === "in_progress" && !heldItemIds.has(item.id))
    .map((item) => item.id);
}
