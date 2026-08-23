import type { GoalFinding, GoalSnapshot, GoalStatus } from "../contract.js";
import { remainingTokens } from "./prompts.js";

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
  if (goal.items.length > 0) {
    const done = goal.items.filter((item) => item.status === "completed").length;
    const completedIds = new Set(
      goal.items.filter((item) => item.status === "completed").map((item) => item.id),
    );
    lines.push(`Plan: ${done}/${goal.items.length}`);
    for (const item of goal.items) {
      const mark =
        item.status === "completed" ? "x" : item.status === "in_progress" ? ">" : " ";
      const crew = goal.agents.filter((agent) => agent.itemId === item.id);
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
      lines.push(`- [${mark}] ${item.id} ${item.step}${gate}${names}`);
    }
  }
  for (const decision of goal.decisions) {
    lines.push(`NEEDS YOU: [${decision.id}] ${decision.question} — answer: bb ultragoal decide ${decision.id} <answer>`);
  }
  if (goal.findings.open + goal.findings.fixed + goal.findings.dismissed > 0) {
    lines.push(
      `Findings: ${goal.findings.open} open, ${goal.findings.fixed} fixed, ${goal.findings.dismissed} dismissed`,
    );
  }
  if (goal.agents.length > 0) {
    const live = goal.agents.filter(
      (agent) =>
        agent.status === "running" ||
        agent.status === "starting" ||
        (agent.role === "worker" &&
          agent.itemId &&
          goal.items.some((item) => item.id === agent.itemId && item.status !== "completed") &&
          agent.status !== "error" &&
          agent.status !== "stopped" &&
          agent.status !== "completed"),
    ).length;
    lines.push(`Agents: ${live}/${goal.agents.length} live`);
    for (const agent of goal.agents) {
      lines.push(
        `- ${agent.nickname} (${agent.role}, ${agent.status}${agent.itemId ? `, item_id=${agent.itemId}` : ", unassigned"})`,
      );
    }
  }
  return lines.join("\n");
}

export function goalToolResponse(
  goal: GoalSnapshot | null,
  reportCompletionBudget = false,
  openFindings: GoalFinding[] = [],
): string {
  const remaining = goal ? remainingTokens(goal) : null;
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
            plan: goal.items.map((item) => ({
              item_id: item.id,
              step: item.step,
              status: item.status,
              deps: item.deps,
              files: item.files,
              check: item.check,
            })),
            agents: goal.agents,
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
          ? "The UltraGoal pane is empty. Call update_plan immediately with concrete requirements. Do not use TodoWrite or Update TODOs for that list."
          : undefined,
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
