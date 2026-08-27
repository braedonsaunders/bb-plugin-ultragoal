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
import {
  createFindingStore,
  findingRegistrationCliMessage,
  findingRegistrationOutcome,
  type RemediationFinding,
} from "./lib/findings.js";
import {
  formatLinkedDefectBrief,
  missingLinkedDefectEvidenceIds,
  parseDefectCoverageEvidence,
  parseVerifierVerdict,
  type FindingAffirmativeEvidence,
} from "./lib/finding-brief.js";
import { workRelatedName } from "./lib/names.js";
import { createItemStore, type ItemStore } from "./lib/items.js";
import {
  forgetNativeScan,
  hasPendingNativeTasks,
  listLiveNativeTasks,
  type LiveNativeTask,
} from "./lib/native-sync.js";
import { currentSliceTitle, shortSliceTitle } from "./lib/titles.js";
import { createWorkerBriefStore, withStandingBrief } from "./lib/worker-brief.js";
import {
  createItemRequirementStore,
  missingDeliverables,
  parseDeliverableEvidence,
} from "./lib/deliverables.js";
import { remediationItemRetirement } from "./lib/remediation-retirement.js";
import { createStaffingHoldStore } from "./lib/staffing-hold.js";
import { createIntegrationRecordStore } from "./lib/integration-record.js";
import { hostContract } from "./host-contract.js";
import { projectPane } from "./lib/projection.js";
import {
  filesOverlap,
  finishedWorkerRetirementCandidates,
  freeSlots,
  ownSliceScope,
  retirementPermittedByHost,
  liveVerifierCount,
  occupyingWorkerIds,
  orphanInProgressIds,
  isTransientTurnFailure,
  isTurnAlreadyActiveError,
  normalizeFindingFile,
  planWorkerRelease,
  setSharedInfrastructureFiles,
  type ReleaseTarget,
  threadAcceptsStart,
  threadAcceptsSteer,
  immediateSendMode,
  threadIsSettledForSubmit,
  verifierStillDeciding,
} from "./lib/scheduler.js";
import {
  closeFindingsForCompletedItem,
  detachStaleFindingLinks,
  reconcileFindingQueue,
} from "./lib/finding-queue.js";
import { createRootTransferStore, executeRootTransfer } from "./lib/root-transfer.js";
import { projectSidebarCrew } from "./lib/sidebar.js";

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
  DEFAULT_MAX_OPEN_FINDINGS,
  DEFAULT_MAX_WORKERS,
  DEFAULT_PROGRESS_UPDATE_MINUTES,
  DEFAULT_VERIFY_MODEL,
  DEFAULT_VERIFY_PROVIDER,
  normalizePermissionMode,
  resolveGoalSettings,
  type GoalSettingDefaults,
} from "./lib/goal-settings.js";
import {
  BRAND_PREFIX,
  catalogModelsFromOptions,
  type CatalogModel,
  type CatalogProvider,
} from "./lib/execution.js";
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
  findings: GoalSnapshot["findings"],
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
        verifyReasoning: goal.verifyReasoningOverride,
        verifyServiceTier: goal.verifyServiceTierOverride,
        autoContinue: goal.autoContinueOverride,
        progressUpdateMinutes: goal.progressUpdateMinutesOverride,
        maxWorkers: goal.maxWorkersOverride,
        maxOpenFindings: null,
        workerProvider: goal.workerProviderOverride,
        workerModel: goal.workerModelOverride,
        workerReasoning: goal.workerReasoningOverride,
        workerServiceTier: goal.workerServiceTierOverride,
      },
      snapshotDefaults,
    ),
    findings,
    decisions,
    completionSummary: goal.completionSummary,
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
  maxOpenFindings: DEFAULT_MAX_OPEN_FINDINGS,
  autoApproveAgentRequests: false,
  workerPermissionMode: "auto",
  reclaimMergedWorktrees: true,
  shareWorktreeNodeModules: true,
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
      description: "Ready-queue slot count: assigned workers occupy a slot until their slice closes, including idle Codex turns. Default 5.",
      default: String(DEFAULT_MAX_WORKERS),
    },
    sharedInfrastructureFiles: {
      type: "string",
      label: "Shared infrastructure files (comma-separated)",
      description: "Repository paths that nearly every slice touches — a pinned schema inventory, a generated manifest — and so cannot prove which defect owns a change. Listing them here stops unrelated defects coalescing onto one file. Ecosystem manifests such as package.json are always included.",
      default: "",
    },
    reclaimMergedWorktrees: {
      type: "boolean",
      label: "Delete a slice's worktree once its work is merged",
      description:
        "This plugin creates one worktree per slice and used to remove none of them: 217 worktrees and 9.9 GB accumulated for a goal with 177 completed slices. A worktree is removed only after its commits are on the base branch, and never when the checkout is dirty.",
      default: true,
    },
    shareWorktreeNodeModules: {
      type: "boolean",
      label: "Share node_modules between worktrees by reference",
      description:
        "Thirteen worktrees each installed the same 1.1 GB dependency tree. Where the filesystem supports copy-by-reference (APFS, Btrfs), each worktree gets a real, independent node_modules that costs nothing until it diverges.",
      default: true,
    },
    autoApproveAgentRequests: {
      type: "boolean",
      label: "Automatically approve agent command, file and permission requests",
      description:
        "OFF by default, and it should stay off unless you are deliberately running unattended. When on, this plugin resolves approval prompts on the goal's own threads for you — that is a real approval boundary being crossed on your behalf, not a convenience toggle. User questions are never answered automatically.",
      default: false,
    },
    workerPermissionMode: {
      type: "string",
      label: "Permission mode for spawned workers (auto | accept-edits | full)",
      description:
        "Defaults to auto, so a worker's risky actions still reach the normal approval gate. Set to full only for a deliberately unattended run.",
      default: "auto",
    },
    maxOpenFindings: {
      type: "string",
      label: "Remediation work capacity per goal",
      description: "Additional defects await assignment once this many distinct remediation work items exist, then backfill oldest-first as capacity opens. Related defects can share one work item. Default 50.",
      default: String(DEFAULT_MAX_OPEN_FINDINGS),
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
      maxOpenFindings: parsePositiveInt(value.maxOpenFindings) ?? DEFAULT_MAX_OPEN_FINDINGS,
      autoApproveAgentRequests: value.autoApproveAgentRequests === true,
      reclaimMergedWorktrees: value.reclaimMergedWorktrees !== false,
      shareWorktreeNodeModules: value.shareWorktreeNodeModules !== false,
      workerPermissionMode: normalizePermissionMode(value.workerPermissionMode),
    };
    // Which files count as shared infrastructure is a property of the
    // repository being worked on, not of this plugin, so it arrives as
    // configuration and is re-read whenever defaults refresh.
    setSharedInfrastructureFiles(
      value.sharedInfrastructureFiles.split(",").map((entry) => entry.trim()).filter(Boolean),
    );
  }
  void refreshDefaults();
  settings.onChange(() => {
    void refreshDefaults();
  });

  const store = createGoalStore(bb);
  const items = createItemStore(bb);
  const findings = createFindingStore(bb);
  const decisions = createDecisionStore(bb);
  const rootTransfers = createRootTransferStore(bb);
  const agentCache = new Map<string, GoalAgent[]>();
  /** Open native task calls per root, from the last fresh scan. */
  const liveTaskCounts = new Map<string, number>();
  const inflight = new Set<string>();
  const starting = new Map<string, number>();
  const running = new Map<string, boolean>();
  let publishFresh: (threadId: string) => Promise<void> = async () => {};
  let workersOnItem = (_rootThreadId: string, _itemId: string): string[] => [];
  let itemClaimants = (_rootThreadId: string, _itemId: string): string[] => [];
  const linkedOpenFindings = (rootThreadId: string, itemId: string): RemediationFinding[] =>
    findings
      .remediationQueue(rootThreadId)
      .filter((finding) => finding.itemId === itemId);
  const linkedDefectBrief = (rootThreadId: string, itemId: string): string =>
    formatLinkedDefectBrief(linkedOpenFindings(rootThreadId, itemId));
  const workerBriefs = createWorkerBriefStore(bb.storage.database());
  const itemRequirements = createItemRequirementStore(bb.storage.database());
  const staffingHolds = createStaffingHoldStore(bb.storage.database());
  const integrations = createIntegrationRecordStore(bb.storage.database());

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
      const existingGoal = store.get(rootThreadId);
      if (existingGoal?.status === "paused") return null;
      // An explicit item reference is the strongest claim: the item's own step
      // text is authoritative and is never rewritten from the message.
      const preferred = itemId
        ? items.list(rootThreadId).find((item) => item.id === itemId)
        : undefined;
      if (preferred && preferred.status !== "completed") {
        const occupants = itemClaimants(rootThreadId, preferred.id);
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
              : itemClaimants(rootThreadId, item.id).length === 0),
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
      if (!goal) return { providerId: null, model: null, reasoningLevel: null, serviceTier: null };
      const resolved = view(goal).settings;
      return {
        providerId: resolved.workerProvider || null,
        model: resolved.workerModel || null,
        reasoningLevel: resolved.workerReasoning || null,
        serviceTier: resolved.workerServiceTier,
      };
    },
    itemBrief(rootThreadId, itemId) {
      const item = items.list(rootThreadId).find((entry) => entry.id === itemId);
      if (!item) return null;
      return {
        files: item.files,
        check: item.check,
        linkedDefects: linkedDefectBrief(rootThreadId, itemId),
      };
    },
    releaseItem(rootThreadId, itemId, reason) {
      // Same effect as `bb ultragoal release`, reachable by the orchestrator
      // that can actually see a worker is redundant.
      items.setStatus(rootThreadId, itemId, "pending");
      markGoalEvent(rootThreadId);
      bb.log.info(`Orchestrator released ${itemId} on ${rootThreadId}: ${reason}`);
      void publishFresh(rootThreadId);
      void scheduleReady(rootThreadId);
    },
    workerPermissionMode: () => snapshotDefaults.workerPermissionMode,
    onRejectedChild(rootThreadId, childThreadId, itemId) {
      if (itemId) {
        const otherClaimants = itemClaimants(rootThreadId, itemId).filter(
          (claimant) => claimant !== childThreadId,
        );
        const item = items.list(rootThreadId).find((entry) => entry.id === itemId);
        if (otherClaimants.length === 0 && item?.status === "in_progress") {
          items.setStatus(rootThreadId, itemId, "pending");
        }
      }
      markGoalEvent(rootThreadId);
      void publishFresh(rootThreadId);
    },
  });
  workersOnItem = (rootThreadId, itemId) => collab.workersOnItem(rootThreadId, itemId);
  itemClaimants = (rootThreadId, itemId) => collab.claimantsOnItem(rootThreadId, itemId);

  function transferLocked(threadId: string): boolean {
    const rootThreadId = collab.rowOf(threadId)?.root_thread_id ?? threadId;
    return rootTransfers.isLocked(threadId) || rootTransfers.isLocked(rootThreadId);
  }

  function publish(threadId: string, goal: GoalSnapshot | null): void {
    bb.realtime.publish("ultragoal", { threadId, goal });
  }

  function account(
    threadId: string,
    options?: { evenIfIdle?: boolean; busy?: boolean; force?: boolean; scan?: boolean },
  ) {
    return accountGoalProgress(bb, store, threadId, {
      ...options,
      // A transferred goal still owns its prior root provider sessions.
      // Scan those before workers so bounded reload scans restore the root
      // provenance first, while the durable token total remains a floor.
      extraThreadIds: [
        ...(store.get(threadId)?.accountingThreadIds ?? []),
        ...collab.threadIdsForRoot(threadId),
      ],
      // A goal's usage is the sum over every session it ever ran, and
      // one-agent-per-slice retires far more sessions than it keeps. Retired
      // ones are backfilled a few per tick and then never re-read.
      historicalThreadIds: collab.allThreadIdsForRoot(threadId),
    });
  }

  const paneRefresh = new Set<string>();
  function refreshPane(threadId: string): void {
    if (transferLocked(threadId)) return;
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
  // the model PLANS — ultragoal_patch emits work with deps/files/check — and this
  // deterministic code SCHEDULES: every pending slice whose deps are complete
  // and whose file scope is disjoint from in-flight work gets a fresh worker,
  // up to maxWorkers, the moment a slot frees. Items without DAG metadata
  // (legacy plans, native mirrors) keep the old nudge-based staffing.
  const STAFF_RETRY_MS = 5 * 60_000;
  const lastStaffTry = new Map<string, number>();
  const scheduling = new Set<string>();

  function itemBriefMessage(rootThreadId: string, item: GoalItem, restaffed: boolean): string {
    const lines = [`SLICE (item_id=${item.id}): ${item.step}`];
    if (restaffed) {
      lines.push(
        `The previous worker on this slice died mid-work. Its partial work may exist on a prior slice branch — run \`git branch -a | grep ${item.id.replace(/_/g, "-")}\` (bb names slice branches after the item id) and continue from the furthest branch by checking it out or cherry-picking, rather than redoing the work. Give your commits their own subjects describing what THEY add — never repeat a prior commit's subject.`,
      );
    }
    if (item.files.length > 0) {
      lines.push(
        `Scope: touch only files within: ${item.files.join(", ")}. If the slice requires edits outside this scope, stop and report ULTRAGOAL_BLOCKED with the reason instead of expanding scope.`,
      );
    }
    const requiredPaths = itemRequirements.list(rootThreadId, item.id);
    if (requiredPaths.length > 0) {
      lines.push(
        `Required outputs — this slice cannot close without them. Scope above is what you MAY touch; these are what you MUST produce: ${requiredPaths.join(", ")}. Account for each one with an exact line: DELIVERABLE: {"path":"<path>","proof":"what it does and how you verified it"}. Prose describing the work does not count, a missing line refuses the completion, and if you cannot produce one, report ULTRAGOAL_BLOCKED saying which and why.`,
      );
    }
    lines.push(
      item.check
        ? `Done-check: \`${item.check}\` must pass. Run it yourself and include its result in your slice_done evidence.`
        : "Define a machine-checkable done criterion first (a failing test where applicable), make it pass, and include the command and its output in your slice_done evidence.",
    );
    lines.push(
      "Dispatched by the UltraGoal scheduler: this slice's dependencies are complete. Work only this slice.",
    );
    return lines.join("\n\n");
  }

  /** A plugin reload starts with an empty in-memory cache while durable
   * collaboration rows and their BB threads remain alive. Scheduling must
   * rebuild that ownership view before it calculates slots or decides an
   * in-progress item was abandoned. */
  async function hydrateSchedulerOwnership(rootThreadId: string): Promise<boolean> {
    if (agentCache.has(rootThreadId)) return true;
    try {
      const listed = await collab.listForRoot(rootThreadId, {
        discover: true,
        refreshLimit: 24,
        refreshHolders: true,
      });
      const assigned = assignLiveAgents(rootThreadId, listed);
      applyDeclaredWorkers(rootThreadId, assigned);
      agentCache.set(rootThreadId, assigned);
      return true;
    } catch (error) {
      bb.log.warn(
        `Scheduler ownership hydration failed on ${rootThreadId}; staffing held closed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  async function scheduleReady(rootThreadId: string): Promise<void> {
    if (transferLocked(rootThreadId)) return;
    const goal = store.get(rootThreadId);
    if (
      !goal ||
      (goal.status !== "active" && goal.status !== "budget_limited" && goal.status !== "blocked")
    ) {
      return;
    }
    if (scheduling.has(rootThreadId)) return;
    scheduling.add(rootThreadId);
    try {
      const maxWorkers = view(goal).settings.maxWorkers;
      if (!collab.setWorkerCap(rootThreadId, maxWorkers)) return;
      if (!(await hydrateSchedulerOwnership(rootThreadId))) return;
      if (maxWorkers <= 0) return;
      const agents = agentCache.get(rootThreadId) ?? [];
      const list = items.list(rootThreadId);
      const openItemIds = new Set(
        list.filter((item) => item.status !== "completed").map((item) => item.id),
      );
      const occupied = occupyingWorkerIds(agents, openItemIds);
      let slots = freeSlots(maxWorkers, occupied.length);
      if (slots <= 0) return;
      const completedIds = new Set(
        list.filter((item) => item.status === "completed").map((item) => item.id),
      );
      const heldLive = new Set(
        agents
          .filter(
            (agent) =>
              agent.role !== "verifier" &&
              agent.itemId &&
              openItemIds.has(agent.itemId) &&
              agent.status !== "error" &&
              agent.status !== "stopped",
          )
          .map((agent) => agent.itemId as string),
      );
      const inFlightFiles = list
        .filter((item) => item.status !== "completed" && heldLive.has(item.id))
        .flatMap((item) => item.files);
      const now = Date.now();
      let staffed = false;
      for (const item of list) {
        if (slots <= 0) break;
        if (item.status === "completed" || heldLive.has(item.id)) continue;
        // Held out of scheduling while its contract is rewritten. Without this
        // a released slice is re-staffed within seconds under the same wrong
        // brief, and the only way to edit one item was to pause the whole goal.
        if (staffingHolds.isHeld(rootThreadId, item.id)) continue;
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
        const durableHolderIds = collab.workersOnItem(rootThreadId, item.id);
        let restaffed = false;
        if (item.status === "pending") {
          // Any prior worker row means this slice was staffed before; its
          // completion/reconcile path owns it, not fresh staffing.
          if (holders.length > 0 || durableHolderIds.length > 0) {
            continue;
          }
        } else {
          // Only a holder observed explicitly error/stopped is dead. Unknown
          // after a transient host lookup, idle, and completed-but-unharvested
          // are all ownership states that must survive a plugin reload.
          if (holders.some((agent) => agent.status !== "error" && agent.status !== "stopped")) {
            continue;
          }
          const observedHolderIds = new Set(holders.map((holder) => holder.threadId));
          if (durableHolderIds.some((threadId) => !observedHolderIds.has(threadId))) continue;
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
        const still = store.get(rootThreadId);
        if (
          !still ||
          (still.status !== "active" && still.status !== "budget_limited" && still.status !== "blocked")
        ) {
          return;
        }
        let result: Awaited<ReturnType<typeof collab.spawnWorker>>;
        try {
          result = await collab.spawnWorker({
            parentThreadId: rootThreadId,
            itemId: item.id,
            maxWorkers,
            displayName: workRelatedName(
              item.step,
              agents.map((agent) => agent.nickname),
            ),
            message: itemBriefMessage(rootThreadId, item, restaffed),
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
          const spawnedRow = collab.rowOf(result.threadId);
          if (result.itemId !== item.id || spawnedRow?.item_id !== item.id) {
            collab.forget(result.threadId);
            void releaseWorkerRuntime(result.threadId);
            bb.log.warn(
              `Scheduler rejected worker ${result.threadId}: intended ${item.id}, returned ${
                result.itemId ?? "no item"
              }, persisted ${spawnedRow?.item_id ?? "no item"}`,
            );
            if (item.status === "pending") items.setStatus(rootThreadId, item.id, "pending");
            continue;
          }
          slots -= 1;
          staffed = true;
          markGoalEvent(rootThreadId);
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
  const hostClient = bb.hosts.experimental_client({ contract: hostContract });
  const integrating = new Map<string, Promise<void>>();
  const INTEGRATION_STEER_COOLDOWN_MS = 30 * 60_000;
  const integrationSteerAt = new Map<string, number>();

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
  const decisionPromptBackoff = new Map<string, number>();
  const DECISION_PROMPT_BACKOFF_MS = 10 * 60_000;

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
      (await threadIsRunning(bb, rootThreadId)) ? "steer" : "start",
    );
    return true;
  }

  function raiseDecisionPrompt(rootThreadId: string, decisionId: string): void {
    if (decisionKeepers.has(decisionId) || decisionDismissed.has(decisionId)) return;
    const failedAt = decisionPromptBackoff.get(decisionId);
    if (failedAt != null && Date.now() - failedAt < DECISION_PROMPT_BACKOFF_MS) return;
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
            // The interaction title caps at 160 chars; the card body renders
            // the full question from the payload.
            const title =
              current.question.length > 160
                ? `${current.question.slice(0, 157)}...`
                : current.question;
            result = await bb.ui.requestInput(
              {
                threadId: rootThreadId,
                rendererId: "owner-decision",
                title,
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
            decisionPromptBackoff.set(decisionId, Date.now());
            bb.log.warn(
              `Owner-decision prompt failed on ${rootThreadId}: ${
                error instanceof Error ? error.message : String(error)
              } (backing off 10m)`,
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

  /**
   * Hand a merged slice's worktree back to the filesystem.
   *
   * Runs on the host daemon that owns the directory, because git and rm are not
   * on the server-side API. Everything here is best effort and non-fatal: a
   * failure to reclaim disk must never turn a successful integration into a
   * failed one.
   */
  /**
   * One transfer implementation for both entry points.
   *
   * The CLI grew this first and rotateRoot needs the identical sequence. Two
   * copies of a journalled, resumable state machine is how the two drift, and a
   * half-applied transfer is the worst state this plugin can be left in.
   */
  async function runRootTransfer(
    sourceThreadId: string,
    targetThreadId: string,
    dryRun: boolean,
  ) {
            const report = await executeRootTransfer({
              bb,
              store: rootTransfers,
              sourceThreadId,
              targetThreadId,
              dryRun,
              async targetIntakeRowId() {
                const rows = await readTimeline(targetThreadId);
                const last = rows.at(-1) as { id?: unknown } | undefined;
                const id = String(last?.id ?? "").trim();
                return id || null;
              },
              workerExecution() {
                const sourceGoal = store.get(sourceThreadId);
                if (!sourceGoal) throw new Error("source goal disappeared before worker pin snapshot");
                const settings = view(sourceGoal).settings;
                if (!settings.workerProvider || !settings.workerModel) {
                  throw new Error("source worker execution is inherited; set explicit worker provider/model before transfer");
                }
                return {
                  providerId: settings.workerProvider,
                  model: settings.workerModel,
                  reasoningLevel: settings.workerReasoning || null,
                  serviceTier: settings.workerServiceTier,
                };
              },
              async finalAccount() {
                await account(sourceThreadId, { evenIfIdle: true, force: true, scan: true });
              },
              async wakeSeen(id, marker) {
                const rows = await readTimeline(id);
                return rows.some((row) => JSON.stringify(row).includes(marker));
              },
              async wakeTarget(id, marker) {
                const goal = store.get(id);
                if (!goal) throw new Error("transferred target goal is missing before wake");
                const snap = await viewFresh(goal);
                const sent = await sendSteering(
                  id,
                  [
                    marker,
                    "CONTROLLED ROOT TAKEOVER COMPLETE. You are now the UltraGoal orchestrator. Existing remediation state, work items, counters, and provider-pinned workers were transferred durably. Continue from this bounded handoff; do not replay the old startup prompt.",
                    continuationPrompt(snap),
                  ].join("\n\n"),
                  "start",
                );
                if (!sent) throw new Error("target rejected the takeover handoff");
              },
              onDatabaseCommitted() {
                agentCache.delete(sourceThreadId);
                agentCache.delete(targetThreadId);
                liveTaskCounts.delete(sourceThreadId);
                liveTaskCounts.delete(targetThreadId);
                rootActivity.delete(sourceThreadId);
                rootReviveState.delete(sourceThreadId);
                forgetNativeScan(sourceThreadId);
                publish(sourceThreadId, null);
              },
            });
    const targetGoal = store.get(targetThreadId);
    if (!dryRun && targetGoal) {
      await refreshRunning(targetThreadId);
      publish(targetThreadId, await viewFresh(targetGoal));
      reconcileFindingBacklog(targetThreadId);
      void ensureCrew(targetThreadId);
      void scheduleReady(targetThreadId);
    }
    return report;
  }

  async function reclaimWorktree(
    rootThreadId: string,
    itemId: string,
    environmentId: string,
    mergedInto: string,
  ): Promise<void> {
    if (!snapshotDefaults.reclaimMergedWorktrees) return;
    try {
      const environment = await bb.sdk.environments.get({ environmentId });
      const checkoutPath = (environment as { path?: string | null }).path ?? null;
      const hostId = (environment as { hostId?: string | null }).hostId ?? null;
      if (!checkoutPath || !hostId) return;
      if (!environment.isWorktree || !environment.managed) return;

      if (snapshotDefaults.shareWorktreeNodeModules) {
        // Seed the store from a checkout that is about to be deleted: the
        // cheapest possible moment to capture a good dependency tree.
        const seeded = await hostClient
          .call("shareNodeModules", { checkoutPath, seedIfEmpty: true }, { hostId })
          .catch(() => null);
        if (seeded?.seeded) {
          bb.log.info(`Seeded the node_modules store from ${itemId} (${seeded.key})`);
        }
      }

      const result = await hostClient.call(
        "reclaimWorktree",
        { checkoutPath, mergedInto, force: false },
        { hostId },
      );
      if (result.removed) {
        bb.log.info(
          `Reclaimed the worktree for slice ${itemId}: ${Math.round(result.freedBytes / 1048576)}MB`,
        );
      } else if (result.reason) {
        bb.log.info(`Kept the worktree for slice ${itemId}: ${result.reason}`);
      }
    } catch (error) {
      bb.log.warn(
        `Worktree reclaim failed for slice ${itemId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async function integrateWorker(
    rootThreadId: string,
    workerThreadId: string,
    itemId: string,
  ): Promise<void> {
    let strandedBranch: string | null = null;
    let integrationCheckout: string | null = null;
    let integrationHostId: string | null = null;
    let integrationBase: string | null = null;
    try {
      const worker = await bb.sdk.threads.get({ threadId: workerThreadId });
      if (!worker.environmentId) return;
      const environment = await bb.sdk.environments.get({ environmentId: worker.environmentId });
      if (!environment.isWorktree || !environment.managed) return;
      strandedBranch = environment.branchName ?? null;
      integrationCheckout = (environment as { path?: string | null }).path ?? null;
      integrationHostId = (environment as { hostId?: string | null }).hostId ?? null;
      const base =
        environment.mergeBaseBranch ?? environment.defaultBranch ?? environment.baseBranch;
      if (!base) return;
      integrationBase = base;
      await bb.sdk.environments.squashMerge({
        environmentId: worker.environmentId,
        mergeBaseBranch: base,
      });
      markGoalEvent(rootThreadId);
      // Record WHERE it landed. Nothing did, so 256 of 417 register entries had
      // no commit attribution at all and "fixed" could not be checked against
      // the tree by anyone, including the reviewers whose job that is.
      integrations.record(
        rootThreadId,
        {
          itemId,
          commit: null,
          branch: environment.branchName ?? null,
          status: "integrated",
          detail: `squash-merged into ${base}`,
        },
        Date.now(),
      );
      bb.log.info(
        `Integrated slice ${itemId}: squash-merged ${environment.branchName ?? worker.environmentId} into ${base} on ${rootThreadId}`,
      );
      // Completed, merged, and now the worktree is pure disk. The plugin made
      // it, so the plugin removes it — leaving that to whoever notices the disk
      // filling is how 217 of them accumulated.
      await reclaimWorktree(rootThreadId, itemId, worker.environmentId, base);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Ask the REPOSITORY whether the branch still adds anything. Matching the
      // error text cannot work: bb reports `HTTP 502: git merge --squash
      // <branch> failed` and does not pass git's own words through, so 0.25.3's
      // message match was inert and 22 no-op merges in one hour were still
      // recorded as failures — and, after 0.26.0, would have reopened findings
      // whose work was already on the branch.
      let addsWork = true;
      if (strandedBranch && integrationCheckout && integrationHostId && integrationBase) {
        const verdict = await hostClient
          .call(
            "branchAddsWork",
            { checkoutPath: integrationCheckout, branch: strandedBranch, base: integrationBase },
            { hostId: integrationHostId },
          )
          .catch(() => null);
        if (verdict && !verdict.adds) addsWork = false;
      }
      if (!addsWork) {
        integrations.record(
          rootThreadId,
          {
            itemId,
            commit: null,
            branch: strandedBranch,
            status: "integrated",
            detail: "already present on the base branch (verified by diff, not by message)",
          },
          Date.now(),
        );
        bb.log.info(`Integration skipped for slice ${itemId} on ${rootThreadId}: already on the base branch`);
        return;
      }
      if (/no changes|nothing to (merge|commit)|up.to.date|already|nothing to squash/i.test(message)) {
        // "Already up to date. (nothing to squash)" is git exiting non-zero
        // because there was nothing to stage, and bb surfaces that as a 502.
        // Recording it as a FAILED integration is worse than useless: it is the
        // provenance table saying work did not land when it demonstrably did,
        // in the one instrument built to answer that question. 15 of 17
        // recorded failures on a live goal were this.
        integrations.record(
          rootThreadId,
          {
            itemId,
            commit: null,
            branch: null,
            status: "integrated",
            detail: `already present on the base branch: ${message.slice(0, 200)}`,
          },
          Date.now(),
        );
        bb.log.info(`Integration skipped for slice ${itemId} on ${rootThreadId}: ${message}`);
        return;
      }
      // A finding is closed on the worker's report BEFORE this runs, so a failed
      // merge previously left the register asserting a fix that is provably not
      // in the tree, with nothing recording the contradiction. Write it down.
      integrations.record(
        rootThreadId,
        { itemId, commit: null, branch: strandedBranch, status: "failed", detail: message },
        Date.now(),
      );
      // Closure happened on the worker's report, before this merge was even
      // attempted. The merge has now genuinely failed, so the fix is provably
      // not on the base branch and the register must stop claiming otherwise.
      // Reopen the defects and return the slice to the queue.
      const reopened = findings.reopenForFailedIntegration(
        rootThreadId,
        itemId,
        `Reopened: integration of ${strandedBranch ?? "the slice branch"} failed — ${message.slice(0, 200)}`,
      );
      if (reopened > 0) {
        // Name the branch in the step. The work is committed and recoverable;
        // a re-staffed worker that starts over instead of recovering it is how
        // one slice got re-implemented against an already-merged predecessor.
        const current = items.list(rootThreadId).find((row) => row.id === itemId);
        if (current && current.status === "completed") {
          items.patch(rootThreadId, [{
            id: itemId,
            status: "pending",
            step: strandedBranch && !current.step.includes(strandedBranch)
              ? `${current.step} STRANDED WORK: this slice was completed and its integration FAILED, so its defects are open again. The commits are on ${strandedBranch} — recover them and resolve the conflict; do not start over.`
              : current.step,
          }], []);
        }
        bb.log.warn(
          `Reopened ${reopened} finding(s) and requeued ${itemId} on ${rootThreadId}: its fix is not on the base branch`,
        );
      }
      bb.log.warn(`Integration failed for slice ${itemId} (${workerThreadId}) on ${rootThreadId}: ${message}`);
      // One escalation per goal per cooldown window: twelve identical
      // dirty-checkout steers in ninety minutes is noise, not urgency.
      const lastSteer = integrationSteerAt.get(rootThreadId) ?? 0;
      if (Date.now() - lastSteer < INTEGRATION_STEER_COOLDOWN_MS) return;
      integrationSteerAt.set(rootThreadId, Date.now());
      await sendSteering(
        rootThreadId,
        `INTEGRATION CONFLICT: completed slice ${itemId} (worker ${workerThreadId}) could not be squash-merged into the default branch automatically: ${message}. Merge that worker's branch manually (rebase-train: merge, run gates, push) before anything else — a completed slice that is not on the default branch does not exist.`,
        "steer",
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

      const plannedItems = items.list(rootThreadId);
      const openItems = plannedItems.filter((item) => item.status === "in_progress");

      // A worker whose slice is already closed is not work: it is a durable row
      // the SQL capacity fence keeps counting. Retiring it used to wait for a
      // later sweep to observe the host as `stopped`, which depends on a
      // best-effort threads.stop that swallows its failures — so every swallowed
      // failure permanently consumed one root slot until no reservation could be
      // granted.
      //
      // This must read the DURABLE rows. `agentCache` holds the projection from
      // oneWorkerPerItem, which drops any worker whose item is completed — the
      // exact set being collected here. Reconciling against the projection was a
      // no-op that looked correct.
      const liveHosts = new Set(
        agents
          .filter((agent) => agent.status === "running" || agent.status === "starting")
          .map((agent) => agent.threadId),
      );
      const candidates = finishedWorkerRetirementCandidates(
        collab.durableRowsForRoot(rootThreadId).filter((row) => row.threadId !== rootThreadId),
        plannedItems,
        (workerThreadId) => verifierStillDeciding(
          collab.verifiersFor(workerThreadId).map((row) => ({
            threadId: row.thread_id,
            createdAt: row.created_at,
            reportStatus: row.report_status ?? null,
          })),
          (verifierThreadId) => liveHosts.has(verifierThreadId),
          now,
          RESCUE_AFTER_MS,
        ),
      );
      const retired = new Set<string>();
      for (const workerThreadId of candidates) {
        // Confirm each candidate's host directly. The in-memory projection
        // cannot answer this: it drops exactly these workers, so absence there
        // means "unknown", not "dead". Retiring on unknown would stop a live
        // worker whenever a single host read failed transiently.
        let hostStatus: string | null = null;
        try {
          hostStatus = (await bb.sdk.threads.get({ threadId: workerThreadId })).status ?? null;
        } catch {
          continue;
        }
        if (!retirementPermittedByHost(hostStatus)) continue;
        collab.forget(workerThreadId);
        firstSeenIdle.delete(workerThreadId);
        retired.add(workerThreadId);
        void releaseWorkerRuntime(workerThreadId);
        // Archive it as well, so the rest of the system can tell it is done.
        // Retirement was a fact known only to this plugin: 201 retired workers
        // still counted as live threads, which made the worktree collector —
        // correctly refusing to delete a live thread's directory — protect 135
        // worktrees that nothing would ever use again. A retired worker is
        // finished; saying so is what lets its disk be reclaimed.
        void bb.sdk.threads
          .archive({ threadId: workerThreadId })
          .catch(() => undefined);
        bb.log.info(
          `Retired finished worker ${workerThreadId} on ${rootThreadId} (host ${hostStatus}): its slice is closed; released its scheduler slot`,
        );
      }

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
          if (agent.status === "running" || agent.status === "starting") {
            collab.resetNudges(agent.threadId);
          }
          continue;
        }
        if (retired.has(agent.threadId)) continue;
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
        // Declared out here: the send below needs this thread's status to pick
        // its mode, and a const inside the try block is not in scope there.
        let workerThread: Awaited<ReturnType<typeof bb.sdk.threads.get>> | null = null;
        try {
          workerThread = await bb.sdk.threads.get({ threadId: agent.threadId });
          if (!threadAcceptsSteer(workerThread)) continue;
        } catch {
          continue;
        }
        collab.bumpNudge(agent.threadId);
        try {
          const defectBrief = agent.itemId
            ? linkedDefectBrief(rootThreadId, agent.itemId)
            : "";
          await bb.sdk.threads.send({
            threadId: agent.threadId,
            mode: (workerThread ? immediateSendMode(workerThread) : null) ?? "steer",
            permissionMode: snapshotDefaults.workerPermissionMode,
            input: [
              {
                type: "text",
                text: [
                  "Your turn ended but your slice is still open and you have not reported. Resume and finish the slice now. When it is fully done, call the slice_done tool with evidence (commit SHAs + passing check output) and end your turn. If you cannot finish, call slice_blocked with the specific blocker.",
                  defectBrief,
                ].filter(Boolean).join("\n\n"),
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
      if (goal.status === "paused") {
        const parked = parkGoalSlices(goal.threadId);
        if (parked > 0) {
          bb.log.info(`Paused goal ${goal.threadId}: parked ${parked} in-progress slice(s)`);
        }
      }
      const [listed, liveTasks, sessionId] = await Promise.all([
        // Now renders from liveness, so the crew's thread statuses must be
        // fresh, not cache defaults. Discovery registers children the
        // orchestrator spawned natively (outside spawn_agent) so they get
        // Now rows and auto-approval like any other worker.
        collab.listForRoot(goal.threadId, {
          discover: goal.status === "active" || goal.status === "budget_limited" || goal.status === "blocked",
          refreshLimit: 24,
          refreshHolders: true,
        }),
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
      const reclaimed = reclaimOrphanInProgress(goal.threadId);
      if (reclaimed > 0) {
        bb.log.info(`Demoted ${reclaimed} unheld in_progress slice(s) on ${goal.threadId}`);
      }
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
    if (transferLocked(threadId)) return;
    const goal = store.get(threadId);
    if (!goal || (goal.status !== "active" && goal.status !== "budget_limited")) return;
    if (staffing.has(threadId)) return;
    staffing.add(threadId);
    try {
      const snap = await viewFresh(store.get(threadId) ?? goal);
      for (const agent of snap.agents.filter((row) => row.role === "worker")) {
        // Unknown is not proof of death: immediately after reload a transient
        // threads.get failure used to retire active durable owners and open a
        // duplicate scheduler slot. Only explicit terminal host states retire.
        if (agent.status !== "error" && agent.status !== "stopped") continue;
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
  /**
   * A resolved finding can leave the slice it minted behind as a ready plan
   * row, which the scheduler cannot tell from real work and will staff a worker
   * against to re-fix already-guarded code. Retire it — remove, never complete,
   * because completion carries per-defect evidence rules.
   */
  function retireOrphanedRemediationItem(rootThreadId: string, itemId: string | null | undefined): boolean {
    if (!itemId) return false;
    const item = items.list(rootThreadId).find((row) => row.id === itemId);
    if (!item) return false;
    const verdict = remediationItemRetirement({
      item,
      linkedFindings: findings.list(rootThreadId).filter((finding) => finding.itemId === itemId),
      staffed:
        workersOnItem(rootThreadId, itemId).length > 0 ||
        itemClaimants(rootThreadId, itemId).length > 0,
    });
    if (!verdict.retire) return false;
    const removed = items.patch(rootThreadId, [], [itemId]).removed > 0;
    if (removed) {
      bb.log.info(`Retired remediation item ${itemId} on ${rootThreadId}: no linked finding is open and nobody is on it`);
    }
    return removed;
  }

  function closeItemFindings(rootThreadId: string, itemId: string, note: string): number {
    const result = closeFindingsForCompletedItem({
      threadId: rootThreadId,
      itemId,
      note,
      findings,
      items,
    });
    if (result.requeuedInvalid > 0 || result.requeuedMissing > 0) {
      bb.log.warn(
        `Completion guard on ${itemId}: detached ${result.requeuedInvalid} invalid and ${result.requeuedMissing} missing-item finding link(s) before closure`,
      );
    }
    if (result.fixed + result.requeuedInvalid + result.requeuedMissing > 0) {
      reconcileFindingBacklog(rootThreadId);
    }
    return result.fixed;
  }

  /** Apply the same stale-link rule as startup before checking a completion
   * report, then require explicit evidence coverage for every valid linked
   * defect. This makes a coalesced work item an honest implementation unit,
   * not a way to hide later findings behind its title. */
  function missingCompletionFindingIds(
    rootThreadId: string,
    itemId: string,
    findingEvidence: readonly FindingAffirmativeEvidence[] | null | undefined,
  ): string[] {
    const detached = detachStaleFindingLinks({
      threadId: rootThreadId,
      itemId,
      findings,
      items,
    });
    if (detached.requeuedInvalid > 0 || detached.requeuedMissing > 0) {
      bb.log.warn(
        `Evidence guard on ${itemId}: detached ${detached.requeuedInvalid} invalid and ${detached.requeuedMissing} missing-item defect link(s)`,
      );
      reconcileFindingBacklog(rootThreadId);
    }
    return missingLinkedDefectEvidenceIds(
      findingEvidence,
      linkedOpenFindings(rootThreadId, itemId),
    );
  }

  function completeItemFor(
    rootThreadId: string,
    itemId: string | null,
    report: string | null | undefined,
    options?: {
      requirePass?: boolean;
      recordedClaim?: "done" | "blocked" | null;
      findingEvidence?: readonly FindingAffirmativeEvidence[];
      /** Whose report this is, so a refusal reaches them instead of only a log. */
      workerThreadId?: string | null;
    },
  ): boolean {
    if (!itemId) return false;
    const goal = store.get(rootThreadId);
    // A blocked goal still records landed work: "blocked" usually means the
    // ROOT died, and refusing completion there stranded finished slices
    // (worker reported done, nothing merged) until a human noticed.
    if (
      !goal ||
      (goal.status !== "active" && goal.status !== "budget_limited" && goal.status !== "blocked")
    ) {
      return false;
    }
    if (options?.requirePass) {
      if (parseVerifierVerdict(report) !== "pass") return false;
    } else {
      if (view(goal).settings.verifyEnabled) return false;
      // The recorded tool claim decides; the text sentinel remains only as a
      // transitional fallback for workers briefed before the tools existed.
      const contract = options?.recordedClaim ?? structuredReport(report);
      if (contract === "blocked") markGoalEvent(rootThreadId);
      if (contract !== "done") return false;
    }
    const item = items
      .list(rootThreadId)
      .find((row) => row.id === itemId && row.status === "in_progress");
    if (!item) return false;
    // A worker normally proves its linked defects through the slice_done tool.
    // Some providers cannot dispose a tool call as the turn ends, so those
    // workers are briefed to close with DEFECT_COVERAGE lines and the
    // ULTRAGOAL_DONE sentinel instead. That is the same machine-readable
    // contract the verifier emits and clears the same bar — discarding it is
    // what stranded every sentinel worker's slice as unattended in_progress
    // with its finding still open.
    const findingEvidence = options?.requirePass
      ? parseDefectCoverageEvidence(report)
      : options?.findingEvidence?.length
        ? options.findingEvidence
        : parseDefectCoverageEvidence(report);
    const missingFindingIds = missingCompletionFindingIds(
      rootThreadId,
      itemId,
      findingEvidence,
    );
    if (missingFindingIds.length > 0) {
      bb.log.warn(
        `Rejected completion of ${itemId} on ${rootThreadId}: report omitted linked defect evidence for ${missingFindingIds.join(", ")}`,
      );
      // The same silence that stranded the deliverable floor, and with a worse
      // ending: a slice refused here stays in_progress, its worker is released,
      // and the scheduler eventually re-staffs it — so a second worker redid
      // work that was already committed and integrated, on a stale base, and
      // was heading for a merge conflict with its own predecessor.
      if (options?.workerThreadId) {
        void sendSteering(
          options.workerThreadId,
          [
            `SLICE NOT CLOSED. Your work may well be done and committed, but ${itemId} is linked to defects your report did not attest: ${missingFindingIds.join(", ")}.`,
            `This is a reporting gap, not a request to redo the work — do NOT start over. Re-report with one line per defect, exactly this shape:`,
            ...missingFindingIds.map(
              (findingId) => `DEFECT_COVERAGE: {"finding_id":"${findingId}","status":"pass","proof":"<what you checked and how you know it holds>"}`,
            ),
            `Then end with ULTRAGOAL_DONE. Prose naming the defect does not count; if you use the slice_done tool instead, pass the same ids as structured finding_evidence.`,
          ].join("\n"),
          "steer",
        );
      }
      return false;
    }
    // Declared outputs are a FLOOR, unlike item.files which is only the scope
    // ceiling. Opt-in: an item with no requirements behaves exactly as before,
    // so this cannot retroactively block work already in flight.
    const required = itemRequirements.list(rootThreadId, itemId);
    if (required.length > 0) {
      const missingPaths = missingDeliverables(parseDeliverableEvidence(report), required);
      if (missingPaths.length > 0) {
        bb.log.warn(
          `Rejected completion of ${itemId} on ${rootThreadId}: report omitted deliverable evidence for ${missingPaths.join(", ")}`,
        );
        // Telling only the log is why four workers finished their work, had
        // their closure refused, and went idle holding every scheduler slot
        // while twenty-five items waited. The refusal has to reach whoever can
        // act on it, and it has to carry the exact line that satisfies it —
        // a worker that cannot see the contract cannot meet it.
        if (options?.workerThreadId) {
          void sendSteering(
            options.workerThreadId,
            [
              `SLICE NOT CLOSED. Your work may well be done, but ${itemId} declares required outputs and your report did not account for: ${missingPaths.join(", ")}.`,
              `This is a reporting gap, not a request to redo the work. For EACH path above, emit one line, exactly this shape, then end your report:`,
              ...missingPaths.map(
                (path) => `DELIVERABLE: {"path":"${path}","proof":"<what you did to it and how you know it works>"}`,
              ),
              `The proof must be nonempty and specific — name the assertion or the command output. Prose elsewhere in the report does not count, which is the whole reason this gate exists.`,
            ].join("\n"),
            "steer",
          );
        }
        return false;
      }
    }
    items.setStatus(rootThreadId, itemId, "completed");
    markGoalEvent(rootThreadId);
    const closed = closeItemFindings(rootThreadId, itemId, (report ?? "").trim().slice(-400));
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
        const claim = collab.reportOf(agent.threadId);
        if (
          completeItemFor(rootThreadId, agent.itemId, claim?.evidence ?? output, {
            workerThreadId: agent.threadId,
            recordedClaim: claim?.status ?? null,
            findingEvidence: claim?.findingEvidence ?? [],
          })
        ) {
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
    const liveVerifiers = liveVerifierCount(agentCache.get(row.root_thread_id) ?? []);
    if (liveVerifiers >= resolved.maxWorkers) return;

    let output = "";
    try {
      output = (await bb.sdk.threads.output({ threadId: workerThreadId })).output?.trim() ?? "";
    } catch {
      return;
    }
    const claim = collab.reportOf(workerThreadId);
    if (claim?.evidence) output = (claim.evidence + "\n\n" + output).trim();
    if (!output) return;
    // A verifier judges a completion claim, not every pause: mid-work idles
    // spawn no auditors.
    if ((claim?.status ?? structuredReport(output)) !== "done") return;
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
      const defectBrief = row.item_id ? linkedDefectBrief(row.root_thread_id, row.item_id) : "";
      const spawned = await collab.spawnVerifier({
        rootThreadId: row.root_thread_id,
        sourceThreadId: workerThreadId,
        itemId: row.item_id,
        providerId: resolved.verifyProvider,
        model: resolved.verifyModel,
        reasoningLevel: resolved.verifyReasoning,
        serviceTier: resolved.verifyServiceTier,
        workText: item?.step ?? "",
        prompt: [
          "Independent verification of a finished Goal worker.",
          `Parent objective: ${goal.objective}`,
          item ? `Assigned slice: ${item.step}` : "Assigned slice: (not linked to a plan item)",
          `Worker call sign: ${row.display_name || row.task_name}`,
          defectBrief,
          "The worker's report follows. Do not trust it. Inspect the current worktree.",
          output.slice(0, 8000),
          defectBrief
            ? 'Before the verdict, emit one exact JSON line per linked defect: DEFECT_COVERAGE: {"finding_id":"fnd_...","status":"pass","proof":"what you checked"}. Prose mentions, missing IDs, empty proof, and non-pass status cannot pass.'
            : "",
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

  // Approving another agent's command, file-change, permission or plan request
  // is a real approval boundary, and a long-running goal is not a reason to
  // cross it silently. This is opt-in and OFF by default: with the setting off,
  // every request reaches the owner exactly as it would without this plugin.
  // User questions are never answered here either way.
  async function approveInteractions(threadId: string): Promise<number> {
    if (!snapshotDefaults.autoApproveAgentRequests) return 0;
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
    if (!snapshotDefaults.autoApproveAgentRequests) return;
    for (const threadId of store.listActiveThreadIds()) {
      if (transferLocked(threadId)) continue;
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

  // Intake: every real owner message to the goal thread is triaged by a
  // dedicated plugin-spawned agent that files defects (report_finding) and
  // requests (add_slice) through the formal tools — filing never depends on
  // the orchestrator noticing a message. Provenance filters keep it honest:
  // composer-origin user rows only (no inter-thread sends, no child-outcome
  // system rows, none of the plugin's own [ultragoal]-marked steers).
  async function maybeIntakeUserMessage(
    rootThreadId: string,
    rows: readonly unknown[],
  ): Promise<void> {
    if (transferLocked(rootThreadId)) return;
    const goal = store.get(rootThreadId);
    if (!goal || (goal.status !== "active" && goal.status !== "budget_limited")) return;
    let latest: { id: string; text: string } | null = null;
    for (const raw of rows) {
      const row = raw as {
        kind?: string;
        role?: string;
        text?: string;
        id?: string;
        senderThreadId?: string | null;
        systemMessageKind?: string;
      };
      if (row?.kind !== "conversation" || row.role !== "user") continue;
      if (row.senderThreadId) continue;
      if (row.systemMessageKind && row.systemMessageKind !== "unlabeled") continue;
      const text = row.text?.trim() ?? "";
      if (!text || text.startsWith("[bb ") || text.startsWith("[ultragoal]")) continue;
      latest = { id: String(row.id ?? ""), text };
    }
    if (!latest || !latest.id) return;
    const seen = goal.intakeRowId;
    if (seen === latest.id) return;
    store.setIntakeRow(rootThreadId, latest.id);
    // First-ever sighting for this goal baselines without replaying history;
    // the cursor is durable, so a plugin reload never skips a message again.
    if (seen === null) return;
    if (parseSlashGoal(latest.text)) return;
    const result = await collab.spawnWorker({
      parentThreadId: rootThreadId,
      itemId: null,
      maxWorkers: view(goal).settings.maxWorkers,
      skipClaim: true,
      // Fixed name: the slug must start with intake_ so idle cleanup matches.
      displayName: "Intake Courier",
      message: [
        "INTAKE TRIAGE (you are the goal's intake agent; do not implement anything).",
        "The goal owner just sent the message below to the goal thread. File every actionable item through the formal tools:",
        "- Each DEFECT they describe: one report_finding call (title = the defect in one sentence; file = the best area path you can determine by reading the repo read-only; evidence = the owner's words plus any quick read-only verification). Duplicates are fingerprint-deduped — file without fear.",
        "- Each FEATURE/UX request: one add_slice call (step starts 'Owner UX:' or 'Owner request:', self-contained, narrow or empty files).",
        "- Questions or decisions only the owner can answer are NOT yours to file; skip them.",
        "If nothing is actionable, do nothing. End your turn when filing is complete — do not call slice_done (you hold no slice), do not implement fixes, do not message anyone.",
        "OWNER MESSAGE:",
        latest.text,
      ].join("\n\n"),
    });
    if ("error" in result) {
      bb.log.warn(`Intake spawn failed on ${rootThreadId}: ${result.error}`);
    } else {
      bb.log.info(`Intake ${result.nickname} (${result.threadId}) triaging owner message on ${rootThreadId}`);
    }
  }

  async function nudgeRoot(rootId: string): Promise<void> {
    if (transferLocked(rootId)) return;
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
    const ids = new Set(collab.threadIdsForRoot(rootId));
    for (const agent of agentCache.get(rootId) ?? []) ids.add(agent.threadId);
    try {
      const listed = await bb.sdk.threads.list({
        parentThreadId: rootId,
        includeHidden: true,
        limit: 200,
      });
      for (const child of listed) ids.add(child.id);
    } catch {
      // Parent listing is best-effort; collab rows still get stopped.
    }
    await Promise.all([...ids].map((id) => stopThread(id)));
  }

  function parkGoalSlices(rootId: string): number {
    for (const id of collab.threadIdsForRoot(rootId)) {
      collab.forget(id);
    }
    agentCache.set(rootId, []);
    let parked = 0;
    for (const item of items.list(rootId)) {
      if (item.status !== "in_progress") continue;
      items.setStatus(rootId, item.id, "pending");
      parked += 1;
    }
    return parked;
  }

  function reclaimOrphanInProgress(rootId: string): number {
    const held = new Set<string>();
    for (const agent of agentCache.get(rootId) ?? []) {
      if (agent.role !== "verifier" && agent.itemId) held.add(agent.itemId);
    }
    for (const item of items.list(rootId)) {
      if (collab.workersOnItem(rootId, item.id).length > 0) held.add(item.id);
    }
    const orphans = orphanInProgressIds(items.list(rootId), held);
    for (const id of orphans) items.setStatus(rootId, id, "pending");
    return orphans.length;
  }

  async function pauseGoal(threadId: string, reason: string): Promise<StoredGoal | null> {
    const goal = applyStatus(threadId, "paused", reason);
    await stopThread(threadId);
    await stopCrew(threadId);
    const parked = parkGoalSlices(threadId);
    if (parked > 0) {
      bb.log.info(`Paused ${threadId}: parked ${parked} in-progress slice(s) back to pending`);
    }
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
        await continueIfIdle(threadId, latest, { force: true });
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

  async function threadStatus(threadId: string): Promise<string> {
    return (await bb.sdk.threads.get({ threadId })).status ?? "";
  }

  async function waitUntilSettled(threadId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let status = "";
      try {
        status = await threadStatus(threadId);
      } catch {
        await delay(400);
        continue;
      }
      if (threadIsSettledForSubmit(status)) return true;
      await delay(400);
    }
    return false;
  }

  // OpenCode ACP can keep a turn held after BB marks the thread error/stopped.
  // compact and continue are both turn.submit, so a leftover turn makes every
  // recovery attempt fail with "A turn is already active".
  async function settleThreadForSubmit(threadId: string, timeoutMs = 30_000): Promise<boolean> {
    try {
      await bb.sdk.threads.stop({ threadId });
    } catch {
      // Already stopped or the provider ignored a second stop.
    }
    running.set(threadId, false);
    const settled = await waitUntilSettled(threadId, timeoutMs);
    if (!settled) {
      bb.log.warn(`Could not settle ghost turn on ${threadId} before submit`);
    }
    return settled;
  }

  async function submitGoalTurn(
    threadId: string,
    text: string,
    mode: "start" | "steer",
  ): Promise<void> {
    await bb.sdk.threads.send({
      threadId,
      mode,
      permissionMode: snapshotDefaults.workerPermissionMode,
      input: [{ type: "text", text: `[ultragoal]\n${text}`, visibility: "agent-only", mentions: [] }],
    });
  }

  async function sendSteering(
    threadId: string,
    text: string,
    mode: "start" | "steer",
  ): Promise<boolean> {
    if (inflight.has(threadId)) return false;
    if (mode === "start" && (starting.get(threadId) ?? 0) > Date.now()) {
      bb.log.info(`Skipping Goal start on ${threadId}: another start is in flight`);
      return false;
    }
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (mode === "start") {
        if (thread.status === "error") {
          await settleThreadForSubmit(threadId);
        }
        const next = await bb.sdk.threads.get({ threadId });
        if (!threadAcceptsStart(next)) {
          bb.log.info(`Skipping Goal start on ${threadId}: ${next.status ?? "unavailable"}`);
          return false;
        }
      } else if (!threadAcceptsSteer(thread)) {
        bb.log.info(`Skipping Goal steer on ${threadId}: ${thread.status ?? "unavailable"}`);
        return false;
      }
    } catch {
      return false;
    }
    inflight.add(threadId);
    try {
      await submitGoalTurn(threadId, text, mode);
      if (mode === "start") starting.set(threadId, Date.now() + 8_000);
      return true;
    } catch (error) {
      if (mode === "start" && isTurnAlreadyActiveError(error)) {
        bb.log.warn(`Goal start hit an active turn on ${threadId} — settling and retrying`);
        if (await settleThreadForSubmit(threadId)) {
          try {
            await submitGoalTurn(threadId, text, mode);
            starting.set(threadId, Date.now() + 8_000);
            return true;
          } catch (retryError) {
            bb.log.warn(
              `Goal start retry failed on ${threadId}: ${
                retryError instanceof Error ? retryError.message : String(retryError)
              }`,
            );
            return false;
          }
        }
      }
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
      runningNow ? "steer" : "start",
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

  // Root-turn watchdog: a root that stays "active" while its timeline stops
  // growing is wedged in a provider turn — queued steers pile up unprocessed
  // behind it. Workers get the three-strike retire; the root gets stopped and
  // auto-continued, which also flushes its queue.
  const ROOT_WEDGE_MS = 10 * 60_000;
  const rootActivity = new Map<string, { rowId: string; at: number }>();

  async function watchRootTurn(rootThreadId: string): Promise<boolean> {
    if (!(await threadIsRunning(bb, rootThreadId))) {
      rootActivity.delete(rootThreadId);
      return false;
    }
    const rows = await readTimeline(rootThreadId);
    const last = rows.at(-1) as { id?: string } | undefined;
    const rowId = String(last?.id ?? "");
    const now = Date.now();
    const seen = rootActivity.get(rootThreadId);
    if (!seen || seen.rowId !== rowId) {
      rootActivity.set(rootThreadId, { rowId, at: now });
      return false;
    }
    if (now - seen.at < ROOT_WEDGE_MS) return false;
    rootActivity.delete(rootThreadId);
    bb.log.warn(
      `Root turn wedged on ${rootThreadId}: active with no timeline growth for ${Math.round((now - seen.at) / 60000)}m — stopping and continuing`,
    );
    try {
      await bb.sdk.threads.stop({ threadId: rootThreadId });
    } catch {
      return false;
    }
    markGoalEvent(rootThreadId);
    running.set(rootThreadId, false);
    // OpenCode still holds the stopped turn for a beat; submitting immediately
    // is what produced "A turn is already active" on the openbooks root.
    if (!(await waitUntilSettled(rootThreadId, 30_000))) return false;
    const goal = store.get(rootThreadId);
    if (goal && (goal.status === "active" || goal.status === "budget_limited")) {
      await continueIfIdle(rootThreadId, goal);
      return true;
    }
    return false;
  }

  // Errored roots revive themselves: thread.failed marks the goal blocked and
  // the root sits in error state forever unless something sends it a turn.
  // The pulse restarts it with exponential backoff (2m -> 30m cap), resetting
  // once a turn actually runs. Paused and complete goals are never revived.
  const rootReviveState = new Map<string, { attempts: number; nextAt: number }>();

  async function reviveErroredRoot(rootThreadId: string): Promise<void> {
    const goal = store.get(rootThreadId);
    if (!goal || (goal.status !== "active" && goal.status !== "blocked" && goal.status !== "budget_limited")) {
      return;
    }
    let status = "";
    try {
      status = await threadStatus(rootThreadId);
    } catch {
      return;
    }
    if (status === "active" || status === "starting") {
      rootReviveState.delete(rootThreadId);
      return;
    }
    const blockedTransient =
      goal.status === "blocked" && isTransientTurnFailure(goal.reason);
    if (status !== "error" && !blockedTransient) return;
    if (status !== "error" && status !== "idle" && status !== "stopped") return;
    const state = rootReviveState.get(rootThreadId) ?? { attempts: 0, nextAt: 0 };
    const now = Date.now();
    if (now < state.nextAt) return;
    const backoff = Math.min(2 * 60_000 * 2 ** state.attempts, 30 * 60_000);
    rootReviveState.set(rootThreadId, { attempts: state.attempts + 1, nextAt: now + backoff });
    // A leftover OpenCode turn survives BB error/stop. Clearing it first is
    // what makes compact and continue actually land.
    if (status === "error" && !(await settleThreadForSubmit(rootThreadId))) return;
    // A root that keeps dying after a plain resume is usually drowning in its
    // own context (giant sessions fail turn submission under load) — compact
    // it before the second and later revivals, then wait so continue does not
    // collide with the compact turn.
    if (state.attempts >= 1) {
      try {
        await bb.sdk.threads.compact({ threadId: rootThreadId });
        bb.log.warn(`Requested context compaction for repeatedly-dying root ${rootThreadId}`);
        if (!(await waitUntilSettled(rootThreadId, 10 * 60_000))) {
          bb.log.warn(`Compact still running on ${rootThreadId}; deferring resume`);
          return;
        }
      } catch (error) {
        if (isTurnAlreadyActiveError(error)) {
          await settleThreadForSubmit(rootThreadId);
          bb.log.warn(`Compact skipped on ${rootThreadId}: turn still active after settle`);
        }
      }
    }
    bb.log.warn(
      `Root ${rootThreadId} is in error state — reviving (attempt ${state.attempts + 1}, next retry in ${Math.round(backoff / 60000)}m)`,
    );
    await resumeGoal(rootThreadId);
  }

  async function pulseStaleProgress(): Promise<void> {
    for (const threadId of store.listActiveThreadIds()) {
      if (transferLocked(threadId)) continue;
      const goal = store.get(threadId);
      if (!goal) continue;
      reconcileFindingBacklog(threadId);
      const transientBlock = goal.status === "blocked" && isTransientTurnFailure(goal.reason);
      if (goal.status !== "active" && goal.status !== "budget_limited" && !transientBlock) continue;
      try {
        const root = await bb.sdk.threads.get({ threadId }).catch(() => null);
        if (!root || root.archivedAt || root.deletedAt) continue;
        if (transientBlock) {
          await reviveErroredRoot(threadId);
          continue;
        }
        ensureDecisionPrompts(threadId);
        await reviveErroredRoot(threadId);
        const restarted = await watchRootTurn(threadId);
        // A wedge restart already submitted one turn. A second start in the
        // same pulse (progress check-in) is the "A turn is already active" race.
        if (!restarted) await requestProgressUpdate(threadId, goal);
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

  async function continueIfIdle(
    threadId: string,
    goal: StoredGoal,
    options?: { force?: boolean },
  ): Promise<void> {
    await ensureCrew(threadId);
    const latestGoal = store.get(threadId) ?? goal;
    const snap = await viewFresh(latestGoal);
    const due = !isBudgetExhausted(snap) && progressIsDue(latestGoal, snap.settings.progressUpdateMinutes);
    // Nothing new since the root's last turn and no heartbeat due: the root
    // has no job — waiting on live workers is the scheduler's business, not a
    // reason to burn a polling turn every idle. Resume/revive pass force so a
    // dead root still gets a new provider session.
    if (!options?.force && !due && latestGoal.lastContinueAt != null) {
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
        await sendSteering(
          threadId,
          objectiveUpdatedPrompt(view(result)),
          "steer",
        );
      } else if (
        threadAcceptsStart(thread) &&
        view(result).settings.autoContinue &&
        result.status === "active"
      ) {
        await continueIfIdle(threadId, result, { force: true });
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
      if (
        status === "completed" &&
        missingCompletionFindingIds(threadId, itemId, []).length > 0
      ) {
        bb.log.warn(
          `Pane completion of remediation item ${itemId} was rejected: linked defects require per-id evidence from slice_done or verification.`,
        );
        const goal = store.get(threadId);
        return { goal: goal ? await viewFresh(goal) : null };
      }
      items.setStatus(threadId, itemId, status);
      if (status === "completed") {
        closeItemFindings(threadId, itemId, "Marked completed from the pane.");
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
    /**
     * Move the goal onto a fresh orchestrator thread.
     *
     * A root re-reads its entire conversation on every request — one measured
     * at 520,000 cached tokens per turn, which is most of what a long goal
     * spends. Plan, findings, decisions, workers, the standing brief and the
     * completion floors all live in this plugin's tables, so a new root starts
     * at zero context and loses only the transcript.
     */
    async rotateRoot({ threadId }) {
      const goal = store.get(threadId);
      if (!goal) return { rotated: false, targetThreadId: null, reason: "no UltraGoal on this thread" };
      const settings = view(goal).settings;
      if (!settings.workerProvider || !settings.workerModel) {
        // executeRootTransfer refuses to guess a worker pin, and inheriting one
        // silently is how a fleet ended up on an unintended provider.
        return {
          rotated: false,
          targetThreadId: null,
          reason: "set an explicit worker provider and model before rotating",
        };
      }
      let source;
      try {
        source = await bb.sdk.threads.get({ threadId });
      } catch {
        return { rotated: false, targetThreadId: null, reason: "could not read the current root" };
      }
      try {
        const spawned = await bb.sdk.threads.spawn({
          projectId: source.projectId,
          providerId: source.providerId,
          executionInputSources: { providerId: "explicit" as const },
          permissionMode: snapshotDefaults.workerPermissionMode,
          environment: source.environmentId
            ? { type: "reuse" as const, environmentId: source.environmentId }
            : { type: "project-default" as const },
          title: `${source.title ?? "UltraGoal"} (rotated)`,
          input: [{
            type: "text" as const,
            text: "[ultragoal] Stand by for a controlled root rotation. Do not start work, do not plan, do not spawn agents. Acknowledge in one short line and wait.",
            mentions: [],
          }],
        });
        const targetThreadId = (spawned as { threadId?: string; id?: string }).threadId
          ?? (spawned as { id?: string }).id
          ?? "";
        if (!targetThreadId) {
          return { rotated: false, targetThreadId: null, reason: "spawned thread returned no id" };
        }
        await bb.sdk.threads.wait({
          threadId: targetThreadId,
          status: "idle",
          timeoutMs: 120_000,
          pollIntervalMs: 500,
        }).catch(() => undefined);
        await runRootTransfer(threadId, targetThreadId, false);
        bb.log.info(`Rotated the orchestrator for ${threadId} onto ${targetThreadId}`);
        return { rotated: true, targetThreadId, reason: null };
      } catch (error) {
        return {
          rotated: false,
          targetThreadId: null,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async updateSettings({
      threadId,
      verifyEnabled,
      verifyProvider,
      verifyModel,
      verifyReasoning,
      verifyServiceTier,
      autoContinue,
      progressUpdateMinutes,
      maxWorkers,
      workerProvider,
      workerModel,
      workerReasoning,
      workerServiceTier,
      tokenBudget,
    }) {
      const existing = store.get(threadId);
      if (!existing) return { goal: null };
      const next = store.update(threadId, {
        verifyEnabledOverride: verifyEnabled,
        verifyProviderOverride: verifyProvider,
        verifyModelOverride: verifyModel,
        verifyReasoningOverride: verifyReasoning,
        verifyServiceTierOverride: verifyServiceTier,
        autoContinueOverride: autoContinue,
        progressUpdateMinutesOverride: progressUpdateMinutes,
        maxWorkersOverride: maxWorkers,
        workerProviderOverride: workerProvider,
        workerModelOverride: workerModel,
        workerReasoningOverride: workerReasoning,
        workerServiceTierOverride: workerServiceTier,
        tokenBudget,
      });
      const snap = next ? await viewFresh(next) : null;
      if (snap) publish(threadId, snap);
      return { goal: snap };
    },
    async listModels({ threadId }) {
      return { providers: await listExecutionCatalog(bb, threadId) };
    },
    async workerTranscript({ threadId, workerThreadId }) {
      // Scope: only threads in this goal's tree are readable through the pane.
      const row = collab.rowOf(workerThreadId);
      let inTree = row?.root_thread_id === threadId;
      if (!inTree) {
        try {
          const worker = await bb.sdk.threads.get({ threadId: workerThreadId });
          inTree = worker.parentThreadId === threadId;
        } catch {
          inTree = false;
        }
      }
      if (!inTree) {
        return { workerThreadId, threadStatus: "unknown", entries: [], truncated: false };
      }
      let threadStatus = "unknown";
      try {
        threadStatus = (await bb.sdk.threads.get({ threadId: workerThreadId })).status ?? "unknown";
      } catch {
        // Status stays unknown; the timeline may still read.
      }
      const first = (...values: unknown[]): string | null => {
        for (const value of values) {
          if (typeof value === "string" && value.trim()) return value;
        }
        return null;
      };
      const rows = await readTimeline(workerThreadId);
      const mapped = rows
        .map((raw, index) => {
          const entry = raw as Record<string, unknown>;
          const kindRaw = `${entry.kind ?? ""} ${entry.type ?? ""}`.toLowerCase();
          const role = String(entry.role ?? "");
          const text = first(entry.text, entry.output, entry.summary, entry.content);
          const title = first(entry.title, entry.command, entry.toolName, entry.name, entry.label);
          let kind: "user" | "message" | "reasoning" | "tool" | "command" | "file" | "other";
          if (kindRaw.includes("conversation")) kind = role === "user" ? "user" : "message";
          else if (kindRaw.includes("reasoning") || kindRaw.includes("thinking")) kind = "reasoning";
          else if (kindRaw.includes("command") || kindRaw.includes("shell")) kind = "command";
          else if (kindRaw.includes("file")) kind = "file";
          else if (kindRaw.includes("tool") || kindRaw.includes("mcp")) kind = "tool";
          else kind = "other";
          const statusRaw = String(entry.status ?? "").toLowerCase();
          const status =
            statusRaw === "failed" || statusRaw === "error"
              ? ("failed" as const)
              : statusRaw === "pending" || statusRaw === "running"
                ? ("pending" as const)
                : ("completed" as const);
          return {
            id: String(entry.id ?? `row_${index}`),
            kind,
            title,
            text,
            status,
          };
        })
        .filter((entry) => entry.text || entry.title);
      const MAX_ENTRIES = 300;
      const truncated = mapped.length > MAX_ENTRIES;
      return {
        workerThreadId,
        threadStatus,
        entries: truncated ? mapped.slice(-MAX_ENTRIES) : mapped,
        truncated,
      };
    },
    async listCrews() {
      // Every root that ever staffed a crew, not just active goals: clearing
      // a goal must not dump its (hidden) worker threads into the sidebar.
      // Include every durable goal status so its chip remains until clear.
      const roots = new Set<string>([...store.listThreadIds(), ...collab.listRoots()]);
      const crews = [];
      for (const threadId of roots) {
        const goal = store.get(threadId);
        const snap = goal ? view(goal) : null;
        crews.push(
          projectSidebarCrew(
            threadId,
            snap,
            agentCache.get(threadId) ?? [],
            collab.threadIdsForRoot(threadId),
          ),
        );
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

  // Canonical provider-neutral UltraGoal controls on every provider.
  bb.agents.registerTool({
    name: "ultragoal_start",
    description:
      "Start a durable UltraGoal only when explicitly requested by the user or system/developer instructions. Do not infer an UltraGoal from an ordinary task. Set token_budget only when explicitly requested. Fails while an unfinished UltraGoal exists.",
    parameters: z
      .object({
        objective: z
          .string()
          .min(1)
          .describe("The concrete objective to pursue as a durable UltraGoal."),
        token_budget: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Positive token budget. Omit unless explicitly requested."),
      })
      .strict(),
    async execute({ objective, token_budget }, { threadId }) {
      const rootThreadId = collab.rootId(threadId);
      const existing = store.get(rootThreadId);
      if (existing && isUnfinished(existing.status)) {
        return {
          content: [
            {
              type: "text",
              text: "cannot start a new UltraGoal because this thread has an unfinished UltraGoal; finish the existing UltraGoal first",
            },
          ],
          isError: true,
        };
      }
      const result = await userSetGoal(rootThreadId, objective, token_budget ?? null);
      if ("error" in result) {
        return { content: [{ type: "text", text: result.error }], isError: true };
      }
      return goalToolResponse(view(result));
    },
  });

  bb.agents.registerTool({
    name: "ultragoal_state",
    description: "Read the durable UltraGoal and a bounded page of its work items.",
    parameters: z.object({
      plan_status: z.enum(["open", "pending", "in_progress", "completed", "all"]).optional(),
      plan_cursor: z.number().int().nonnegative().optional(),
      plan_limit: z.number().int().min(1).max(100).optional(),
    }).strict(),
    async execute({ plan_status, plan_cursor, plan_limit }, { threadId }) {
      const rootThreadId = collab.rootId(threadId);
      await refreshRunning(rootThreadId);
      const accounted = await account(rootThreadId);
      const goal = accounted ?? store.get(rootThreadId);
      return goalToolResponse(
        goal ? await viewFresh(goal) : null,
        false,
        findings.list(rootThreadId, "open"),
        { planStatus: plan_status, planCursor: plan_cursor, planLimit: plan_limit },
      );
    },
  });

  bb.agents.registerTool({
    name: "ultragoal_patch",
    description: "Patch up to 200 new or changed work items in the durable UltraGoal. Omitted items are preserved.",
    parameters: z.object({
      explanation: z.string().optional(),
      remove_item_ids: z.array(z.string().min(1)).max(200).optional(),
      plan: z.array(z.object({
        id: z.string().optional(),
        step: z.string().min(1),
        status: z.enum(["pending", "in_progress", "completed"]),
        deps: z.array(z.string()).optional(),
        files: z.array(z.string()).optional(),
        check: z.string().nullable().optional(),
      })).max(200).default([]),
    }).strict(),
    async execute({ plan, remove_item_ids }, { threadId }) {
      const rootThreadId = collab.rootId(threadId);
      const goal = store.get(rootThreadId);
      if (!goal || !isUnfinished(goal.status)) {
        return { content: [{ type: "text", text: "no unfinished UltraGoal" }], isError: true };
      }
      const before = items.list(rootThreadId);
      const beforeById = new Map(before.map((item) => [item.id, item]));
      const removals = [...new Set((remove_item_ids ?? []).map((id) => id.trim()).filter(Boolean))];
      const suppliedIds = plan.flatMap((patch) => patch.id?.trim() ? [patch.id.trim()] : []);
      const unknownIds = [...new Set([...removals, ...suppliedIds].filter((id) => !beforeById.has(id)))];
      if (unknownIds.length > 0) {
        return {
          content: [{ type: "text", text: `unknown work item id(s): ${unknownIds.join(", ")}` }],
          isError: true,
        };
      }
      const active = removals.filter((id) => {
        const item = beforeById.get(id);
        return item?.status === "in_progress" || workersOnItem(rootThreadId, id).length > 0;
      });
      if (active.length > 0) {
        return { content: [{ type: "text", text: `cannot remove active work item(s): ${active.join(", ")}` }], isError: true };
      }
      // Repair stale legacy coalescing before deciding whether a completion
      // lacks evidence. Otherwise an invalid generated-migration attachment
      // can permanently block the very patch that should close its item.
      let repairedLinks = 0;
      for (const patch of plan) {
        if (!patch.id || patch.status !== "completed") continue;
        if (beforeById.get(patch.id)?.status === "completed") continue;
        const detached = detachStaleFindingLinks({
          threadId: rootThreadId,
          itemId: patch.id,
          findings,
          items,
        });
        repairedLinks += detached.requeuedInvalid + detached.requeuedMissing;
      }
      if (repairedLinks > 0) reconcileFindingBacklog(rootThreadId);
      const uncoveredRemediation = plan.flatMap((patch) => {
        if (!patch.id || patch.status !== "completed") return [];
        if (beforeById.get(patch.id)?.status === "completed") return [];
        return linkedOpenFindings(rootThreadId, patch.id).map((finding) => finding.id);
      });
      if (uncoveredRemediation.length > 0) {
        return {
          content: [{
            type: "text",
            text: `cannot mark remediation work complete through ultragoal_patch without per-defect evidence: ${uncoveredRemediation.join(", ")}. Use slice_done/verification or resolve each defect with evidence.`,
          }],
          isError: true,
        };
      }
      try {
        const patched = items.patch(rootThreadId, plan, removals);
        for (const item of patched.items) {
          if (item.status !== "completed") continue;
          if (beforeById.get(item.id)?.status === "completed") continue;
          closeItemFindings(rootThreadId, item.id, "Marked completed through ultragoal_patch.");
        }
        const added = patched.items.filter((item) => !beforeById.has(item.id)).length;
        const updated = patched.items.length - added;
        markGoalEvent(rootThreadId);
        const next = await viewFresh(goal);
        publish(rootThreadId, next);
        void ensureCrew(rootThreadId);
        void scheduleReady(rootThreadId);
        return JSON.stringify({ added, updated, removed: patched.removed, total: next.items.length });
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  });

  bb.agents.registerTool({
    name: "ultragoal_finish",
    description: "Mark the durable UltraGoal complete or genuinely blocked. Completion requires a delivery summary and no open defects or owner decisions.",
    parameters: z.object({
      status: z.enum(["complete", "blocked"]),
      summary: z.string().optional(),
    }).strict(),
    async execute({ status, summary }, { threadId }) {
      const rootThreadId = collab.rootId(threadId);
      const accounted = (await account(rootThreadId)) ?? store.get(rootThreadId);
      if (!accounted) {
        return { content: [{ type: "text", text: "no UltraGoal" }], isError: true };
      }
      if (status === "complete") {
        if (!summary || summary.trim().length < 40) {
          return { content: [{ type: "text", text: "completion requires a substantive delivery summary" }], isError: true };
        }
        const openWork = items.list(rootThreadId).filter((item) => item.status !== "completed");
        if (openWork.length > 0) {
          return {
            content: [{ type: "text", text: `cannot complete: ${openWork.length} work item(s) remain open` }],
            isError: true,
          };
        }
        const openDecisions = decisions.list(rootThreadId, "open");
        const openFindings = findings.list(rootThreadId, "open");
        if (openDecisions.length > 0 || openFindings.length > 0) {
          return {
            content: [{
              type: "text",
              text: `cannot complete: ${openDecisions.length} owner decision(s) and ${openFindings.length} open defect(s) remain`,
            }],
            isError: true,
          };
        }
        store.update(rootThreadId, { completionSummary: summary.trim() });
      }
      const next = applyStatus(rootThreadId, status, null);
      return goalToolResponse(next ? view(next) : null, status === "complete");
    },
  });
  const reconcilingFindingQueues = new Set<string>();

  function reconcileFindingBacklog(rootThreadId: string): void {
    if (transferLocked(rootThreadId)) return;
    if (reconcilingFindingQueues.has(rootThreadId)) return;
    const goal = store.get(rootThreadId);
    if (!goal || !isUnfinished(goal.status)) return;
    reconcilingFindingQueues.add(rootThreadId);
    try {
      const result = reconcileFindingQueue({
        threadId: rootThreadId,
        findings,
        items,
        maxStaffed: view(goal).settings.maxOpenFindings,
        completionEvidence: (itemId) => collab.findingEvidenceForItem(rootThreadId, itemId, {
          verifierOnly: view(goal).settings.verifyEnabled,
        }),
      });
      const changed =
        result.linked +
        result.minted +
        result.autoFixed +
        result.healedDuplicates +
        result.requeuedMissing +
        result.requeuedInvalid +
        result.requeuedCompleted;
      if (changed === 0) return;
      bb.log.info(
        `Finding queue on ${rootThreadId}: ${result.minted} minted, ${result.linked} attached, ${result.healedDuplicates} duplicate singleton(s) healed, ${result.autoFixed} recovered from structured evidence, ${result.requeuedMissing} requeued missing, ${result.requeuedInvalid} requeued invalid, ${result.requeuedCompleted} requeued from unproven completed work; ${result.remediationWorkItems} remediation work item(s), ${result.awaitingAssignment} awaiting assignment`,
      );
      markGoalEvent(rootThreadId);
      void publishFresh(rootThreadId);
      if (result.minted > 0 || result.linked > 0 || result.healedDuplicates > 0) {
        void scheduleReady(rootThreadId);
      }
    } finally {
      reconcilingFindingQueues.delete(rootThreadId);
    }
  }

  async function registerFinding(
    rootThreadId: string,
    input: {
      title: string;
      file: string;
      evidence: string;
      fixFiles?: string[];
      check?: string | null;
      ownSlice?: boolean;
    },
  ): Promise<{ created: boolean; findingId: string; fixItemId: string | null; status: string }> {
    const result = findings.report(rootThreadId, {
      title: input.title,
      file: input.file,
      evidence: input.evidence,
      fixFiles: input.fixFiles,
      check: input.check,
    });
    if (result.created && input.ownSlice) {
      // An outside auditor filing a proven blocker can demand its own slice.
      // Ordinary coalescing attaches a finding to any older open item sharing
      // one concrete file, which is right for avoiding two workers in the same
      // file and wrong for a distinct defect with its own reproduction and
      // done-check — six proven launch blockers were silently buried inside
      // four unrelated slices that way. The explicit CONTEXT clause is the
      // plugin's own durable ownership declaration, so this link survives both
      // stale-link detachment and auto-minted duplicate healing.
      // Scope defaults to the evidence file when the filer declared no repair
      // files. The scheduler serializes overlapping work through `item.files`
      // alone, so an empty scope silently opts the slice out of that guard and
      // lets a second worker edit the same file concurrently.
      //
      // Declared files are normalized too, not just the fallback: overlap is
      // compared as exact paths, so a line-qualified `src/x.ts:99` would be
      // stored literally and never match another slice's `src/x.ts`, quietly
      // defeating the same guard the default exists to preserve.
      const evidenceFile = normalizeFindingFile(result.finding.file);
      const scope = ownSliceScope(result.finding.file, input.fixFiles);
      // The minted step used to be title + file + finding id and nothing else,
      // while the reproduction and done-check sat in the finding's evidence.
      // Workers see that evidence through the linked-defect brief, but anyone
      // reading the PLAN sees an empty-looking slice — an orchestrator reported
      // one of these as "check:(none) and a one-line step" and could not tell
      // it from an unbriefed item. Point at the contract, and when no check was
      // supplied say so, because nothing then gates the slice's completion.
      const dedicated = items.add(
        rootThreadId,
        [
          `Fix: ${result.finding.title} [${evidenceFile}] CONTEXT (audit findings: ${result.finding.id}).`,
          `The reproduction and the done-check are in that finding's evidence — read it before you start; this step is a label, not the contract.`,
          input.check
            ? ""
            : `NO CHECK COMMAND was filed with this defect, so nothing automatically gates completion: state in your report exactly how you verified the fix, and name the command you ran.`,
        ]
          .filter(Boolean)
          .join(" "),
        "pending",
        { deps: [], files: scope, check: input.check ?? null },
      );
      if (dedicated && !findings.linkItem(rootThreadId, result.finding.id, dedicated.id)) {
        items.remove(rootThreadId, dedicated.id);
      }
    }
    reconcileFindingBacklog(rootThreadId);
    const latest = findings.get(rootThreadId, result.finding.id) ?? result.finding;
    if (!result.created) {
      return {
        created: false,
        findingId: latest.id,
        fixItemId: latest.itemId,
        status: latest.status,
      };
    }
    if (!latest.itemId) {
      bb.log.warn(
        `Finding ${result.finding.id} awaits assignment on ${rootThreadId}: remediation capacity is full`,
      );
    }
    markGoalEvent(rootThreadId);
    void publishFresh(rootThreadId);
    void nudgeRoot(rootThreadId);
    return {
      created: true,
      findingId: result.finding.id,
      fixItemId: latest.itemId,
      status: "open",
    };
  }

  bb.agents.registerTool({
    name: "add_slice",
    description:
      "Add ONE new plan slice to the goal (feature request, follow-up work, or escalation that is not a defect — defects go through report_finding). The scheduler staffs it when its deps complete. Write the step as a self-contained brief; keep files the narrow real touched set or empty.",
    parameters: z.object({
      step: z.string().min(10).describe("Self-contained slice brief: objective + boundaries."),
      files: z.array(z.string()).optional().describe("Narrow file scope, or omit."),
      check: z.string().optional().describe("Runnable command proving the slice done."),
      deps: z.array(z.string()).optional().describe("item_ids this slice must wait for."),
    }),
    async execute({ step, files, check, deps }, { threadId }) {
      const rootThreadId = collab.rootId(threadId);
      const goal = store.get(rootThreadId);
      if (!goal || (goal.status !== "active" && goal.status !== "budget_limited")) {
        return {
          content: [{ type: "text", text: "no active UltraGoal on this thread tree" }],
          isError: true,
        };
      }
      const item = items.add(rootThreadId, step, "pending", {
        deps: deps ?? [],
        files: files ?? [],
        check: check ?? null,
      });
      if (!item) {
        return { content: [{ type: "text", text: "could not add slice" }], isError: true };
      }
      markGoalEvent(rootThreadId);
      void publishFresh(rootThreadId);
      void scheduleReady(rootThreadId);
      return { content: [{ type: "text", text: JSON.stringify({ item_id: item.id }) }] };
    },
  });

  bb.agents.registerTool({
    name: "slice_done",
    description:
      "Formally report your assigned slice complete. Pass general evidence plus one structured finding_evidence entry (exact finding_id and nonempty affirmative proof) for every linked defect. Prose mentions never count. Then END YOUR TURN: the slice closes or verification starts when your turn ends.",
    parameters: z.object({
      evidence: z
        .string()
        .min(10)
        .describe("Commit SHA(s) plus the passing check command and its output/summary."),
      finding_evidence: z.array(z.object({
        finding_id: z.string().regex(/^fnd_[a-z0-9_]+$/i),
        proof: z.string().trim().min(1),
      }).strict()).max(5_000).default([]).describe(
        "One affirmative proof record per linked defect. Exact IDs only; omissions, prefix matches, and prose mentions are rejected.",
      ),
    }).strict(),
    async execute({ evidence, finding_evidence }, { threadId }) {
      const row = collab.rowOf(threadId);
      if (!row || row.role === "verifier" || !row.item_id) {
        return {
          content: [{ type: "text", text: "slice_done is for goal workers with an assigned slice" }],
          isError: true,
        };
      }
      const structuredEvidence = finding_evidence.map((entry) => ({
        findingId: entry.finding_id,
        proof: entry.proof,
      }));
      const missingFindingIds = missingCompletionFindingIds(
        row.root_thread_id,
        row.item_id,
        structuredEvidence,
      );
      if (missingFindingIds.length > 0) {
        const remainingBrief = formatLinkedDefectBrief(
          linkedOpenFindings(row.root_thread_id, row.item_id).filter((finding) =>
            missingFindingIds.includes(finding.id),
          ),
        );
        return {
          content: [{
            type: "text",
            text: [
              `slice_done rejected: finding_evidence must contain exact affirmative proof for every linked defect. Missing: ${missingFindingIds.join(", ")}`,
              remainingBrief,
            ].filter(Boolean).join("\n\n"),
          }],
          isError: true,
        };
      }
      collab.setReport(threadId, "done", evidence, structuredEvidence);
      return {
        content: [
          {
            type: "text",
            text: "Done report recorded. End your turn now - the slice closes (or verification starts) on turn end.",
          },
        ],
      };
    },
  });

  bb.agents.registerTool({
    name: "slice_blocked",
    description:
      "Formally report your assigned slice blocked. Pass the specific blocker (what you need, from whom). Then END YOUR TURN - the orchestrator is woken to act. This tool call is the only blocked signal; prose claims do nothing.",
    parameters: z.object({
      blocker: z.string().min(10).describe("The specific blocker: what is needed and from whom."),
    }),
    async execute({ blocker }, { threadId }) {
      const row = collab.rowOf(threadId);
      if (!row || row.role === "verifier" || !row.item_id) {
        return {
          content: [{ type: "text", text: "slice_blocked is for goal workers with an assigned slice" }],
          isError: true,
        };
      }
      collab.setReport(threadId, "blocked", blocker);
      markGoalEvent(row.root_thread_id);
      return {
        content: [
          { type: "text", text: "Blocked report recorded. End your turn - the orchestrator will act." },
        ],
      };
    },
  });

  bb.agents.registerTool({
    name: "report_finding",
    description:
      "Report ONE discrete defect the moment you confirm it during a hunt/audit/review — do not batch findings into a final report. Findings are fingerprint-deduplicated. Same-file defects coalesce; new files mint ready fix slices until the staffed remediation cap, then queue durably and backfill oldest-first. Open findings block goal completion.",
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
      const registered = await registerFinding(rootThreadId, {
        title,
        file,
        evidence,
        fixFiles: fix_files,
        check,
      });
      if (!registered.created) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "duplicate",
                finding_id: registered.findingId,
                finding_status: registered.status,
                note:
                  registered.status === "fixed"
                    ? "This finding was already fixed. Verify it actually regressed before re-reporting; if it did, report with a more specific title."
                    : "Already known; its fix is tracked.",
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              findingRegistrationOutcome(registered.findingId, registered.fixItemId),
            ),
          },
        ],
      };
    },
  });

  bb.agents.registerTool({
    name: "request_decision",
    description:
      "Escalate a decision only the OWNER (the human user) can make — irreversible actions (history rewrites, deletions, spending), scope changes, or preference calls. It renders in the UltraGoal pane's 'Needs you' section and blocks goal completion until answered (bb ultragoal decide <id> <answer>). Also post one short user-visible chat message stating the question. Never bury an owner decision inside a progress note, never re-ask an open one, and never proceed on an assumed answer.",
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
    parameters: z.object({
      decision: z.string().min(1).describe("Decision id (dec_...) from request_decision or ultragoal_state."),
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
    parameters: z.object({
      finding: z.string().min(1).describe("Finding id (fnd_...) or fingerprint from report_finding/ultragoal_state."),
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
      const retiredItemId = retireOrphanedRemediationItem(rootThreadId, resolved.itemId)
        ? resolved.itemId
        : null;
      reconcileFindingBacklog(rootThreadId);
      void publishFresh(rootThreadId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              finding_id: resolved.id,
              status: resolved.status,
              ...(retiredItemId ? { retired_item_id: retiredItemId } : {}),
            }),
          },
        ],
      };
    },
  });

  collab.registerTools();

  bb.agents.configure((context) => {
    const row = collab.rowOf(context.thread.id);
    const storedRoot = store.get(context.thread.id);
    // UltraGoal is provider-neutral. Registered workers get the same worker
    // controls, while every root gets the canonical ultragoal_* surface even
    // when no goal exists yet (availability alone never starts one).
    if (context.origin.pluginId === "side-chat") {
      return { tools: [], skills: [] };
    }
    const parentId = row?.parent_thread_id ?? context.thread.parentThreadId;
    const rootId = row?.root_thread_id ?? parentId ?? context.thread.id;
    const inherited = parentId ? store.get(rootId) : null;
    const isWorker = Boolean(inherited && isUnfinished(inherited.status) && inherited.threadId !== context.thread.id);
    const goal = isWorker ? inherited : storedRoot;
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
                'For every linked defect, emit DEFECT_COVERAGE: {"finding_id":"fnd_...","status":"pass","proof":"what you checked"}; prose mentions never count. End with VERIFY_PASS or VERIFY_FAIL. Do not implement fixes.',
                "Do not call ultragoal_finish, do not rewrite the parent plan, and do not take over the whole UltraGoal.",
              ].join("\n")
            : [
                `You are an UltraGoal subagent${row?.display_name ? ` (${row.display_name})` : ""}. Parent objective: ${goal.objective}`,
                "Complete only the slice you were assigned. Signal completion ONLY via slice_done with general evidence plus one structured finding_evidence {finding_id, proof} entry per linked defect, or slice_blocked. Prose claims and ID mentions do nothing.",
                'If your provider cannot call a tool as your turn ends, use the text fallback instead: emit one line per linked defect — DEFECT_COVERAGE: {"finding_id":"fnd_...","status":"pass","proof":"what you checked"} — and end your final message with ULTRAGOAL_DONE (or ULTRAGOAL_BLOCKED). It carries exactly the same evidence bar; a sentinel without per-defect coverage lines does not close the slice.',
                "If your slice is a hunt/audit/review, call report_finding per discrete defect the moment you confirm it — fixes are staffed automatically; do not batch findings into your final report.",
                "Do not call ultragoal_finish, do not rewrite the parent plan, and do not take over the whole UltraGoal.",
                "You may spawn nested helpers for your slice if it splits cleanly.",
              ].join("\n")
          : undefined;
      // The goal here is the worker's inherited root, so its thread id is the
      // goal whose house rules apply.
      const briefed = worker && goal
        ? withStandingBrief(worker, workerBriefs.get(goal.threadId))
        : worker;
      return {
        tools: [...COLLAB_TOOL_NAMES, "slice_done", "slice_blocked", "report_finding", "resolve_finding", "request_decision"],
        skills: [],
        instructions: briefed,
      };
    }

    const live =
      goal && (goal.status === "active" || goal.status === "budget_limited")
        ? [
            `Durable UltraGoal (${goal.status}): ${goal.objective}`,
            "This root thread is the orchestrator. Subagents do the implementation by default.",
            plan.length > 0
              ? `Requirement plan: ${done}/${plan.length} complete. ultragoal_patch is patch-style: send only new or changed work items; omitted items remain. Use ultragoal_state pagination when you need more than the bounded working set.`
              : "The UltraGoal pane is empty. Call ultragoal_patch immediately with concrete remaining work. Do not use TodoWrite or Update TODOs for that list.",
            liveAgents.length > 0
              ? `${liveAgents.length} subagent(s) are live. Wait or follow up; do not redo their slices on the root.`
              : "No subagents are live. Keep the plan's ready slices flowing; the scheduler staffs them.",
            `You plan; the scheduler staffs. Express all work through ultragoal_patch with deps/files/check — the UltraGoal scheduler spawns one fresh worker per ready work item automatically, up to ${view(goal).settings.maxWorkers} concurrent. Do not spawn workers for plan items yourself and never use the native Task tool for slice work (it blocks this thread). spawn_agent is only for ad-hoc helpers outside the plan; give any such helper a humorous display_name related to its work.`,
            "Hunts stream: workers report_finding per defect. Related defects coalesce; new files mint remediation work until capacity, then wait durably and backfill oldest-first. Never write catch-all tail items. Open defects block ultragoal_finish complete.",
            view(goal).settings.verifyEnabled
              ? `Verification is on. After a worker returns, a ${view(goal).settings.verifyProvider}/${view(goal).settings.verifyModel} verifier is launched automatically. Do not mark that slice complete until VERIFY_PASS. On VERIFY_FAIL, spawn a fix worker.`
              : "Verification is off for this UltraGoal.",
            view(goal).settings.progressUpdateMinutes > 0
              ? `Do not write a visible chat status on ordinary turns. A progress-check-in every ${view(goal).settings.progressUpdateMinutes} minutes will ask when a chat update is due. You may also write one short note when a slice completes or a worker fails.`
              : "Progress chat updates are off for this UltraGoal. Do not write routine status notes.",
            "Stay on the root to plan, wait, verify, and unblock.",
            "Call ultragoal_finish with status complete only when current evidence proves every requirement.",
            "Call ultragoal_finish with status blocked only after the same blocker repeats for three consecutive goal turns.",
            "Use only the canonical ultragoal_* controls. Provider-native goal state is unrelated to this UltraGoal.",
            "Do not pause, resume, clear, or budget-limit the goal; those are user or system controls.",
          ].join("\n")
        : undefined;
    return {
      tools: [
        "ultragoal_start",
        "ultragoal_state",
        "ultragoal_patch",
        "ultragoal_finish",
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
    if (transferLocked(thread.id)) return;
    if (store.get(thread.id) || collab.rowOf(thread.id)) {
      void approveInteractions(thread.id);
    }
    // A blocked/usage-limited goal whose root runs again has recovered: the
    // block was a turn error or a passed limit, and the contract treats any
    // resumed run as a fresh blocked audit. Paused stays paused — that is
    // user intent.
    const recovering = store.get(thread.id);
    if (
      recovering &&
      (recovering.status === "blocked" || recovering.status === "usage_limited")
    ) {
      applyStatus(thread.id, "active", null);
      markGoalEvent(thread.id);
      bb.log.info(
        `Goal auto-resumed on ${thread.id}: root thread active again (was ${recovering.status}: ${recovering.reason ?? "no reason"})`,
      );
    }
    await registerNewChild(thread);
    const existing = store.get(thread.id);
    if (existing && (existing.status === "active" || existing.status === "budget_limited")) {
      const next = store.update(thread.id, { lastAccountedAt: Date.now() });
      if (next) publish(thread.id, await viewFresh(next));
    }
    const rootId = collab.rowOf(thread.id)?.root_thread_id;
    if (rootId && rootId !== thread.id) void publishFresh(rootId);
    const rows = await readTimeline(thread.id);
    await applyUserSlash(thread.id, lastUserText(rows));
    void maybeIntakeUserMessage(thread.id, rows);
  });

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    if (transferLocked(thread.id)) {
      running.set(thread.id, false);
      return;
    }
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
      if (child.role !== "verifier" && child.task_name.includes("/intake_")) {
        void releaseWorkerRuntime(thread.id);
        collab.forget(thread.id);
        void publishFresh(parentRoot);
        return;
      }
      if (child.role !== "verifier") {
        const claim = collab.reportOf(thread.id);
        if (
          completeItemFor(parentRoot, child.item_id, claim?.evidence ?? lastAssistantText, {
            workerThreadId: child.thread_id,
            recordedClaim: claim?.status ?? null,
            findingEvidence: claim?.findingEvidence ?? [],
          })
        ) {
          queueIntegration(parentRoot, thread.id, child.item_id);
        }
        await maybeVerifyWorker(thread.id);
      } else {
        const sourceItemId = child.source_thread_id
          ? (collab.rowOf(child.source_thread_id)?.item_id ?? child.item_id)
          : child.item_id;
        const verifierEvidence = parseDefectCoverageEvidence(lastAssistantText);
        const verdict = parseVerifierVerdict(lastAssistantText);
        const passClaim = verdict === "pass";
        const missingVerifierCoverage =
          passClaim && sourceItemId
            ? missingCompletionFindingIds(parentRoot, sourceItemId, verifierEvidence)
            : [];
        const protocolFailure = verdict === null
          ? {
              reason:
                "Your verifier output was rejected because its final verdict was missing, malformed, or ambiguous.",
              brief: sourceItemId
                ? formatLinkedDefectBrief(linkedOpenFindings(parentRoot, sourceItemId))
                : "",
              instruction:
                'Reinspect the work. Emit one exact JSON line per linked defect: DEFECT_COVERAGE: {"finding_id":"fnd_...","status":"pass","proof":"what you checked"}. End with exactly one nonempty final line: VERIFY_PASS: <sentence> or VERIFY_FAIL: <what is still wrong>.',
              log: "an invalid verdict",
            }
          : passClaim && missingVerifierCoverage.length > 0
            ? {
                reason: `Your VERIFY_PASS was rejected because it omitted structured affirmative coverage for: ${missingVerifierCoverage.join(", ")}.`,
                brief: sourceItemId
                  ? formatLinkedDefectBrief(
                      linkedOpenFindings(parentRoot, sourceItemId).filter((finding) =>
                        missingVerifierCoverage.includes(finding.id),
                      ),
                    )
                  : "",
                instruction:
                  'Reinspect every missing defect. Emit one exact JSON line per defect: DEFECT_COVERAGE: {"finding_id":"fnd_...","status":"pass","proof":"what you checked"}. Then end with VERIFY_PASS or VERIFY_FAIL.',
                log: `missing coverage for ${missingVerifierCoverage.join(", ")}`,
              }
            : null;
        if (protocolFailure) {
          // Protocol failures consume the same durable budget as a real failed
          // verification. Otherwise a provider that never follows the output
          // contract can retry forever across plugin reloads.
          const sourceThreadId = child.source_thread_id;
          if (sourceThreadId) collab.setVerifyHash(sourceThreadId, null);
          const failures = sourceThreadId
            ? collab.bumpVerifyFails(sourceThreadId)
            : MAX_VERIFY_FAILS;
          if (!sourceThreadId || failures >= MAX_VERIFY_FAILS) {
            collab.forget(thread.id);
            void releaseWorkerRuntime(thread.id);
            markGoalEvent(parentRoot);
            bb.log.warn(
              `Verifier ${thread.id} exhausted ${failures}/${MAX_VERIFY_FAILS} attempts on ${parentRoot} after ${protocolFailure.log}; leaving the open slice to the orchestrator`,
            );
            void publishFresh(parentRoot);
            void nudgeRoot(parentRoot);
            return;
          }
          try {
            await bb.sdk.threads.send({
              threadId: thread.id,
              mode: immediateSendMode(thread) ?? "start",
              permissionMode: snapshotDefaults.workerPermissionMode,
              input: [{
                type: "text",
                text: [
                  `${protocolFailure.reason} (attempt ${failures}/${MAX_VERIFY_FAILS})`,
                  protocolFailure.brief,
                  protocolFailure.instruction,
                ].filter(Boolean).join("\n\n"),
                mentions: [],
              }],
            });
            bb.log.warn(
              `Retried verifier ${thread.id} ${failures}/${MAX_VERIFY_FAILS} on ${parentRoot} after ${protocolFailure.log}`,
            );
          } catch (error) {
            collab.forget(thread.id);
            void releaseWorkerRuntime(thread.id);
            await maybeVerifyWorker(sourceThreadId);
            bb.log.warn(
              `Could not retry verifier ${thread.id}; released it for replacement: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          void publishFresh(parentRoot);
          return;
        }
        if (passClaim) {
          collab.setReport(thread.id, "done", lastAssistantText ?? "", verifierEvidence);
        }
        const passed = completeItemFor(parentRoot, sourceItemId, lastAssistantText, {
          // The verifier judged someone else's slice; a refusal belongs to the
          // worker that produced the report, not to the verifier.
          workerThreadId: child.source_thread_id ?? thread.id,
          requirePass: true,
        });
        if (passed && child.source_thread_id) {
          queueIntegration(parentRoot, child.source_thread_id, sourceItemId);
        }
        // A failed verdict goes back to the worker WITH the findings — a
        // blind resume just repeats the same mistake. Three failed cycles
        // hand the slice to the orchestrator instead of looping forever.
        // The verifier's runtime is done either way — release it. (Verifiers
        // were leaking one codex process per audit.) Its durable row is done
        // too: `verifiersFor` counts every non-retired verifier row regardless
        // of host status, so a terminal row left behind would block its source
        // worker from ever being retired. A later VERIFY_FAIL cycle spawns a
        // fresh verifier.
        collab.forget(thread.id);
        void releaseWorkerRuntime(thread.id);
        if (
          !passed &&
          child.source_thread_id &&
          verdict === "fail"
        ) {
          const fails = collab.bumpVerifyFails(child.source_thread_id);
          if (fails < MAX_VERIFY_FAILS) {
            try {
              await bb.sdk.threads.send({
                threadId: child.source_thread_id,
                mode: "start",
                permissionMode: snapshotDefaults.workerPermissionMode,
                input: [
                  {
                    type: "text",
                    text: [
                      `Your slice failed independent verification (attempt ${fails}/${MAX_VERIFY_FAILS}). The verifier's findings:`,
                      (lastAssistantText ?? "").slice(-1800),
                      "Address every finding, re-run your check, then call slice_done again with fresh evidence (commit SHAs + passing check output).",
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
        const sent = await sendSteering(
          thread.id,
          budgetLimitPrompt(view(latest)),
          "start",
        );
        if (sent) store.update(thread.id, { lastContinueWasAutomatic: true, lastContinueAt: Date.now() });
      }
      return;
    }
    await continueIfIdle(thread.id, latest);
  });

  bb.events.on("thread.failed", async ({ thread, error }) => {
    if (transferLocked(thread.id)) return;
    // A rejected second submit is not a dead root. OpenCode still holds the
    // first turn; marking blocked here is what made compact/continue pile on
    // and left the openbooks goal stuck on "Command turn.submit failed".
    if (isTurnAlreadyActiveError(error) || /no active acp session/i.test(error ?? "")) {
      bb.log.warn(`Ignoring recoverable submit failure on ${thread.id}: ${error}`);
      return;
    }
    running.set(thread.id, false);
    const failedChild = collab.rowOf(thread.id);
    if (failedChild && failedChild.root_thread_id !== thread.id) {
      // A failed child is dead, and its durable row is not. Leaving it live
      // wedges a slot two ways: as a worker it keeps consuming root capacity,
      // and as a verifier it keeps `verifiersFor` reporting a dependant, which
      // blocks its SOURCE worker from ever being retired. Its slice returns to
      // the queue through the ordinary orphan reclaim.
      collab.forget(thread.id);
      markGoalEvent(failedChild.root_thread_id);
      void publishFresh(failedChild.root_thread_id);
      void scheduleReady(failedChild.root_thread_id);
    }
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
    if (transferLocked(thread.id)) return;
    running.delete(thread.id);
    forgetNativeScan(thread.id);
    // A deleted child cannot come back, so its durable row is pure leak: it
    // holds a root slot, and as a verifier row it blocks its source worker's
    // retirement forever.
    const deletedChild = collab.rowOf(thread.id);
    if (deletedChild && deletedChild.root_thread_id !== thread.id) {
      collab.forget(thread.id);
      markGoalEvent(deletedChild.root_thread_id);
      void publishFresh(deletedChild.root_thread_id);
      void scheduleReady(deletedChild.root_thread_id);
    }
    items.clear(thread.id);
    findings.clear(thread.id);
    decisions.clear(thread.id);
    if (store.clear(thread.id)) publish(thread.id, null);
  });

  const runCli = async (argv: string[], ctx: { threadId?: string }) => {
      const parsed = parseCli(argv, ctx.threadId);
      if (parsed.error) return { exitCode: 1, stderr: parsed.error };
      const { threadId, action, objective } = parsed;

      if (action === "transfer-root") {
        const args = parsed.rawRest ?? [];
        const dryRun = args.includes("--dry-run");
        const ids = args.filter((arg) => arg !== "--dry-run");
        if (ids.length !== 2) {
          return {
            exitCode: 1,
            stderr: "Usage: bb ultragoal transfer-root <source-thread-id> <target-thread-id> [--dry-run]",
          };
        }
        const [sourceThreadId, targetThreadId] = ids as [string, string];
        try {
          const report = await runRootTransfer(sourceThreadId, targetThreadId, dryRun);
          return {
            exitCode: 0,
            stdout: JSON.stringify(
              {
                command: `bb ultragoal transfer-root ${sourceThreadId} ${targetThreadId}`,
                phase: report.journal?.phase ?? null,
                ...report,
              },
              null,
              2,
            ),
          };
        } catch (error) {
          return {
            exitCode: 1,
            stderr: error instanceof Error ? error.message : String(error),
          };
        }
      }

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
          await sendSteering(
            threadId,
            continuationPrompt(view(result)),
            "start",
          );
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

      if (action === "finding") {
        const tokens = (objective ?? "").length > 0 ? parsed.rawRest ?? [] : parsed.rawRest ?? [];
        let file = "";
        let evidence = "";
        let check: string | null = null;
        let fixFiles: string[] = [];
        let ownSlice = false;
        const titleParts: string[] = [];
        for (let i = 0; i < tokens.length; i += 1) {
          const token = tokens[i];
          if (token === "--file") { file = tokens[++i] ?? ""; continue; }
          if (token === "--evidence") { evidence = tokens[++i] ?? ""; continue; }
          if (token === "--check") { check = tokens[++i] ?? null; continue; }
          if (token === "--own-slice") { ownSlice = true; continue; }
          if (token === "--fix-files") {
            fixFiles = (tokens[++i] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
            continue;
          }
          titleParts.push(token);
        }
        const title = titleParts.join(" ").trim();
        if (!title || !file || !evidence) {
          return {
            exitCode: 1,
            stderr:
              'Usage: bb ultragoal finding "<title>" --file <path[:line]> --evidence "<proof>" [--fix-files a,b] [--check <cmd>] [--own-slice] [--thread <id>]',
          };
        }
        const goal = store.get(threadId);
        if (!goal || (goal.status !== "active" && goal.status !== "budget_limited")) {
          return { exitCode: 1, stderr: "No active UltraGoal on this thread." };
        }
        const registered = await registerFinding(threadId, {
          title, file, evidence, fixFiles, check, ownSlice,
        });
        return {
          exitCode: 0,
          stdout: registered.created
            ? findingRegistrationCliMessage(registered.findingId, registered.fixItemId, Boolean(check))
            : `Duplicate of ${registered.findingId} (${registered.status}).`,
        };
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

      // An orchestrator that deliberately stops a worker had no supported way to
      // get its slice back. `bb thread stop` leaves the host `idle`, not
      // `stopped`, so ensureCrew never retires the durable row; the item stays
      // in_progress and held, reclaimOrphanInProgress refuses to demote a held
      // item, and the capacity fence keeps counting the row. The slot was gone
      // until the stall healer eventually nudged the corpse three times.
      if (action === "release") {
        const words = (objective ?? "").trim().split(/\s+/).filter(Boolean);
        const hold = words.includes("--hold");
        const target = words.filter((word) => word !== "--hold").join(" ").trim();
        if (!target) {
          return {
            exitCode: 1,
            stderr: "Usage: bb ultragoal release <worker-thread-id|item-id> [--hold] [--thread <id>]",
          };
        }
        const goal = store.get(threadId);
        if (!goal) return { exitCode: 1, stderr: "No UltraGoal is set on this thread." };
        // Hold before releasing, never after: the scheduler runs on the
        // release and would staff the slice again in the gap.
        if (hold && target.startsWith("itm_")) {
          if (!items.list(threadId).some((row) => row.id === target)) {
            return { exitCode: 1, stderr: `Unknown work item: ${target}` };
          }
          staffingHolds.hold(threadId, target, "released for re-scoping", Date.now());
          void publishFresh(threadId);
        } else if (hold) {
          return { exitCode: 1, stderr: "--hold needs an item id; a worker thread id does not identify the slice to hold." };
        }
        const workerIds = target.startsWith("itm_")
          ? collab.workersOnItem(threadId, target)
          : [target];
        if (workerIds.length === 0) {
          return hold
            ? { exitCode: 0, stdout: `No live worker held ${target}; it is now held out of scheduling. Editing it lifts the hold.` }
            : { exitCode: 1, stderr: `No live worker holds ${target}.` };
        }
        // Validate every target before mutating any of them; see
        // planWorkerRelease for why a partial release is not acceptable.
        const targets: ReleaseTarget[] = [];
        for (const workerId of workerIds) {
          const row = collab.rowOf(workerId);
          if (!row) {
            return { exitCode: 1, stderr: `${workerId} is not a live worker on ${threadId}.` };
          }
          let hostStatus: string | null = null;
          try {
            hostStatus = (await bb.sdk.threads.get({ threadId: workerId })).status ?? null;
          } catch {
            // An unreadable host is not proof of life; releasing is still correct.
          }
          targets.push({
            threadId: workerId,
            rootThreadId: row.root_thread_id,
            role: row.role ?? null,
            itemId: row.item_id ?? null,
            reportStatus: row.report_status ?? null,
            hostStatus,
          });
        }
        const plan = planWorkerRelease(targets, threadId);
        if (!plan.ok) return { exitCode: 1, stderr: `${plan.reason}.` };
        const released: string[] = [];
        for (const { threadId: workerId, itemId } of plan.release) {
          collab.forget(workerId);
          void releaseWorkerRuntime(workerId);
          if (itemId) items.setStatus(threadId, itemId, "pending");
          released.push(itemId ? `${workerId} -> ${itemId}` : workerId);
        }
        markGoalEvent(threadId);
        void publishFresh(threadId);
        void scheduleReady(threadId);
        return {
          exitCode: 0,
          stdout: hold
            ? `Released ${released.length} slice(s) and held ${target} out of scheduling: ${released.join(", ")}. Editing the item lifts the hold.`
            : `Released ${released.length} slice(s) back to pending: ${released.join(", ")}`,
        };
      }

      if (action === "brief") {
        const goal = store.get(threadId);
        if (!goal) return { exitCode: 1, stderr: "No UltraGoal is set on this thread." };
        const text = (objective ?? "").trim();
        if (text === "--clear") {
          const removed = workerBriefs.clear(threadId);
          return { exitCode: 0, stdout: removed ? "Standing worker brief cleared." : "No standing worker brief was set." };
        }
        if (!text) {
          const current = workerBriefs.get(threadId);
          return {
            exitCode: 0,
            stdout: current
              ? `Standing worker brief:\n${current}`
              : "No standing worker brief. Set one so every worker inherits it instead of relying on each slice to repeat it.",
          };
        }
        const error = workerBriefs.set(threadId, text);
        if (error) return { exitCode: 1, stderr: error };
        return { exitCode: 0, stdout: "Standing worker brief set; every worker spawned from now on inherits it." };
      }

      if (action === "requires") {
        const goal = store.get(threadId);
        if (!goal) return { exitCode: 1, stderr: "No UltraGoal is set on this thread." };
        const parts = (objective ?? "").trim().split(/\s+/).filter(Boolean);
        const itemId = parts[0];
        if (!itemId) {
          return { exitCode: 1, stderr: "Usage: bb ultragoal requires <item-id> <path,path> | <item-id> --clear" };
        }
        const item = items.list(threadId).find((row) => row.id === itemId);
        if (!item) return { exitCode: 1, stderr: `Unknown work item: ${itemId}` };
        const rest = parts.slice(1).join(" ").trim();
        if (rest === "--clear") {
          const removed = itemRequirements.clear(threadId, itemId);
          return { exitCode: 0, stdout: removed ? `Cleared required outputs on ${itemId}.` : `${itemId} had no required outputs.` };
        }
        if (!rest) {
          const current = itemRequirements.list(threadId, itemId);
          return {
            exitCode: 0,
            stdout: current.length
              ? `${itemId} cannot close without: ${current.join(", ")}`
              : `${itemId} has no required outputs; its files are a scope ceiling only.`,
          };
        }
        // Requiring an output on work already running would change the contract
        // a worker was briefed under, mid-slice.
        if (item.status === "in_progress") {
          return {
            exitCode: 1,
            stderr: `${itemId} is in progress; its worker was briefed without these requirements. Wait for it to settle, or release the slice first.`,
          };
        }
        const stored = itemRequirements.set(threadId, itemId, rest.split(",").map((entry) => entry.trim()));
        if (stored.length === 0) return { exitCode: 1, stderr: "No usable paths given." };
        markGoalEvent(threadId);
        void publishFresh(threadId);
        return { exitCode: 0, stdout: `${itemId} now requires: ${stored.join(", ")}` };
      }

      if (action === "item") {
        const goal = store.get(threadId);
        if (!goal) return { exitCode: 1, stderr: "No UltraGoal is set on this thread." };
        const tokens = parsed.rawRest ?? [];
        const creating = tokens[0] === "--new";
        const itemId = creating ? "" : tokens[0] ?? "";
        let step: string | undefined;
        let files: string[] | undefined;
        let check: string | null | undefined;
        let remove = false;
        let unhold = false;
        for (let i = 1; i < tokens.length; i += 1) {
          const token = tokens[i];
          if (token === "--step") { step = (tokens[++i] ?? "").trim(); continue; }
          if (token === "--check") { check = (tokens[++i] ?? "").trim() || null; continue; }
          if (token === "--no-check") { check = null; continue; }
          if (token === "--remove") { remove = true; continue; }
          if (token === "--unhold") { unhold = true; continue; }
          if (token === "--files") {
            files = (tokens[++i] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
            continue;
          }
          return { exitCode: 1, stderr: `Unknown option: ${token}` };
        }
        if (creating) {
          if (remove) return { exitCode: 1, stderr: "--new and --remove are contradictory." };
          if (!step) {
            return { exitCode: 1, stderr: 'A new work item needs --step "<what to do and how it is proven done>".' };
          }
          const before = new Set(items.list(threadId).map((row) => row.id));
          const patched = items.patch(threadId, [{
            step,
            status: "pending",
            ...(files !== undefined ? { files } : {}),
            ...(check !== undefined ? { check } : {}),
          }], []);
          const created = patched.items.find((row) => !before.has(row.id));
          if (!created) return { exitCode: 1, stderr: "Could not create the work item." };
          markGoalEvent(threadId);
          void publishFresh(threadId);
          void scheduleReady(threadId);
          return {
            exitCode: 0,
            stdout: [
              `Created ${created.id} [${created.status}]`,
              `  files: ${created.files.length > 0 ? created.files.join(", ") : "(none)"}`,
              `  check: ${created.check ?? "(none)"}`,
              "No finding is linked; it closes on its own report, not on defect coverage.",
            ].join("\n"),
          };
        }
        if (!itemId) {
          return {
            exitCode: 1,
            stderr: 'Usage: bb ultragoal item <item-id> [--step "<text>"] [--files a,b] [--check "<cmd>" | --no-check] [--remove]\n       bb ultragoal item --new --step "<text>" [--files a,b] [--check "<cmd>"]',
          };
        }
        const item = items.list(threadId).find((row) => row.id === itemId);
        if (!item) return { exitCode: 1, stderr: `Unknown work item: ${itemId}` };
        if (remove) {
          const verdict = remediationItemRetirement({
            item,
            linkedFindings: findings.list(threadId).filter((finding) => finding.itemId === itemId),
            staffed:
              workersOnItem(threadId, itemId).length > 0 ||
              itemClaimants(threadId, itemId).length > 0,
          });
          if (!verdict.retire) {
            return { exitCode: 1, stderr: `Refusing to remove ${itemId}: ${verdict.reason}.` };
          }
          if (items.patch(threadId, [], [itemId]).removed === 0) {
            return { exitCode: 1, stderr: `Could not remove ${itemId}.` };
          }
          markGoalEvent(threadId);
          void publishFresh(threadId);
          return { exitCode: 0, stdout: `Removed ${itemId}; every finding that pointed at it is resolved.` };
        }
        if (unhold && step === undefined && files === undefined && check === undefined) {
          const lifted = staffingHolds.lift(threadId, itemId);
          if (lifted) {
            markGoalEvent(threadId);
            void publishFresh(threadId);
            void scheduleReady(threadId);
          }
          return {
            exitCode: 0,
            stdout: lifted ? `${itemId} is schedulable again.` : `${itemId} was not held.`,
          };
        }
        if (step === undefined && files === undefined && check === undefined) {
          return {
            exitCode: 0,
            stdout: [
              `${item.id} [${item.status}]${staffingHolds.isHeld(threadId, itemId) ? " HELD out of scheduling" : ""}`,
              `  step:  ${item.step}`,
              `  files: ${item.files.length > 0 ? item.files.join(", ") : "(none)"}`,
              `  check: ${item.check ?? "(none)"}`,
            ].join("\n"),
          };
        }
        // Same rule as `requires`: a running worker was briefed under this
        // step, scope and check, and rewriting them underneath it changes the
        // contract mid-slice.
        if (item.status === "in_progress") {
          return {
            exitCode: 1,
            stderr: `${itemId} is in progress; its worker was briefed under the current step and scope. Wait for it to settle, or release the slice first.`,
          };
        }
        if (step !== undefined && step.length === 0) {
          return { exitCode: 1, stderr: "An empty --step would erase the item's brief." };
        }
        // Status is deliberately not editable here. Completion carries
        // per-defect evidence rules, and a flag that skipped them would be the
        // shortest path around the whole evidence contract.
        const patched = items.patch(threadId, [{
          id: item.id,
          step: step ?? item.step,
          status: item.status,
          ...(files !== undefined ? { files } : {}),
          ...(check !== undefined ? { check } : {}),
        }], []);
        const next = patched.items.find((row) => row.id === itemId) ?? item;
        // The edit is what the hold was waiting for. Lifting it here rather
        // than on a second command is the point: a hold nobody remembers to
        // lift is just a lost slice.
        const lifted = staffingHolds.lift(threadId, itemId);
        markGoalEvent(threadId);
        void publishFresh(threadId);
        if (lifted) void scheduleReady(threadId);
        return {
          exitCode: 0,
          stdout: [
            `Updated ${next.id} [${next.status}]${lifted ? " — hold lifted, schedulable again" : ""}`,
            `  step:  ${next.step}`,
            `  files: ${next.files.length > 0 ? next.files.join(", ") : "(none)"}`,
            `  check: ${next.check ?? "(none)"}`,
          ].join("\n"),
        };
      }

      if (action === "resolve") {
        const goal = store.get(threadId);
        if (!goal) return { exitCode: 1, stderr: "No UltraGoal is set on this thread." };
        const tokens = parsed.rawRest ?? [];
        const findingId = tokens[0] ?? "";
        let as = "";
        let evidence = "";
        for (let i = 1; i < tokens.length; i += 1) {
          const token = tokens[i];
          if (token === "--as") { as = (tokens[++i] ?? "").trim(); continue; }
          if (token === "--evidence") { evidence = (tokens[++i] ?? "").trim(); continue; }
          return { exitCode: 1, stderr: `Unknown option: ${token}` };
        }
        const resolution = as === "fixed" ? "fixed" : as === "not-a-defect" || as === "not_a_defect" ? "dismissed" : null;
        if (!findingId || !resolution || !evidence) {
          return {
            exitCode: 1,
            stderr: 'Usage: bb ultragoal resolve <finding-id> --as fixed|not-a-defect --evidence "<proof>"',
          };
        }
        const resolved = findings.resolve(threadId, findingId, resolution, evidence);
        if (!resolved) return { exitCode: 1, stderr: `Finding not found: ${findingId}` };
        const retired = retireOrphanedRemediationItem(threadId, resolved.itemId);
        reconcileFindingBacklog(threadId);
        markGoalEvent(threadId);
        void publishFresh(threadId);
        return {
          exitCode: 0,
          stdout: retired
            ? `${resolved.id} resolved: ${resolved.status}; retired its now-orphaned remediation item ${resolved.itemId}`
            : `${resolved.id} resolved: ${resolved.status}`,
        };
      }

      if (action === "exec") {
        const goal = store.get(threadId);
        if (!goal) return { exitCode: 1, stderr: "No UltraGoal is set on this thread." };
        const tokens = parsed.rawRest ?? [];
        const role = tokens[0] ?? "";
        if (!role) {
          // Reading this was impossible from the CLI, which is how a goal ran
          // ninety-nine workers on the wrong provider before anyone noticed.
          return {
            exitCode: 0,
            stdout: [
              `worker:   ${goal.workerProviderOverride ?? "(inherits the root thread)"} ${goal.workerModelOverride ?? ""}`.trim(),
              `verifier: ${goal.verifyProviderOverride ?? "(default)"} ${goal.verifyModelOverride ?? ""}`.trim(),
            ].join("\n"),
          };
        }
        if (role !== "worker" && role !== "verifier") {
          return { exitCode: 1, stderr: 'Usage: bb ultragoal exec | exec worker <provider> <model> | exec verifier <provider> <model>' };
        }
        const providerId = (tokens[1] ?? "").trim();
        const model = tokens.slice(2).join(" ").trim();
        if (!providerId || !model) {
          return { exitCode: 1, stderr: `Usage: bb ultragoal exec ${role} <provider> <model>` };
        }
        const updated = store.update(
          threadId,
          role === "worker"
            ? { workerProviderOverride: providerId, workerModelOverride: model }
            : { verifyProviderOverride: providerId, verifyModelOverride: model },
        );
        if (!updated) return { exitCode: 1, stderr: "Could not update the goal." };
        markGoalEvent(threadId);
        void publishFresh(threadId);
        return {
          exitCode: 0,
          stdout: `${role} now runs on ${providerId} ${model}. Workers already running keep the provider they started on.`,
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
      { name: "exec", summary: "Show or pin which provider and model workers and verifiers run on", usage: "bb ultragoal exec | exec worker <provider> <model> | exec verifier <provider> <model> [--thread <id>]" },
      { name: "workers", summary: "Set the goal's concurrent worker slots", usage: "bb ultragoal workers <0-16> [--thread <id>]" },
      { name: "decide", summary: "Answer an open owner decision", usage: "bb ultragoal decide <decision_id> <answer> [--thread <id>]" },
      { name: "finding", summary: "File a defect finding from outside the goal (auditors, automations)", usage: "bb ultragoal finding \"<title>\" --file <path[:line]> --evidence \"<proof>\" [--fix-files a,b] [--check <cmd>] [--own-slice] [--thread <id>]" },
      { name: "transfer-root", summary: "Atomically transfer an unfinished UltraGoal to an idle Codex root", usage: "bb ultragoal transfer-root <source-thread-id> <target-thread-id> [--dry-run]" },
      { name: "release", summary: "Return a stopped worker's slice to the queue and free its slot", usage: "bb ultragoal release <worker-thread-id|item-id> [--hold] [--thread <id>]" },
      { name: "brief", summary: "Set the standing rules every worker on this goal inherits", usage: "bb ultragoal brief [<rules> | --clear] [--thread <id>]" },
      { name: "requires", summary: "Declare output paths a work item cannot close without", usage: "bb ultragoal requires <item-id> <path,path> | <item-id> --clear [--thread <id>]" },
      { name: "item", summary: "Edit a work item's brief, scope or check without staffing it", usage: "bb ultragoal item <item-id> [--step \"<text>\"] [--files a,b] [--check \"<cmd>\" | --no-check] [--remove] [--unhold] | bb ultragoal item --new --step \"<text>\" [--files a,b] [--check \"<cmd>\"] [--thread <id>]" },
      { name: "resolve", summary: "Close a finding whose fix landed outside its own slice, or that is not a defect", usage: "bb ultragoal resolve <finding-id> --as fixed|not-a-defect --evidence \"<proof>\" [--thread <id>]" },
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  action: "status" | "pane" | "set" | "edit" | "pause" | "resume" | "clear" | "workers" | "decide" | "finding" | "release" | "brief" | "requires" | "item" | "resolve" | "exec" | "transfer-root";
  threadId: string | undefined;
  objective?: string;
  rawRest?: string[];
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
  if (
    action === "set" || action === "edit" || action === "workers" ||
    action === "decide" || action === "release" || action === "brief" ||
    action === "requires"
  ) {
    return { action, threadId, objective: rest.slice(1).join(" ").trim() };
  }
  if (action === "finding" || action === "item" || action === "resolve" || action === "exec") {
    return { action, threadId, objective: rest.slice(1).join(" ").trim(), rawRest: rest.slice(1) };
  }
  if (action === "transfer-root") {
    return { action, threadId, rawRest: rest.slice(1) };
  }
  if (action === "pane" || action === "pause" || action === "resume" || action === "clear") {
    return { action, threadId };
  }
  return { action: "status", threadId, error: `Unknown goal command: ${action}` };
}

type ExecutionOptions = Awaited<ReturnType<BbPluginApi["sdk"]["system"]["executionOptions"]>>;
type ExecutionProvider = NonNullable<ExecutionOptions["providers"]>[number];

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
  let providers: ExecutionProvider[] = [];
  try {
    const options = await bb.sdk.system.executionOptions(scope);
    providers = options.providers ?? [];
  } catch {
    const listed = await bb.sdk.providers.list(scope).catch(() => []);
    providers = listed.map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      available: provider.available !== false,
      capabilities: {
        supportsServiceTier: false,
        permissionModes: [],
        supportsFork: false,
        supportsNativeUserQuestion: false,
        supportsSessionRewind: false,
        supportsThreadArchive: false,
        supportsThreadRename: false,
      },
      composerActions: [],
      logoUrl: null,
    }));
  }

  if (providers.length === 0) {
    return [
      {
        id: DEFAULT_VERIFY_PROVIDER,
        displayName: "Codex",
        available: true,
        supportsServiceTier: true,
        brandPrefix: BRAND_PREFIX.codex,
        models: [
          {
            id: DEFAULT_VERIFY_MODEL,
            displayName: "GPT-5.6-Sol",
            isDefault: true,
            defaultReasoning: "medium",
            reasoning: ["medium", "high", "xhigh"],
          },
        ],
      },
    ];
  }

  return Promise.all(
    providers.map(async (provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      available: provider.available !== false,
      supportsServiceTier: provider.capabilities?.supportsServiceTier === true,
      ...(BRAND_PREFIX[provider.id] ? { brandPrefix: BRAND_PREFIX[provider.id] } : {}),
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
  return catalogModelsFromOptions(options, providerId);
}
