import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  continuationPrompt,
  MAX_PLAN_INSTRUCTION_CHARS,
  planInstruction,
  progressPrompt,
} from "./prompts.ts";
import { makeLargeGoal } from "./test-goal.ts";

describe("bounded UltraGoal prompts", () => {
  it("keeps a 1,000-item plan at or below 6KB without completed bodies", () => {
    const instruction = planInstruction(makeLargeGoal());
    assert.ok(instruction.length <= MAX_PLAN_INSTRUCTION_CHARS);
    assert.equal(MAX_PLAN_INSTRUCTION_CHARS, 6_000);
    assert.doesNotMatch(instruction, /COMPLETED_BODY_/);
    assert.match(instruction, /1000 total; 800 completed; 10 in progress; 100 ready; 90 blocked/);
    assert.match(instruction, /open work item\(s\) omitted/);
    assert.match(instruction, /ultragoal_state with plan_status\/plan_cursor\/plan_limit/);
  });

  it("keeps automatic wake-ups compact and operational", () => {
    const goal = makeLargeGoal();
    const continuation = continuationPrompt(goal);
    const progress = progressPrompt(goal);
    assert.ok(continuation.length < 8_500, `continuation was ${continuation.length} chars`);
    assert.ok(progress.length < 8_000, `progress was ${progress.length} chars`);
    assert.doesNotMatch(continuation, /COMPLETED_BODY_/);
    assert.doesNotMatch(progress, /COMPLETED_BODY_/);
    assert.match(continuation, /compact wake-up, not a new goal/);
  });
});
