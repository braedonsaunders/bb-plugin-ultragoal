import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GoalSnapshot } from "../contract.js";

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, "..", "templates", "goals");

const CONTINUATION = readFileSync(join(templatesDir, "continuation.md"), "utf8");
const BUDGET_LIMIT = readFileSync(join(templatesDir, "budget_limit.md"), "utf8");
const OBJECTIVE_UPDATED = readFileSync(join(templatesDir, "objective_updated.md"), "utf8");
const PROGRESS = readFileSync(join(templatesDir, "progress.md"), "utf8");
const WORKER_BRIEF = readFileSync(join(templatesDir, "worker_brief.md"), "utf8");

/**
 * Automatic turns are durable wake-ups, not plan exports. Keep this bounded so
 * a 1,000-slice goal costs roughly the same context as a 20-slice goal.
 */
export const MAX_PLAN_INSTRUCTION_CHARS = 6_000;
const MAX_PROMPT_STEP_CHARS = 220;
const MAX_PROMPT_AGENT_CHARS = 120;
const MAX_IN_PROGRESS_ITEMS = 20;
const MAX_READY_ITEMS = 24;
const MAX_BLOCKED_ITEMS = 12;
const MAX_ACTIVE_AGENTS = 12;
const MAX_AGENT_SECTION_CHARS = 1_400;

/** The generalized engineering quality bar injected into every worker brief. */
export function workerQualityBrief(): string {
  return WORKER_BRIEF.trim();
}

function escapeXml(input: string): string {
  return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function render(template: string, values: Record<string, string>): string {
  return template.replaceAll(/\{\{\s*([a-z_]+)\s*\}\}/g, (_match, key: string) => values[key] ?? "");
}

function budgetFields(goal: GoalSnapshot): {
  tokens_used: string;
  token_budget: string;
  remaining_tokens: string;
} {
  const tokensUsed = String(goal.tokensUsed);
  if (goal.tokenBudget == null) {
    return {
      tokens_used: tokensUsed,
      token_budget: "none",
      remaining_tokens: "unbounded",
    };
  }
  return {
    tokens_used: tokensUsed,
    token_budget: String(goal.tokenBudget),
    remaining_tokens: String(Math.max(0, goal.tokenBudget - goal.tokensUsed)),
  };
}

function truncate(text: string, max: number): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function hardCap(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = "\n… working-set prompt truncated; use ultragoal_state pagination for more.";
  return `${text.slice(0, Math.max(0, max - marker.length)).trimEnd()}${marker}`;
}

function fitLines(lines: readonly string[], maxChars: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (used + cost > maxChars) break;
    kept.push(line);
    used += cost;
  }
  return kept;
}

