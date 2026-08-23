import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rpcContract, type GoalAgent, type GoalItem, type GoalSnapshot, type GoalStatus } from "./contract.js";
import {
  accountGoalProgress,
  readThreadTokens,
  sessionIdForThread,
  threadIsRunning,
} from "./lib/accounting.js";
import {
  getOpenCodeTaskCalls,
  listOpenCodeChildren,
  sessionIsLive,
  type NativeChildSession,
  type NativeTaskCall,
} from "./lib/provider-children.js";
import { usesNativeGoal } from "./lib/continue.js";
import {
  budgetLimitPrompt,
  continuationPrompt,
  isBudgetExhausted,
  progressPrompt,
  objectiveUpdatedPrompt,
} from "./lib/prompts.js";
import { lastUserText, parseSlashGoal } from "./lib/slash.js";
import { formatGoalCard, goalToolResponse, isUnfinished } from "./lib/status.js";
import { COLLAB_TOOL_NAMES, createCollabStore } from "./lib/collab.js";
import { createDecisionStore } from "./lib/decisions.js";
import { createFindingStore } from "./lib/findings.js";
import { workRelatedName } from "./lib/names.js";
import { createItemStore, type ItemStore } from "./lib/items.js";
import {
  forgetNativeScan,
  hasPendingNativeTasks,
  listLiveNativeTasks,
  type LiveNativeTask,
} from "./lib/native-sync.js";
import { currentSliceTitle, shortSliceTitle } from "./lib/titles.js";
import { projectPane } from "./lib/projection.js";

