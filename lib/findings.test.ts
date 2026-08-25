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