export function planInstruction(goal: GoalSnapshot): string {
  if (goal.items.length === 0) {
    return "The UltraGoal pane has no requirements yet. Call ultragoal_patch at the start of this turn with concrete remaining work derived from current evidence: independent, file-disjoint work items with deps/files/check so the scheduler can staff them in parallel. Keep that plan current as you discover or finish work. Do not treat a plan patch as a substitute for doing the work.";
  }
  const completedIds = new Set(
    goal.items.filter((item) => item.status === "completed").map((item) => item.id),
  );
  const openIds = new Set(
    goal.items.filter((item) => item.status !== "completed").map((item) => item.id),
  );
  const agents = goal.agents ?? [];
  const crewByItem = new Map<string, string[]>();
  for (const agent of agents) {
    if (!agent.itemId) continue;
    const crew = crewByItem.get(agent.itemId) ?? [];
    crew.push(truncate(agent.nickname, 60));
    crewByItem.set(agent.itemId, crew);
  }
  const lineForItem = (item: GoalSnapshot["items"][number]) => {
    const names = crewByItem.get(item.id);
    const crew = names?.length ? ` — ${names.slice(0, 3).join(", ")}` : "";
    const blockers = item.deps.filter((dep) => !completedIds.has(dep));
    const shownBlockers = blockers.slice(0, 6);
    const gate =
      blockers.length > 0
        ? ` (blocked by ${shownBlockers.join(", ")}${blockers.length > shownBlockers.length ? ` +${blockers.length - shownBlockers.length}` : ""})`
        : item.status === "pending"
          ? " (ready)"
          : "";
    const mark = item.status === "in_progress" ? ">" : " ";
    return `- [${mark}] item_id=${item.id} ${truncate(item.step, MAX_PROMPT_STEP_CHARS)}${gate}${crew}`;
  };

  const liveWorkers = agents.filter(
    (agent) =>
      agent.role !== "verifier" &&
      ((agent.status === "running" || agent.status === "starting") ||
        (Boolean(agent.itemId) &&
          openIds.has(agent.itemId!) &&
          agent.status !== "error" &&
          agent.status !== "stopped" &&
          agent.status !== "completed")),
  );
  const activeAgents = agents.filter(
    (agent) =>
      agent.status === "running" ||
      agent.status === "starting" ||
      (Boolean(agent.itemId) &&
        openIds.has(agent.itemId!) &&
        agent.status !== "error" &&
        agent.status !== "stopped" &&
        agent.status !== "completed"),
  );
  const rawAgentLines =
    activeAgents.length > 0
      ? [
          `Active/assigned agents (${activeAgents.length}; showing up to ${Math.min(activeAgents.length, MAX_ACTIVE_AGENTS)}):`,
          ...activeAgents.slice(0, MAX_ACTIVE_AGENTS).map(
            (agent) =>
              `- ${truncate(agent.nickname, 60)} (${agent.role}, ${agent.status}${agent.itemId ? `, item_id=${agent.itemId}` : ", unassigned"})${agent.title ? ` — ${truncate(agent.title, MAX_PROMPT_AGENT_CHARS)}` : ""}`,
          ),
          ...(activeAgents.length > MAX_ACTIVE_AGENTS
            ? [`- … ${activeAgents.length - MAX_ACTIVE_AGENTS} more active/assigned agent(s) omitted.`]
            : []),
        ]
      : [];
  const agentLines = fitLines(rawAgentLines, MAX_AGENT_SECTION_CHARS);
  const heldByLive = new Set(
    liveWorkers.filter((agent) => agent.itemId).map((agent) => agent.itemId as string),
  );
  const open = goal.items.filter((item) => item.status !== "completed");
  const inProgress = open.filter((item) => item.status === "in_progress");
  const ready = open.filter(
    (item) =>
      item.status === "pending" &&
      !heldByLive.has(item.id) &&
      item.deps.every((dep) => completedIds.has(dep)),
  );
  const blocked = open.filter(
    (item) => item.status === "pending" && item.deps.some((dep) => !completedIds.has(dep)),
  );
  const maxWorkers = goal.settings.maxWorkers;

  const candidates = [
    ...inProgress.slice(0, MAX_IN_PROGRESS_ITEMS),
    ...ready.slice(0, MAX_READY_ITEMS),
    ...blocked.slice(0, MAX_BLOCKED_ITEMS),
  ];

  const schedulerLines: string[] = [];
  if (open.length > 0 && maxWorkers > 0) {
    schedulerLines.push(
      `SCHEDULER: the UltraGoal scheduler staffs ready slices automatically (deps complete, file scopes disjoint) — one fresh worker per slice, up to ${maxWorkers} concurrent. Assigned workers occupy a slot until their slice closes (idle Codex turns still count). Do not spawn workers for plan items yourself; write the plan and the scheduler dispatches. Do not implement slices on the root thread.`,
    );
    const idleSlots = maxWorkers - liveWorkers.length - ready.length;
    if (idleSlots > 0 && open.length > ready.length + heldByLive.size) {
      schedulerLines.push(
        `WIDTH: ${ready.length} ready work item(s) for ${maxWorkers} worker slots. If remaining work can split into independent, file-disjoint items, split it NOW via ultragoal_patch (self-contained step + files + check, deps only where genuinely sequential). Do not pad with fake parallelism if the remaining work is truly sequential.`,
      );
    }
    if (ready.length === 0 && liveWorkers.length === 0 && blocked.length > 0) {
      schedulerLines.push(
        "DEADLOCK: pending work exists but none is ready and no worker is live — its deps are unsatisfiable or circular. Restructure the plan with ultragoal_patch.",
      );
    }
  }

  const decisionsLine =
    goal.decisions.length > 0
      ? [
          `DECISIONS: ${goal.decisions.length} owner decision(s) await the user (${goal.decisions
            .slice(0, 20)
            .map((decision) => decision.id)
            .join(", ")}${goal.decisions.length > 20 ? ` +${goal.decisions.length - 20} more` : ""}). Do not re-ask, do not proceed on assumptions, and do not treat this as blocked — continue all work that does not depend on the answer.`,
        ]
      : [];
  const findingsLine =
    goal.findings.open > 0
      ? [
          goal.findings.remediationWorkItems >= goal.settings.maxOpenFindings
            ? `FINDINGS: ${goal.findings.open} open (${goal.findings.assignedDefects} assigned, ${goal.findings.awaitingAssignment} awaiting assignment); remediation work is at capacity (${goal.settings.maxOpenFindings} distinct work items). The oldest-first backlog fills automatically as fixes close.`
            : `FINDINGS: ${goal.findings.open} open (${goal.findings.assignedDefects} assigned, ${goal.findings.awaitingAssignment} awaiting assignment) across ${goal.findings.remediationWorkItems} remediation work item(s). Related defects coalesce; new files mint work until capacity (${goal.settings.maxOpenFindings}). resolve_finding (with evidence) anything that is not a real defect.`,
        ]
      : [];
  const summaryLine = `Plan summary: ${goal.items.length} total; ${completedIds.size} completed; ${inProgress.length} in progress; ${ready.length} ready; ${blocked.length} blocked. Completed slice bodies are intentionally omitted.`;
  const headingLine = "Current bounded working set (ultragoal_patch is patch-style: send only changed/new work items; omitted items are preserved):";
  const tailLines = [
    ...agentLines,
    ...schedulerLines,
    ...decisionsLine,
    ...findingsLine,
  ];
  const reservedOmissionChars = 180;
  const fixedChars = [summaryLine, headingLine, ...tailLines].join("\n").length;
  const itemBudget = Math.max(0, MAX_PLAN_INSTRUCTION_CHARS - fixedChars - reservedOmissionChars);
  const workingLines = fitLines(candidates.map(lineForItem), itemBudget);
  const omitted = open.length - workingLines.length;
  const omissionLine =
    omitted > 0
      ? `- … ${omitted} open work item(s) omitted from this bounded working set; call ultragoal_state with plan_status/plan_cursor/plan_limit to page them.`
      : null;
  return hardCap(
    [summaryLine, headingLine, ...workingLines, ...(omissionLine ? [omissionLine] : []), ...tailLines].join("\n"),
    MAX_PLAN_INSTRUCTION_CHARS,
  );
}

