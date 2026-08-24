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

function planInstruction(goal: GoalSnapshot): string {
  if (goal.items.length === 0) {
    return "The UltraGoal pane has no requirements yet. Call update_plan at the start of this turn with concrete remaining work derived from current evidence: independent, file-disjoint slices with deps/files/check so the scheduler can staff them in parallel. Keep that plan current as you discover or finish work. Do not treat a plan update as a substitute for doing the work.";
  }
  const completedIds = new Set(
    goal.items.filter((item) => item.status === "completed").map((item) => item.id),
  );
  const lines = goal.items.map((item) => {
    const mark = item.status === "completed" ? "x" : item.status === "in_progress" ? ">" : " ";
    const crew = (goal.agents ?? []).filter((agent) => agent.itemId === item.id);
    const names = crew.length > 0 ? ` — ${crew.map((agent) => agent.nickname).join(", ")}` : "";
    const blockers = item.deps.filter((dep) => !completedIds.has(dep));
    const gate =
      item.status === "completed"
        ? ""
        : blockers.length > 0
          ? ` (blocked by ${blockers.join(", ")})`
          : item.status === "pending"
            ? " (ready)"
            : "";
    return `- [${mark}] item_id=${item.id} ${item.step}${gate}${names}`;
  });
  const agents = goal.agents ?? [];
  const agentLines =
    agents.length > 0
      ? [
          "Live subagents (root orchestrates; workers do the slices):",
          ...agents.map(
            (agent) =>
              `- ${agent.nickname} (${agent.role}, ${agent.status}${agent.itemId ? `, item_id=${agent.itemId}` : ", unassigned"})`,
          ),
        ]
      : [];
  const liveWorkers = agents.filter(
    (agent) =>
      agent.role !== "verifier" && (agent.status === "running" || agent.status === "starting"),
  );
  const heldByLive = new Set(
    liveWorkers.filter((agent) => agent.itemId).map((agent) => agent.itemId as string),
  );
  const open = goal.items.filter((item) => item.status !== "completed");
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

  const schedulerLines: string[] = [];
  if (open.length > 0 && maxWorkers > 0) {
    schedulerLines.push(
      `SCHEDULER: the UltraGoal scheduler staffs ready slices automatically (deps complete, file scopes disjoint) — one fresh worker per slice, up to ${maxWorkers} concurrent. Assigned workers occupy a slot until their slice closes (idle Codex turns still count). Do not spawn workers for plan items yourself; write the plan and the scheduler dispatches. Do not implement slices on the root thread.`,
    );
    const idleSlots = maxWorkers - liveWorkers.length - ready.length;
    if (idleSlots > 0 && open.length > ready.length + heldByLive.size) {
      schedulerLines.push(
        `WIDTH: ${ready.length} ready slice(s) for ${maxWorkers} worker slots. If remaining work can split into independent, file-disjoint slices, split it NOW via update_plan (self-contained step + files + check, deps only where genuinely sequential). Do not pad with fake parallelism if the remaining work is truly sequential.`,
      );
    }
    if (ready.length === 0 && liveWorkers.length === 0 && blocked.length > 0) {
      schedulerLines.push(
        "DEADLOCK: pending slices exist but none is ready and no worker is live — their deps are unsatisfiable or circular. Restructure the plan with update_plan.",
      );
    }
  }

  const decisionsLine =
    goal.decisions.length > 0
      ? [
          `DECISIONS: ${goal.decisions.length} owner decision(s) await the user (${goal.decisions
            .map((decision) => decision.id)
            .join(", ")}). Do not re-ask, do not proceed on assumptions, and do not treat this as blocked — continue all work that does not depend on the answer.`,
        ]
      : [];
  const findingsLine =
    goal.findings.open > 0
      ? [
          goal.findings.open >= goal.settings.maxOpenFindings
            ? `FINDINGS: ${goal.findings.open} open finding(s) are at the cap (${goal.settings.maxOpenFindings}). New distinct-file findings are recorded but do not mint another slice — resolve_finding false positives or finish existing fix slices before the hunt grows again.`
            : `FINDINGS: ${goal.findings.open} open finding(s) block completion. Same-file findings attach to the existing slice; new files mint a fix slice until the cap (${goal.settings.maxOpenFindings}). resolve_finding (with evidence) anything that is not a real defect.`,
        ]
      : [];
  return [
    "Current requirement plan (keep update_plan current as steps complete or the next best action changes):",
    ...lines,
    ...agentLines,
    ...schedulerLines,
    ...decisionsLine,
    ...findingsLine,
  ].join("\n");
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
