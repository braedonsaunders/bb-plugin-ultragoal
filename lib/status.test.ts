import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatGoalCard, goalToolResponse } from "./status.ts";
import { makeLargeGoal } from "./test-goal.ts";

describe("bounded goal reads", () => {
  it("defaults ultragoal_state to the first 40 open work items with a continuation cursor", () => {
    const parsed = JSON.parse(goalToolResponse(makeLargeGoal())) as any;
    assert.deepEqual(parsed.goal.planSummary, {
      total: 1_000,
      open: 200,
      pending: 190,
      inProgress: 10,
      completed: 800,
    });
    assert.equal(parsed.goal.plan.length, 40);
    assert.equal(parsed.goal.planPage.status, "open");
    assert.equal(parsed.goal.planPage.nextCursor, 40);
    assert.equal(parsed.goal.agents.length, 10);
    assert.doesNotMatch(JSON.stringify(parsed.goal.plan), /COMPLETED_BODY_/);
  });

  it("pages completed work explicitly without exporting the full plan", () => {
    const parsed = JSON.parse(
      goalToolResponse(makeLargeGoal(), false, [], {
        planStatus: "completed",
        planCursor: 790,
        planLimit: 25,
      }),
    ) as any;
    assert.equal(parsed.goal.plan.length, 10);
    assert.equal(parsed.goal.plan[0].item_id, "itm_0790");
    assert.equal(parsed.goal.planPage.nextCursor, null);
  });

  it("keeps CLI status bounded to a working set", () => {
    const card = formatGoalCard(makeLargeGoal());
    assert.match(card, /Plan: 800\/1000 complete; 10 in progress; 190 pending/);
    assert.match(card, /160 more open work item\(s\) omitted/);
    assert.doesNotMatch(card, /COMPLETED_BODY_/);
    assert.ok(card.length < 30_000, `status card was ${card.length} chars`);
  });
});
