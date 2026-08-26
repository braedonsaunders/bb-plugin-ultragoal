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

// Files nearly every repository shares, which therefore prove nothing about
// which defect owns a change. Deliberately only ecosystem-level manifests: a
// path meaningful to one project does not belong in a plugin every project
// runs. `schema/canonical-baseline.test.ts` used to sit here, which quietly
// applied one repository's layout to everyone else's.
const BUILT_IN_SHARED_FILES: readonly string[] = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

let SHARED_INFRASTRUCTURE_FILES: ReadonlySet<string> = new Set(BUILT_IN_SHARED_FILES);

/**
 * Extend the shared-file set with paths this installation cares about.
 *
 * A repository usually has one or two files that every slice touches — a pinned
 * schema inventory, a generated lockfile of its own — and letting such a file
 * anchor defect ownership merges unrelated defects. Which files those are is a
 * property of the repository, so it is configuration, not code.
 */
export function setSharedInfrastructureFiles(paths: readonly string[]): void {
  SHARED_INFRASTRUCTURE_FILES = new Set([
    ...BUILT_IN_SHARED_FILES,
    ...paths.map((path) => normalizeFindingFile(path)).filter(Boolean),
  ]);
}
const GENERATED_MIGRATION_ARTIFACT = /(?:^|\/)migrations\/generated(?:\/|$)/;

