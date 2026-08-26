import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findingRegistrationCliMessage,
  findingRegistrationOutcome,
} from "./findings.ts";

describe("finding registration reporting", () => {
  it("reports a scheduler-staffed fix slice when one was linked", () => {
    assert.deepEqual(findingRegistrationOutcome("fnd_1", "itm_1"), {
      status: "new",
      finding_id: "fnd_1",
      fix_item_id: "itm_1",
    });
    assert.match(findingRegistrationCliMessage("fnd_1", "itm_1"), /fix slice itm_1 assigned/);
  });

  it("reports cap-exceeded findings as recorded but unstaffed", () => {
    const outcome = findingRegistrationOutcome("fnd_2", null);
    assert.equal(outcome.status, "recorded_unstaffed");
    assert.equal(outcome.fix_item_id, null);
    assert.match(outcome.note ?? "", /durably queued/);
    const message = findingRegistrationCliMessage("fnd_2", null);
    assert.doesNotMatch(message, /null staffed/);
    assert.match(message, /queued without a fix slice/);
  });
});

describe("filing warns when a slice has no gate", () => {
  it("says nothing extra when a check was supplied", () => {
    const msg = findingRegistrationCliMessage("fnd_1", "itm_1", true);
    assert.match(msg, /fix slice itm_1 assigned/);
    assert.doesNotMatch(msg, /nothing gates/);
  });

  it("tells the filer their slice can close unverified, and how to fix it", () => {
    // A minted slice with no check can be closed with nothing proving the
    // defect gone, and the filer is the only one who knows the command.
    const msg = findingRegistrationCliMessage("fnd_1", "itm_1", false);
    assert.match(msg, /nothing gates its completion/);
    assert.match(msg, /bb ultragoal item itm_1 --check/);
  });

  it("stays quiet about checks when no slice was minted at all", () => {
    assert.match(findingRegistrationCliMessage("fnd_1", null, false), /without a fix slice/);
  });
});
