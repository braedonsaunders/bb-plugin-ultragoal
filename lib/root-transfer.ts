import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ReasoningLevel, ServiceTier } from "./execution.js";

const UNFINISHED = new Set(["active", "paused", "blocked", "budget_limited", "usage_limited"]);

export type RootTransferPhase =
  | "prepared"
  | "target_released"
  | "db_committed"
  | "source_archived"
  | "children_reparented"
  | "target_activated"
  | "waking"
  | "complete";

export interface RootTransferCounts {
  goals: number;
  items: number;
  findings: number;
  decisions: number;
  agents: number;
  reservations: number;
  workerCaps: number;
}

export interface RootTransferChild {
  threadId: string;
}

export interface RootTransferJournal {
  sourceThreadId: string;
  targetThreadId: string;
  phase: RootTransferPhase;
  targetIntakeRowId: string;
  wakeMarker: string;
  lastError: string | null;
}

export interface RootTransferInspection {
  mode: "transfer" | "repair-target";
  sourceThreadId: string;
  targetThreadId: string;
  databaseOwner: string;
  goalStatus: string;
  workerProvider: string | null;
  workerModel: string | null;
  counts: RootTransferCounts;
  directChildren: RootTransferChild[];
  journal: RootTransferJournal | null;
}

export interface ExplicitWorkerExecution {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel | null;
  serviceTier: ServiceTier | null;
}

interface GoalOwnerRow {
  thread_id: string;
  status: string;
  worker_provider: string | null;
  worker_model: string | null;
  accounting_thread_ids: string | null;
}

interface JournalRow {
  source_thread_id: string;
  target_thread_id: string;
  phase: RootTransferPhase;
  target_intake_row_id: string;
  wake_marker: string;
  last_error: string | null;
}

function parseList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function rowToJournal(row: JournalRow): RootTransferJournal {
  return {
    sourceThreadId: row.source_thread_id,
    targetThreadId: row.target_thread_id,
    phase: row.phase,
    targetIntakeRowId: row.target_intake_row_id,
    wakeMarker: row.wake_marker,
    lastError: row.last_error,
  };
}