const SLICE_PREAMBLE =
  /^(you are|parent goal|parent objective|complete only|the new agent's|do not|constraints\b|local main|skip |when done|report |end with|if |head is)/i;

// Titles come from structure, never from guessing at prose. Two structured
// sources exist and each gets its own extractor:
//   - a spawn_agent message, whose first line IS the task by tool contract;
//   - an explicit "SLICE:" / "SLICE (item_id=...):" marker line in a prompt.
// Guessing "the first informative line" is what turned context like
// "HEAD is 38b9e4ed" into Now row titles.

function titleFromFirstLine(message: string): string {
  const line = message.trim().split(/\n/)[0]?.replace(/^#+\s*/, "").trim() ?? "";
  const cleaned = line.replace(/^(?:assigned\s+)?slice\s*(?:\([^)]*\))?\s*:\s*/i, "");
  if (/^[-*•]\s/.test(cleaned)) return "";
  const title = currentSliceTitle(cleaned);
  if (title.length < 8 || title.length > 180) return "";
  if (SLICE_PREAMBLE.test(title)) return "";
  return title;
}

function titleFromSliceMarker(message: string): string {
  for (const raw of message.trim().split(/\n/).slice(0, 16)) {
    const match = /^(?:#+\s*)?(?:assigned\s+)?slice\s*(?:\([^)]*\))?\s*:\s*(.+)$/i.exec(raw.trim());
    if (!match) continue;
    const title = currentSliceTitle(match[1]!.trim());
    if (title.length >= 8 && title.length <= 180 && !SLICE_PREAMBLE.test(title)) return title;
  }
  return "";
}

// Machine-readable worker completion, injected into every spawned worker's
// prompt. Prose regex remains only as a fallback for workers that predate the
// contract or were spawned natively without it.
function structuredReport(text: string | null | undefined): "done" | "blocked" | null {
  const tail = (text ?? "").slice(-2000);
  if (/\bULTRAGOAL_BLOCKED\b/.test(tail)) return "blocked";
  if (/\bULTRAGOAL_DONE\b/.test(tail)) return "done";
  return null;
}
import {
  createGoalStore,
  validateObjective,
  type StoredGoal,
} from "./lib/store.js";
import {
  DEFAULT_MAX_WORKERS,
  DEFAULT_PROGRESS_UPDATE_MINUTES,
  DEFAULT_VERIFY_MODEL,
  DEFAULT_VERIFY_PROVIDER,
  resolveGoalSettings,
  type GoalSettingDefaults,
} from "./lib/goal-settings.js";
import { createHash } from "node:crypto";

export { rpcContract };
export type { GoalSnapshot } from "./contract.js";

const STALE_CONTINUE_MS = 2_000;

function parsePositiveInt(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeInt(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function snapshotOf(
  goal: StoredGoal,
  items: ItemStore,
  agentRunning: boolean,
  agents: GoalAgent[],
  rootRunning: boolean,
  findings: { open: number; fixed: number; dismissed: number },
  decisions: GoalSnapshot["decisions"],
): GoalSnapshot {
  const itemList = items.list(goal.threadId);
  const pane = projectPane(goal.threadId, itemList, agents, rootRunning);
  return {
    threadId: goal.threadId,
    objective: goal.objective,
    status: goal.status,
    reason: goal.reason,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    startedAt: goal.startedAt,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    lastContinueAt: goal.lastContinueAt,
    lastProgressAt: goal.lastProgressAt,
    lastAccountedAt: goal.lastAccountedAt,
    agentRunning,
    items: itemList,
    agents,
    now: pane.now,
    next: pane.next,
    settings: resolveGoalSettings(
      {
        verifyEnabled: goal.verifyEnabledOverride,
        verifyProvider: goal.verifyProviderOverride,
        verifyModel: goal.verifyModelOverride,
        autoContinue: goal.autoContinueOverride,
        progressUpdateMinutes: goal.progressUpdateMinutesOverride,
        maxWorkers: goal.maxWorkersOverride,
        workerProvider: goal.workerProviderOverride,
        workerModel: goal.workerModelOverride,
      },
      snapshotDefaults,
    ),
    findings,
    decisions,
  };
}

function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

let snapshotDefaults: GoalSettingDefaults = {
  verifyByDefault: true,
  verifyProvider: DEFAULT_VERIFY_PROVIDER,
  verifyModel: DEFAULT_VERIFY_MODEL,
  autoContinue: true,
  progressUpdateMinutes: DEFAULT_PROGRESS_UPDATE_MINUTES,
  maxWorkers: DEFAULT_MAX_WORKERS,
};

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    autoContinue: {
      type: "boolean",
      label: "Auto-continue when an UltraGoal is active",
      default: true,
    },
    maxGoalTokenBudget: {
      type: "string",
      label: "Maximum UltraGoal token budget (empty = unbounded)",
      default: "",
    },
    verifyByDefault: {
      type: "boolean",
      label: "Verify worker output by default",
      description: "After a subagent returns, launch a second model to check the work.",
      default: true,
    },
    verifyProvider: {
      type: "string",
      label: "Default verifier provider",
      default: DEFAULT_VERIFY_PROVIDER,
    },
    verifyModel: {
      type: "string",
      label: "Default verifier model",
      description: "Codex GPT-5.6-Sol unless an UltraGoal overrides it in the right-pane Settings.",
      default: DEFAULT_VERIFY_MODEL,
    },
    progressUpdateMinutes: {
      type: "string",
      label: "Progress update interval (minutes, 0 = off)",
      description: "Ask the orchestrator to post a visible main-thread update if none landed in this window. Default 5.",
      default: String(DEFAULT_PROGRESS_UPDATE_MINUTES),
    },
    maxWorkers: {
      type: "string",
      label: "Max concurrent workers per goal (0 = scheduler off)",
      description: "Ready-queue slot count: the scheduler keeps up to this many workers staffed on ready slices. Default 5.",
      default: String(DEFAULT_MAX_WORKERS),
    },
  });

  async function refreshDefaults() {
    const value = await settings.get();
    snapshotDefaults = {
      verifyByDefault: value.verifyByDefault,
      verifyProvider: value.verifyProvider.trim() || DEFAULT_VERIFY_PROVIDER,
      verifyModel: value.verifyModel.trim() || DEFAULT_VERIFY_MODEL,
      autoContinue: value.autoContinue,
      progressUpdateMinutes:
        parseNonNegativeInt(value.progressUpdateMinutes) ?? DEFAULT_PROGRESS_UPDATE_MINUTES,
      maxWorkers: parseNonNegativeInt(value.maxWorkers) ?? DEFAULT_MAX_WORKERS,
    };
  }
  void refreshDefaults();
  settings.onChange(() => {
    void refreshDefaults();
  });

  const store = createGoalStore(bb);
  const items = createItemStore(bb);
  const findings = createFindingStore(bb);
  const decisions = createDecisionStore(bb);
  const agentCache = new Map<string, GoalAgent[]>();
  /** Open native task calls per root, from the last fresh scan. */
  const liveTaskCounts = new Map<string, number>();
  const inflight = new Set<string>();
  const running = new Map<string, boolean>();
  let publishFresh: (threadId: string) => Promise<void> = async () => {};
  let workersOnItem = (_rootThreadId: string, _itemId: string): string[] => [];
  const collab = createCollabStore(bb, {
    onChange: (rootThreadId) => {
      void publishFresh(rootThreadId);
    },
    retitleItem(rootThreadId, itemId, message) {
      const title = titleFromFirstLine(message);
      if (!title) return;
      items.updateStep(rootThreadId, itemId, title);
      items.setStatus(rootThreadId, itemId, "in_progress");
      collab.setWorkTitleForItem(rootThreadId, itemId, title);
    },
    claimItem(rootThreadId, { itemId, message, workerThreadId, createIfMissing, source }) {
      // An explicit item reference is the strongest claim: the item's own step
      // text is authoritative and is never rewritten from the message.
      const preferred = itemId
        ? items.list(rootThreadId).find((item) => item.id === itemId)
        : undefined;
      if (preferred && preferred.status !== "completed") {
        const occupants = workersOnItem(rootThreadId, preferred.id);
        const free =
          occupants.length === 0 ||
          (Boolean(workerThreadId) && occupants.every((id) => id === workerThreadId));
        if (free) {
          items.setStatus(rootThreadId, preferred.id, "in_progress");
          collab.setWorkTitleForItem(rootThreadId, preferred.id, preferred.step);
          return preferred.id;
        }
      }
      // Otherwise the message must yield a title through structure: the first
      // line of a spawn_agent call, or an explicit SLICE marker in a prompt.
      const title =
        source === "prompt" ? titleFromSliceMarker(message) : titleFromFirstLine(message);
      if (!title) return null;
      // Match an existing open slice by text before minting a duplicate. A
      // tool-source claim requires the slice to be truly unheld; a discovered
      // worker's prompt-source claim re-links a slice whose previous workers
      // are all dead — orchestrators respawn died natives under the same
      // title, and minting a twin item put two live workers on the same work.
      const normalized = title.toLowerCase().replace(/\s+/g, " ").trim();
      const liveHolders = new Set(
        (agentCache.get(rootThreadId) ?? [])
          .filter(
            (agent) =>
              agent.role !== "verifier" &&
              (agent.status === "running" || agent.status === "starting") &&
              agent.threadId !== workerThreadId,
          )
          .map((agent) => agent.itemId)
          .filter(Boolean),
      );
      const match = items
        .list(rootThreadId)
        .find(
          (item) =>
            item.status !== "completed" &&
            item.step.toLowerCase().replace(/\s+/g, " ").trim() === normalized &&
            (source === "prompt"
              ? !liveHolders.has(item.id)
              : workersOnItem(rootThreadId, item.id).length === 0),
        );
      if (match) {
        items.setStatus(rootThreadId, match.id, "in_progress");
        collab.setWorkTitleForItem(rootThreadId, match.id, match.step);
        return match.id;
      }
      if (createIfMissing === false) return null;
      const created = items.add(rootThreadId, title, "in_progress");
      if (created) collab.setWorkTitleForItem(rootThreadId, created.id, title);
      return created?.id ?? null;
    },
    itemStatus(rootThreadId, itemId) {
      return items.list(rootThreadId).find((item) => item.id === itemId)?.status ?? null;
    },
    workerExecution(rootThreadId) {
      const goal = store.get(rootThreadId);
      if (!goal) return { providerId: null, model: null };
      const resolved = view(goal).settings;
      return {
        providerId: resolved.workerProvider || null,
        model: resolved.workerModel || null,
      };
    },
    itemBrief(rootThreadId, itemId) {
      const item = items.list(rootThreadId).find((entry) => entry.id === itemId);
      if (!item) return null;
      return { files: item.files, check: item.check };
    },
  });
  workersOnItem = (rootThreadId, itemId) => collab.workersOnItem(rootThreadId, itemId);

  function publish(threadId: string, goal: GoalSnapshot | null): void {
    bb.realtime.publish("ultragoal", { threadId, goal });
  }

  function account(
    threadId: string,
    options?: { evenIfIdle?: boolean; busy?: boolean; scan?: boolean },
  ) {
    return accountGoalProgress(bb, store, threadId, {
      ...options,
      extraThreadIds: collab.threadIdsForRoot(threadId),
    });
  }

  const paneRefresh = new Set<string>();
  function refreshPane(threadId: string): void {
    if (paneRefresh.has(threadId)) return;
    paneRefresh.add(threadId);
    void (async () => {
      try {
        await refreshRunning(threadId);
        const goal = store.get(threadId);
        if (!goal) return;
        await ensureCrew(threadId);
        const latest = store.get(threadId);
        if (latest) publish(threadId, await viewFresh(latest));
      } catch (error) {
        bb.log.warn(
          `UltraGoal pane refresh failed on ${threadId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        paneRefresh.delete(threadId);
      }
    })();
  }

  function crewIsLive(threadId: string, agents: readonly GoalAgent[]): boolean {
    const open = new Set(
      items.list(threadId).filter((item) => item.status !== "completed").map((item) => item.id),
    );
    return agents.some((agent) => {
      if (agent.status === "running" || agent.status === "starting") return true;
      if (agent.role === "verifier") return false;
      if (agent.status === "error" || agent.status === "stopped" || agent.status === "completed") {
        return false;
      }
      return Boolean(agent.itemId && open.has(agent.itemId));
    });
  }

  function goalIsBusy(threadId: string, agents = agentCache.get(threadId) ?? []): boolean {
    return running.get(threadId) === true || crewIsLive(threadId, agents);
  }

  function withWorkTitles(threadId: string, agents: GoalAgent[]): GoalAgent[] {
    const byId = new Map(items.list(threadId).map((item) => [item.id, item]));
    return agents.map((agent) => {
      const item = agent.itemId ? byId.get(agent.itemId) : undefined;
      const work = item ? shortSliceTitle(item.step) : "";
      const title =
        agent.title && agent.title !== agent.nickname ? agent.title : work || agent.title || agent.nickname;
      return { ...agent, title };
    });
  }

  function view(goal: StoredGoal): GoalSnapshot {
    const agents = withWorkTitles(goal.threadId, agentCache.get(goal.threadId) ?? []);
    // "Orchestrator is working this slice itself" only holds when the root
    // turn runs free. While native task calls are open the root is blocked
    // awaiting subagents, not hand-working other in-progress slices.
    const rootWorkingInline =
      running.get(goal.threadId) === true && (liveTaskCounts.get(goal.threadId) ?? 0) === 0;
    return snapshotOf(
      goal,
      items,
      goalIsBusy(goal.threadId, agents),
      agents,
      rootWorkingInline,
      findings.counts(goal.threadId),
      decisions.list(goal.threadId, "open"),
    );
  }

  function isRootNativeAgent(rootThreadId: string, agent: GoalAgent): boolean {
    return agent.threadId === rootThreadId && agent.taskName.startsWith("task/");
  }

  // Agents keep only the item links they actually claimed (spawn, follow-up,
  // claimItem). Never invent an assignment to fill a row: a Now row without a
  // real worker must say so instead of pointing at an unrelated thread.
  function assignLiveAgents(threadId: string, agents: GoalAgent[]): GoalAgent[] {
    const open = new Map(
      items.list(threadId).filter((item) => item.status !== "completed").map((item) => [item.id, item]),
    );
    const next = agents.map((agent) => ({ ...agent }));
    const live = (agent: GoalAgent) =>
      agent.status === "running" || agent.status === "starting";
    for (const agent of next) {
      if (agent.role === "verifier" || isRootNativeAgent(threadId, agent)) continue;
      if (!agent.itemId) continue;
      const item = open.get(agent.itemId);
      if (!item) continue;
      if (item.status === "pending" && live(agent)) {
        items.setStatus(threadId, item.id, "in_progress");
      }
    }
    return oneWorkerPerItem(threadId, next);
  }

  function oneWorkerPerItem(threadId: string, agents: GoalAgent[]): GoalAgent[] {
    const open = new Set(
      items.list(threadId).filter((item) => item.status !== "completed").map((item) => item.id),
    );
    const rank = (agent: GoalAgent) => {
      if (agent.status === "running") return 0;
      if (agent.status === "starting") return 1;
      if (agent.status === "idle") return 2;
      if (agent.status === "completed") return 3;
      return 4;
    };
    const live: GoalAgent[] = [];
    const picked = new Map<string, GoalAgent>();
    const extra: GoalAgent[] = [];
    for (const agent of agents) {
      if (agent.role === "verifier") {
        if (agent.status === "running" || agent.status === "starting") extra.push(agent);
        continue;
      }
      if (agent.status === "running" || agent.status === "starting") {
        live.push(agent);
        continue;
      }
      if (!agent.itemId || !open.has(agent.itemId)) continue;
      const current = picked.get(agent.itemId);
      if (!current || rank(agent) < rank(current)) picked.set(agent.itemId, agent);
    }
    const liveKeys = new Set(live.map((agent) => agent.taskName));
    const rest = [...picked.values()].filter((agent) => !liveKeys.has(agent.taskName));
    return [...live, ...rest, ...extra];
  }

  // One GoalAgent per live native Task call in the open turn.
  //
  // On providers where a Task call materializes a real child thread (OpenCode
  // ACP sometimes does; Cursor never), the discovered child already renders a
  // named Now row, so a generic row per call would double-count. Synthesize
  // rows only for the surplus of live calls over live child workers.
  //
  // Names come from the provider's own lifecycle store when it has one:
  // OpenCode records each task subagent as a child session (with its real
  // title) the moment it starts. bb's pending tool-call event carries nothing,
  // so a session created within the pairing window of the call's start is that
  // call's subagent. A named row also links to the open plan item whose step
  // matches its title exactly, so the same slice cannot render twice.
  const CHILD_SESSION_PAIRING_MS = 3 * 60_000;

  function titleTokens(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter((token) => token.length > 1),
    );
  }

  // Providers paraphrase slice titles ("Wave 2c hunt: org-scoping sweep" for
  // the plan's "Wave 2c+: org-scoping sweep of API/lib queries…"), so exact
  // matching misses. Link when nearly all of the title's tokens appear in one
  // item's step and no other open item comes close.
  function itemIdMatchingTitle(threadId: string, title: string): string | null {
    const want = titleTokens(title);
    if (want.size < 3) return null;
    let bestId: string | null = null;
    let bestScore = 0;
    let runnerUp = 0;
    for (const item of items.list(threadId)) {
      if (item.status === "completed") continue;
      const have = titleTokens(item.step);
      let hit = 0;
      for (const token of want) if (have.has(token)) hit += 1;
      const score = hit / want.size;
      if (score > bestScore) {
        runnerUp = bestScore;
        bestScore = score;
        bestId = item.id;
      } else if (score > runnerUp) {
        runnerUp = score;
      }
    }
    return bestScore >= 0.8 && runnerUp < 0.8 ? bestId : null;
  }

  // The provider store is the liveness authority for task calls. bb's own
  // completion events can carry a rewritten tool name (OpenCode retitles the
  // call with the subagent's title) and killed subagents may never emit one,
  // so calls are paired to the provider's part state by call id: a call whose
  // part is no longer running/pending is a phantom, however open it looks in
  // the event stream. Sessions (paired by start time) still contribute the
  // agent type and a title fallback.
  function nativeTaskAgents(
    threadId: string,
    tasks: LiveNativeTask[],
    liveChildWorkers: number,
    childSessions: NativeChildSession[],
    taskCalls: Map<string, NativeTaskCall>,
  ): { agents: GoalAgent[]; aliveCalls: number } {
    const usedSessions = new Set<string>();
    const paired = tasks.map((task) => {
      const call = taskCalls.get(task.key) ?? null;
      let bestDelta = CHILD_SESSION_PAIRING_MS;
      let best: NativeChildSession | null = null;
      for (const session of childSessions) {
        if (usedSessions.has(session.id)) continue;
        const delta = Math.abs(session.createdAt - task.startedAt);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = session;
        }
      }
      if (best) usedSessions.add(best.id);
      return { task, call, session: best };
    });
    const alive = paired.filter(({ call, session }) =>
      call
        ? call.status === "running" || call.status === "pending"
        : !session || sessionIsLive(session),
    );
    const surplus = Math.max(0, alive.length - liveChildWorkers);
    const agents = alive.slice(alive.length - surplus).map(({ task, call, session }, index) => {
      const title = call?.description ?? session?.title ?? null;
      return {
        threadId,
        taskName: `task/${task.key}`,
        nickname: session?.agentType ?? `Subagent ${index + 1}`,
        title,
        itemId: title ? itemIdMatchingTitle(threadId, title) : null,
        role: "worker" as const,
        status: "running" as const,
        summary: null,
      };
    });
    return { agents, aliveCalls: alive.length };
  }

  // Orchestrators sometimes declare assignments inside the plan itself
  // ("Hunt A ... — worker thr_x"). An explicit thread id in an open step is a
  // machine-readable link, so honor it: that worker holds that slice.
  function applyDeclaredWorkers(threadId: string, agents: GoalAgent[]): void {
    const open = items.list(threadId).filter((item) => item.status !== "completed");
    const openIds = new Set(open.map((item) => item.id));
    const byThread = new Map(
      agents.filter((agent) => agent.role !== "verifier").map((agent) => [agent.threadId, agent]),
    );
    for (const item of open) {
      for (const ref of item.step.match(/thr_[a-z0-9]+/gi) ?? []) {
        const agent = byThread.get(ref);
        if (!agent || agent.itemId === item.id) continue;
        // Only relink a worker whose current slice is finished or missing.
        if (agent.itemId && openIds.has(agent.itemId)) continue;
        collab.setMeta(agent.threadId, { itemId: item.id });
        agent.itemId = item.id;
        bb.log.info(`Linked ${agent.nickname} to ${item.id} declared in its plan step`);
      }
    }
  }

  // "Now" rows must be moving. An idle row is a stall, and the plugin heals
  // stalls instead of just displaying them:
  //   - A worker that went idle holding an open slice without reporting gets
  //     a direct follow-up: resume, finish, report.
  //   - A slice whose worker died with no thread left to nudge gets a rescue
  //     worker — but only while the root turn is blocked on open native task
  //     calls and cannot re-staff it itself. When the root is free, staffing
  //     stays with the orchestrator (the continuation prompt demands it).
  // ---------------------------------------------------------------------------
  // Ready-queue scheduler (LLMCompiler-style split, docs/architecture-research.md):
  // the model PLANS — update_plan emits slices with deps/files/check — and this
  // deterministic code SCHEDULES: every pending slice whose deps are complete
  // and whose file scope is disjoint from in-flight work gets a fresh worker,
  // up to maxWorkers, the moment a slot frees. Items without DAG metadata
  // (legacy plans, native mirrors) keep the old nudge-based staffing.
  const STAFF_RETRY_MS = 5 * 60_000;
  const lastStaffTry = new Map<string, number>();
  const scheduling = new Set<string>();

  function globPrefix(path: string): string {
    return path.trim().replace(/\*+.*$/, "").replace(/\/+$/, "");
  }

  function filesOverlap(a: readonly string[], b: readonly string[]): boolean {
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

  function itemBriefMessage(item: GoalItem, restaffed: boolean): string {
    const lines = [`SLICE (item_id=${item.id}): ${item.step}`];
    if (restaffed) {
      lines.push(
        "The previous worker on this slice died mid-work. Pick the slice up from the current worktree state and finish it. It may have landed partial commits already: check the log first, keep its work, and give your commits their own subjects describing what THEY add — never repeat a prior commit's subject.",
      );
    }
    if (item.files.length > 0) {
      lines.push(
        `Scope: touch only files within: ${item.files.join(", ")}. If the slice requires edits outside this scope, stop and report ULTRAGOAL_BLOCKED with the reason instead of expanding scope.`,
      );
    }
    lines.push(
      item.check
        ? `Done-check: \`${item.check}\` must pass. Run it yourself and include its result in your final report.`
        : "Define a machine-checkable done criterion first (a failing test where applicable), make it pass, and include the command and its output in your final report.",
    );
    lines.push(
      "Dispatched by the UltraGoal scheduler: this slice's dependencies are complete. Work only this slice.",
    );
    return lines.join("\n\n");
  }

  async function scheduleReady(rootThreadId: string): Promise<void> {
    const goal = store.get(rootThreadId);
    if (!goal || (goal.status !== "active" && goal.status !== "budget_limited")) return;
    if (scheduling.has(rootThreadId)) return;
    scheduling.add(rootThreadId);
    try {
      const maxWorkers = view(goal).settings.maxWorkers;
      if (maxWorkers <= 0) return;
      const agents = agentCache.get(rootThreadId) ?? [];
      const liveWorkers = agents.filter(
        (agent) =>
          agent.role !== "verifier" &&
          (agent.status === "running" || agent.status === "starting"),
      );
      let slots = maxWorkers - liveWorkers.length;
      if (slots <= 0) return;
      const list = items.list(rootThreadId);
      const completedIds = new Set(
        list.filter((item) => item.status === "completed").map((item) => item.id),
      );
      const heldLive = new Set(
        liveWorkers.filter((agent) => agent.itemId).map((agent) => agent.itemId as string),
      );
      const inFlightFiles = list
        .filter((item) => item.status !== "completed" && heldLive.has(item.id))
        .flatMap((item) => item.files);
      const now = Date.now();
      let staffed = false;
      for (const item of list) {
        if (slots <= 0) break;
        if (item.status === "completed" || heldLive.has(item.id)) continue;
        const lastTry = lastStaffTry.get(item.id);
        if (lastTry != null && now - lastTry < STAFF_RETRY_MS) continue;
        if (item.deps.some((dep) => !completedIds.has(dep))) continue;
        if (
          item.files.length > 0 &&
          inFlightFiles.length > 0 &&
          filesOverlap(item.files, inFlightFiles)
        ) {
          continue;
        }
        const holders = agents.filter(
          (agent) => agent.role !== "verifier" && agent.itemId === item.id,
        );
        let restaffed = false;
        if (item.status === "pending") {
          // Any prior worker row means this slice was staffed before; its
          // completion/reconcile path owns it, not fresh staffing.
          if (holders.length > 0 || collab.workersOnItem(rootThreadId, item.id).length > 0) {
            continue;
          }
        } else {
          // in_progress with no live holder. An idle/completed holder likely
          // reported (harvest/reconcile closes it) or is being stall-nudged;
          // only husks (error/stopped/unknown) or no holder at all mean the
          // worker is truly gone.
          if (holders.some((agent) => agent.status === "idle" || agent.status === "completed")) {
            continue;
          }
          // A step that declares a live thread ("— thr_x running") IS held —
          // the declared owner just claimed a different item id from its
          // spawn prompt. Never double-staff a declared live owner.
          const declaredLive = (item.step.match(/thr_[a-z0-9]+/gi) ?? []).some((ref) =>
            agents.some(
              (agent) =>
                agent.threadId === ref &&
                (agent.status === "running" || agent.status === "starting"),
            ),
          );
          if (declaredLive) continue;
          const updatedAt = items.updatedAt(rootThreadId, item.id);
          if (updatedAt == null || now - updatedAt < RESCUE_AFTER_MS) continue;
          for (const holder of holders) collab.forget(holder.threadId);
          restaffed = true;
        }
        lastStaffTry.set(item.id, now);
        let result: Awaited<ReturnType<typeof collab.spawnWorker>>;
        try {
          result = await collab.spawnWorker({
            parentThreadId: rootThreadId,
            itemId: item.id,
            displayName: workRelatedName(
              item.step,
              agents.map((agent) => agent.nickname),
            ),
            message: itemBriefMessage(item, restaffed),
          });
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) };
        }
        if ("error" in result) {
          bb.log.warn(`Scheduler could not staff slice ${item.id} on ${rootThreadId}: ${result.error}`);
          // The spawn claims the slice before the thread exists; a failed
          // spawn must roll that claim back or the slice strands in_progress
          // until the stale window.
          if (item.status === "pending") {
            items.setStatus(rootThreadId, item.id, "pending");
          }
        } else {
          slots -= 1;
          staffed = true;
          inFlightFiles.push(...item.files);
          bb.log.info(
            `Scheduler staffed ${restaffed ? "abandoned" : "ready"} slice ${item.id} with ${result.nickname} (${result.threadId}) on ${rootThreadId}`,
          );
        }
      }
      if (staffed) {
        const latest = store.get(rootThreadId);
        if (latest) publish(rootThreadId, view(latest));
      }
    } finally {
      scheduling.delete(rootThreadId);
    }
  }

  // The Refinery (docs/architecture-research.md): completed ≠ integrated.
  // Every completed slice whose worker ran in a managed worktree is
  // squash-merged into the base branch, one merge at a time per goal;
  // conflicts escalate to the orchestrator. Pushing the remote stays the
  // orchestrator's job.
  const integrating = new Map<string, Promise<void>>();

  // Event-gated continuation: the root gets a turn when something it must act
  // on happened (completion, finding, blocked worker, failure) or the
  // progress heartbeat is due — never as a busy-poll loop while it waits on
  // live workers.
  const lastGoalEvent = new Map<string, number>();
  function markGoalEvent(rootThreadId: string): void {
    lastGoalEvent.set(rootThreadId, Date.now());
  }

  // Owner decisions render as native center-pane question cards
  // (bb.ui.requestInput + the plugin's owner-decision renderer). Interactions
  // cap at one hour, so a keeper re-raises the card until the durable decision
  // record is answered; answering from the CLI aborts the live card.
  const decisionKeepers = new Set<string>();
  const decisionDismissed = new Set<string>();
  const decisionAborts = new Map<string, AbortController>();

  async function applyDecisionAnswer(
    rootThreadId: string,
    decisionId: string,
    answer: string,
  ): Promise<boolean> {
    const resolved = decisions.resolve(rootThreadId, decisionId, "answered", answer);
    if (!resolved) return false;
    markGoalEvent(rootThreadId);
    decisionAborts.get(decisionId)?.abort();
    const goal = store.get(rootThreadId);
    if (goal) publish(rootThreadId, view(goal));
    bb.log.info(`Owner decision ${decisionId} answered on ${rootThreadId}: ${answer.slice(0, 80)}`);
    await sendSteering(
      rootThreadId,
      `OWNER DECISION ANSWERED (${decisionId}): "${resolved.question}" -> ${answer}. Act on this now and resolve any dependent work.`,
      (await threadIsRunning(bb, rootThreadId)) ? "auto" : "start",
    );
    return true;
  }

  function raiseDecisionPrompt(rootThreadId: string, decisionId: string): void {
    if (decisionKeepers.has(decisionId) || decisionDismissed.has(decisionId)) return;
    decisionKeepers.add(decisionId);
    void (async () => {
      try {
        while (true) {
          const current = decisions.get(rootThreadId, decisionId);
          if (!current || current.status !== "open") return;
          const controller = new AbortController();
          decisionAborts.set(decisionId, controller);
          let result: Awaited<ReturnType<typeof bb.ui.requestInput>>;
          try {
            result = await bb.ui.requestInput(
              {
                threadId: rootThreadId,
                rendererId: "owner-decision",
                title: current.question,
                payload: {
                  decisionId: current.id,
                  question: current.question,
                  context: current.context,
                  options: current.options,
                  threadId: rootThreadId,
                },
                timeoutMs: 60 * 60_000,
              },
              { signal: controller.signal },
            );
          } catch (error) {
            bb.log.warn(
              `Owner-decision prompt failed on ${rootThreadId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return;
          } finally {
            decisionAborts.delete(decisionId);
          }
          if (result.outcome === "submitted") {
            const raw = result.value as { answer?: unknown } | string | null;
            const answer = (
              typeof raw === "string" ? raw : String((raw as { answer?: unknown })?.answer ?? "")
            ).trim();
            if (!answer) continue;
            await applyDecisionAnswer(rootThreadId, decisionId, answer);
            return;
          }
          if (result.reason === "timeout") continue;
          if (result.reason === "user") {
            // Dismissed: stop nagging this session; the decision stays open,
            // visible in status, answerable via CLI.
            decisionDismissed.add(decisionId);
            return;
          }
          // Lifecycle cancel (restart/stop/abort): the pulse sweep re-raises.
          return;
        }
      } finally {
        decisionKeepers.delete(decisionId);
      }
    })();
  }

  function ensureDecisionPrompts(rootThreadId: string): void {
    for (const decision of decisions.list(rootThreadId, "open")) {
      raiseDecisionPrompt(rootThreadId, decision.id);
    }
  }

  async function releaseWorkerRuntime(workerThreadId: string): Promise<void> {
    try {
      await bb.sdk.threads.stop({ threadId: workerThreadId });
      bb.log.info(`Released runtime of finished worker ${workerThreadId}`);
    } catch {
      // Releasing is best-effort; an already-stopped thread is fine.
    }
  }

  function queueIntegration(rootThreadId: string, workerThreadId: string, itemId: string | null): void {
    if (!itemId) return;
    const prev = integrating.get(rootThreadId) ?? Promise.resolve();
    const next = prev
      .then(() => integrateWorker(rootThreadId, workerThreadId, itemId))
      .catch(() => {})
      .then(() => releaseWorkerRuntime(workerThreadId));
    integrating.set(rootThreadId, next);
  }

  async function integrateWorker(
    rootThreadId: string,
    workerThreadId: string,
    itemId: string,
  ): Promise<void> {
    try {
      const worker = await bb.sdk.threads.get({ threadId: workerThreadId });
      if (!worker.environmentId) return;
      const environment = await bb.sdk.environments.get({ environmentId: worker.environmentId });
      if (!environment.isWorktree || !environment.managed) return;
      const base =
        environment.mergeBaseBranch ?? environment.defaultBranch ?? environment.baseBranch;
      if (!base) return;
      await bb.sdk.environments.squashMerge({
        environmentId: worker.environmentId,
        mergeBaseBranch: base,
      });
      bb.log.info(
        `Integrated slice ${itemId}: squash-merged ${environment.branchName ?? worker.environmentId} into ${base} on ${rootThreadId}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no changes|nothing to (merge|commit)|up.to.date|already/i.test(message)) {
        bb.log.info(`Integration skipped for slice ${itemId} on ${rootThreadId}: ${message}`);
        return;
      }
      bb.log.warn(`Integration failed for slice ${itemId} (${workerThreadId}) on ${rootThreadId}: ${message}`);
      await sendSteering(
        rootThreadId,
        `INTEGRATION CONFLICT: completed slice ${itemId} (worker ${workerThreadId}) could not be squash-merged into the default branch automatically: ${message}. Merge that worker's branch manually (rebase-train: merge, run gates, push) before anything else — a completed slice that is not on the default branch does not exist.`,
        "auto",
      );
    }
  }

  const MAX_VERIFY_FAILS = 3;
  const MAX_STALL_NUDGES = 3;
  const STALL_NUDGE_AFTER_MS = 3 * 60_000;
  const STALL_NUDGE_COOLDOWN_MS = 15 * 60_000;
  const RESCUE_AFTER_MS = 10 * 60_000;
  const firstSeenIdle = new Map<string, number>();
  const healing = new Set<string>();

  async function healStalls(rootThreadId: string): Promise<void> {
    const goal = store.get(rootThreadId);
    if (!goal || (goal.status !== "active" && goal.status !== "budget_limited")) return;
    if (healing.has(rootThreadId)) return;
    healing.add(rootThreadId);
    try {
      const agents = agentCache.get(rootThreadId) ?? [];
      const now = Date.now();

      const openItems = items
        .list(rootThreadId)
        .filter((item) => item.status === "in_progress");

      const liveVerifierSources = new Set(
        agents
          .filter(
            (agent) =>
              agent.role === "verifier" &&
              (agent.status === "running" || agent.status === "starting"),
          )
          .map((agent) => collab.rowOf(agent.threadId)?.source_thread_id)
          .filter(Boolean),
      );
      for (const agent of agents) {
        if (agent.role !== "worker" || agent.threadId === rootThreadId) continue;
        if (agent.status !== "idle") {
          firstSeenIdle.delete(agent.threadId);
          continue;
        }
        if (!agent.itemId || !openItems.some((item) => item.id === agent.itemId)) continue;
        // Under judgment is not stalled: the verifier's verdict drives the
        // next step (VERIFY_PASS closes the slice; VERIFY_FAIL is routed back
        // with the findings). Past the fail cap the slice is the
        // orchestrator's call, not a nudge loop's.
        if (liveVerifierSources.has(agent.threadId)) continue;
        const row = collab.rowOf(agent.threadId);
        if ((row?.verify_fails ?? 0) >= MAX_VERIFY_FAILS) continue;
        // A worker that has been nudged repeatedly and still never reports is
        // wedged: retire it and let the scheduler restaff the slice with a
        // fresh worker (which also carries the current brief contract).
        if ((row?.nudge_count ?? 0) >= MAX_STALL_NUDGES) {
          collab.forget(agent.threadId);
          void releaseWorkerRuntime(agent.threadId);
          bb.log.info(
            `Retired unresponsive worker ${agent.nickname} (${agent.threadId}) after ${row?.nudge_count} nudges on ${rootThreadId}; slice ${agent.itemId} returns to the scheduler`,
          );
          continue;
        }
        const since = firstSeenIdle.get(agent.threadId);
        if (since == null) {
          firstSeenIdle.set(agent.threadId, now);
          continue;
        }
        if (now - since < STALL_NUDGE_AFTER_MS) continue;
        // Cooldown reads the durable row, not an in-memory map that resets on
        // every plugin reload.
        if (now - (row?.last_nudge_at ?? 0) < STALL_NUDGE_COOLDOWN_MS) continue;
        collab.bumpNudge(agent.threadId);
        try {
          await bb.sdk.threads.send({
            threadId: agent.threadId,
            mode: "auto",
            permissionMode: "full",
            input: [
              {
                type: "text",
                text: "Your turn ended but your slice is still open and you have not reported. Resume and finish the slice now. When it is fully done, end your final message with exactly one line: ULTRAGOAL_DONE: <one-sentence evidence>. If you cannot finish, end with exactly one line: ULTRAGOAL_BLOCKED: <blocker>.",
                mentions: [],
              },
            ],
          });
          bb.log.info(`Nudged stalled worker ${agent.nickname} (${agent.threadId}) on ${rootThreadId}`);
        } catch (error) {
          bb.log.warn(
            `Could not nudge stalled worker ${agent.threadId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      await scheduleReady(rootThreadId);
    } catch (error) {
      bb.log.warn(
        `Goal heal pass failed on ${rootThreadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      healing.delete(rootThreadId);
    }
  }

  async function viewFresh(goal: StoredGoal): Promise<GoalSnapshot> {
    try {
      const [listed, liveTasks, sessionId] = await Promise.all([
        // Now renders from liveness, so the crew's thread statuses must be
        // fresh, not cache defaults. Discovery registers children the
        // orchestrator spawned natively (outside spawn_agent) so they get
        // Now rows and auto-approval like any other worker.
        collab.listForRoot(goal.threadId, { discover: true, refreshLimit: 24 }),
        listLiveNativeTasks(bb, goal.threadId),
        sessionIdForThread(bb, goal.threadId),
      ]);
      const childSessions =
        liveTasks.length > 0 && sessionId ? listOpenCodeChildren(sessionId) : [];
      const taskCalls =
        liveTasks.length > 0 && sessionId
          ? getOpenCodeTaskCalls(sessionId)
          : new Map<string, NativeTaskCall>();
      const assigned = assignLiveAgents(goal.threadId, listed);
      applyDeclaredWorkers(goal.threadId, assigned);
      const open = new Map(
        items.list(goal.threadId).filter((item) => item.status !== "completed").map((item) => [item.id, item]),
      );
      for (const agent of assigned) {
        if (!agent.itemId || agent.role === "verifier") continue;
        const item = open.get(agent.itemId);
        if (!item) continue;
        if (agent.title && agent.title !== agent.nickname) continue;
        collab.setWorkTitleForItem(goal.threadId, item.id, item.step);
      }
      const liveChildWorkers = assigned.filter(
        (agent) =>
          agent.role !== "verifier" &&
          agent.threadId !== goal.threadId &&
          (agent.status === "running" || agent.status === "starting"),
      ).length;
      const native = nativeTaskAgents(
        goal.threadId,
        liveTasks,
        liveChildWorkers,
        childSessions,
        taskCalls,
      );
      liveTaskCounts.set(goal.threadId, native.aliveCalls);
      agentCache.set(goal.threadId, [...assigned, ...native.agents]);
      void healStalls(goal.threadId);
    } catch (error) {
      bb.log.warn(
        `Could not list Goal agents on ${goal.threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return view(store.get(goal.threadId) ?? goal);
  }

  publishFresh = async (threadId: string) => {
    const goal = store.get(threadId);
    if (!goal) return;
    publish(threadId, await viewFresh(goal));
  };

  const verifying = new Set<string>();
  const staffing = new Set<string>();

  // Staffing belongs to the orchestrator model, not the plugin. UltraGoal
  // used to auto-spawn a worker for every open item — which raced the model's
  // own orchestration, spawned premature workers for unbriefed pending
  // slices, and silently dropped failures. Now the plugin only cleans up
  // errored workers; the continuation prompt tells the model to staff slices.
  async function ensureCrew(threadId: string): Promise<void> {
    const goal = store.get(threadId);
    if (!goal || (goal.status !== "active" && goal.status !== "budget_limited")) return;
    if (staffing.has(threadId)) return;
    staffing.add(threadId);
    try {
      const snap = await viewFresh(store.get(threadId) ?? goal);
      for (const agent of snap.agents.filter((row) => row.role === "worker")) {
        if (agent.status !== "error" && agent.status !== "unknown") continue;
        collab.forget(agent.threadId);
        bb.log.info(`Dropped errored Goal worker ${agent.nickname} (${agent.threadId}) on ${threadId}`);
        try {
          await bb.sdk.threads.stop({ threadId: agent.threadId });
        } catch {
          // Failed forks can be dropped from the Goal store even if stop is unavailable.
        }
      }
    } catch (error) {
      bb.log.warn(
        `Could not tidy Goal crew on ${threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      staffing.delete(threadId);
    }
  }

  // Close the loop Codex Goal closes inside the provider: a finished worker
  // finishes its plan item. With verification on, only VERIFY_PASS completes
  // the slice; with it off, the worker's own done report does.
  function completeItemFor(
    rootThreadId: string,
    itemId: string | null,
    report: string | null | undefined,
    options?: { requirePass?: boolean },
  ): boolean {
    if (!itemId) return false;
    const goal = store.get(rootThreadId);
    if (!goal || (goal.status !== "active" && goal.status !== "budget_limited")) return false;
    if (options?.requirePass) {
      if (!/\bVERIFY_PASS\b/i.test(report ?? "")) return false;
    } else {
      if (view(goal).settings.verifyEnabled) return false;
      // The injected report contract is the only completion signal.
      const contract = structuredReport(report);
      if (contract === "blocked") markGoalEvent(rootThreadId);
      if (contract !== "done") return false;
    }
    const item = items
      .list(rootThreadId)
      .find((row) => row.id === itemId && row.status === "in_progress");
    if (!item) return false;
    items.setStatus(rootThreadId, itemId, "completed");
    markGoalEvent(rootThreadId);
    const closed = findings.markFixedByItem(
      rootThreadId,
      itemId,
      (report ?? "").trim().slice(-400),
    );
    if (closed > 0) {
      bb.log.info(`Closed ${closed} finding(s) fixed by slice ${itemId} on ${rootThreadId}`);
    }
    bb.log.info(`Goal slice ${itemId} completed on ${rootThreadId} from worker report`);
    return true;
  }

  const reconciledReports = new Set<string>();

  // Finished workers whose idle event predates this plugin build (or was
  // missed) still close out their slices.
  async function reconcileFinishedSlices(rootThreadId: string): Promise<boolean> {
    const goal = store.get(rootThreadId);
    if (!goal || (goal.status !== "active" && goal.status !== "budget_limited")) return false;
    if (view(goal).settings.verifyEnabled) return false;
    const openIds = new Set(
      items.list(rootThreadId).filter((item) => item.status === "in_progress").map((item) => item.id),
    );
    let changed = false;
    for (const agent of agentCache.get(rootThreadId) ?? []) {
      if (agent.role === "verifier" || !agent.itemId || !openIds.has(agent.itemId)) continue;
      if (agent.status === "running" || agent.status === "starting") continue;
      if (agent.threadId === rootThreadId) continue;
      const key = `${agent.threadId}:${agent.itemId}`;
      if (reconciledReports.has(key)) continue;
      reconciledReports.add(key);
      try {
        const output = (await bb.sdk.threads.output({ threadId: agent.threadId })).output ?? null;
        if (completeItemFor(rootThreadId, agent.itemId, output)) {
          queueIntegration(rootThreadId, agent.threadId, agent.itemId);
          changed = true;
        }
      } catch {
        // Unreadable worker output leaves the slice open for the orchestrator.
      }
    }
    return changed;
  }

  async function maybeVerifyWorker(workerThreadId: string): Promise<void> {
    const row = collab.rowOf(workerThreadId);
    if (!row || row.role === "verifier") return;
    const goal = store.get(row.root_thread_id);
    if (!goal || (goal.status !== "active" && goal.status !== "budget_limited")) return;
    const resolved = view(goal).settings;
    if (!resolved.verifyEnabled) return;
    if (verifying.has(workerThreadId)) return;

    let output = "";
    try {
      output = (await bb.sdk.threads.output({ threadId: workerThreadId })).output?.trim() ?? "";
    } catch {
      return;
    }
    if (!output) return;
    // A verifier judges a completion claim, not every pause: mid-work idles
    // spawn no auditors. This is what kept minting verifier after verifier
    // while the stall machinery resumed a worker that was merely being judged.
    if (structuredReport(output) !== "done") return;
    const digest = hashText(output);
    if (row.last_verify_hash === digest) return;

    for (const verifier of collab.verifiersFor(workerThreadId)) {
      try {
        const thread = await bb.sdk.threads.get({ threadId: verifier.thread_id });
        if (thread.status === "active" || thread.status === "starting") return;
      } catch {
        // A missing verifier thread does not block a new one.
      }
    }

    verifying.add(workerThreadId);
    try {
      const item = row.item_id
        ? items.list(row.root_thread_id).find((entry) => entry.id === row.item_id)
        : null;
      const spawned = await collab.spawnVerifier({
        rootThreadId: row.root_thread_id,
        sourceThreadId: workerThreadId,
        itemId: row.item_id,
        providerId: resolved.verifyProvider,
        model: resolved.verifyModel,
        workText: item?.step ?? "",
        prompt: [
          "Independent verification of a finished Goal worker.",
          `Parent objective: ${goal.objective}`,
          item ? `Assigned slice: ${item.step}` : "Assigned slice: (not linked to a plan item)",
          `Worker call sign: ${row.display_name || row.task_name}`,
          "The worker's report follows. Do not trust it. Inspect the current worktree.",
          output.slice(0, 8000),
          "End with exactly one line: VERIFY_PASS: <sentence> or VERIFY_FAIL: <what is still wrong>.",
        ].join("\n\n"),
      });
      if (spawned) {
        collab.setVerifyHash(workerThreadId, digest);
        bb.log.info(
          `Goal verifier ${spawned.nickname} launched for ${workerThreadId} on ${resolved.verifyProvider}/${resolved.verifyModel}`,
        );
      }
    } catch (error) {
      bb.log.warn(
        `Could not spawn Goal verifier for ${workerThreadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      verifying.delete(workerThreadId);
    }
  }

  // UltraGoal runs unattended: approval gates (command, file-change,
  // permission, plan) on the goal tree are resolved automatically, session-wide
  // when the provider allows it. User questions are left for the user.
  async function approveInteractions(threadId: string): Promise<number> {
    let rows: Array<Record<string, unknown>> = [];
    try {
      const listed = await bb.sdk.threads.interactions.list({ threadId });
      rows = (Array.isArray(listed) ? listed : []) as Array<Record<string, unknown>>;
    } catch {
      return 0;
    }
    let approved = 0;
    for (const row of rows) {
      const id = typeof row.id === "string" ? row.id : null;
      const payload = (row.payload ?? null) as
        | { kind?: string; availableDecisions?: unknown }
        | null;
      if (!id || payload?.kind !== "approval") continue;
      const decisions = Array.isArray(payload.availableDecisions)
        ? payload.availableDecisions
        : [];
      const decision = decisions.includes("allow_for_session")
        ? ("allow_for_session" as const)
        : ("allow_once" as const);
      try {
        await bb.sdk.threads.interactions.resolve({
          threadId,
          interactionId: id,
          resolution: { decision, grantedPermissions: null } as never,
        });
        approved += 1;
      } catch (error) {
        bb.log.warn(
          `Could not auto-approve interaction ${id} on ${threadId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (approved > 0) {
      bb.log.info(`Auto-approved ${approved} interaction(s) on ${threadId}`);
    }
    return approved;
  }

  async function approveGoalTree(rootId: string): Promise<void> {
    const goal = store.get(rootId);
    if (!goal || (goal.status !== "active" && goal.status !== "budget_limited")) return;
    const ids = new Set<string>([rootId]);
    for (const agent of agentCache.get(rootId) ?? []) {
      if (agent.threadId !== rootId) ids.add(agent.threadId);
    }
    // The agent cache lags behind discovery; the store has every registered
    // child, including natively spawned ones.
    for (const id of collab.threadIdsForRoot(rootId)) ids.add(id);
    await Promise.all([...ids].map((id) => approveInteractions(id)));
  }

  async function approvalPulse(): Promise<void> {
    for (const threadId of store.listActiveThreadIds()) {
      try {
        await approveGoalTree(threadId);
      } catch (error) {
        bb.log.warn(
          `Goal approval pulse failed on ${threadId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  async function nudgeRoot(rootId: string): Promise<void> {
    const goal = store.get(rootId);
    if (!goal || (goal.status !== "active" && goal.status !== "budget_limited")) return;
    if (!view(goal).settings.autoContinue) return;
    await ensureCrew(rootId);
    if (await threadIsRunning(bb, rootId)) return;
    await continueIfIdle(rootId, store.get(rootId) ?? goal);
  }

  async function refreshRunning(threadId: string): Promise<boolean> {
    const next = await threadIsRunning(bb, threadId);
    running.set(threadId, next);
    return next;
  }

  async function limits() {
    const value = await settings.get();
    return {
      autoContinue: value.autoContinue,
      maxGoalTokenBudget: parsePositiveInt(value.maxGoalTokenBudget),
    };
  }

  function applyStatus(
    threadId: string,
    status: GoalStatus,
    reason?: string | null,
  ): StoredGoal | null {
    const next = store.update(threadId, { status, reason: reason ?? null });
    if (next) publish(threadId, view(next));
    return next;
  }

  async function stopThread(threadId: string): Promise<void> {
    running.set(threadId, false);
    try {
      await bb.sdk.threads.stop({ threadId });
    } catch (error) {
      bb.log.warn(
        `Could not stop thread ${threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async function stopCrew(rootId: string): Promise<void> {
    const agents = agentCache.get(rootId) ?? [];
    await Promise.all(
      agents
        .filter((agent) => agent.status === "running" || agent.status === "starting")
        .map(async (agent) => {
          try {
            await bb.sdk.threads.stop({ threadId: agent.threadId });
          } catch (error) {
            bb.log.warn(
              `Could not stop Goal worker ${agent.threadId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }),
    );
  }

  async function pauseGoal(threadId: string, reason: string): Promise<StoredGoal | null> {
    const goal = applyStatus(threadId, "paused", reason);
    await stopThread(threadId);
    await stopCrew(threadId);
    const latest = store.get(threadId);
    if (latest) publish(threadId, await viewFresh(latest));
    return latest ?? goal;
  }

  async function resumeGoal(
    threadId: string,
    options?: { start?: boolean },
  ): Promise<StoredGoal | null> {
    const existing = store.get(threadId);
    if (!existing) return null;
    applyStatus(threadId, "active", null);
    store.update(threadId, {
      blockedStreak: 0,
      lastBlockKey: null,
      lastContinueWasAutomatic: false,
    });
    await ensureCrew(threadId);
    const latest = store.get(threadId);
    if (latest && options?.start !== false) {
      await refreshRunning(threadId);
      if (!running.get(threadId)) {
        await continueIfIdle(threadId, latest);
      }
    }
    return store.get(threadId);
  }

  async function userSetGoal(
    threadId: string,
    objective: string,
    tokenBudget?: number | null,
  ): Promise<StoredGoal | { error: string }> {
    const invalid = validateObjective(objective);
    if (invalid) return { error: invalid };
    const { maxGoalTokenBudget } = await limits();
    const budget = tokenBudget ?? maxGoalTokenBudget;
    if (budget != null && maxGoalTokenBudget != null && budget > maxGoalTokenBudget) {
      return {
        error: `goal token budget ${budget} exceeds the maximum allowed goal token budget of ${maxGoalTokenBudget}`,
      };
    }

    const existing = store.get(threadId);
    if (!existing || existing.status === "complete") {
      items.clear(threadId);
      findings.clear(threadId);
      decisions.clear(threadId);
    }
    const goal =
      !existing || existing.status === "complete"
        ? store.replace({
            threadId,
            objective: objective.trim(),
            status: "active",
            tokenBudget: budget ?? null,
          })
        : store.update(threadId, {
            objective: objective.trim(),
            status: "active",
            reason: null,
            tokenBudget: budget ?? existing.tokenBudget,
            blockedStreak: 0,
            lastBlockKey: null,
          });
    if (!goal) return { error: "failed to set goal" };
    const baseline = await readThreadTokens(bb, threadId);
    const next = store.update(threadId, {
      lastSeenTokens: baseline,
      lastAccountedAt: Date.now(),
      lastContinueWasAutomatic: false,
    });
    const ready = next ?? goal;
    publish(threadId, view(ready));
    return ready;
  }

  async function sendSteering(
    threadId: string,
    text: string,
    mode: "start" | "auto",
  ): Promise<boolean> {
    if (inflight.has(threadId)) return false;
    inflight.add(threadId);
    try {
      await bb.sdk.threads.send({
        threadId,
        mode,
        permissionMode: "full",
        input: [{ type: "text", text, visibility: "agent-only", mentions: [] }],
      });
      return true;
    } catch (error) {
      bb.log.warn(
        `Goal steering failed on ${threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    } finally {
      inflight.delete(threadId);
    }
  }

  async function requestProgressUpdate(threadId: string, goal: StoredGoal): Promise<boolean> {
    if (inflight.has(threadId)) return false;
    const snap = await viewFresh(goal);
    const minutes = snap.settings.progressUpdateMinutes;
    if (minutes <= 0 || !snap.settings.autoContinue) return false;
    const lastAt = goal.lastProgressAt ?? goal.lastContinueAt ?? goal.startedAt;
    if (Date.now() - lastAt < minutes * 60_000) return false;
    // Steered input interrupts pending native Task subagents on Cursor and
    // orphans their tool calls; hold the check-in until they finish.
    if (hasPendingNativeTasks(threadId)) return false;
    const runningNow = await threadIsRunning(bb, threadId);
    const sent = await sendSteering(
      threadId,
      progressPrompt(snap),
      runningNow ? "auto" : "start",
    );
    if (!sent) return false;
    store.update(threadId, {
      lastProgressAt: Date.now(),
      lastContinueAt: Date.now(),
      lastContinueWasAutomatic: false,
    });
    const latest = store.get(threadId);
    if (latest) publish(threadId, view(latest));
    bb.log.info(`Goal progress update requested on ${threadId}`);
    return true;
  }

  async function pulseStaleProgress(): Promise<void> {
    for (const threadId of store.listActiveThreadIds()) {
      const goal = store.get(threadId);
      if (!goal || (goal.status !== "active" && goal.status !== "budget_limited")) continue;
      try {
        ensureDecisionPrompts(threadId);
        await requestProgressUpdate(threadId, goal);
        const reconciled = await reconcileFinishedSlices(threadId);
        const accounted = await account(threadId, { busy: goalIsBusy(threadId), scan: true });
        if (accounted || reconciled) {
          const latest = store.get(threadId);
          if (latest) publish(threadId, view(latest));
        }
      } catch (error) {
        bb.log.warn(
          `Goal progress pulse failed on ${threadId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  function progressIsDue(goal: StoredGoal, minutes: number): boolean {
    if (minutes <= 0) return false;
    const lastAt = goal.lastProgressAt ?? goal.startedAt;
    return Date.now() - lastAt >= minutes * 60_000;
  }

  async function continueIfIdle(threadId: string, goal: StoredGoal): Promise<void> {
    await ensureCrew(threadId);
    const latestGoal = store.get(threadId) ?? goal;
    const snap = await viewFresh(latestGoal);
    const due = !isBudgetExhausted(snap) && progressIsDue(latestGoal, snap.settings.progressUpdateMinutes);
    // Nothing new since the root's last turn and no heartbeat due: the root
    // has no job — waiting on live workers is the scheduler's business, not a
    // reason to burn a polling turn every idle.
    if (!due && latestGoal.lastContinueAt != null) {
      const lastEvent = lastGoalEvent.get(threadId) ?? 0;
      if (lastEvent <= latestGoal.lastContinueAt) {
        bb.log.info(`Goal continue skipped on ${threadId}: no new events; next turn on event or heartbeat`);
        return;
      }
    }
    const text = isBudgetExhausted(snap)
      ? budgetLimitPrompt(snap)
      : due
        ? progressPrompt(snap)
        : continuationPrompt(snap);
    const sent = await sendSteering(threadId, text, "start");
    if (!sent) return;
    store.update(threadId, {
      lastContinueAt: Date.now(),
      lastContinueWasAutomatic: true,
      lastProgressAt: due ? Date.now() : latestGoal.lastProgressAt,
    });
    const latest = store.get(threadId);
    if (latest) publish(threadId, await viewFresh(latest));
    bb.log.info(`Goal continue sent on ${threadId}`);
  }

  async function editGoal(threadId: string, objective: string): Promise<StoredGoal | null> {
    const result = await userSetGoal(threadId, objective);
    if ("error" in result) return store.get(threadId);
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.status === "active") {
        await sendSteering(threadId, objectiveUpdatedPrompt(view(result)), "auto");
      } else if (thread.status === "idle" && view(result).settings.autoContinue && result.status === "active") {
        await continueIfIdle(threadId, result);
      }
    } catch {
      // Store update still stands if we cannot inspect or continue the thread.
    }
    return result;
  }

  async function readTimeline(threadId: string): Promise<readonly unknown[]> {
    try {
      const timeline = await bb.sdk.threads.timeline({ threadId });
      return timeline.rows;
    } catch (error) {
      bb.log.warn(
        `Could not read timeline for ${threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  async function applyUserSlash(threadId: string, userText: string | null): Promise<boolean> {
    const slash = parseSlashGoal(userText);
    if (!slash) return false;
    if (slash.kind === "clear") {
      items.clear(threadId);
      findings.clear(threadId);
      decisions.clear(threadId);
      if (store.clear(threadId)) publish(threadId, null);
      return true;
    }
    if (slash.kind === "status") return true;
    if (slash.kind === "pause") {
      await pauseGoal(threadId, "Paused from /ultragoal");
      return true;
    }
    if (slash.kind === "resume") {
      await resumeGoal(threadId, { start: false });
      return true;
    }
    if (slash.kind !== "set" && slash.kind !== "edit") return true;
    const result = await userSetGoal(threadId, slash.objective);
    if ("error" in result) {
      bb.log.warn(`Goal set failed on ${threadId}: ${result.error}`);
    }
    return true;
  }

  bb.rpc.register(rpcContract, {
    async getGoal({ threadId }) {
      const goal = store.get(threadId);
      if (goal) refreshPane(threadId);
      return { goal: goal ? view(goal) : null };
    },
    async pause({ threadId }) {
      const goal = await pauseGoal(threadId, "Paused from the composer.");
      return { goal: goal ? await viewFresh(goal) : null };
    },
    async resume({ threadId }) {
      const goal = await resumeGoal(threadId);
      return { goal: goal ? await viewFresh(goal) : null };
    },
    clear({ threadId }) {
      items.clear(threadId);
      findings.clear(threadId);
      decisions.clear(threadId);
      const cleared = store.clear(threadId);
      if (cleared) publish(threadId, null);
      return { cleared };
    },
    async edit({ threadId, objective }) {
      const goal = await editGoal(threadId, objective);
      return { goal: goal ? view(goal) : null };
    },
    async setItemStatus({ threadId, itemId, status }) {
      items.setStatus(threadId, itemId, status);
      if (status === "completed") {
        findings.markFixedByItem(threadId, itemId, "Marked completed from the pane.");
      }
      const goal = store.get(threadId);
      const next = goal ? await viewFresh(goal) : null;
      if (next) publish(threadId, next);
      return { goal: next };
    },
    async addItem({ threadId, step }) {
      items.add(threadId, step);
      const goal = store.get(threadId);
      const next = goal ? await viewFresh(goal) : null;
      if (next) publish(threadId, next);
      return { goal: next };
    },
    async updateSettings({
      threadId,
      verifyEnabled,
      verifyProvider,
      verifyModel,
      autoContinue,
      progressUpdateMinutes,
      maxWorkers,
      workerProvider,
      workerModel,
      tokenBudget,
    }) {
      const existing = store.get(threadId);
      if (!existing) return { goal: null };
      const next = store.update(threadId, {
        verifyEnabledOverride: verifyEnabled,
        verifyProviderOverride: verifyProvider,
        verifyModelOverride: verifyModel,
        autoContinueOverride: autoContinue,
        progressUpdateMinutesOverride: progressUpdateMinutes,
        maxWorkersOverride: maxWorkers,
        workerProviderOverride: workerProvider,
        workerModelOverride: workerModel,
        tokenBudget,
      });
      const snap = next ? await viewFresh(next) : null;
      if (snap) publish(threadId, snap);
      return { goal: snap };
    },
    async listModels({ threadId }) {
      return { providers: await listExecutionCatalog(bb, threadId) };
    },
    async listCrews() {
      // Every root that ever staffed a crew, not just active goals: clearing
      // a goal must not dump its (hidden) worker threads into the sidebar.
      const roots = new Set<string>([...store.listActiveThreadIds(), ...collab.listRoots()]);
      const crews = [];
      for (const threadId of roots) {
        const goal = store.get(threadId);
        const active = Boolean(goal && (goal.status === "active" || goal.status === "budget_limited"));
        const snap = goal ? view(goal) : null;
        crews.push({
          threadId,
          active,
          items: snap?.items ?? [],
          agents: snap?.agents ?? agentCache.get(threadId) ?? [],
          workerIds: collab.threadIdsForRoot(threadId),
        });
      }
      return { crews };
    },
    removeItem({ threadId, itemId }) {
      items.remove(threadId, itemId);
      const goal = store.get(threadId);
      const next = goal ? view(goal) : null;
      if (next) publish(threadId, next);
      return { goal: next };
    },
  });

  bb.agents.registerTool({
    name: "get_goal",
    description:
      "Get the current goal for this thread, including status, budgets, token and elapsed-time usage, remaining token budget, and the requirement plan.",
    experimental_statusLabels: {
      pending: "Checking Goal",
      completed: "Checked Goal",
    },
    parameters: z.object({}).strict(),
    async execute(_params, { threadId }) {
      const rootThreadId = collab.rootId(threadId);
      await refreshRunning(rootThreadId);
      const accounted = await account(rootThreadId);
      const goal = accounted ?? store.get(rootThreadId);
      return goalToolResponse(
        goal ? await viewFresh(goal) : null,
        false,
        findings.list(rootThreadId, "open"),
      );
    },
  });

  bb.agents.registerTool({
    name: "create_goal",
    description:
      "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Set token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; use update_goal only for status.",
    experimental_statusLabels: {
      pending: "Creating Goal",
      completed: "Created Goal",
    },
    parameters: z.object({
      objective: z
        .string()
        .min(1)
        .describe(
          "Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete.",
        ),
      token_budget: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Positive token budget for the new goal. Omit unless explicitly requested."),
    }),
    async execute({ objective, token_budget }, { threadId }) {
      const existing = store.get(threadId);
      if (existing && isUnfinished(existing.status)) {
        return {
          content: [
            {
              type: "text",
              text: "cannot create a new goal because this thread has an unfinished goal; complete the existing goal first",
            },
          ],
          isError: true,
        };
      }
      const result = await userSetGoal(threadId, objective, token_budget ?? null);
      if ("error" in result) {
        return { content: [{ type: "text", text: result.error }], isError: true };
      }
      return goalToolResponse(view(result));
    },
  });

  bb.agents.registerTool({
    name: "update_goal",
    description:
      "Update the existing goal. Use this tool only to mark the goal achieved or genuinely blocked. Set status to `complete` only when the objective has actually been achieved and no required work remains. Set status to `blocked` only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic continuations, and the agent cannot make meaningful progress without user input or an external-state change. If the user resumes a goal that was previously marked `blocked`, treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least three consecutive resumed goal turns, set status to `blocked` again. Once the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to `blocked`. Do not use `blocked` merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification. Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work. You cannot use this tool to pause, resume, budget-limit, or usage-limit a goal; those status changes are controlled by the user or system. When marking a budgeted goal achieved with status `complete`, report the final token usage from the tool result to the user.",
    experimental_statusLabels: {
      pending: "Updating Goal",
      completed: "Updated Goal",
    },
    parameters: z.object({
      status: z
        .enum(["complete", "blocked"])
        .describe(
          "Required. Set to `complete` only when the objective is achieved and no required work remains. Set to `blocked` only after the same blocking condition has recurred for at least three consecutive goal turns and the agent is at an impasse. After a previously blocked goal is resumed, the resumed run starts a fresh blocked audit.",
        ),
    }),
    async execute({ status }, { threadId }) {
      const accounted = (await account(threadId)) ?? store.get(threadId);
      if (!accounted) {
        return {
          content: [{ type: "text", text: "cannot update goal because this thread has no goal" }],
          isError: true,
        };
      }
      if (status === "complete") {
        const openDecisions = decisions.list(threadId, "open");
        if (openDecisions.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: `cannot mark the goal complete: ${openDecisions.length} owner decision(s) await the user: ${openDecisions
                  .map((decision) => `${decision.id} ${decision.question}`)
                  .join("; ")}. The user answers via bb ultragoal decide <id> <answer>; use resolve_decision only for their verbatim answer or a genuinely moot question.`,
              },
            ],
            isError: true,
          };
        }
        const open = findings.list(threadId, "open");
        if (open.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: `cannot mark the goal complete: ${open.length} open finding(s) remain. Fix them (their fix slices close them automatically) or call resolve_finding with evidence for any that are not real defects. Open: ${open
                  .slice(0, 10)
                  .map((finding) => `${finding.id} ${finding.title} [${finding.file}]`)
                  .join("; ")}`,
              },
            ],
            isError: true,
          };
        }
      }
      const next = applyStatus(threadId, status, null);
      return goalToolResponse(next ? view(next) : null, status === "complete");
    },
  });

  bb.agents.registerTool({
    name: "update_plan",
    description: `Updates the task plan — the dependency DAG the UltraGoal scheduler executes.
Provide the full list of plan items. Each item is a self-contained slice brief: step (objective + boundaries), files (the disjoint file paths/globs this slice owns), check (a runnable command that proves it done), and deps (item_ids or "#N" 1-based positions in this list it must wait for; empty = ready now).
The scheduler staffs one fresh worker per READY slice automatically, up to the goal's max concurrent workers — do not spawn workers for plan items yourself. Plan WIDE: prefer many independent file-disjoint slices over few coarse ones; declare deps only for genuinely sequential work; never write catch-all tail items like "fix whatever the hunt proves" (hunt workers report_finding per defect and fixes are staffed as they stream in).
Keep the plan current as steps complete or the next best action changes. When a live worker moves to a new slice, pass that item's id and the new step text and keep status in_progress. Do not add a pending Next row for work a worker is already doing. Append only genuinely unstarted work. Do not treat a plan update as a substitute for doing the work.
`,
    experimental_statusLabels: {
      pending: "Updating plan",
      completed: "Plan updated",
    },
    parameters: z.object({
      explanation: z.string().optional().describe("Optional explanation for this plan update."),
      plan: z
        .array(
          z.object({
            id: z
              .string()
              .optional()
              .describe(
                "Existing item_id from get_goal. Pass this when updating a slice so the Now title changes in place instead of creating a new Next row.",
              ),
            step: z.string().describe("Task step text. Update this when the worker's current slice changes."),
            status: z.enum(["pending", "in_progress", "completed"]).describe("Step status."),
            deps: z
              .array(z.string())
              .optional()
              .describe(
                'Item ids (or "#N" = 1-based position in this list) this slice must wait for. Pass [] for slices that are ready now. Omit to keep the item\'s existing deps.',
              ),
            files: z
              .array(z.string())
              .optional()
              .describe(
                "File paths/globs this slice owns. Keep scopes disjoint across parallel slices so workers cannot collide. Omit to keep existing.",
              ),
            check: z
              .string()
              .nullable()
              .optional()
              .describe(
                "Runnable command that proves this slice done (its verification gate). Omit to keep existing; null to clear.",
              ),
          }),
        )
        .describe("The full list of slices forming the dependency DAG."),
    }),
    async execute({ plan }, { threadId }) {
      bb.log.info(`update_plan on ${threadId}: ${plan.length} steps`);
      items.replace(threadId, plan);
      const goal = store.get(threadId);
      const next = goal ? await viewFresh(goal) : null;
      if (next) publish(threadId, next);
      void ensureCrew(threadId);
      void scheduleReady(threadId);
      return "Plan updated";
    },
  });
  bb.agents.registerTool({
    name: "report_finding",
    description:
      "Report ONE discrete defect the moment you confirm it during a hunt/audit/review — do not batch findings into a final report. Findings are fingerprint-deduplicated (same file + same defect = same finding across sweeps). A fresh finding auto-creates a ready fix slice that the scheduler staffs immediately, so fixes start while the hunt continues. Open findings block goal completion.",
    experimental_statusLabels: { pending: "Reporting finding", completed: "Reported finding" },
    parameters: z.object({
      title: z.string().min(1).describe("One-sentence statement of the defect."),
      file: z
        .string()
        .min(1)
        .describe('Primary location, "path/to/file.ts" or "path/to/file.ts:123".'),
      evidence: z
        .string()
        .min(1)
        .describe("Proof it is real: the offending code/behavior, not a hunch."),
      fix_files: z
        .array(z.string())
        .optional()
        .describe("File scope the fix slice should own. Defaults to the finding's file."),
      check: z
        .string()
        .optional()
        .describe("Runnable command that proves the fix (e.g. the failing test to make pass)."),
    }),
    async execute({ title, file, evidence, fix_files, check }, { threadId }) {
      const rootThreadId = collab.rootId(threadId);
      const goal = store.get(rootThreadId);
      if (!goal || (goal.status !== "active" && goal.status !== "budget_limited")) {
        return {
          content: [{ type: "text", text: "no active UltraGoal on this thread tree" }],
          isError: true,
        };
      }
      const result = findings.report(rootThreadId, { title, file, evidence });
      if (!result.created) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "duplicate",
                finding_id: result.finding.id,
                finding_status: result.finding.status,
                note:
                  result.finding.status === "fixed"
                    ? "This finding was already fixed. Verify it actually regressed before re-reporting; if it did, report with a more specific title."
                    : "Already known; its fix is tracked.",
              }),
            },
          ],
        };
      }
      const fixItem = items.add(
        rootThreadId,
        `Fix: ${title} [${file.replace(/[:#]\d+([-:]\d+)?$/, "")}]`,
        "pending",
        {
          deps: [],
          files: fix_files && fix_files.length > 0 ? fix_files : [file.replace(/[:#]\d+([-:]\d+)?$/, "")],
          check: check ?? null,
        },
      );
      if (fixItem) findings.linkItem(rootThreadId, result.finding.id, fixItem.id);
      markGoalEvent(rootThreadId);
      bb.log.info(
        `Finding ${result.finding.id} reported on ${rootThreadId}${fixItem ? ` -> fix slice ${fixItem.id}` : ""}`,
      );
      void publishFresh(rootThreadId);
      void scheduleReady(rootThreadId);
      void nudgeRoot(rootThreadId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "new",
              finding_id: result.finding.id,
              fix_item_id: fixItem?.id ?? null,
            }),
          },
        ],
      };
    },
  });

  bb.agents.registerTool({
    name: "request_decision",
    description:
      "Escalate a decision only the OWNER (the human user) can make — irreversible actions (history rewrites, deletions, spending), scope changes, or preference calls. It renders in the UltraGoal pane's 'Needs you' section and blocks goal completion until answered (bb ultragoal decide <id> <answer>). Also post one short user-visible chat message stating the question. Never bury an owner decision inside a progress note, never re-ask an open one, and never proceed on an assumed answer.",
    experimental_statusLabels: { pending: "Requesting decision", completed: "Requested decision" },
    parameters: z.object({
      question: z.string().min(1).describe("The single decision the owner must make, phrased as a question."),
      context: z
        .string()
        .optional()
        .describe("What the owner needs to know: consequences of each path, evidence, urgency."),
      options: z.array(z.string()).optional().describe("Concrete answer options, if enumerable."),
    }),
    async execute({ question, context, options }, { threadId }) {
      const rootThreadId = collab.rootId(threadId);
      const goal = store.get(rootThreadId);
      if (!goal || (goal.status !== "active" && goal.status !== "budget_limited")) {
        return {
          content: [{ type: "text", text: "no active UltraGoal on this thread tree" }],
          isError: true,
        };
      }
      const decision = decisions.request(rootThreadId, { question, context, options });
      bb.log.info(`Owner decision ${decision.id} requested on ${rootThreadId}: ${question.slice(0, 80)}`);
      raiseDecisionPrompt(rootThreadId, decision.id);
      void publishFresh(rootThreadId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              decision_id: decision.id,
              status: decision.status,
              note: "The question renders as a native card in the user's thread; you will be woken with the answer. Continue all work that does not depend on it — do not wait idle.",
            }),
          },
        ],
      };
    },
  });

  bb.agents.registerTool({
    name: "resolve_decision",
    description:
      "Close an open owner decision: pass the owner's answer verbatim when they gave one in chat, or withdraw a decision that became moot (with the reason). Never invent an answer the owner did not give.",
    experimental_statusLabels: { pending: "Resolving decision", completed: "Resolved decision" },
    parameters: z.object({
      decision: z.string().min(1).describe("Decision id (dec_...) from request_decision or get_goal."),
      resolution: z.enum(["answered", "withdrawn"]).describe("answered = the owner decided; withdrawn = moot."),
      answer: z.string().min(1).describe("The owner's answer verbatim, or why it is moot."),
    }),
    async execute({ decision, resolution, answer }, { threadId }) {
      const rootThreadId = collab.rootId(threadId);
      const resolved = decisions.resolve(rootThreadId, decision, resolution, answer);
      if (!resolved) {
        return {
          content: [{ type: "text", text: `decision not found: ${decision}` }],
          isError: true,
        };
      }
      decisionAborts.get(resolved.id)?.abort();
      markGoalEvent(rootThreadId);
      void publishFresh(rootThreadId);
      return {
        content: [
          { type: "text", text: JSON.stringify({ decision_id: resolved.id, status: resolved.status }) },
        ],
      };
    },
  });

  bb.agents.registerTool({
    name: "resolve_finding",
    description:
      "Resolve an open finding that will not be closed by a fix slice: mark it not_a_defect with evidence, or fixed when the fix landed outside its own slice. Findings fixed by their auto-created fix slice close automatically — do not resolve those by hand.",
    experimental_statusLabels: { pending: "Resolving finding", completed: "Resolved finding" },
    parameters: z.object({
      finding: z.string().min(1).describe("Finding id (fnd_...) or fingerprint from report_finding/get_goal."),
      resolution: z.enum(["fixed", "not_a_defect"]).describe("What happened to it."),
      evidence: z
        .string()
        .min(1)
        .describe("Proof: commit SHA / passing check output, or why it is not a real defect."),
    }),
    async execute({ finding, resolution, evidence }, { threadId }) {
      const rootThreadId = collab.rootId(threadId);
      const resolved = findings.resolve(
        rootThreadId,
        finding,
        resolution === "fixed" ? "fixed" : "dismissed",
        evidence,
      );
      if (!resolved) {
        return {
          content: [{ type: "text", text: `finding not found: ${finding}` }],
          isError: true,
        };
      }
      void publishFresh(rootThreadId);
      return {
        content: [
          { type: "text", text: JSON.stringify({ finding_id: resolved.id, status: resolved.status }) },
        ],
      };
    },
  });

  collab.registerTools();

  bb.agents.configure((context) => {
    if (usesNativeGoal(context.provider.id) || context.origin.pluginId === "side-chat") {
      return { tools: [], skills: [] };
    }
    const row = collab.rowOf(context.thread.id);
    const parentId = row?.parent_thread_id ?? context.thread.parentThreadId;
    const rootId = row?.root_thread_id ?? parentId ?? context.thread.id;
    const inherited = parentId ? store.get(rootId) : null;
    const isWorker = Boolean(inherited && isUnfinished(inherited.status) && inherited.threadId !== context.thread.id);
    const goal = isWorker ? inherited : store.get(context.thread.id);
    const plan = goal ? items.list(goal.threadId) : [];
    const done = plan.filter((item) => item.status === "completed").length;
    const liveAgents = (agentCache.get(goal?.threadId ?? "") ?? []).filter(
      (agent) => agent.status === "running" || agent.status === "starting",
    );

    if (isWorker) {
      const isVerifier = row?.role === "verifier";
      const worker =
        goal && (goal.status === "active" || goal.status === "budget_limited")
          ? isVerifier
            ? [
                `You are an UltraGoal verifier${row?.display_name ? ` (${row.display_name})` : ""}. Parent objective: ${goal.objective}`,
                "Inspect the current worktree. Do not trust the worker report.",
                "End with VERIFY_PASS or VERIFY_FAIL. Do not implement fixes.",
                "Do not call update_goal, do not rewrite the parent plan, and do not take over the whole Goal.",
              ].join("\n")
            : [
                `You are an UltraGoal subagent${row?.display_name ? ` (${row.display_name})` : ""}. Parent objective: ${goal.objective}`,
                "Complete only the slice you were assigned. Report evidence when done: commit SHA(s) and your check's passing output, not bare claims.",
                "If your slice is a hunt/audit/review, call report_finding per discrete defect the moment you confirm it — fixes are staffed automatically; do not batch findings into your final report.",
                "Do not call update_goal, do not rewrite the parent plan, and do not take over the whole Goal.",
                "You may spawn nested helpers for your slice if it splits cleanly.",
              ].join("\n")
          : undefined;
      return {
        tools: [...COLLAB_TOOL_NAMES, "report_finding", "resolve_finding", "request_decision"],
        skills: [],
        instructions: worker,
      };
    }

    const live =
      goal && (goal.status === "active" || goal.status === "budget_limited")
        ? [
            `Durable UltraGoal (${goal.status}): ${goal.objective}`,
            "This root thread is the orchestrator. Subagents do the implementation by default.",
            plan.length > 0
              ? `Requirement plan: ${done}/${plan.length} complete. Keep update_plan current as steps complete or the next best action changes.`
              : "The UltraGoal pane is empty. Call update_plan immediately with concrete remaining work. Do not use TodoWrite or Update TODOs for that list.",
            liveAgents.length > 0
              ? `${liveAgents.length} subagent(s) are live. Wait or follow up; do not redo their slices on the root.`
              : "No subagents are live. Keep the plan's ready slices flowing; the scheduler staffs them.",
            `You plan; the scheduler staffs. Express all work as update_plan slices with deps/files/check — the UltraGoal scheduler spawns one fresh worker per ready slice automatically, up to ${view(goal).settings.maxWorkers} concurrent. Do not spawn workers for plan items yourself and never use the native Task tool for slice work (it blocks this thread). spawn_agent is only for ad-hoc helpers outside the plan; give any such helper a humorous display_name related to its work.`,
            "Hunts stream: workers report_finding per defect and each finding auto-creates a staffed fix slice. Never write catch-all tail items like 'fix whatever the hunt proves'. Open findings block update_goal complete; resolve_finding (with evidence) anything that is not a real defect.",
            view(goal).settings.verifyEnabled
              ? `Verification is on. After a worker returns, a ${view(goal).settings.verifyProvider}/${view(goal).settings.verifyModel} verifier is launched automatically. Do not mark that slice complete until VERIFY_PASS. On VERIFY_FAIL, spawn a fix worker.`
              : "Verification is off for this UltraGoal.",
            view(goal).settings.progressUpdateMinutes > 0
              ? `Do not write a visible chat status on ordinary turns. A progress-check-in every ${view(goal).settings.progressUpdateMinutes} minutes will ask when a chat update is due. You may also write one short note when a slice completes or a worker fails.`
              : "Progress chat updates are off for this UltraGoal. Do not write routine status notes.",
            "Stay on the root to plan, wait, verify, and unblock.",
            "Call update_goal with status complete only when current evidence proves every requirement.",
            "Call update_goal with status blocked only after the same blocker repeats for three consecutive goal turns.",
            "Do not pause, resume, clear, or budget-limit the goal; those are user or system controls.",
          ].join("\n")
        : undefined;
    return {
      tools: [
        "get_goal",
        "create_goal",
        "update_goal",
        "update_plan",
        "report_finding",
        "resolve_finding",
        "request_decision",
        "resolve_decision",
        ...COLLAB_TOOL_NAMES,
      ],
      skills: ["ultragoal"],
      instructions: live,
    };
  });

  // A goal-tree child just started: register it with the crew right now, so
  // it renders as a named worker immediately instead of waiting for the next
  // discovery poll (during which it shows as an anonymous "Subagent task").
  async function registerNewChild(thread: { id: string; parentThreadId?: string | null }): Promise<void> {
    if (!thread.parentThreadId || collab.rowOf(thread.id)) return;
    const parentRoot = store.get(thread.parentThreadId)
      ? thread.parentThreadId
      : collab.rowOf(thread.parentThreadId)?.root_thread_id;
    if (!parentRoot) return;
    const goal = store.get(parentRoot);
    if (!goal) return;
    try {
      await collab.listForRoot(parentRoot, { discover: true, refreshLimit: 8 });
      await publishFresh(parentRoot);
      void approveInteractions(thread.id);
    } catch (error) {
      bb.log.warn(
        `Could not register new child ${thread.id} on ${parentRoot}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  bb.events.on("thread.active", async ({ thread }) => {
    running.set(thread.id, true);
    if (store.get(thread.id) || collab.rowOf(thread.id)) {
      void approveInteractions(thread.id);
    }
    void registerNewChild(thread);
    const existing = store.get(thread.id);
    if (existing && (existing.status === "active" || existing.status === "budget_limited")) {
      const next = store.update(thread.id, { lastAccountedAt: Date.now() });
      if (next) publish(thread.id, await viewFresh(next));
    }
    const rootId = collab.rowOf(thread.id)?.root_thread_id;
    if (rootId && rootId !== thread.id) void publishFresh(rootId);
    if (usesNativeGoal(thread.providerId)) return;
    const rows = await readTimeline(thread.id);
    await applyUserSlash(thread.id, lastUserText(rows));
  });

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const child = collab.rowOf(thread.id);
    const parentRoot = child?.root_thread_id;
    const pendingInteraction = (thread as { hasPendingInteraction?: boolean })
      .hasPendingInteraction === true;
    if (pendingInteraction && (child || store.get(thread.id))) {
      const approved = await approveInteractions(thread.id);
      // Approval resumes the provider turn; let the next idle event finish up.
      if (approved > 0) return;
    }
    if (parentRoot && parentRoot !== thread.id && !pendingInteraction) {
      if (child.role !== "verifier") {
        if (completeItemFor(parentRoot, child.item_id, lastAssistantText)) {
          queueIntegration(parentRoot, thread.id, child.item_id);
        }
        await maybeVerifyWorker(thread.id);
      } else {
        const sourceItemId = child.source_thread_id
          ? (collab.rowOf(child.source_thread_id)?.item_id ?? child.item_id)
          : child.item_id;
        const passed = completeItemFor(parentRoot, sourceItemId, lastAssistantText, {
          requirePass: true,
        });
        if (passed && child.source_thread_id) {
          queueIntegration(parentRoot, child.source_thread_id, sourceItemId);
        }
        // A failed verdict goes back to the worker WITH the findings — a
        // blind resume just repeats the same mistake. Three failed cycles
        // hand the slice to the orchestrator instead of looping forever.
        // The verifier's runtime is done either way — release it. (Verifiers
        // were leaking one codex process per audit.)
        void releaseWorkerRuntime(thread.id);
        if (
          !passed &&
          child.source_thread_id &&
          /\bVERIFY_FAIL\b/i.test(lastAssistantText ?? "")
        ) {
          const fails = collab.bumpVerifyFails(child.source_thread_id);
          if (fails < MAX_VERIFY_FAILS) {
            try {
              await bb.sdk.threads.send({
                threadId: child.source_thread_id,
                mode: "auto",
                permissionMode: "full",
                input: [
                  {
                    type: "text",
                    text: [
                      `Your slice failed independent verification (attempt ${fails}/${MAX_VERIFY_FAILS}). The verifier's findings:`,
                      (lastAssistantText ?? "").slice(-1800),
                      "Address every finding, re-run your check, and end with ULTRAGOAL_DONE: <evidence — commit SHA(s) and the passing check output>.",
                    ].join("\n\n"),
                    mentions: [],
                  },
                ],
              });
              bb.log.info(
                `Routed VERIFY_FAIL ${fails}/${MAX_VERIFY_FAILS} to worker ${child.source_thread_id} on ${parentRoot}`,
              );
            } catch (error) {
              bb.log.warn(
                `Could not route VERIFY_FAIL to ${child.source_thread_id}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          } else {
            markGoalEvent(parentRoot);
            bb.log.warn(
              `Slice held by ${child.source_thread_id} failed verification ${fails}x on ${parentRoot}; leaving it to the orchestrator`,
            );
          }
        }
      }
      void publishFresh(parentRoot);
      void nudgeRoot(parentRoot);
    }
    if (usesNativeGoal(thread.providerId)) {
      bb.log.info(`Skipping Goal continue on ${thread.id}: native Codex Goal`);
      return;
    }
    const pendingInteractions = await bb.sdk.threads.interactions
      .list({ threadId: thread.id })
      .catch(() => []);
    if (Array.isArray(pendingInteractions) && pendingInteractions.length > 0) {
      bb.log.info(`Skipping Goal continue on ${thread.id}: pending interaction`);
      return;
    }

    const rows = await readTimeline(thread.id);
    const slash = parseSlashGoal(lastUserText(rows));
    if (slash) {
      await applyUserSlash(thread.id, lastUserText(rows));
      if (slash.kind === "clear" || slash.kind === "pause" || slash.kind === "status") return;
    }

    running.set(thread.id, false);
    const accounted = await account(thread.id, { evenIfIdle: true });
    let goal = accounted ?? store.get(thread.id);
    if (!goal) return;
    const snap = await viewFresh(goal);
    publish(thread.id, snap);
    if (goal.status !== "active" && goal.status !== "budget_limited") return;

    if (isBudgetExhausted(view(goal)) && goal.status === "active") {
      goal = applyStatus(thread.id, "budget_limited", "Reached the token budget.") ?? goal;
    }

    if (goal.lastContinueAt && Date.now() - goal.lastContinueAt < STALE_CONTINUE_MS) {
      return;
    }

    const latest = store.get(thread.id);
    if (!latest || (latest.status !== "active" && latest.status !== "budget_limited")) return;
    if (!view(latest).settings.autoContinue) {
      bb.log.info(`Skipping Goal continue on ${thread.id}: autoContinue disabled`);
      return;
    }
    if (latest.status === "budget_limited") {
      if (!latest.lastContinueWasAutomatic) {
        const sent = await sendSteering(thread.id, budgetLimitPrompt(view(latest)), "start");
        if (sent) store.update(thread.id, { lastContinueWasAutomatic: true, lastContinueAt: Date.now() });
      }
      return;
    }
    await continueIfIdle(thread.id, latest);
  });

  bb.events.on("thread.failed", async ({ thread, error }) => {
    running.set(thread.id, false);
    const failedChild = collab.rowOf(thread.id);
    if (failedChild && failedChild.root_thread_id !== thread.id) {
      markGoalEvent(failedChild.root_thread_id);
    }
    if (usesNativeGoal(thread.providerId)) return;
    const goal = store.get(thread.id);
    if (!goal || !isUnfinished(goal.status)) return;
    const usage = /usage|rate limit|quota/i.test(error ?? "");
    applyStatus(
      thread.id,
      usage ? "usage_limited" : "blocked",
      error ?? (usage ? "Usage limited" : "Turn error"),
    );
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    running.delete(thread.id);
    forgetNativeScan(thread.id);
    items.clear(thread.id);
    findings.clear(thread.id);
    decisions.clear(thread.id);
    if (store.clear(thread.id)) publish(thread.id, null);
  });

  const runCli = async (argv: string[], ctx: { threadId?: string }) => {
      const parsed = parseCli(argv, ctx.threadId);
      if (parsed.error) return { exitCode: 1, stderr: parsed.error };
      const { threadId, action, objective } = parsed;
      if (!threadId) {
        return { exitCode: 1, stderr: "Pass --thread <id> or run this from a thread." };
      }

      if (action === "status") {
        await account(threadId);
        const latest = store.get(threadId);
        return {
          exitCode: 0,
          stdout: latest ? formatGoalCard(view(latest)) : "No UltraGoal is set on this thread.",
        };
      }

      if (action === "pane") {
        // Debug window: the exact projection the sidebar renders, fresh.
        const goal = store.get(threadId);
        if (!goal) return { exitCode: 1, stderr: "No UltraGoal is set on this thread." };
        const snap = await viewFresh(goal);
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            {
              now: snap.now,
              next: snap.next,
              agents: snap.agents,
              tokens: snap.tokensUsed,
              findings: snap.findings,
            },
            null,
            2,
          ),
        };
      }

      if (action === "set") {
        if (!objective) return { exitCode: 1, stderr: "Usage: bb ultragoal set <objective>" };
        const result = await userSetGoal(threadId, objective);
        if ("error" in result) return { exitCode: 1, stderr: result.error };
        try {
          await sendSteering(threadId, continuationPrompt(view(result)), "start");
        } catch (error) {
          return {
            exitCode: 0,
            stdout: `${formatGoalCard(view(result))}\n\nCould not start a turn: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
        return { exitCode: 0, stdout: formatGoalCard(view(result)) };
      }

      if (action === "edit") {
        if (!objective) return { exitCode: 1, stderr: "Usage: bb ultragoal edit <objective>" };
        const goal = await editGoal(threadId, objective);
        return {
          exitCode: goal ? 0 : 1,
          stdout: goal ? formatGoalCard(view(goal)) : undefined,
          stderr: goal ? undefined : "No UltraGoal is set on this thread.",
        };
      }

      if (action === "decide") {
        const [decisionId, ...answerParts] = (objective ?? "").split(/\s+/);
        const answer = answerParts.join(" ").trim();
        if (!decisionId || !answer) {
          return { exitCode: 1, stderr: "Usage: bb ultragoal decide <decision_id> <answer> [--thread <id>]" };
        }
        const applied = await applyDecisionAnswer(threadId, decisionId, answer);
        if (!applied) return { exitCode: 1, stderr: `Decision not found: ${decisionId}` };
        return { exitCode: 0, stdout: `Decision ${decisionId} answered: ${answer}` };
      }

      if (action === "workers") {
        const parsed = Number.parseInt(objective ?? "", 10);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 16) {
          return { exitCode: 1, stderr: "Usage: bb ultragoal workers <0-16>" };
        }
        const goal = store.update(threadId, { maxWorkersOverride: parsed });
        if (!goal) return { exitCode: 1, stderr: "No UltraGoal is set on this thread." };
        publish(threadId, view(goal));
        void scheduleReady(threadId);
        return { exitCode: 0, stdout: formatGoalCard(view(goal)) };
      }

      if (action === "pause") {
        const goal = await pauseGoal(threadId, "Paused from the CLI.");
        return {
          exitCode: goal ? 0 : 1,
          stdout: goal ? formatGoalCard(view(goal)) : undefined,
          stderr: goal ? undefined : "No UltraGoal is set on this thread.",
        };
      }

      if (action === "resume") {
        const goal = await resumeGoal(threadId);
        return {
          exitCode: goal ? 0 : 1,
          stdout: goal ? formatGoalCard(view(goal)) : undefined,
          stderr: goal ? undefined : "No UltraGoal is set on this thread.",
        };
      }

      items.clear(threadId);
      findings.clear(threadId);
      decisions.clear(threadId);
      store.clear(threadId);
      publish(threadId, null);
      return { exitCode: 0, stdout: "UltraGoal cleared." };
  };

  bb.cli.register({
    name: "ultragoal",
    summary: "Set, inspect, pause, resume, or clear a durable UltraGoal",
    commands: [
      { name: "status", summary: "Show the UltraGoal on a thread", usage: "bb ultragoal [status] [--thread <id>]" },
      { name: "pane", summary: "Dump the sidebar projection as JSON", usage: "bb ultragoal pane [--thread <id>]" },
      { name: "set", summary: "Set or replace the UltraGoal", usage: "bb ultragoal set <objective> [--thread <id>]" },
      { name: "edit", summary: "Edit the UltraGoal objective", usage: "bb ultragoal edit <objective> [--thread <id>]" },
      { name: "workers", summary: "Set the goal's concurrent worker slots", usage: "bb ultragoal workers <0-16> [--thread <id>]" },
      { name: "decide", summary: "Answer an open owner decision", usage: "bb ultragoal decide <decision_id> <answer> [--thread <id>]" },
      { name: "pause", summary: "Pause the UltraGoal", usage: "bb ultragoal pause [--thread <id>]" },
      { name: "resume", summary: "Resume a paused UltraGoal", usage: "bb ultragoal resume [--thread <id>]" },
      { name: "clear", summary: "Clear the UltraGoal", usage: "bb ultragoal clear [--thread <id>]" },
    ],
    run: runCli,
  });

  bb.background.service("progress-pulse", {
    async start(signal) {
      while (!signal.aborted) {
        await pulseStaleProgress();
        await sleep(20_000, signal);
      }
    },
  });

  bb.background.service("approval-pulse", {
    async start(signal) {
      while (!signal.aborted) {
        await approvalPulse();
        await sleep(5_000, signal);
      }
    },
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function parseCli(
  argv: string[],
  fallbackThreadId: string | undefined,
): {
  action: "status" | "pane" | "set" | "edit" | "pause" | "resume" | "clear" | "workers" | "decide";
  threadId: string | undefined;
  objective?: string;
  error?: string;
} {
  let threadId = fallbackThreadId;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--thread" || arg === "-t") {
      threadId = argv[i + 1];
      i += 1;
      continue;
    }
    rest.push(arg);
  }

  const action = rest[0];
  if (!action || action === "status") {
    return { action: "status", threadId };
  }
  if (action === "set" || action === "edit" || action === "workers" || action === "decide") {
    return { action, threadId, objective: rest.slice(1).join(" ").trim() };
  }
  if (action === "pane" || action === "pause" || action === "resume" || action === "clear") {
    return { action, threadId };
  }
  return { action: "status", threadId, error: `Unknown goal command: ${action}` };
}

type CatalogModel = { id: string; displayName: string; description?: string };
type CatalogProvider = {
  id: string;
  displayName: string;
  available: boolean;
  models: CatalogModel[];
};

type ExecutionOptions = Awaited<ReturnType<BbPluginApi["sdk"]["system"]["executionOptions"]>>;

async function listExecutionCatalog(
  bb: BbPluginApi,
  threadId?: string,
): Promise<CatalogProvider[]> {
  let environmentId: string | undefined;
  if (threadId) {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      environmentId = thread.environmentId ?? undefined;
    } catch {
      // Catalog still loads from the primary host.
    }
  }

  const scope = environmentId ? { environmentId } : {};
  let providers: Array<{ id: string; displayName: string; available?: boolean }> = [];
  try {
    const options = await bb.sdk.system.executionOptions(scope);
    providers = options.providers ?? [];
  } catch {
    providers = await bb.sdk.providers.list(scope).catch(() => []);
  }

  if (providers.length === 0) {
    return [
      {
        id: DEFAULT_VERIFY_PROVIDER,
        displayName: "Codex",
        available: true,
        models: [{ id: DEFAULT_VERIFY_MODEL, displayName: "GPT-5.6-Sol" }],
      },
    ];
  }

  return Promise.all(
    providers.map(async (provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      available: provider.available !== false,
      models: await listProviderModels(bb, provider.id, environmentId),
    })),
  );
}

async function listProviderModels(
  bb: BbPluginApi,
  providerId: string,
  environmentId?: string,
): Promise<CatalogModel[]> {
  const args = environmentId ? { providerId, environmentId } : { providerId };
  try {
    return modelsFromOptions(await bb.sdk.system.executionOptions(args), providerId);
  } catch {
    try {
      return modelsFromOptions(await bb.sdk.providers.models(args), providerId);
    } catch {
      return [];
    }
  }
}

function modelsFromOptions(options: ExecutionOptions, providerId: string): CatalogModel[] {
  const rows = [...(options.models ?? []), ...(options.selectedOnlyModels ?? [])];
  return uniqueModels(
    rows
      .filter((model) => !model.routeProviderId || model.routeProviderId === providerId)
      .map((model) => ({
        id: model.model || model.id,
        displayName: model.displayName,
        // Spread, not `description: undefined` — the rpc validator rejects
        // explicit undefined values.
        ...(model.description ? { description: model.description } : {}),
      })),
  );
}

function uniqueModels(
  models: CatalogProvider["models"],
): CatalogProvider["models"] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}
