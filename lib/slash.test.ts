import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSlashGoal } from "./slash.ts";

describe("UltraGoal slash command", () => {
  it("parses only the canonical /ultragoal command", () => {
    assert.deepEqual(parseSlashGoal("/ultragoal Ship the release"), {
      kind: "set",
      objective: "Ship the release",
    });
    assert.deepEqual(parseSlashGoal("/ultragoal edit Ship safely"), {
      kind: "edit",
      objective: "Ship safely",
    });
    assert.deepEqual(parseSlashGoal("/ultragoal pause"), { kind: "pause" });
    assert.deepEqual(parseSlashGoal("/ultragoal resume"), { kind: "resume" });
    assert.deepEqual(parseSlashGoal("/ultragoal clear"), { kind: "clear" });
    assert.deepEqual(parseSlashGoal("/ultragoal"), { kind: "status" });
  });

  it("rejects the retired short command", () => {
    assert.equal(parseSlashGoal("/goal"), null);
    assert.equal(parseSlashGoal("/goal Ship the release"), null);
    assert.equal(parseSlashGoal("/goal pause"), null);
  });
});
