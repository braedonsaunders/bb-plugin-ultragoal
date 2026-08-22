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
    return "The Goal pane has no requirements yet. Call update_plan at the start of this turn with concrete remaining work derived from current evidence. Keep that plan current as you discover or finish work. Do not treat a plan update as a substitute for doing the work.";
  }
  const lines = goal.items.map((item) => {
    const mark = item.status === "completed" ? "x" : item.status === "in_progress" ? ">" : " ";
    const crew = (goal.agents ?? []).filter((agent) => agent.itemId === item.id);
    const names = crew.length > 0 ? ` — ${crew.map((agent) => agent.nickname).join(", ")}` : "";
    return `- [${mark}] item_id=${item.id} ${item.step}${names}`;
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
      : [
          "No subagents are running. Spawn one worker per in-progress slice before doing implementation on the root.",
        ];
  return [
    "Current requirement plan (keep update_plan current; mark every independent in-flight step in_progress at the same time):",
    ...lines,
    ...agentLines,
  ].join("\n");
}

export function progressPrompt(goal: GoalSnapshot): string {
  return render(PROGRESS, {
    objective: escapeXml(goal.objective),
    plan_instruction: planInstruction(goal),
    ...budgetFields(goal),
  });
}

export function continuationPrompt(goal: GoalSnapshot): string {
  return render(CONTINUATION, {
    objective: escapeXml(goal.objective),
    plan_instruction: planInstruction(goal),
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
