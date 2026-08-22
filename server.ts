import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rpcContract, type GoalAgent, type GoalSnapshot, type GoalStatus } from "./contract.js";
import { accountGoalProgress, readThreadTokens, threadIsRunning } from "./lib/accounting.js";
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
import { createItemStore, type ItemStore } from "./lib/items.js";
import { currentSliceTitle, shortSliceTitle } from "./lib/titles.js";
import { extractCompleted, seedPlanFromOutput } from "./lib/plan-seed.js";
import {
  createGoalStore,
  validateObjective,
  type StoredGoal,
} from "./lib/store.js";
import {
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
): GoalSnapshot {
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
    items: items.list(goal.threadId),
    agents,
    settings: resolveGoalSettings(
      {
        verifyEnabled: goal.verifyEnabledOverride,
        verifyProvider: goal.verifyProviderOverride,
        verifyModel: goal.verifyModelOverride,
        autoContinue: goal.autoContinueOverride,
        progressUpdateMinutes: goal.progressUpdateMinutesOverride,
      },
      snapshotDefaults,
    ),
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
    };
  }
  void refreshDefaults();
  settings.onChange(() => {
    void refreshDefaults();
  });

  const store = createGoalStore(bb);
  const items = createItemStore(bb);
  const agentCache = new Map<string, GoalAgent[]>();
  const inflight = new Set<string>();
  const running = new Map<string, boolean>();
  let publishFresh: (threadId: string) => Promise<void> = async () => {};
  const collab = createCollabStore(bb, {
    onChange: (rootThreadId) => {
      void publishFresh(rootThreadId);
    },
    retitleItem(rootThreadId, itemId, message) {
      const line =
        message
          .trim()
          .split(/\n/)[0]
          ?.replace(/^#+\s*/, "")
          .trim() ?? "";
      const title = currentSliceTitle(line);
      if (title.length < 8 || title.length > 180) return;
      if (/^(you are|parent goal|assigned slice|complete only|the new agent's)/i.test(title)) {
        return;
      }
      items.updateStep(rootThreadId, itemId, title);
      collab.setWorkTitleForItem(rootThreadId, itemId, title);
    },
    nextItemId(rootThreadId) {
      const used = new Set(
        (agentCache.get(rootThreadId) ?? [])
          .map((agent) => agent.itemId)
          .filter((id): id is string => Boolean(id)),
      );
      const open = items.list(rootThreadId).filter((item) => item.status !== "completed");
      return (
        open.find((item) => item.status === "pending" && !used.has(item.id))?.id ??
        open.find((item) => !used.has(item.id))?.id ??
        null
      );
    },
  });

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
        await seedEmptyPlan(threadId, goal);
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
    return snapshotOf(goal, items, goalIsBusy(goal.threadId, agents), agents);
  }

  function isRootNativeAgent(rootThreadId: string, agent: GoalAgent): boolean {
    return agent.threadId === rootThreadId && agent.taskName.startsWith("task/");
  }

  function assignLiveAgents(threadId: string, agents: GoalAgent[]): GoalAgent[] {
    const open = items.list(threadId).filter((item) => item.status !== "completed");
    const next = agents.map((agent) => ({ ...agent }));
    const claimed = new Set<string>();
    const assignable = (agent: GoalAgent) =>
      agent.role !== "verifier" &&
      !isRootNativeAgent(threadId, agent) &&
      agent.status !== "stopped" &&
      agent.status !== "completed" &&
      agent.status !== "error";
    for (const agent of next) {
      if (isRootNativeAgent(threadId, agent)) continue;
      if (agent.itemId && open.some((item) => item.id === agent.itemId) && !claimed.has(agent.itemId)) {
        claimed.add(agent.itemId);
        const item = open.find((row) => row.id === agent.itemId);
        if (item?.status === "pending" && assignable(agent)) {
          items.setStatus(threadId, item.id, "in_progress");
        }
        continue;
      }
      if (!assignable(agent)) continue;
      if (agent.itemId && claimed.has(agent.itemId)) agent.itemId = null;
      const match =
        open.find((item) => item.status === "in_progress" && !claimed.has(item.id)) ??
        open.find((item) => item.status === "pending" && !claimed.has(item.id)) ??
        open.find((item) => !claimed.has(item.id));
      if (!match) continue;
      collab.setMeta(agent.threadId, { itemId: match.id });
      agent.itemId = match.id;
      claimed.add(match.id);
      if (match.status === "pending") items.setStatus(threadId, match.id, "in_progress");
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

  async function viewFresh(goal: StoredGoal): Promise<GoalSnapshot> {
    try {
      const listed = await collab.listForRoot(goal.threadId);
      const assigned = assignLiveAgents(goal.threadId, listed);
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
      agentCache.set(goal.threadId, assigned);
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
  const MAX_PARALLEL_WORKERS = 4;

  async function ensureCrew(threadId: string): Promise<void> {
    const goal = store.get(threadId);
    if (!goal || (goal.status !== "active" && goal.status !== "budget_limited")) return;
    if (staffing.has(threadId)) return;
    staffing.add(threadId);
    try {
      const snap = await viewFresh(store.get(threadId) ?? goal);
      const open = snap.items.filter((item) => item.status !== "completed");
      if (open.length === 0) return;
      for (const agent of snap.agents.filter((row) => row.role === "worker")) {
        if (agent.status !== "error" && agent.status !== "unknown") continue;
        collab.forget(agent.threadId);
        try {
          await bb.sdk.threads.stop({ threadId: agent.threadId });
        } catch {
          // Failed forks can be dropped from the Goal store even if stop is unavailable.
        }
      }
      const latest = await viewFresh(store.get(threadId) ?? goal);
      const workers = latest.agents.filter((agent) => agent.role === "worker");
      const staffed = new Set(
        workers
          .filter((agent) => agent.itemId && agent.status !== "error" && agent.status !== "unknown")
          .map((agent) => agent.itemId as string),
      );
      const live = workers.filter(
        (agent) => agent.status === "running" || agent.status === "starting",
      ).length;
      const slots = Math.max(0, MAX_PARALLEL_WORKERS - live);
      if (slots === 0) return;
      const needs = open.filter((item) => !staffed.has(item.id)).slice(0, slots);
      for (const item of needs) {
        if (item.status === "pending") items.setStatus(threadId, item.id, "in_progress");
        const spawned = await collab.spawnWorker({
          rootThreadId: threadId,
          itemId: item.id,
          step: item.step,
          objective: goal.objective,
        });
        if (spawned) {
          staffed.add(item.id);
          bb.log.info(`Goal worker ${spawned.nickname} assigned to ${item.id} on ${threadId}`);
        }
      }
      if (needs.length > 0) await viewFresh(store.get(threadId) ?? goal);
    } catch (error) {
      bb.log.warn(
        `Could not staff Goal crew on ${threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      staffing.delete(threadId);
    }
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
    const current = store.get(threadId);
    if (current) await seedEmptyPlan(threadId, current);
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

  async function seedEmptyPlan(threadId: string, goal: StoredGoal): Promise<void> {
    if (items.list(threadId).length > 0) {
      await hydrateCompleted(threadId);
      return;
    }
    try {
      const result = await bb.sdk.threads.output({ threadId });
      const seeded = seedPlanFromOutput(result.output, goal.reason);
      if (seeded.length === 0) return;
      items.replace(threadId, seeded);
      const latest = store.get(threadId);
      if (latest) publish(threadId, view(latest));
      bb.log.info(`Seeded ${seeded.length} Goal plan items on ${threadId} from last output`);
    } catch (error) {
      bb.log.warn(
        `Could not seed Goal plan on ${threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async function hydrateCompleted(threadId: string): Promise<void> {
    try {
      const result = await bb.sdk.threads.output({ threadId });
      const completed = extractCompleted(result.output);
      if (completed.length === 0) return;
      const before = items.list(threadId).length;
      items.merge(threadId, completed);
      if (items.list(threadId).length === before) return;
      const latest = store.get(threadId);
      if (latest) publish(threadId, view(latest));
    } catch {
      // Completed-item hydration is best-effort.
    }
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
        input: [{ type: "text", text, visibility: "agent-only" }],
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
        await requestProgressUpdate(threadId, goal);
        const accounted = await account(threadId, { busy: goalIsBusy(threadId), scan: true });
        if (accounted) publish(threadId, view(accounted));
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
      const crews = [];
      for (const threadId of store.listActiveThreadIds()) {
        const goal = store.get(threadId);
        if (!goal) continue;
        const snap = view(goal);
        crews.push({
          threadId,
          items: snap.items,
          agents: snap.agents,
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
      await refreshRunning(threadId);
      const accounted = await account(threadId);
      const goal = accounted ?? store.get(threadId);
      return goalToolResponse(goal ? await viewFresh(goal) : null);
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
      const next = applyStatus(threadId, status, null);
      return goalToolResponse(next ? view(next) : null, status === "complete");
    },
  });

  bb.agents.registerTool({
    name: "update_plan",
    description: `Updates the task plan.
Provide an optional explanation and a list of plan items, each with a step and status.
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
          }),
        )
        .describe("The list of steps"),
    }),
    async execute({ plan }, { threadId }) {
      bb.log.info(`update_plan on ${threadId}: ${plan.length} steps`);
      items.replace(threadId, plan);
      const goal = store.get(threadId);
      const next = goal ? await viewFresh(goal) : null;
      if (next) publish(threadId, next);
      void ensureCrew(threadId);
      return "Plan updated";
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
                "Complete only the slice you were assigned. Report evidence when done.",
                "Do not call update_goal, do not rewrite the parent plan, and do not take over the whole Goal.",
                "You may spawn nested helpers for your slice if it splits cleanly.",
              ].join("\n")
          : undefined;
      return {
        tools: [...COLLAB_TOOL_NAMES],
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
              : "No subagents are live. Spawn one worker per in-progress slice before doing the work yourself.",
            "Call spawn_agent for each in-progress slice in this turn. Give each a humorous display_name and the item_id from get_goal.",
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
        ...COLLAB_TOOL_NAMES,
      ],
      skills: ["ultragoal"],
      instructions: live,
    };
  });

  bb.events.on("thread.active", async ({ thread }) => {
    running.set(thread.id, true);
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

  bb.events.on("thread.idle", async ({ thread }) => {
    const child = collab.rowOf(thread.id);
    const parentRoot = child?.root_thread_id;
    if (parentRoot && parentRoot !== thread.id && !thread.hasPendingInteraction) {
      if (child.role !== "verifier") await maybeVerifyWorker(thread.id);
      void publishFresh(parentRoot);
      void nudgeRoot(parentRoot);
    }
    if (usesNativeGoal(thread.providerId)) {
      bb.log.info(`Skipping Goal continue on ${thread.id}: native Codex Goal`);
      return;
    }
    if (thread.hasPendingInteraction) {
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
    items.clear(thread.id);
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
        const goal = (await account(threadId)) ?? store.get(threadId);
        if (goal) await seedEmptyPlan(threadId, goal);
        const latest = store.get(threadId);
        return {
          exitCode: 0,
          stdout: latest ? formatGoalCard(view(latest)) : "No UltraGoal is set on this thread.",
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
      store.clear(threadId);
      publish(threadId, null);
      return { exitCode: 0, stdout: "UltraGoal cleared." };
  };

  bb.cli.register({
    name: "ultragoal",
    summary: "Set, inspect, pause, resume, or clear a durable UltraGoal",
    commands: [
      { name: "status", summary: "Show the UltraGoal on a thread", usage: "bb ultragoal [status] [--thread <id>]" },
      { name: "set", summary: "Set or replace the UltraGoal", usage: "bb ultragoal set <objective> [--thread <id>]" },
      { name: "edit", summary: "Edit the UltraGoal objective", usage: "bb ultragoal edit <objective> [--thread <id>]" },
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
  action: "status" | "set" | "edit" | "pause" | "resume" | "clear";
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
  if (action === "set" || action === "edit") {
    return { action, threadId, objective: rest.slice(1).join(" ").trim() };
  }
  if (action === "pause" || action === "resume" || action === "clear") {
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

  const scope = { environmentId };
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
  const args = { providerId, environmentId };
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
        description: model.description || undefined,
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