/** Durable half of the cross-provider takeover protocol. */
export function createRootTransferStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  const goal = db.prepare(`
    SELECT thread_id, status, worker_provider, worker_model, accounting_thread_ids
    FROM goals WHERE thread_id = ?
  `);
  const count = {
    goals: db.prepare("SELECT COUNT(*) AS n FROM goals WHERE thread_id = ?"),
    items: db.prepare("SELECT COUNT(*) AS n FROM goal_items WHERE thread_id = ?"),
    findings: db.prepare("SELECT COUNT(*) AS n FROM goal_findings WHERE thread_id = ?"),
    decisions: db.prepare("SELECT COUNT(*) AS n FROM goal_decisions WHERE thread_id = ?"),
    agents: db.prepare("SELECT COUNT(*) AS n FROM collab_agents WHERE root_thread_id = ?"),
    reservations: db.prepare(
      "SELECT COUNT(*) AS n FROM collab_item_reservations WHERE root_thread_id = ?",
    ),
    workerCaps: db.prepare(
      "SELECT COUNT(*) AS n FROM collab_root_worker_caps WHERE root_thread_id = ?",
    ),
  };
  const collabThreadId = db.prepare(
    "SELECT 1 FROM collab_agents WHERE thread_id = ? LIMIT 1",
  );
  // Historical retired workers remain under the archived source in BB. Only
  // live direct children are externally reparented and have parent metadata
  // changed; every row still moves to the target root for durable history.
  const children = db.prepare(`
    SELECT thread_id FROM collab_agents
    WHERE root_thread_id = ? AND parent_thread_id = ? AND retired_at IS NULL
    ORDER BY thread_id ASC
  `);
  const journalByPair = db.prepare(`
    SELECT * FROM goal_root_transfers
    WHERE source_thread_id = ? AND target_thread_id = ?
  `);
  const locked = db.prepare(`
    SELECT 1 FROM goal_root_transfers
    WHERE phase != 'complete' AND (source_thread_id = ? OR target_thread_id = ?)
    LIMIT 1
  `);
  const targetOfTransfer = db.prepare(`
    SELECT 1 FROM goal_root_transfers
    WHERE target_thread_id = ? AND phase != 'complete' LIMIT 1
  `);
  const historicalTarget = db.prepare(`
    SELECT 1 FROM goal_root_transfers WHERE target_thread_id = ? LIMIT 1
  `);
  const insertJournal = db.prepare(`
    INSERT INTO goal_root_transfers (
      source_thread_id, target_thread_id, phase, target_intake_row_id,
      wake_marker, last_error, created_at, updated_at
    ) VALUES (?, ?, 'prepared', ?, ?, NULL, ?, ?)
  `);
  const updateJournal = db.prepare(`
    UPDATE goal_root_transfers SET phase = ?, last_error = ?, updated_at = ?
    WHERE source_thread_id = ? AND target_thread_id = ?
  `);
  const updateItems = db.prepare("UPDATE goal_items SET thread_id = ? WHERE thread_id = ?");
  const updateFindings = db.prepare("UPDATE goal_findings SET thread_id = ? WHERE thread_id = ?");
  const updateDecisions = db.prepare("UPDATE goal_decisions SET thread_id = ? WHERE thread_id = ?");
  const updateLiveAgentParents = db.prepare(`
    UPDATE collab_agents SET parent_thread_id = ?
    WHERE root_thread_id = ? AND parent_thread_id = ? AND retired_at IS NULL
  `);
  const updateAgentRoots = db.prepare(
    "UPDATE collab_agents SET root_thread_id = ? WHERE root_thread_id = ?",
  );
  const updateReservationRoots = db.prepare(
    "UPDATE collab_item_reservations SET root_thread_id = ? WHERE root_thread_id = ?",
  );
  const updateWorkerCapRoots = db.prepare(
    "UPDATE collab_root_worker_caps SET root_thread_id = ? WHERE root_thread_id = ?",
  );
  const updateGoal = db.prepare(`
    UPDATE goals SET
      thread_id = ?, intake_row_id = ?,
      worker_provider = ?, worker_model = ?, worker_reasoning = ?, worker_service_tier = ?,
      accounting_thread_ids = ?
    WHERE thread_id = ?
  `);
  const activateGoal = db.prepare(
    "UPDATE goals SET status = 'active', reason = NULL, updated_at = ? WHERE thread_id = ?",
  );

  const n = (statement: { get: (threadId: string) => unknown }, threadId: string): number =>
    (statement.get(threadId) as { n: number }).n;
  const countsFor = (threadId: string): RootTransferCounts => ({
    goals: n(count.goals, threadId),
    items: n(count.items, threadId),
    findings: n(count.findings, threadId),
    decisions: n(count.decisions, threadId),
    agents: n(count.agents, threadId),
    reservations: n(count.reservations, threadId),
    workerCaps: n(count.workerCaps, threadId),
  });
  const nonzero = (counts: RootTransferCounts): string[] =>
    Object.entries(counts)
      .filter(([, value]) => value > 0)
      .map(([table, value]) => `${table}=${value}`);
  const journal = (sourceThreadId: string, targetThreadId: string): RootTransferJournal | null => {
    const row = journalByPair.get(sourceThreadId, targetThreadId) as JournalRow | undefined;
    return row ? rowToJournal(row) : null;
  };

  const inspect = (sourceThreadId: string, targetThreadId: string): RootTransferInspection => {
    if (!sourceThreadId || !targetThreadId) throw new Error("source and target thread ids are required");
    if (sourceThreadId === targetThreadId) throw new Error("source and target must be different threads");
    const sourceGoal = goal.get(sourceThreadId) as GoalOwnerRow | undefined;
    const targetGoal = goal.get(targetThreadId) as GoalOwnerRow | undefined;
    let mode: RootTransferInspection["mode"];
    let owner: string;
    let ownedGoal: GoalOwnerRow;
    if (sourceGoal && !targetGoal) {
      mode = "transfer";
      owner = sourceThreadId;
      ownedGoal = sourceGoal;
      const collisions = nonzero(countsFor(targetThreadId));
      if (collabThreadId.get(targetThreadId)) collisions.push("collab child thread_id");
      if (collisions.length > 0) {
        throw new Error(`target has UltraGoal-owned rows: ${collisions.join(", ")}`);
      }
    } else if (!sourceGoal && targetGoal) {
      mode = "repair-target";
      owner = targetThreadId;
      ownedGoal = targetGoal;
      const leftovers = nonzero(countsFor(sourceThreadId));
      if (leftovers.length > 0) {
        throw new Error(`source has orphaned UltraGoal-owned rows: ${leftovers.join(", ")}`);
      }
    } else if (sourceGoal && targetGoal) {
      throw new Error("both source and target already own an UltraGoal");
    } else {
      throw new Error("source has no UltraGoal to transfer");
    }
    if (!UNFINISHED.has(ownedGoal.status)) {
      throw new Error(`UltraGoal on ${owner} is not unfinished (status=${ownedGoal.status})`);
    }
    return {
      mode,
      sourceThreadId,
      targetThreadId,
      databaseOwner: owner,
      goalStatus: ownedGoal.status,
      workerProvider: ownedGoal.worker_provider,
      workerModel: ownedGoal.worker_model,
      counts: countsFor(owner),
      directChildren: (children.all(owner, owner) as Array<{ thread_id: string }>).map((row) => ({
        threadId: row.thread_id,
      })),
      journal: journal(sourceThreadId, targetThreadId),
    };
  };

  const setPhase = (
    sourceThreadId: string,
    targetThreadId: string,
    phase: RootTransferPhase,
    error: string | null = null,
  ): RootTransferJournal => {
    if (updateJournal.run(phase, error, Date.now(), sourceThreadId, targetThreadId).changes !== 1) {
      throw new Error("root transfer journal is missing");
    }
    return journal(sourceThreadId, targetThreadId)!;
  };

  return {
    inspect,
    journal,
    isLocked(threadId: string): boolean {
      return Boolean(locked.get(threadId, threadId));
    },
    isTarget(threadId: string): boolean {
      return Boolean(targetOfTransfer.get(threadId));
    },
    wasTarget(threadId: string): boolean {
      return Boolean(historicalTarget.get(threadId));
    },

    prepare(
      sourceThreadId: string,
      targetThreadId: string,
      targetIntakeRowId: string,
      wakeMarker: string,
    ): RootTransferJournal {
      const txn = db.transaction(() => {
        const before = inspect(sourceThreadId, targetThreadId);
        if (before.journal) return before.journal;
        if (before.mode !== "transfer") throw new Error("cannot prepare a transfer already owned by target");
        const now = Date.now();
        insertJournal.run(sourceThreadId, targetThreadId, targetIntakeRowId, wakeMarker, now, now);
        return journal(sourceThreadId, targetThreadId)!;
      });
      return txn.immediate();
    },

    /** Move every root-owned row and phase marker in one IMMEDIATE transaction. */
    commit(
      sourceThreadId: string,
      targetThreadId: string,
      worker: ExplicitWorkerExecution,
    ): RootTransferInspection {
      const txn = db.transaction(() => {
        const before = inspect(sourceThreadId, targetThreadId);
        if (before.mode === "repair-target") return before;
        if (!before.journal || before.journal.phase !== "target_released") {
          throw new Error("root transfer target runtime is not released");
        }
        if (!worker.providerId || !worker.model) {
          throw new Error("effective worker provider and model must be explicit before transfer");
        }
        const sourceRow = goal.get(sourceThreadId) as GoalOwnerRow;
        const accountingIds = [...new Set([...parseList(sourceRow.accounting_thread_ids), sourceThreadId])];
        const expected = before.counts;
        const itemChanges = updateItems.run(targetThreadId, sourceThreadId).changes;
        const findingChanges = updateFindings.run(targetThreadId, sourceThreadId).changes;
        const decisionChanges = updateDecisions.run(targetThreadId, sourceThreadId).changes;
        updateLiveAgentParents.run(targetThreadId, sourceThreadId, sourceThreadId);
        const agentChanges = updateAgentRoots.run(targetThreadId, sourceThreadId).changes;
        const reservationChanges = updateReservationRoots.run(targetThreadId, sourceThreadId).changes;
        const workerCapChanges = updateWorkerCapRoots.run(targetThreadId, sourceThreadId).changes;
        const goalChanges = updateGoal.run(
          targetThreadId,
          before.journal.targetIntakeRowId,
          worker.providerId,
          worker.model,
          worker.reasoningLevel,
          worker.serviceTier,
          JSON.stringify(accountingIds),
          sourceThreadId,
        ).changes;
        if (
          itemChanges !== expected.items ||
          findingChanges !== expected.findings ||
          decisionChanges !== expected.decisions ||
          agentChanges !== expected.agents ||
          reservationChanges !== expected.reservations ||
          workerCapChanges !== expected.workerCaps ||
          goalChanges !== 1
        ) {
          throw new Error("UltraGoal root transfer changed an unexpected number of rows");
        }
        setPhase(sourceThreadId, targetThreadId, "db_committed");
        const after = inspect(sourceThreadId, targetThreadId);
        if (after.counts.goals !== 1 || nonzero(countsFor(sourceThreadId)).length > 0) {
          throw new Error("UltraGoal root transfer parity check failed");
        }
        return after;
      });
      return txn.immediate();
    },

    activateTarget(sourceThreadId: string, targetThreadId: string): RootTransferJournal {
      const txn = db.transaction(() => {
        const current = journal(sourceThreadId, targetThreadId);
        if (!current || current.phase !== "children_reparented") {
          throw new Error("root transfer is not ready to activate the target");
        }
        if (activateGoal.run(Date.now(), targetThreadId).changes !== 1) {
          throw new Error("transferred target goal is missing");
        }
        return setPhase(sourceThreadId, targetThreadId, "target_activated");
      });
      return txn.immediate();
    },

    setPhase,
  };
}