export function isConcreteFindingFile(path: string): boolean {
  path = normalizeFindingFile(path);
  // Square brackets are literal path characters in frameworks such as Next
  // (`app/api/[entity]/route.ts`). Exact equality makes them safe here; only
  // actual wildcard syntax remains non-concrete.
  if (!path || /[*?{}]/.test(path)) return false;
  if (SHARED_INFRASTRUCTURE_FILES.has(path)) return false;
  // Generated migration output is a shared build artifact, not a semantic
  // domain owner. Exact line-stripped equality on a monolithic baseline would
  // otherwise merge unrelated defects from tens of thousands of SQL lines.
  if (GENERATED_MIGRATION_ARTIFACT.test(path)) return false;
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

/**
 * Durable worker rows whose slice is over, and so are CANDIDATES for retirement.
 *
 * The SQL capacity fence counts every non-retired `collab_agents` row, while
 * {@link occupyingWorkerIds} counts only live-or-holding workers. A finished
 * worker used to be retired only once a later sweep observed its host as
 * `stopped`, which depends on a best-effort `threads.stop` that swallows its
 * failures. Each swallowed failure left a row the fence counted forever and the
 * scheduler did not — enough of them and no reservation could ever be granted
 * again.
 *
 * Input must be the DURABLE rows, not the projected agent list: that projection
 * drops any worker whose item is already completed, which is exactly the set
 * this function exists to find. Passing the projection makes it a no-op.
 *
 * These are candidates, not decisions. Liveness deliberately is NOT decided
 * here, because the only liveness signal available in memory is that same
 * projection — and inferring "not live" from "absent from the projection" would
 * retire and stop a genuinely running worker whenever a host read failed
 * transiently. The caller must confirm each candidate's host directly and fail
 * closed when it cannot.
 *
 * A worker is only a candidate when its slice is `completed` or gone from the
 * plan entirely; a `pending` or `in_progress` slice may still be handed back to
 * the same worker. One a verifier still reads as its source is never a
 * candidate, because the verifier resolves its slice through that row.
 */
export function finishedWorkerRetirementCandidates(
  workers: readonly { threadId: string; itemId: string | null; role: string | null }[],
  items: readonly Pick<GoalItem, "id" | "status">[],
  hasLiveVerifier: (workerThreadId: string) => boolean,
): string[] {
  const byId = new Map(items.map((item) => [item.id, item.status]));
  const retire: string[] = [];
  for (const worker of workers) {
    if (worker.role === "verifier" || !worker.itemId) continue;
    const status = byId.get(worker.itemId);
    if (status !== undefined && status !== "completed") continue;
    if (hasLiveVerifier(worker.threadId)) continue;
    retire.push(worker.threadId);
  }
  return retire;
}

/** Host states that mean a worker is still doing something. `starting` counts:
 * its first turn has produced nothing yet, but it is about to. Both the host
 * and projection vocabularies appear here because callers read from both. */
const HOST_LIVE: ReadonlySet<string> = new Set(["active", "running", "starting"]);

/**
 * Whether a confirmed host status permits retiring the row.
 *
 * `null` means the host could not be read, and unknown is not proof of death:
 * retiring there would stop a live worker mid-slice. Retirement is a
 * fail-closed decision, unlike release, where an unreadable host is the very
 * situation the operator is trying to clean up.
 */
export function retirementPermittedByHost(hostStatus: string | null): boolean {
  if (hostStatus === null) return false;
  return !HOST_LIVE.has(hostStatus);
}

/**
 * The file scope an `--own-slice` item is created with.
 *
 * Both branches normalize, because the scheduler compares scopes as exact
 * paths: a line-qualified `src/x.ts:99` stored literally would never overlap
 * another slice's `src/x.ts`, silently defeating the serialization guard that
 * defaulting the scope exists to preserve.
 */
export function ownSliceScope(
  evidenceFile: string,
  fixFiles: readonly string[] | undefined,
): string[] {
  const declared = [
    ...new Set((fixFiles ?? []).map(normalizeFindingFile).filter(Boolean)),
  ];
  if (declared.length > 0) return declared;
  const evidence = normalizeFindingFile(evidenceFile);
  return evidence ? [evidence] : [];
}

/**
 * Whether any verifier can still produce a verdict for this worker, and so must
 * keep its source row alive.
 *
 * Row existence alone is not the question. `verifiersFor` returns every
 * non-retired verifier row regardless of host state, so a verifier that crashed
 * or was deleted before emitting a verdict used to block its source worker's
 * retirement for the life of the goal — wedging that slot in the SQL capacity
 * fence. A verifier counts only while it is live in the refreshed snapshot, or
 * young enough that an unharvested idle verdict is still plausible. One that
 * already recorded a terminal report has had its say.
 */
export function verifierStillDeciding(
  verifiers: readonly { threadId: string; createdAt: number; reportStatus: string | null }[],
  isHostLive: (threadId: string) => boolean,
  now: number,
  graceMs: number,
): boolean {
  return verifiers.some((verifier) => {
    if (verifier.reportStatus === "done" || verifier.reportStatus === "blocked") return false;
    if (isHostLive(verifier.threadId)) return true;
    return now - verifier.createdAt < graceMs;
  });
}

export type ReleaseTarget = {
  threadId: string;
  rootThreadId: string | null;
  role: string | null;
  itemId: string | null;
  reportStatus: string | null;
  /** Refreshed host status, or null when the host could not be read. */
  hostStatus: string | null;
};

export type ReleasePlan =
  | { ok: true; release: Array<{ threadId: string; itemId: string | null }> }
  | { ok: false; reason: string };

/**
 * Validate every release target before any of them is mutated.
 *
 * An item can be held by more than one durable row, so releasing some and then
 * rejecting a later one would leave a half-released slice the caller has no way
 * to reason about. An unreadable host is not proof of life — the row is still
 * releasable — but `active` and `starting` both are: `starting` has produced
 * nothing yet, and is about to.
 */
export function planWorkerRelease(
  targets: readonly ReleaseTarget[],
  rootThreadId: string,
): ReleasePlan {
  if (targets.length === 0) {
    return { ok: false, reason: "no live worker holds that target" };
  }
  const release: Array<{ threadId: string; itemId: string | null }> = [];
  for (const target of targets) {
    if (target.rootThreadId !== rootThreadId) {
      return { ok: false, reason: `${target.threadId} is not a live worker on ${rootThreadId}` };
    }
    if (target.role === "verifier") {
      return {
        ok: false,
        reason: `${target.threadId} is a verifier, not a slice holder; releasing it would strand the worker it judges`,
      };
    }
    if (target.reportStatus === "done") {
      return {
        ok: false,
        reason: `${target.threadId} reported done; let the completion path consume it rather than releasing it`,
      };
    }
    if (target.hostStatus === "active" || target.hostStatus === "starting") {
      return {
        ok: false,
        reason: `${target.threadId} is ${target.hostStatus}; stop it before releasing its slice`,
      };
    }
    release.push({ threadId: target.threadId, itemId: target.itemId });
  }
  return { ok: true, release };
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
