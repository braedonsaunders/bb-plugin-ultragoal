import type { AgentPermissionMode } from "./goal-settings.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isPromptLikeTitle, shortSliceTitle } from "./titles.js";
import { z } from "zod";
import type { GoalAgent, GoalAgentRole, GoalAgentStatus } from "../contract.js";
import { auditorNameFor, nextHumorousName, slugFromName, workRelatedName } from "./names.js";
import { workerQualityBrief } from "./prompts.js";
import { isReasoningLevel, type ReasoningLevel, type ServiceTier } from "./execution.js";
import { createItemReservationStore } from "./item-reservations.js";
import type { FindingAffirmativeEvidence } from "./finding-brief.js";

const MIN_WAIT_TIMEOUT_MS = 1_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_WAIT_TIMEOUT_MS = 600_000;

const SPAWN_AGENT_DESCRIPTION = `
        Spawns an agent to work on the specified task. If your current task is \`/root/task1\` and you spawn_agent with task_name "task_3" the agent will have canonical task name \`/root/task1/task_3\`.
You are then able to refer to this agent as \`task_3\` or \`/root/task1/task_3\` interchangeably. However an agent \`/root/task2/task_3\` would only be able to communicate with this agent via its canonical name \`/root/task1/task_3\`.
The spawned agent will have the same tools as you and the ability to spawn its own subagents.
This is the default way UltraGoal work gets done. The root thread is the orchestrator; spawn one worker per in-progress slice, several in one turn. Do not implement those slices on the root.
ONE AGENT = ONE SLICE, ALWAYS. Spawn a fresh agent for every slice and let it die when the slice is done. Never send a finished worker a new slice — retired workers refuse follow-ups, and thread reuse is what breaks the live Now view.
Give every worker a short humorous display_name RELATED TO ITS WORK ITEM (a typecheck fixer might be "Captain Typecheck"; a date-bug hunter "The Timezone Reckoning") and pass item_id from ultragoal_state when that item is still open and unassigned. If the item is taken or finished, UltraGoal opens a new Now row from your message. Prefer this over the native Task tool — native Task subagents are tracked in Now automatically but cannot be messaged or verified.
When verification is on, a separate verifier is launched after each worker returns. Do not mark that slice complete until the verifier reports VERIFY_PASS.
It will be able to send you and other running agents messages, and its final answer will be provided to you when it finishes.
The new agent's canonical task name will be provided to it along with the message.

Note that passing \`fork_turns="none"\` will not pass any surrounding context to the spawned subagent, which may cause the agent to lack the context it needs to complete its task, whereas \`fork_turns="all"\` will provide the subagent with all surrounding context.`;

type AgentStatus =
  | "pending_init"
  | "running"
  | "interrupted"
  | "shutdown"
  | "not_found"
  | { completed: string | null }
  | { errored: string };

interface CollabRow {
  thread_id: string;
  root_thread_id: string;
  parent_thread_id: string | null;
  task_name: string;
  created_at: number;
  display_name: string | null;
  item_id: string | null;
  role: GoalAgentRole | null;
  source_thread_id: string | null;
  last_verify_hash: string | null;
  retired_at?: number | null;
  verify_fails?: number | null;
  last_nudge_at?: number | null;
  nudge_count?: number | null;
  report_status?: string | null;
  report_evidence?: string | null;
  report_item_id?: string | null;
}

interface CollabReport {
  status: "done" | "blocked";
  evidence: string;
  findingEvidence: FindingAffirmativeEvidence[];
}

function encodeReport(evidence: string, findingEvidence: readonly FindingAffirmativeEvidence[]): string {
  return JSON.stringify({
    version: 1,
    evidence: evidence.trim(),
    finding_evidence: findingEvidence.map((entry) => ({
      finding_id: entry.findingId,
      proof: entry.proof.trim(),
    })),
  });
}

function decodeReport(row: Pick<CollabRow, "report_status" | "report_evidence">): CollabReport | null {
  if (row.report_status !== "done" && row.report_status !== "blocked") return null;
  const stored = row.report_evidence ?? "";
  try {
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    if (parsed.version !== 1 || typeof parsed.evidence !== "string") throw new Error("legacy");
    const findingEvidence = Array.isArray(parsed.finding_evidence)
      ? parsed.finding_evidence.flatMap((raw) => {
          if (!raw || typeof raw !== "object") return [];
          const entry = raw as Record<string, unknown>;
          if (typeof entry.finding_id !== "string" || typeof entry.proof !== "string") return [];
          return [{ findingId: entry.finding_id, proof: entry.proof }];
        })
      : [];
    return { status: row.report_status, evidence: parsed.evidence, findingEvidence };
  } catch {
    // Pre-v0.17.15 claims remain readable but intentionally carry no
    // structured per-finding proof, so they cannot close linked defects.
    return { status: row.report_status, evidence: stored, findingEvidence: [] };
  }
}

function nicknameOf(taskName: string, fallback?: string | null): string {
  const leaf = taskName.split("/").filter(Boolean).at(-1);
  return fallback?.trim() || leaf || taskName;
}

function mapThreadStatus(status: string | undefined, output?: string | null): {
  status: GoalAgentStatus;
  summary: string | null;
} {
  if (status === "active") return { status: "running", summary: null };
  if (status === "starting" || status === "provisioning") return { status: "starting", summary: null };
  if (status === "stopping") return { status: "stopped", summary: null };
  if (status === "error") return { status: "error", summary: "Turn error" };
  if (status === "idle") {
    const summary = output?.trim() ? output.trim().slice(0, 160) : null;
    return { status: summary ? "completed" : "idle", summary };
  }
  return { status: "unknown", summary: null };
}

