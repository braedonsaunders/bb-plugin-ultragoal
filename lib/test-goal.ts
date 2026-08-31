import type { GoalSnapshot } from "../contract.js";

export function makeLargeGoal(count = 1_000): GoalSnapshot {
  const completedCount = Math.floor(count * 0.8);
  const inProgressCount = Math.min(10, Math.max(0, count - completedCount));
  const readyEnd = Math.min(count, completedCount + inProgressCount + 100);
  const items = Array.from({ length: count }, (_, index) => {
    const id = `itm_${String(index).padStart(4, "0")}`;
    if (index < completedCount) {
      return {
        id,
        step: `COMPLETED_BODY_${index} ${"historical detail ".repeat(20)}`,
        status: "completed" as const,
        deps: [],
        files: [`src/completed-${index}.ts`],
        check: `test completed-${index}`,
      };
    }
    const status = index < completedCount + inProgressCount ? "in_progress" as const : "pending" as const;
    return {
      id,
      step: `OPEN_BODY_${index} ${"bounded current work ".repeat(20)}`,
      status,
      deps: index < readyEnd ? [] : [`itm_${String(completedCount).padStart(4, "0")}`],
      files: [`src/open-${index}.ts`],
      check: `test open-${index}`,
    };
  });
  const agents = Array.from({ length: 120 }, (_, index) => ({
    threadId: `thr_${index}`,
    taskName: `task_${index}`,
    nickname: `Worker ${index}`,
    title: `Worker title ${index} ${"detail ".repeat(30)}`,
    itemId: index < inProgressCount ? items[completedCount + index]!.id : items[index]!.id,
    role: "worker" as const,
    status: index < inProgressCount ? "running" as const : "completed" as const,
    summary: null,
  }));
  return {
    threadId: "thr_root",
    objective: "Complete a very large durable goal without retransmitting its history.",
    status: "active",
    reason: null,
    createdAt: 1,
    updatedAt: 2,
    startedAt: 1,
    tokenBudget: null,
    tokensUsed: 123_456,
    timeUsedSeconds: 7_200,
    lastContinueAt: null,
    lastProgressAt: null,
    lastAccountedAt: null,
    agentRunning: false,
    items,
    agents,
    now: [],
    next: [],
    settings: {
      verifyEnabled: true,
      verifyProvider: "codex",
      verifyModel: "gpt-5.6-sol",
      verifyReasoning: "high",
      verifyServiceTier: null,
      autoContinue: true,
      progressUpdateMinutes: 5,
      maxWorkers: 5,
      maxOpenFindings: 50,
      workerProvider: "",
      workerModel: "",
      workerReasoning: "",
      workerServiceTier: null,
      autoIntegrateCompletedSlices: false,
      reclaimMergedWorktrees: false,
      readLocalProviderData: false,
    },
    standingBrief: null,
    findings: {
      open: 137,
      fixed: 159,
      dismissed: 9,
      assignedDefects: 50,
      awaitingAssignment: 87,
      remediationWorkItems: 42,
    },
    decisions: [],
    completionSummary: null,
  };
}
