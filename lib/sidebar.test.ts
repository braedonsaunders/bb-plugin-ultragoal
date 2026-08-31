import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GoalAgent, GoalStatus } from "../contract.ts";
import { projectSidebarCrew } from "./sidebar.ts";

describe("projectSidebarCrew", () => {
  it("keeps the pill for every durable goal status", () => {
    const statuses: GoalStatus[] = [
      "active",
      "paused",
      "blocked",
      "complete",
      "budget_limited",
      "usage_limited",
    ];

    for (const status of statuses) {
      const crew = projectSidebarCrew("thr_goal", { status, agents: [] }, [], []);
      assert.equal(crew.active, true, status);
    }
  });

  it("clears the pill but retains cached workers after the goal is cleared", () => {
    const cached = [{ threadId: "thr_worker" }] as GoalAgent[];
    const crew = projectSidebarCrew("thr_goal", null, cached, ["thr_worker"]);

    assert.equal(crew.active, false);
    assert.equal(crew.agents, cached);
    assert.deepEqual(crew.workerIds, ["thr_worker"]);
  });
});
