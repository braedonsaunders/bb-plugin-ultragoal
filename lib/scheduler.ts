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

const SHARED_INFRASTRUCTURE_FILES: ReadonlySet<string> = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "schema/canonical-baseline.test.ts",
]);

export function isConcreteFindingFile(path: string): boolean {
  path = normalizeFindingFile(path);
  // Square brackets are literal path characters in frameworks such as Next
  // (`app/api/[entity]/route.ts`). Exact equality makes them safe here; only
  // actual wildcard syntax remains non-concrete.
  if (!path || /[*?{}]/.test(path)) return false;
  if (SHARED_INFRASTRUCTURE_FILES.has(path)) return false;
  const leaf = path.split("/").at(-1) ?? "";
  return leaf.includes(".");
}

const STEP_FILE_PATTERN = /(?:^|[\s`"'([{])((?:[A-Za-z0-9_.@+\[\]-]+\/)*[A-Za-z0-9_.@+\[\]-]+\.[A-Za-z0-9_+-]+(?::\d+(?:[-:]\d+)?)?)(?=$|[\s`"'\])},;.!?])/g;
const CONTEXT_AUDIT_FINDINGS_PATTERN = /\bCONTEXT\s*\(\s*audit\s+findings?\b([^)]*)\)/gi;
const FINDING_ID_PATTERN = /\bfnd_[a-z0-9_]+\b/gi;

/** Concrete repository files explicitly named in a work item's brief. */
export function concreteFilesInStep(step: string): string[] {
  return [...step.matchAll(STEP_FILE_PATTERN)]
    .map((match) => normalizeFindingFile(match[1] ?? ""))
    .filter(isConcreteFindingFile);
}

/** Only the structured CONTEXT audit-finding clause is authoritative. A
 * finding id mentioned elsewhere (for example, an auditor note explaining
 * that an old coalescing decision was wrong) is deliberately ignored. */
export function itemContextDeclaresFinding(step: string, findingId: string): boolean {
  const target = findingId.trim().toLowerCase();
  if (!/^fnd_[a-z0-9_]+$/.test(target)) return false;
  for (const context of step.matchAll(CONTEXT_AUDIT_FINDINGS_PATTERN)) {
    const ids = (context[1] ?? "").match(FINDING_ID_PATTERN) ?? [];
    if (ids.some((id) => id.toLowerCase() === target)) return true;
  }
  return false;
}

/** A durable finding link needs direct file evidence. Directory scopes and
 * shared infrastructure files serialize work, but cannot prove ownership of
 * a defect. One of the finding's evidence or declared repair files must
 * exactly match the item's concrete scope or a concrete file in its brief. */
export function findingFilesMatchItem(
  findingFile: string,
  fixFiles: readonly string[],
  item: Pick<GoalItem, "files" | "step">,
): boolean {
  const evidenceFiles = [findingFile, ...fixFiles]
    .map(normalizeFindingFile)
    .filter(isConcreteFindingFile);
  if (evidenceFiles.length === 0) return false;
  const ownedFiles = new Set([
    ...item.files.map(normalizeFindingFile).filter(isConcreteFindingFile),
    ...concreteFilesInStep(item.step),
  ]);
  return evidenceFiles.some((file) => ownedFiles.has(file));
}

/** Exact concrete-file ownership is preferred; an explicit structured audit
 * declaration is the only non-file positive signal accepted for coalescing. */
export function findingMatchesItem(
  findingId: string,
  findingFile: string,
  fixFiles: readonly string[],
  item: Pick<GoalItem, "files" | "step">,
): boolean {
  return (
    findingFilesMatchItem(findingFile, fixFiles, item) ||
    itemContextDeclaresFinding(item.step, findingId)
  );
}

/** Finding coalescing is deliberately stricter than scheduler scope overlap.
 * A directory scope must serialize workers that could edit descendants, but it
 * is not evidence that two defects belong to the same remediation slice. */
export function coalescingFilesOverlap(a: readonly string[], b: readonly string[]): boolean {
  const concreteA = new Set(
    a.map(normalizeFindingFile).filter(isConcreteFindingFile),
  );
  return b
    .map(normalizeFindingFile)
    .filter(isConcreteFindingFile)
    .some((path) => concreteA.has(path));
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

/** Same-file findings join the existing slice. Past the staffed-remediation cap,
 * new distinct files are recorded but do not mint another auto-staffed slice. */
export function findingAction(input: {
  findingId: string;
  file: string;
  fixFiles?: readonly string[];
  staffedRemediationCount: number;
  maxStaffedRemediations: number;
  openItems: readonly Pick<GoalItem, "id" | "status" | "files" | "step">[];
}): FindingAction {
  const attach = input.openItems.find(
    (item) =>
      item.status !== "completed" &&
      findingMatchesItem(input.findingId, input.file, input.fixFiles ?? [], item),
  );
  if (attach) return { action: "attach", attachItemId: attach.id };
  if (input.staffedRemediationCount >= input.maxStaffedRemediations) return { action: "record-only" };
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

/** Start a new turn on an idle, errored, or stopped thread. Active/starting
 * means a provider turn is still held — settle it first. */
export function threadAcceptsStart(thread: {
  status?: string | null;
  archivedAt?: number | null;
  deletedAt?: number | null;
}): boolean {
  if (thread.archivedAt || thread.deletedAt) return false;
  const status = thread.status ?? "";
  return status !== "active" && status !== "starting" && status !== "stopping";
}

export function threadIsSettledForSubmit(status: string | null | undefined): boolean {
  const value = status ?? "";
  return value !== "active" && value !== "starting" && value !== "stopping";
}

export function isTurnAlreadyActiveError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /a turn is already active|turn is already active/i.test(message);
}

/** Infrastructure turn failures that should self-heal, not stay blocked. */
export function isTransientTurnFailure(reason: string | null | undefined): boolean {
  const text = reason ?? "";
  return /turn\.submit|turn is already active|already active|no active acp session/i.test(text);
}

export function orphanInProgressIds(
  items: readonly Pick<GoalItem, "id" | "status">[],
  heldItemIds: ReadonlySet<string>,
): string[] {
  return items
    .filter((item) => item.status === "in_progress" && !heldItemIds.has(item.id))
    .map((item) => item.id);
}
