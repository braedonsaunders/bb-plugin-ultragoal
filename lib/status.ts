import type { GoalFinding, GoalSnapshot, GoalStatus } from "../contract.js";
import { remainingTokens } from "./prompts.js";

export const DEFAULT_GOAL_PAGE_LIMIT = 40;
export const MAX_GOAL_PAGE_LIMIT = 100;
const MAX_STATUS_ITEMS = 40;
const MAX_STATUS_AGENTS = 20;
const MAX_STATUS_DECISIONS = 20;

export type PlanStatusFilter = "open" | "pending" | "in_progress" | "completed" | "all";

export interface GoalToolPageOptions {
  planStatus?: PlanStatusFilter;
  planCursor?: number;
  planLimit?: number;
}

function planCounts(goal: GoalSnapshot) {
  const completed = goal.items.filter((item) => item.status === "completed").length;
  const inProgress = goal.items.filter((item) => item.status === "in_progress").length;
  const pending = goal.items.length - completed - inProgress;
  return { total: goal.items.length, open: pending + inProgress, pending, inProgress, completed };
}

function matchesPlanStatus(
  item: GoalSnapshot["items"][number],
  status: PlanStatusFilter,
): boolean {
  if (status === "all") return true;
  if (status === "open") return item.status !== "completed";
  return item.status === status;
}

function activeAgents(goal: GoalSnapshot) {
  const openIds = new Set(
    goal.items.filter((item) => item.status !== "completed").map((item) => item.id),
  );
  return goal.agents.filter(
    (agent) =>
      agent.status === "running" ||
      agent.status === "starting" ||
      (Boolean(agent.itemId) &&
        openIds.has(agent.itemId!) &&
        agent.status !== "completed" &&
        agent.status !== "stopped" &&
        agent.status !== "error"),
  );
}

export function formatGoalCard(goal: GoalSnapshot): string {
  const remaining = remainingTokens(goal);
  const lines = [
    `UltraGoal: ${goal.status}`,
    `Objective: ${goal.objective}`,
    `Tokens used: ${goal.tokensUsed}`,
    `Token budget: ${goal.tokenBudget ?? "none"}`,
    `Tokens remaining: ${remaining == null ? "unbounded" : remaining}`,
    `Time used: ${goal.timeUsedSeconds}s`,
    `Verify: ${goal.settings.verifyEnabled ? `${goal.settings.verifyProvider}/${goal.settings.verifyModel}` : "off"}`,
    `Progress chat: ${
      goal.settings.progressUpdateMinutes > 0
        ? `every ${goal.settings.progressUpdateMinutes}m`
        : "off"
    }`,
  ];
  if (goal.reason) lines.push(`Reason: ${goal.reason}`);
  if (goal.status === "complete" && goal.completionSummary) {
    lines.push("", "COMPLETE — delivery summary:", goal.completionSummary, "");
  }
  if (goal.items.length > 0) {
    const counts = planCounts(goal);
    const completedIds = new Set(
      goal.items.filter((item) => item.status === "completed").map((item) => item.id),
    );
    const itemAgents = new Map<string, string[]>();
    for (const agent of goal.agents) {
      if (!agent.itemId) continue;
      const names = itemAgents.get(agent.itemId) ?? [];
      names.push(agent.nickname);
      itemAgents.set(agent.itemId, names);
    }
    const relevant =
      goal.status === "complete"
        ? goal.items.filter((item) => item.status === "completed")
        : goal.items.filter((item) => item.status !== "completed");
    const visible = relevant.slice(0, MAX_STATUS_ITEMS);
    lines.push(
      `Plan: ${counts.completed}/${counts.total} complete; ${counts.inProgress} in progress; ${counts.pending} pending`,
    );
    for (const item of visible) {
      const mark =
        item.status === "completed" ? "x" : item.status === "in_progress" ? ">" : " ";
      const crew = itemAgents.get(item.id) ?? [];
      const names = crew.length > 0 ? ` — ${crew.slice(0, 3).join(", ")}` : "";
      const blockers = item.deps.filter((dep) => !completedIds.has(dep));
      const gate =
        item.status === "completed"
          ? ""
          : blockers.length > 0
            ? ` (blocked by ${blockers.join(", ")})`
            : item.status === "pending"
              ? " (ready)"
              : "";
      lines.push(`- [${mark}] ${item.id} ${item.step}${gate}${names}`);
    }
    if (relevant.length > visible.length) {
      lines.push(
        `- … ${relevant.length - visible.length} more ${goal.status === "complete" ? "completed" : "open"} work item(s) omitted; use ultragoal_state pagination for agent reads.`,
      );
    }
  }
  for (const decision of goal.decisions.slice(0, MAX_STATUS_DECISIONS)) {
    lines.push(`NEEDS YOU: [${decision.id}] ${decision.question} — answer: bb ultragoal decide ${decision.id} <answer>`);
  }
  if (goal.decisions.length > MAX_STATUS_DECISIONS) {
    lines.push(`NEEDS YOU: … ${goal.decisions.length - MAX_STATUS_DECISIONS} more decision(s) omitted`);
  }
  if (goal.findings.open + goal.findings.fixed + goal.findings.dismissed > 0) {
    lines.push(
      `Defects: ${goal.findings.open} open (${goal.findings.assignedDefects} linked to work, ${goal.findings.awaitingAssignment} waiting for work across ${goal.findings.remediationWorkItems} repair work items), ${goal.findings.fixed} fixed, ${goal.findings.dismissed} dismissed`,
    );
  }
  if (goal.agents.length > 0) {
    const active = activeAgents(goal);
    lines.push(`Agents: ${active.length}/${goal.agents.length} active or assigned`);
    for (const agent of active.slice(0, MAX_STATUS_AGENTS)) {
      lines.push(
        `- ${agent.nickname} (${agent.role}, ${agent.status}${agent.itemId ? `, item_id=${agent.itemId}` : ", unassigned"})`,
      );
    }
    if (active.length > MAX_STATUS_AGENTS) {
      lines.push(`- … ${active.length - MAX_STATUS_AGENTS} more active/assigned agent(s) omitted`);
    }
  }
  return lines.join("\n");
}