export type RootTransferStore = ReturnType<typeof createRootTransferStore>;

export interface RootTransferExecutionReport extends RootTransferInspection {
  dryRun: boolean;
  targetProvider: string;
  targetModel: string | null;
  childrenAlreadyTargeted: number;
  childrenMoved: number;
  sourceArchived: boolean;
  awakened: boolean;
}

/** Execute or idempotently repair a durable cross-provider root takeover. */
export async function executeRootTransfer(input: {
  bb: BbPluginApi;
  store: RootTransferStore;
  sourceThreadId: string;
  targetThreadId: string;
  dryRun?: boolean;
  targetIntakeRowId: () => Promise<string | null>;
  workerExecution: () => ExplicitWorkerExecution;
  finalAccount: () => Promise<void>;
  wakeSeen: (targetThreadId: string, marker: string) => Promise<boolean>;
  wakeTarget: (targetThreadId: string, marker: string) => Promise<void>;
  onDatabaseCommitted?: () => void;
}): Promise<RootTransferExecutionReport> {
  const { bb, store, sourceThreadId, targetThreadId } = input;
  let inspection = store.inspect(sourceThreadId, targetThreadId);
  const [source, target, targetExecution] = await Promise.all([
    bb.sdk.threads.get({ threadId: sourceThreadId }),
    bb.sdk.threads.get({ threadId: targetThreadId }),
    bb.sdk.threads.defaultExecutionOptions({ threadId: targetThreadId }),
  ]);
  if (source.projectId !== target.projectId || source.environmentId !== target.environmentId) {
    throw new Error("source and target must be in the same project and environment");
  }
  if (target.parentThreadId) throw new Error("target must be a root thread");
  if (target.archivedAt || target.deletedAt) throw new Error("target must not be archived or deleted");
  if (inspection.mode === "transfer" && target.status !== "idle") {
    throw new Error(`target must be idle before transfer (status=${target.status})`);
  }
  // The target used to have to be codex/gpt-5.6-sol xhigh fast/full — one
  // vendor and one model name, written into a plugin that is supposed to be
  // provider-neutral. It made the transfer useless in the exact situation it
  // exists for: when a root dies because ITS provider is unavailable, the only
  // permitted rescue thread was one on that same provider. A goal whose root
  // was a Codex thread became unrecoverable the moment the Codex quota ran out.
  //
  // What actually has to hold is that the target can BE a root: same project
  // and environment, not a child, not archived, idle, and a different thread.
  // Every one of those is checked above. Which model it runs is the owner's
  // choice, and the workers' provider is pinned separately and moves with the
  // goal.
  if (!target.providerId) {
    throw new Error("target has no provider configured");
  }
  if (targetExecution?.model && source.providerId !== target.providerId) {
    // Not fatal — just the one thing an owner would want said out loud, since
    // the new root reasons about the goal in a different model's voice.
    bb.log.info(
      `Root transfer changes the orchestrator provider: ${source.providerId} -> ${target.providerId}/${targetExecution.model}`,
    );
  }

  const childParents = new Map<string, string | null>();
  for (const child of inspection.directChildren) {
    const thread = await bb.sdk.threads.get({ threadId: child.threadId });
    if (thread.projectId !== source.projectId || thread.environmentId !== source.environmentId) {
      throw new Error(`worker ${child.threadId} is not in the source project/environment`);
    }
    if (thread.archivedAt || thread.deletedAt) {
      throw new Error(`live worker ${child.threadId} is archived or deleted`);
    }
    if (
      thread.parentThreadId !== null &&
      thread.parentThreadId !== sourceThreadId &&
      thread.parentThreadId !== targetThreadId
    ) {
      throw new Error(`worker ${child.threadId} has unexpected parent ${thread.parentThreadId ?? "none"}`);
    }
    childParents.set(child.threadId, thread.parentThreadId);
  }

  const targetCursor = inspection.journal?.targetIntakeRowId ?? await input.targetIntakeRowId();
  if (!targetCursor) throw new Error("target has no bootstrap timeline row for the intake cursor");
  const marker = inspection.journal?.wakeMarker ?? `[ultragoal transfer:${sourceThreadId}->${targetThreadId}]`;
  const base = {
    ...inspection,
    dryRun: Boolean(input.dryRun),
    targetProvider: target.providerId,
    targetModel: targetExecution?.model ?? null,
    childrenAlreadyTargeted: [...childParents.values()].filter((parent) => parent === targetThreadId).length,
    childrenMoved: 0,
    sourceArchived: source.archivedAt != null,
    awakened: inspection.journal?.phase === "complete",
  } satisfies RootTransferExecutionReport;
  if (input.dryRun) return base;

  let transfer = inspection.journal ?? store.prepare(sourceThreadId, targetThreadId, targetCursor, marker);
  let moved = 0;
  try {
    if (transfer.phase === "prepared") {
      // Dynamic tool catalogs are fixed when a Codex session is constructed.
      // Release the standby runtime while both roots are journal-locked so the
      // first takeover turn reconstructs the canonical UltraGoal tool catalog.
      await bb.sdk.threads.stop({ threadId: targetThreadId });
      await bb.sdk.threads.wait({
        threadId: targetThreadId,
        status: "idle",
        timeoutMs: 30_000,
        pollIntervalMs: 250,
      });
      transfer = store.setPhase(sourceThreadId, targetThreadId, "target_released");
    }
    if (transfer.phase === "target_released") {
      // Stop even an already-idle source to release any retained provider
      // runtime and disable its old continuation path before final accounting.
      await bb.sdk.threads.stop({ threadId: sourceThreadId });
      await bb.sdk.threads.wait({
        threadId: sourceThreadId,
        status: "idle",
        timeoutMs: 30_000,
        pollIntervalMs: 250,
      });
      await input.finalAccount();
      inspection = store.commit(sourceThreadId, targetThreadId, input.workerExecution());
      transfer = inspection.journal!;
      input.onDatabaseCommitted?.();
    }

    // Single-thread archive releases unarchived direct children to parent=null
    // and suppresses old-root ownership turns. Archive the stopped source
    // before reparenting, then deterministically repair null/source parents.
    if (transfer.phase === "db_committed") {
      const latestSource = await bb.sdk.threads.get({ threadId: sourceThreadId });
      if (!latestSource.archivedAt) await bb.sdk.threads.archive({ threadId: sourceThreadId });
      transfer = store.setPhase(sourceThreadId, targetThreadId, "source_archived");
    }

    if (transfer.phase === "source_archived") {
      inspection = store.inspect(sourceThreadId, targetThreadId);
      for (const child of inspection.directChildren) {
        const thread = await bb.sdk.threads.get({ threadId: child.threadId });
        if (thread.parentThreadId === targetThreadId) continue;
        if (thread.parentThreadId !== sourceThreadId && thread.parentThreadId !== null) {
          throw new Error(`worker ${child.threadId} has unexpected parent ${thread.parentThreadId ?? "none"}`);
        }
        await bb.sdk.threads.update({ threadId: child.threadId, parentThreadId: targetThreadId });
        moved += 1;
      }
      for (const child of inspection.directChildren) {
        const thread = await bb.sdk.threads.get({ threadId: child.threadId });
        if (thread.parentThreadId !== targetThreadId) {
          throw new Error(`worker ${child.threadId} did not reparent to ${targetThreadId}`);
        }
      }
      transfer = store.setPhase(sourceThreadId, targetThreadId, "children_reparented");
    }

    if (transfer.phase === "children_reparented") {
      transfer = store.activateTarget(sourceThreadId, targetThreadId);
    }
    if (transfer.phase === "target_activated" || transfer.phase === "waking") {
      const seen = await input.wakeSeen(targetThreadId, transfer.wakeMarker);
      if (!seen) {
        if (transfer.phase !== "waking") {
          transfer = store.setPhase(sourceThreadId, targetThreadId, "waking");
        }
        await input.wakeTarget(targetThreadId, transfer.wakeMarker);
      }
      transfer = store.setPhase(sourceThreadId, targetThreadId, "complete");
    }
    inspection = store.inspect(sourceThreadId, targetThreadId);
    return {
      ...inspection,
      dryRun: false,
      targetProvider: target.providerId,
      targetModel: targetExecution?.model ?? null,
      childrenAlreadyTargeted: base.childrenAlreadyTargeted,
      childrenMoved: moved,
      sourceArchived: true,
      awakened: transfer.phase === "complete",
    };
  } catch (error) {
    store.setPhase(
      sourceThreadId,
      targetThreadId,
      transfer.phase,
      error instanceof Error ? error.message : String(error),
    );
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}. Transfer is frozen at phase ${transfer.phase}; re-run the same transfer-root command to reconcile deterministically.`,
    );
  }
}