export function createCollabStore(
  bb: BbPluginApi,
  hooks?: {
    onChange?: (rootThreadId: string) => void;
    retitleItem?: (rootThreadId: string, itemId: string, message: string) => void;
    claimItem?: (
      rootThreadId: string,
      args: {
        itemId: string | null;
        message: string;
        workerThreadId?: string;
        createIfMissing?: boolean;
        /** "tool": spawn_agent message (first line is the task). "prompt": a
         * discovered thread's spawn prompt (only SLICE markers are trusted). */
        source?: "tool" | "prompt";
      },
    ) => string | null;
    /** Status of a plan item, so retired workers can refuse new slices. */
    itemStatus?: (rootThreadId: string, itemId: string) => string | null;
    /** Goal-level worker execution pin; null fields inherit the root thread. */
    workerExecution?: (rootThreadId: string) => {
      providerId: string | null;
      model: string | null;
      reasoningLevel: ReasoningLevel | null;
      serviceTier: ServiceTier | null;
    };
    /** DAG metadata of a plan item, injected into worker briefs. */
    itemBrief?: (
      rootThreadId: string,
      itemId: string,
    ) => { files: string[]; check: string | null; linkedDefects?: string } | null;
    /**
     * Permission mode for spawned workers. Defaults to "auto" so a worker's
     * risky actions still reach the normal approval gate; an operator raises it
     * deliberately for an unattended run. Verifiers never use this — they are
     * pinned to "auto" because a verifier that can write is not a verifier.
     */
    workerPermissionMode?: () => AgentPermissionMode;
    /** A discovered BB child could not obtain a durable root worker slot. */
    onRejectedChild?: (
      rootThreadId: string,
      childThreadId: string,
      itemId: string | null,
    ) => void;
  },
) {
  const db = bb.storage.database();
  const reservations = createItemReservationStore(db);
  const insert = db.prepare(`
    INSERT INTO collab_agents (
      thread_id, root_thread_id, parent_thread_id, task_name, created_at, display_name, item_id,
      role, source_thread_id, last_verify_hash
    )
    VALUES (
      @thread_id, @root_thread_id, @parent_thread_id, @task_name, @created_at, @display_name, @item_id,
      @role, @source_thread_id, @last_verify_hash
    )
  `);
  const setMeta = db.prepare(`
    UPDATE collab_agents
    SET display_name = COALESCE(@display_name, display_name),
        item_id = COALESCE(@item_id, item_id)
    WHERE thread_id = @thread_id
  `);
  const tombstoneDiscovered = db.prepare(`
    INSERT OR IGNORE INTO collab_agents (
      thread_id, root_thread_id, parent_thread_id, task_name, created_at,
      display_name, item_id, role, source_thread_id, last_verify_hash, retired_at
    ) VALUES (
      @thread_id, @root_thread_id, @parent_thread_id, @task_name, @created_at,
      NULL, NULL, 'worker', NULL, NULL, @retired_at
    )
  `);
  const byThread = db.prepare(
    "SELECT * FROM collab_agents WHERE thread_id = ? AND retired_at IS NULL",
  );
  const byRoot = db.prepare(
    "SELECT * FROM collab_agents WHERE root_thread_id = ? AND retired_at IS NULL",
  );
  const byRootAll = db.prepare("SELECT thread_id FROM collab_agents WHERE root_thread_id = ?");
  const byName = db.prepare(
    "SELECT * FROM collab_agents WHERE root_thread_id = ? AND task_name = ? AND retired_at IS NULL",
  );
  const bySource = db.prepare(
    "SELECT * FROM collab_agents WHERE source_thread_id = ? AND role = 'verifier' AND retired_at IS NULL",
  );
  const reportsByItem = db.prepare(`
    SELECT report_status, report_evidence, role FROM collab_agents
    WHERE root_thread_id = ? AND COALESCE(report_item_id, item_id) = ?
      AND report_status = 'done'
    ORDER BY created_at DESC, thread_id DESC
  `);
  const setHash = db.prepare(
    "UPDATE collab_agents SET last_verify_hash = @last_verify_hash WHERE thread_id = @thread_id",
  );
  const bumpFails = db.prepare(
    "UPDATE collab_agents SET verify_fails = COALESCE(verify_fails, 0) + 1 WHERE thread_id = ?",
  );
  const bumpNudgeStmt = db.prepare(
    "UPDATE collab_agents SET last_nudge_at = @at, nudge_count = COALESCE(nudge_count, 0) + 1 WHERE thread_id = @thread_id",
  );
  const resetNudgeStmt = db.prepare(
    "UPDATE collab_agents SET nudge_count = 0 WHERE thread_id = ? AND COALESCE(nudge_count, 0) > 0",
  );
  const setReportStmt = db.prepare(
    `UPDATE collab_agents
     SET report_status = @status, report_evidence = @evidence,
         report_item_id = COALESCE(report_item_id, item_id)
     WHERE thread_id = @thread_id`,
  );
  // Retire, never delete: a deleted row lets discovery resurrect the dead
  // thread and re-claim its slice.
  const removeRow = db.prepare(
    `UPDATE collab_agents
     SET retired_at = @retired_at,
         report_item_id = CASE
           WHEN report_status IS NOT NULL THEN COALESCE(report_item_id, item_id)
           ELSE report_item_id
         END,
         item_id = NULL
     WHERE thread_id = @thread_id`,
  );

  function itemHasWorker(
    rootThreadId: string,
    itemId: string | null,
    exceptReservation?: string,
  ): boolean {
    if (!itemId) return false;
    return reservations.isHeld(rootThreadId, itemId, exceptReservation);
  }

  function rowOf(threadId: string): CollabRow | null {
    return (byThread.get(threadId) as CollabRow | undefined) ?? null;
  }

  function rootId(threadId: string): string {
    return rowOf(threadId)?.root_thread_id ?? threadId;
  }

  function canonicalName(threadId: string): string {
    return rowOf(threadId)?.task_name ?? "/root";
  }

  function resolve(fromThreadId: string, target: string): CollabRow | null {
    const root = rootId(fromThreadId);
    const exact = byName.get(root, target) as CollabRow | undefined;
    if (exact) return exact;
    const byId = byThread.get(target) as CollabRow | undefined;
    if (byId && byId.root_thread_id === root) return byId;
    const suffix = `/${target.replace(/^\/+/, "")}`;
    const match = (byRoot.all(root) as CollabRow[]).find(
      (row) => row.task_name === target || row.task_name.endsWith(suffix),
    );
    return match ?? null;
  }

  async function statusOf(threadId: string): Promise<AgentStatus> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.status === "active" || thread.status === "starting") return "running";
      if (thread.status === "stopping") return "interrupted";
      if (thread.status === "error") {
        return { errored: "Turn error" };
      }
      if (thread.status === "idle") {
        const output = await bb.sdk.threads.output({ threadId }).catch(() => ({ output: null }));
        return { completed: output.output ?? null };
      }
      return "shutdown";
    } catch {
      return "not_found";
    }
  }

  async function discoverChildren(root: string): Promise<
    Array<{
      id: string;
      title: string | null;
      titleFallback: string | null;
      parentThreadId: string | null;
      createdAt: number;
    }>
  > {
    const found = new Map<
      string,
      {
        id: string;
        title: string | null;
        titleFallback: string | null;
        parentThreadId: string | null;
        createdAt: number;
      }
    >();
    const take = (
      children: Array<{
        id: string;
        title: string | null;
        titleFallback: string | null;
        parentThreadId: string | null;
        createdAt: number;
      }>,
    ) => {
      for (const child of children) {
        if (child.id === root) continue;
        found.set(child.id, child);
      }
    };
    try {
      take(
        await bb.sdk.threads.list({
          parentThreadId: root,
          includeHidden: true,
          limit: 80,
        }),
      );
    } catch {
      // parent filter is best-effort
    }
    try {
      const rootThread = await bb.sdk.threads.get({ threadId: root });
      if (rootThread.projectId) {
        const listed = await bb.sdk.threads.list({
          projectId: rootThread.projectId,
          includeHidden: true,
          hasParent: true,
          limit: 200,
        });
        const tree = new Set<string>([root, ...found.keys()]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const child of listed) {
            if (!child.parentThreadId || tree.has(child.id)) continue;
            if (!tree.has(child.parentThreadId)) continue;
            tree.add(child.id);
            found.set(child.id, child);
            grew = true;
          }
        }
      }
    } catch {
      // Project-wide listing is a fallback for hidden native children.
    }
    return [...found.values()];
  }

  const statusCache = new Map<
    string,
    { status: GoalAgentStatus; summary: string | null; title: string | null; at: number }
  >();

  /** First user message of a thread — the spawn prompt for a child worker. */
  async function spawnPromptOf(threadId: string): Promise<string | null> {
    try {
      const timeline = await bb.sdk.threads.timeline({ threadId });
      for (const raw of timeline.rows as readonly unknown[]) {
        const row = raw as { kind?: string; role?: string; text?: string };
        if (row?.kind !== "conversation" || row.role !== "user") continue;
        const text = row.text?.trim();
        if (text) return text;
      }
    } catch {
      // Best-effort; the child still renders without a slice link.
    }
    return null;
  }

  const claimTried = new Set<string>();

  function displayTitle(title: string | null | undefined): string | null {
    const text = title?.trim();
    if (!text || isPromptLikeTitle(text)) return null;
    return text;
  }

  async function refreshStatus(
    threadId: string,
  ): Promise<{ status: GoalAgentStatus; summary: string | null; title: string | null }> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      const mapped = mapThreadStatus(thread.status, null);
      const next = { ...mapped, title: displayTitle(thread.title), at: Date.now() };
      statusCache.set(threadId, next);
      return next;
    } catch {
      return statusCache.get(threadId) ?? { status: "unknown", summary: null, title: null };
    }
  }

  async function applyWorkTitle(threadId: string, step: string): Promise<void> {
    const title = shortSliceTitle(step);
    if (!title) return;
    try {
      await bb.sdk.threads.update({ threadId, title });
      const cached = statusCache.get(threadId);
      if (cached) statusCache.set(threadId, { ...cached, title, at: Date.now() });
    } catch {
      // Display name on the pane is enough if the host rejects a title write.
    }
  }

  async function listForRoot(
    threadId: string,
    options?: { discover?: boolean; refreshLimit?: number; refreshHolders?: boolean },
  ): Promise<GoalAgent[]> {
    const root = rootId(threadId);
    const rows = byRoot.all(root) as CollabRow[];
    const seen = new Set(
      (byRootAll.all(root) as Array<{ thread_id: string }>).map((row) => row.thread_id),
    );
    const extras: CollabRow[] = [];
    if (options?.discover) {
      try {
        const children = await discoverChildren(root);
        for (const child of children) {
          if (seen.has(child.id)) continue;
          seen.add(child.id);
          const extra: CollabRow = {
            thread_id: child.id,
            root_thread_id: root,
            parent_thread_id: child.parentThreadId ?? root,
            task_name: child.title || child.titleFallback || child.id,
            created_at: child.createdAt ?? 0,
            display_name: null,
            item_id: null,
            role: "worker",
            source_thread_id: null,
            last_verify_hash: null,
          };
          try {
            insert.run({
              thread_id: extra.thread_id,
              root_thread_id: extra.root_thread_id,
              parent_thread_id: extra.parent_thread_id,
              task_name: extra.task_name,
              created_at: extra.created_at,
              display_name: extra.display_name,
              item_id: extra.item_id,
              role: extra.role,
              source_thread_id: extra.source_thread_id,
              last_verify_hash: extra.last_verify_hash,
            });
            extras.push(extra);
          } catch (error) {
            // A concurrent owner may have persisted the same child between
            // the snapshot and insert. Adopt that row instead of stopping it.
            const persisted = byThread.get(child.id) as CollabRow | undefined;
            if (persisted) {
              extras.push(persisted);
              continue;
            }
            // A capacity-rejected legacy spawn has already created a BB
            // process but owns no durable row. Tombstone first so repeated
            // discovery cannot resurrect it, then stop it and release its
            // optimistic item claim.
            const retired = tombstoneDiscovered.run({
              thread_id: extra.thread_id,
              root_thread_id: extra.root_thread_id,
              parent_thread_id: extra.parent_thread_id,
              task_name: extra.task_name,
              created_at: extra.created_at,
              retired_at: Date.now(),
            });
            if (retired.changes === 0) {
              const raced = byThread.get(child.id) as CollabRow | undefined;
              if (raced) extras.push(raced);
              continue;
            }
            const prompt = await spawnPromptOf(child.id);
            const requested = /\bitem_id=([A-Za-z0-9_]+)/.exec(prompt ?? "")?.[1] ?? null;
            try {
              await bb.sdk.threads.stop({ threadId: child.id });
            } catch {
              // The tombstone still prevents scheduler accounting/adoption.
            }
            hooks?.onRejectedChild?.(root, child.id, requested);
            bb.log.warn(
              `Stopped unowned child ${child.id} on ${root}: durable capacity admission failed (${error instanceof Error ? error.message : String(error)})`,
            );
          }
        }
      } catch {
        // Listing children is best-effort; collab rows still render.
      }
    }

    const all = [...rows, ...extras];
    const usedNames = new Set(
      all.map((row) => row.display_name?.trim()).filter((name): name is string => Boolean(name)),
    );
    for (const row of all) {
      if (row.role === "verifier" || row.display_name?.trim()) continue;
      const displayName = workRelatedName(row.task_name, usedNames);
      usedNames.add(displayName);
      row.display_name = displayName;
      setMeta.run({ thread_id: row.thread_id, display_name: displayName, item_id: row.item_id });
    }

    const refreshLimit = options?.refreshLimit ?? 8;
    const refreshIds = new Set(
      [...all]
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, refreshLimit)
        .map((row) => row.thread_id),
    );
    for (const row of all) {
      const cached = statusCache.get(row.thread_id);
      if (cached && (cached.status === "running" || cached.status === "starting")) {
        refreshIds.add(row.thread_id);
      }
      if (options?.refreshHolders && row.item_id) refreshIds.add(row.thread_id);
    }

    const agents: GoalAgent[] = await Promise.all(
      all.map(async (row) => {
        const mapped = refreshIds.has(row.thread_id)
          ? await refreshStatus(row.thread_id)
          : (statusCache.get(row.thread_id) ?? {
              status: "unknown" as const,
              summary: null,
              title: null,
            });
        const nickname = row.display_name?.trim() || nicknameOf(row.task_name, null);
        const title = mapped.title && mapped.title !== nickname ? mapped.title : null;
        return {
          threadId: row.thread_id,
          taskName: row.task_name,
          nickname,
          title,
          itemId: row.item_id,
          role: row.role === "verifier" ? "verifier" as const : "worker" as const,
          status: mapped.status,
          summary: mapped.summary,
        };
      }),
    );

    // Children spawned outside spawn_agent carry their slice in the spawn
    // prompt ("SLICE (item_id=itm_...): ..."). Claim it once so the Now row
    // shows the task, the plan item leaves Next, and idle completion works.
    if (hooks?.claimItem) {
      const byId = new Map(all.map((row) => [row.thread_id, row]));
      const CLAIM_WINDOW_MS = 6 * 60 * 60_000;
      for (const agent of agents) {
        if (agent.role === "verifier" || agent.itemId) continue;
        const recent =
          Date.now() - (byId.get(agent.threadId)?.created_at ?? 0) < CLAIM_WINDOW_MS;
        // Live workers always claim; recent idle ones claim too so their done
        // reports can close the right slice (reconcile picks it up).
        if (agent.status !== "running" && agent.status !== "starting" && !recent) continue;
        if (claimTried.has(agent.threadId)) continue;
        claimTried.add(agent.threadId);
        const prompt = await spawnPromptOf(agent.threadId);
        if (!prompt) continue;
        const requested = /\bitem_id=([A-Za-z0-9_]+)/.exec(prompt)?.[1] ?? null;
        const live = agent.status === "running" || agent.status === "starting";
        const claimed = hooks.claimItem(root, {
          itemId: requested,
          message: prompt,
          workerThreadId: agent.threadId,
          // Idle stragglers may re-link an open slice but never mint new ones.
          createIfMissing: live,
          source: "prompt",
        });
        if (!claimed) continue;
        const row = byId.get(agent.threadId);
        if (row) row.item_id = claimed;
        agent.itemId = claimed;
        setMeta.run({
          thread_id: agent.threadId,
          display_name: row?.display_name ?? null,
          item_id: claimed,
        });
        bb.log.info(`Linked ${agent.nickname} to ${claimed} from its spawn prompt`);
      }
    }

    const rank: Record<GoalAgentStatus, number> = {
      running: 0,
      starting: 1,
      error: 2,
      idle: 3,
      stopped: 4,
      completed: 5,
      unknown: 6,
    };
    return agents.sort((a, b) => rank[a.status] - rank[b.status] || a.nickname.localeCompare(b.nickname));
  }

  // The one spawn path, shared by the spawn_agent tool and the plugin's own
  // recovery staffing.
  async function spawnAgent(args: {
    threadId: string;
    projectId: string | undefined;
    task_name: string;
    display_name?: string;
    item_id?: string;
    role?: "worker" | "verifier";
    message: string;
    fork_turns?: string;
    model?: string;
    /** Fresh spawn in an isolated managed worktree — no conversation fork.
     * The plugin's own staffing uses this: slice briefs are self-contained,
     * and forking a large root session fails at thread.start. */
    fresh?: boolean;
    /** Do not claim or mint a plan item from the message (intake/triage helpers). */
    skipClaim?: boolean;
    /** Scheduler-only contract: the requested durable item must be claimed
     * exactly as supplied. Never fall through to the user-facing behavior
     * that mints a new item when a requested one is already occupied. */
    strictItemClaim?: boolean;
    /** Root-wide durable worker cap for scheduler-only strict spawns. */
    schedulerMaxWorkers?: number;
  }): Promise<
    | { threadId: string; taskName: string; nickname: string; itemId: string | null }
    | { error: string }
  > {
    const {
      threadId,
      task_name,
      display_name,
      item_id,
      role,
      fork_turns,
      model,
      fresh,
      skipClaim,
      strictItemClaim,
      schedulerMaxWorkers,
    } = args;
    const trimmed = args.message.trim();
    if (!trimmed) return { error: "Empty message can't be sent to an agent" };
    const parent = await bb.sdk.threads.get({ threadId });
    const parentPath = canonicalName(threadId);
    const usedNames = (byRoot.all(rootId(threadId)) as CollabRow[])
      .map((row) => row.display_name)
      .filter((name): name is string => Boolean(name));
    const displayName = (display_name?.trim() || workRelatedName(trimmed, usedNames)).slice(0, 64);
    const slug = /^[a-z0-9_]+$/.test(task_name) ? task_name : slugFromName(displayName);
    const taskName = `${parentPath === "/root" ? "/root" : parentPath}/${slug}`;
    const rootThreadId = rootId(threadId);
    // Explicit item_id, exact text match, or a fresh item — never an
    // arbitrary unassigned Next row (that repurposed unrelated slices).
    const requested = item_id?.trim() || null;
    if (
      strictItemClaim &&
      requested &&
      role !== "verifier" &&
      (!Number.isInteger(schedulerMaxWorkers) || (schedulerMaxWorkers ?? 0) <= 0)
    ) {
      return { error: "Scheduler spawn requires a positive root worker limit." };
    }
    const reservationToken =
      strictItemClaim && requested && role !== "verifier"
        ? reservations.acquire(rootThreadId, requested, schedulerMaxWorkers!)
        : null;
    if (strictItemClaim && requested && role !== "verifier" && !reservationToken) {
      return { error: `Scheduler item ${requested} already has a durable worker/reservation or the root worker capacity is full; refusing spawn.` };
    }
    let reservationCommitted = false;
    try {
      const itemId =
        role === "verifier" || skipClaim
          ? requested
          : hooks?.claimItem?.(rootThreadId, {
              itemId: requested,
              message: trimmed,
              workerThreadId: reservationToken ?? undefined,
              createIfMissing: strictItemClaim ? false : undefined,
              source: "tool",
            }) ?? null;
      if (strictItemClaim && requested && itemId !== requested) {
        return {
          error: `Scheduler requested ${requested}, but the claim resolved to ${itemId ?? "no item"}; refusing spawn.`,
        };
      }
      if (
        itemId &&
        itemHasWorker(rootThreadId, itemId, reservationToken ?? undefined) &&
        role !== "verifier"
      ) {
        return {
          error: `Slice ${itemId} already has a worker. Spawn again so UltraGoal can open a new Now row.`,
        };
      }
      if (byName.get(rootId(threadId), taskName)) {
        return { error: `An agent named ${taskName} already exists.` };
      }
      const brief = itemId ? hooks?.itemBrief?.(rootThreadId, itemId) ?? null : null;
    const briefLines: string[] = [];
    if (brief?.files?.length) {
      briefLines.push(
        role === "verifier"
          ? `Verification scope: inspect the work item and these owned files: ${brief.files.join(", ")}.`
          : `Scope: touch only files within: ${brief.files.join(", ")}. If the slice requires edits outside this scope, stop and call slice_blocked with the reason instead of expanding scope.`,
      );
    }
    if (brief?.check) {
      briefLines.push(
        `Done-check: \`${brief.check}\` must pass. Run it yourself and include its result in your final report.`,
      );
    }
    if (brief?.linkedDefects) briefLines.push(brief.linkedDefects);
    const prompt = [
      trimmed,
      ...briefLines,
      `The new agent's canonical task name is ${taskName}.`,
      `Your call sign is ${displayName}.`,
      role === "verifier"
        ? 'You are an UltraGoal verifier. Inspect the worktree and report VERIFY_PASS or VERIFY_FAIL. For every linked defect emit one exact line: DEFECT_COVERAGE: {"finding_id":"fnd_...","status":"pass","proof":"what you checked"}. Prose mentions do not count. Do not implement fixes. Fail work that ships stubs/placeholders/TODO behavior, weakens or skips tests to get green, leaves dead or duplicated code behind, or touches files unrelated to its slice.'
        : "You are an UltraGoal subagent for this assigned slice only. Do the work and report evidence.",
      "Do not call ultragoal_finish, do not manage the parent UltraGoal plan, and do not re-orchestrate the whole objective.",
      role === "verifier" ? "" : workerQualityBrief(),
      role === "verifier"
        ? ""
        : "If your slice is a hunt/audit/review that uncovers discrete defects, call report_finding the moment you confirm each one (one call per defect; do not batch them into your final report) — a fix slice is staffed automatically per finding.",
      role === "verifier"
        ? ""
        : "When fully done, call slice_done with general evidence (commit SHAs and passing check output) plus one finding_evidence {finding_id, proof} record per linked defect, then end your turn. A bare claim or prose ID mention does not close the slice. If blocked, call slice_blocked and end your turn.",
    ]
      .filter(Boolean)
      .join("\n\n");
    const parentHostId = parent.environmentId
      ? await bb.sdk.environments
          .get({ environmentId: parent.environmentId })
          .then((environment) => environment.hostId)
          .catch(() => undefined)
      : undefined;
    // Execution is pinned with explicit provenance: the server drops
    // provider/model fields that carry no executionInputSources and re-derives
    // them from the project's stored defaults — which follow whatever the user
    // last picked in the composer. Order: tool arg, goal pin, root thread.
    const pin = hooks?.workerExecution?.(rootThreadId) ?? {
      providerId: null,
      model: null,
      reasoningLevel: null,
      serviceTier: null,
    };
    const execProviderId = pin.providerId ?? parent.providerId;
    const execModel = model ?? pin.model ?? undefined;
    const execReasoning = isReasoningLevel(pin.reasoningLevel) ? pin.reasoningLevel : undefined;
    const execServiceTier = pin.serviceTier ?? undefined;
    const spawnArgs = {
      projectId: parent.projectId ?? args.projectId,
      parentThreadId: threadId,
      providerId: execProviderId,
      model: execModel,
      reasoningLevel: execReasoning,
      serviceTier: execServiceTier,
      executionInputSources: {
        ...(execProviderId ? { providerId: "explicit" as const } : {}),
        ...(execModel ? { model: "explicit" as const } : {}),
        ...(execReasoning ? { reasoningLevel: "explicit" as const } : {}),
        ...(execServiceTier ? { serviceTier: "explicit" as const } : {}),
      },
      permissionMode: hooks?.workerPermissionMode?.() ?? ("auto" as const),
      // Non-forked workers get their own managed worktree: sharing the root's
      // environment would put concurrent writers in one directory.
      environment: {
        type: "host" as const,
        hostId: parentHostId,
        workspace: {
          type: "managed-worktree" as const,
          baseBranch: { kind: "default" as const },
        },
      },
      prompt,
      title: shortSliceTitle(trimmed) || displayName,
      visibility: "hidden" as const,
      origin: "plugin" as const,
    };
      const child =
      fresh || fork_turns === "none"
        ? await bb.sdk.threads.spawn(spawnArgs)
        : await bb.sdk.threads
            .fork({
              sourceThreadId: threadId,
              input: [{ type: "text", text: prompt, mentions: [] }],
              title: shortSliceTitle(trimmed) || displayName,
              permissionMode: hooks?.workerPermissionMode?.() ?? "auto",
              visibility: "hidden",
              workspace: "reuse",
              // Plugin-origin children skip bb's parent "needs help"
              // notifications; UltraGoal handles its own crew.
              origin: "plugin",
            })
            .catch(() => bb.sdk.threads.spawn(spawnArgs));
      const row = {
        thread_id: child.id,
        root_thread_id: rootId(threadId),
        parent_thread_id: threadId,
        task_name: taskName,
        created_at: Date.now(),
        display_name: displayName,
        item_id: itemId,
        role: role === "verifier" ? "verifier" : "worker",
        source_thread_id: null,
        last_verify_hash: null,
      };
      if (reservationToken && requested) {
        reservationCommitted = reservations.commit(
          rootThreadId,
          requested,
          reservationToken,
          () => {
            insert.run(row);
          },
        );
        if (!reservationCommitted) {
          try {
            await bb.sdk.threads.stop({ threadId: child.id });
          } catch {
            // The unowned child is still excluded from scheduler accounting.
          }
          return {
            error: `Scheduler reservation for ${requested} expired before worker persistence; spawned thread was stopped.`,
          };
        }
      } else {
        insert.run(row);
      }
    if (strictItemClaim && requested) {
      const persisted = rowOf(child.id);
      if (!persisted || persisted.item_id !== requested || itemId !== requested) {
        removeRow.run({ thread_id: child.id, retired_at: Date.now() });
        try {
          await bb.sdk.threads.stop({ threadId: child.id });
        } catch {
          // The durable row is retired even when the host cannot stop a
          // malformed spawn; scheduler accounting will never accept it.
        }
        return {
          error: `Spawned worker ${child.id} did not retain scheduler item ${requested}; worker was retired.`,
        };
      }
    }
    try {
      await applyWorkTitle(child.id, trimmed);
    } catch {
      // Title from spawn/fork is enough if update is unavailable.
    }
    if (itemId) hooks?.retitleItem?.(rootThreadId, itemId, trimmed);
    hooks?.onChange?.(rootThreadId);
      return { threadId: child.id, taskName, nickname: displayName, itemId };
    } finally {
      if (reservationToken && requested && !reservationCommitted) {
        reservations.release(rootThreadId, requested, reservationToken);
      }
    }
  }

  return {
    rootId,
    rowOf,
    itemHasWorker,
    setWorkerCap(rootThreadId: string, maxWorkers: number): boolean {
      return reservations.setCap(rootId(rootThreadId), maxWorkers);
    },
    threadIdsForRoot(rootThreadId: string): string[] {
      return (byRoot.all(rootId(rootThreadId)) as CollabRow[]).map((row) => row.thread_id);
    },
    /** Every thread the root ever ran, retired included. Token accounting needs
     * this: a goal's usage is the sum over every session it ever had, and
     * "one agent = one slice" retires far more of them than it keeps. */
    allThreadIdsForRoot(rootThreadId: string): string[] {
      return (byRootAll.all(rootId(rootThreadId)) as Array<{ thread_id: string }>).map(
        (row) => row.thread_id,
      );
    },
    /** Every non-retired durable row for the root, unfiltered by host status or
     * plan state. Slot cleanup must reconcile against THESE, not against the
     * projected agent list: that projection drops a worker whose item is already
     * completed, which is precisely the set whose rows still occupy capacity and
     * still need retiring. */
    durableRowsForRoot(rootThreadId: string): Array<{
      threadId: string;
      itemId: string | null;
      role: string | null;
      taskName: string;
      reportStatus: string | null;
    }> {
      return (byRoot.all(rootId(rootThreadId)) as CollabRow[]).map((row) => ({
        threadId: row.thread_id,
        itemId: row.item_id ?? null,
        role: row.role ?? null,
        taskName: row.task_name,
        reportStatus: row.report_status ?? null,
      }));
    },
    listRoots(): string[] {
      return (
        db.prepare("SELECT DISTINCT root_thread_id FROM collab_agents").all() as Array<{
          root_thread_id: string;
        }>
      ).map((row) => row.root_thread_id);
    },
    workersOnItem(rootThreadId: string, itemId: string): string[] {
      return (byRoot.all(rootId(rootThreadId)) as CollabRow[])
        .filter((row) => row.role !== "verifier" && row.item_id === itemId)
        .map((row) => row.thread_id);
    },
    claimantsOnItem(rootThreadId: string, itemId: string): string[] {
      return [
        ...(byRoot.all(rootId(rootThreadId)) as CollabRow[])
          .filter((row) => row.role !== "verifier" && row.item_id === itemId)
          .map((row) => row.thread_id),
        ...reservations.claimants(rootId(rootThreadId), itemId),
      ];
    },
    listForRoot,
    setMeta(threadId: string, patch: { displayName?: string | null; itemId?: string | null }) {
      setMeta.run({
        thread_id: threadId,
        display_name: patch.displayName ?? null,
        item_id: patch.itemId ?? null,
      });
    },
    setWorkTitleForItem(rootThreadId: string, itemId: string, step: string) {
      const title = shortSliceTitle(step);
      if (!title) return;
      const rows = (byRoot.all(rootId(rootThreadId)) as CollabRow[]).filter(
        (row) => row.item_id === itemId && row.role !== "verifier",
      );
      for (const row of rows) void applyWorkTitle(row.thread_id, step);
    },

    forget(threadId: string) {
      removeRow.run({ thread_id: threadId, retired_at: Date.now() });
    },

    setVerifyHash(threadId: string, hash: string | null) {
      setHash.run({ thread_id: threadId, last_verify_hash: hash });
    },

    /** A worker seen actually running has proven it can resume: its nudges
     * count wedged-ness, not work style, so progress clears the strike count.
     * Without this, a worker that legitimately works in short turns collects
     * three nudges and gets wrongly retired. */
    resetNudges(threadId: string): void {
      resetNudgeStmt.run(threadId);
    },

    /** Durable slice report from the slice_done / slice_blocked tools. */
    setReport(
      threadId: string,
      status: "done" | "blocked",
      evidence: string,
      findingEvidence: readonly FindingAffirmativeEvidence[] = [],
    ): boolean {
      const row = byThread.get(threadId) as CollabRow | undefined;
      if (!row) return false;
      setReportStmt.run({
        thread_id: threadId,
        status,
        evidence: encodeReport(evidence, findingEvidence),
      });
      return true;
    },

    reportOf(threadId: string): CollabReport | null {
      const row = byThread.get(threadId) as CollabRow | undefined;
      return row ? decodeReport(row) : null;
    },

    findingEvidenceForItem(
      rootThreadId: string,
      itemId: string,
      options?: { verifierOnly?: boolean },
    ): FindingAffirmativeEvidence[] {
      for (const row of reportsByItem.all(rootId(rootThreadId), itemId) as CollabRow[]) {
        if (options?.verifierOnly && row.role !== "verifier") continue;
        const report = decodeReport(row);
        if (report?.findingEvidence.length) return report.findingEvidence;
      }
      return [];
    },

    /** Records a stall nudge; returns the new total. */
    bumpNudge(threadId: string): number {
      bumpNudgeStmt.run({ thread_id: threadId, at: Date.now() });
      return (byThread.get(threadId) as CollabRow | undefined)?.nudge_count ?? 1;
    },

    /** Records one failed verification for a worker; returns the new total. */
    bumpVerifyFails(threadId: string): number {
      bumpFails.run(threadId);
      return (byThread.get(threadId) as CollabRow | undefined)?.verify_fails ?? 1;
    },

    verifiersFor(sourceThreadId: string): CollabRow[] {
      return bySource.all(sourceThreadId) as CollabRow[];
    },

    async spawnVerifier(args: {
      rootThreadId: string;
      sourceThreadId: string;
      itemId: string | null;
      providerId: string;
      model: string;
      reasoningLevel?: ReasoningLevel;
      serviceTier?: ServiceTier | null;
      prompt: string;
      /** The slice text under audit, for a work-related auditor name. */
      workText?: string;
    }): Promise<{ threadId: string; nickname: string } | null> {
      const root = await bb.sdk.threads.get({ threadId: args.rootThreadId });
      if (!root.projectId) {
        throw new Error("UltraGoal root thread has no project; cannot spawn a verifier");
      }
      // The verifier inspects the worker's worktree — its edits may not exist
      // anywhere else yet.
      const source = await bb.sdk.threads
        .get({ threadId: args.sourceThreadId })
        .catch(() => null);
      const verifyEnvironmentId = source?.environmentId ?? root.environmentId;
      const usedNames = (byRoot.all(args.rootThreadId) as CollabRow[])
        .map((row) => row.display_name)
        .filter((name): name is string => Boolean(name));
      const displayName = auditorNameFor(args.workText ?? "", usedNames);
      const slug = slugFromName(displayName);
      const taskName = `/root/${slug}`;
      const child = await bb.sdk.threads.spawn({
        projectId: root.projectId,
        parentThreadId: args.rootThreadId,
        providerId: args.providerId,
        model: args.model,
        reasoningLevel: args.reasoningLevel,
        serviceTier: args.serviceTier ?? undefined,
        executionInputSources: {
          providerId: "explicit" as const,
          model: "explicit" as const,
          ...(args.reasoningLevel ? { reasoningLevel: "explicit" as const } : {}),
          ...(args.serviceTier ? { serviceTier: "explicit" as const } : {}),
        },
        // A verifier inspects a worktree and reports. It never needs to write,
        // so it is pinned to the ordinary approval gate and is deliberately not
        // configurable: a verifier that can edit the work it is judging can
        // make its own verdict come true.
        permissionMode: "auto",
        environment: verifyEnvironmentId
          ? { type: "reuse" as const, environmentId: verifyEnvironmentId }
          : { type: "project-default" as const },
        prompt: [
          args.prompt,
          `The new agent's canonical task name is ${taskName}.`,
          `Your call sign is ${displayName}.`,
          "You are an UltraGoal verifier. Inspect the worktree. Do not implement fixes.",
          "Do not call ultragoal_finish or ultragoal_patch.",
        ].join("\n\n"),
        title: displayName,
        visibility: "hidden" as const,
        origin: "plugin",
      });
      insert.run({
        thread_id: child.id,
        root_thread_id: args.rootThreadId,
        parent_thread_id: args.rootThreadId,
        task_name: taskName,
        created_at: Date.now(),
        display_name: displayName,
        item_id: args.itemId,
        role: "verifier",
        source_thread_id: args.sourceThreadId,
        last_verify_hash: null,
      });
      try {
        await bb.sdk.threads.update({ threadId: child.id, title: displayName });
      } catch {
        // Title from spawn is enough if update is unavailable.
      }
      hooks?.onChange?.(args.rootThreadId);
      return { threadId: child.id, nickname: displayName };
    },

    // Programmatic spawn with the exact same machinery as the spawn_agent
    // tool, for the plugin's own recovery staffing (rescuing a slice whose
    // worker died while the root turn is blocked and cannot re-staff it).
    async spawnWorker(args: {
      parentThreadId: string;
      itemId: string | null;
      displayName?: string;
      message: string;
      skipClaim?: boolean;
      maxWorkers: number;
    }): Promise<
      | { threadId: string; taskName: string; nickname: string; itemId: string | null }
      | { error: string }
    > {
      const result = await spawnAgent({
        threadId: args.parentThreadId,
        projectId: undefined,
        task_name: `${slugFromName(args.displayName ?? "worker")}_${Date.now().toString(36)}`,
        display_name: args.displayName,
        item_id: args.itemId ?? undefined,
        role: "worker",
        message: args.message,
        fresh: true,
        skipClaim: args.skipClaim,
        strictItemClaim: Boolean(args.itemId) && !args.skipClaim,
        schedulerMaxWorkers: args.maxWorkers,
      });
      return result;
    },

    registerTools() {
      bb.agents.registerTool({
        name: "spawn_agent",
        description: SPAWN_AGENT_DESCRIPTION,
        parameters: z.object({
          task_name: z
            .string()
            .min(1)
            .describe(
              "Stable id slug: lowercase letters, digits, and underscores. The humorous display name goes in display_name.",
            ),
          display_name: z
            .string()
            .optional()
            .describe(
              "Short humorous name shown in the UltraGoal pane and sidebar, punning on the slice's actual work (e.g. 'Captain Typecheck' for a typecheck fix). The orchestrator should always set this.",
            ),
          item_id: z
            .string()
            .optional()
            .describe("UltraGoal work item id from ultragoal_state. Nests this worker under that Now task."),
          role: z
            .enum(["worker", "verifier"])
            .optional()
            .describe("worker implements a slice. verifier audits a finished worker. Omit for a worker."),
          message: z.string().min(1).describe("Initial plain-text task for the new agent."),
          agent_type: z
            .string()
            .optional()
            .describe("Agent type override for the new agent. Omit unless explicitly asked."),
          fork_turns: z
            .string()
            .optional()
            .describe(
              "Optional number of turns to fork. Defaults to `all`. Use `none`, `all`, or a positive integer string such as `3` to fork only the most recent turns.",
            ),
          model: z.string().optional().describe("Model override for the new agent. Omit unless an explicit override is needed."),
          reasoning_effort: z
            .string()
            .optional()
            .describe("Reasoning effort override for the new agent. Omit to inherit the parent effort."),
        }),
        async execute(
          { task_name, display_name, item_id, role, message, fork_turns, model },
          { threadId, projectId },
        ) {
          const result = await spawnAgent({
            threadId,
            projectId,
            task_name,
            display_name,
            item_id,
            role,
            message,
            fork_turns,
            model,
          });
          if ("error" in result) {
            return { content: [{ type: "text", text: result.error }], isError: true };
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  task_name: result.taskName,
                  nickname: result.nickname,
                  item_id: result.itemId,
                }),
              },
            ],
          };
        },
      });

      bb.agents.registerTool({
        name: "send_message",
        description:
          "Send a message to an existing agent. The message will be delivered promptly. Does not trigger a new turn.",
        parameters: z.object({
          target: z
            .string()
            .min(1)
            .describe("Relative or canonical task name to message (from spawn_agent)."),
          message: z.string().min(1).describe("Message text to queue on the target agent."),
        }),
        async execute({ target, message }, { threadId }) {
          const trimmed = message.trim();
          if (!trimmed) {
            return { content: [{ type: "text", text: "Empty message can't be sent to an agent" }], isError: true };
          }
          const agent = resolve(threadId, target);
          if (!agent) {
            return { content: [{ type: "text", text: `Agent not found: ${target}` }], isError: true };
          }
          await bb.sdk.threads.queuedMessages.create({
            threadId: agent.thread_id,
            permissionMode: hooks?.workerPermissionMode?.() ?? "auto",
            input: [{ type: "text", text: trimmed, mentions: [] }],
          });
          return "";
        },
      });

      bb.agents.registerTool({
        name: "followup_task",
        description:
          "Steer an existing agent about the ONE slice it was spawned for (clarify, unblock, course-correct). One agent = one slice: a worker whose slice is finished is retired and cannot take new work — spawn a fresh agent with spawn_agent instead.",
        parameters: z.object({
          target: z
            .string()
            .min(1)
            .describe("Agent id or canonical task name to send a follow-up task to (from spawn_agent)."),
          message: z.string().min(1).describe("Message text to send to the target agent."),
        }),
        async execute({ target, message }, { threadId }) {
          const trimmed = message.trim();
          if (!trimmed) {
            return { content: [{ type: "text", text: "Empty message can't be sent to an agent" }], isError: true };
          }
          if (target === "/root" || target === rootId(threadId)) {
            return {
              content: [{ type: "text", text: "Follow-up tasks can't target the root agent" }],
              isError: true,
            };
          }
          const agent = resolve(threadId, target);
          if (!agent) {
            return { content: [{ type: "text", text: `Agent not found: ${target}` }], isError: true };
          }
          const rootThreadId = rootId(threadId);
          // One thread = one slice. A worker whose slice is done is retired;
          // reusing it is what desynchronized Now from reality.
          if (agent.item_id) {
            const status = hooks?.itemStatus?.(rootThreadId, agent.item_id);
            if (status === "completed") {
              return {
                content: [
                  {
                    type: "text",
                    text: `${agent.task_name} is retired: its slice is completed. One agent = one slice. Spawn a fresh agent with spawn_agent for new work.`,
                  },
                ],
                isError: true,
              };
            }
          }
          await bb.sdk.threads.send({
            threadId: agent.thread_id,
            mode: "auto",
            permissionMode: hooks?.workerPermissionMode?.() ?? "auto",
            input: [{ type: "text", text: trimmed, mentions: [] }],
          });
          hooks?.onChange?.(rootThreadId);
          return "";
        },
      });

      bb.agents.registerTool({
        name: "list_agents",
        description: "List live agents in the current root thread tree. Optionally filter by task-path prefix.",
        parameters: z.object({
          path_prefix: z
            .string()
            .optional()
            .describe("Task-path prefix filter without a trailing slash. Omit to list all live agents."),
        }),
        async execute({ path_prefix }, { threadId }) {
          const root = rootId(threadId);
          const prefix = path_prefix?.replace(/\/$/, "");
          const rows = (byRoot.all(root) as CollabRow[]).filter((row) =>
            prefix ? row.task_name === prefix || row.task_name.startsWith(`${prefix}/`) : true,
          );
          const agents = await Promise.all(
            rows.map(async (row) => ({
              agent_name: row.task_name,
              agent_status: await statusOf(row.thread_id),
            })),
          );
          return { content: [{ type: "text", text: JSON.stringify({ agents }) }] };
        },
      });

      bb.agents.registerTool({
        name: "wait_agent",
        description:
          "Wait for a mailbox update from any live agent, including queued messages and final-status notifications. The wait also ends early when new user input is steered into the active turn. Does not return the content; returns either a summary of which agents have updates (if any), an interruption summary for steered input, or a timeout summary if no activity arrives before the deadline.",
        parameters: z.object({
          timeout_ms: z
            .number()
            .optional()
            .describe(
              `Timeout in milliseconds. Defaults to ${DEFAULT_WAIT_TIMEOUT_MS}, min ${MIN_WAIT_TIMEOUT_MS}, max ${MAX_WAIT_TIMEOUT_MS}.`,
            ),
        }),
        async execute({ timeout_ms }, { threadId, signal }) {
          if (timeout_ms != null && timeout_ms > MAX_WAIT_TIMEOUT_MS) {
            return {
              content: [{ type: "text", text: `timeout_ms must be at most ${MAX_WAIT_TIMEOUT_MS}` }],
              isError: true,
            };
          }
          const timeout = Math.max(MIN_WAIT_TIMEOUT_MS, timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS);
          const rows = byRoot.all(rootId(threadId)) as CollabRow[];
          if (rows.length === 0) {
            return { content: [{ type: "text", text: "No live agents." }] };
          }
          const deadline = Date.now() + timeout;
          const updated: string[] = [];
          await Promise.all(
            rows.map(async (row) => {
              const remaining = Math.max(1, deadline - Date.now());
              try {
                await bb.sdk.threads.wait({
                  threadId: row.thread_id,
                  status: "idle",
                  timeoutMs: remaining,
                  signal,
                });
                updated.push(row.task_name);
              } catch {
                // Timed out or interrupted for this agent.
              }
            }),
          );
          if (updated.length === 0) {
            return {
              content: [{ type: "text", text: "Timed out before any mailbox update." }],
            };
          }
          return {
            content: [{ type: "text", text: `Updates from ${updated.join(", ")}.` }],
          };
        },
      });

      bb.agents.registerTool({
        name: "interrupt_agent",
        description:
          "Interrupt an agent's current turn, if any, and return its previous status. The agent remains available for messages and follow-up tasks.",
        parameters: z.object({
          target: z
            .string()
            .min(1)
            .describe("Agent id or canonical task name to interrupt (from spawn_agent)."),
        }),
        async execute({ target }, { threadId }) {
          const agent = resolve(threadId, target);
          if (!agent) {
            return { content: [{ type: "text", text: `Agent not found: ${target}` }], isError: true };
          }
          const previous_status = await statusOf(agent.thread_id);
          await bb.sdk.threads.stop({ threadId: agent.thread_id });
          return { content: [{ type: "text", text: JSON.stringify({ previous_status }) }] };
        },
      });
    },
  };
}

export const COLLAB_TOOL_NAMES = [
  "spawn_agent",
  "send_message",
  "followup_task",
  "list_agents",
  "wait_agent",
  "interrupt_agent",
] as const;