export function goalToolResponse(
  goal: GoalSnapshot | null,
  reportCompletionBudget = false,
  openFindings: GoalFinding[] = [],
  page: GoalToolPageOptions = {},
): string {
  const remaining = goal ? remainingTokens(goal) : null;
  const planStatus = page.planStatus ?? "open";
  const planCursor = Math.max(0, Math.floor(page.planCursor ?? 0));
  const planLimit = Math.min(
    MAX_GOAL_PAGE_LIMIT,
    Math.max(1, Math.floor(page.planLimit ?? DEFAULT_GOAL_PAGE_LIMIT)),
  );
  const matchingItems = goal
    ? goal.items.filter((item) => matchesPlanStatus(item, planStatus))
    : [];
  const planItems = matchingItems.slice(planCursor, planCursor + planLimit);
  const nextPlanCursor =
    planCursor + planItems.length < matchingItems.length
      ? planCursor + planItems.length
      : null;
  const agents = goal ? activeAgents(goal) : [];
  const completionBudgetReport =
    reportCompletionBudget && goal?.status === "complete"
      ? "UltraGoal achieved. Report final usage from this tool result's structured goal fields. If `goal.tokenBudget` is present, include token usage from `goal.tokensUsed` and `goal.tokenBudget`. If `goal.timeUsedSeconds` is greater than 0, summarize elapsed time in a concise, human-friendly form appropriate to the response language."
      : undefined;
  return JSON.stringify(
    {
      goal: goal
        ? {
            objective: goal.objective,
            status: goal.status,
            tokenBudget: goal.tokenBudget,
            tokensUsed: goal.tokensUsed,
            timeUsedSeconds: goal.timeUsedSeconds,
            createdAt: goal.createdAt,
            updatedAt: goal.updatedAt,
            planSummary: planCounts(goal),
            planPage: {
              status: planStatus,
              cursor: planCursor,
              limit: planLimit,
              returned: planItems.length,
              matching: matchingItems.length,
              nextCursor: nextPlanCursor,
            },
            plan: planItems.map((item) => ({
              item_id: item.id,
              step: item.step,
              status: item.status,
              deps: item.deps,
              files: item.files,
              check: item.check,
            })),
            agentSummary: {
              total: goal.agents.length,
              activeOrAssigned: agents.length,
              returned: Math.min(agents.length, MAX_STATUS_AGENTS),
            },
            agents: agents.slice(0, MAX_STATUS_AGENTS),
            settings: goal.settings,
            findings: goal.findings,
            openDecisions: goal.decisions.map((decision) => ({
              decision_id: decision.id,
              question: decision.question,
              options: decision.options,
            })),
            openFindings: openFindings.slice(0, 20).map((finding) => ({
              finding_id: finding.id,
              title: finding.title,
              file: finding.file,
              fix_item_id: finding.itemId,
            })),
          }
        : null,
      remainingTokens: remaining,
      planReminder:
        goal && goal.items.length === 0
          ? "The UltraGoal pane is empty. Call ultragoal_patch immediately with concrete requirements. Do not use TodoWrite or Update TODOs for that list."
          : undefined,
      paginationReminder:
        nextPlanCursor == null
          ? undefined
          : `More ${planStatus} work items remain. Call ultragoal_state again with plan_status=${planStatus}, plan_cursor=${nextPlanCursor}, and the same plan_limit.`,
      completionBudgetReport,
    },
    null,
    2,
  );
}

export function lastTurnUsedTools(rows: readonly unknown[]): boolean {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i] as { kind?: string; role?: string; type?: string };
    const kind = `${row?.kind ?? ""} ${row?.type ?? ""}`.toLowerCase();
    if (row?.kind === "conversation" && row.role === "user") return false;
    if (
      kind.includes("tool") ||
      kind.includes("command") ||
      kind.includes("file_change") ||
      kind.includes("filechange") ||
      kind.includes("mcp")
    ) {
      return true;
    }
  }
  return false;
}

export function isUnfinished(status: GoalStatus): boolean {
  return (
    status === "active" ||
    status === "paused" ||
    status === "blocked" ||
    status === "budget_limited" ||
    status === "usage_limited"
  );
}