export function progressPrompt(goal: GoalSnapshot): string {
  return render(PROGRESS, {
    objective: escapeXml(goal.objective),
    plan_instruction: planInstruction(goal),
    max_workers: String(goal.settings.maxWorkers),
    ...budgetFields(goal),
  });
}

export function continuationPrompt(goal: GoalSnapshot): string {
  return render(CONTINUATION, {
    objective: escapeXml(goal.objective),
    plan_instruction: planInstruction(goal),
    max_workers: String(goal.settings.maxWorkers),
    ...budgetFields(goal),
  });
}

export function budgetLimitPrompt(goal: GoalSnapshot): string {
  return render(BUDGET_LIMIT, {
    objective: escapeXml(goal.objective),
    time_used_seconds: String(goal.timeUsedSeconds),
    tokens_used: String(goal.tokensUsed),
    token_budget: goal.tokenBudget == null ? "none" : String(goal.tokenBudget),
  });
}

export function objectiveUpdatedPrompt(goal: GoalSnapshot): string {
  return render(OBJECTIVE_UPDATED, {
    objective: escapeXml(goal.objective),
    ...budgetFields(goal),
  });
}

export function remainingTokens(goal: GoalSnapshot): number | null {
  if (goal.tokenBudget == null) return null;
  return Math.max(0, goal.tokenBudget - goal.tokensUsed);
}

export function isBudgetExhausted(goal: GoalSnapshot): boolean {
  return goal.tokenBudget != null && goal.tokensUsed >= goal.tokenBudget;
}
