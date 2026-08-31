import type { GoalAgent, GoalSnapshot } from "../contract.js";

export interface SidebarCrew {
  threadId: string;
  active: boolean;
  agents: GoalAgent[];
  workerIds: string[];
}

/**
 * Project the lightweight sidebar contract. A goal's workflow status does not
 * control its pill: the pill follows the durable record and disappears only
 * after that record is cleared.
 */
export function projectSidebarCrew(
  threadId: string,
  goal: Pick<GoalSnapshot, "status" | "agents"> | null,
  cachedAgents: GoalAgent[],
  workerIds: string[],
): SidebarCrew {
  return {
    threadId,
    active: goal !== null,
    agents: goal?.agents ?? cachedAgents,
    workerIds,
  };
}
