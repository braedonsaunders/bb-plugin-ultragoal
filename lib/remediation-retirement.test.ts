import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { remediationItemRetirement } from "./remediation-retirement.ts";

const pending = { id: "itm_1", status: "pending" };
const fixed = [{ status: "fixed" }];

function verdict(overrides = {}) {
  return remediationItemRetirement({
    item: pending,
    linkedFindings: fixed,
    staffed: false,
    ...overrides,
  });
}

describe("retiring an orphaned remediation item", () => {
  it("retires a pending, unstaffed item whose every linked finding is resolved", () => {
    // The case that started this: a finding fixed in someone else's slice left
    // its own slice ready in the plan, and the scheduler staffed it.
    assert.deepEqual(verdict(), { retire: true });
  });

  it("retires when the finding was dismissed rather than fixed", () => {
    assert.deepEqual(verdict({ linkedFindings: [{ status: "dismissed" }] }), { retire: true });
  });

  it("retires a coalesced item only once every one of its findings is resolved", () => {
    const partly = verdict({ linkedFindings: [{ status: "fixed" }, { status: "open" }] });
    assert.equal(partly.retire, false);
    assert.match(partly.retire === false ? partly.reason : "", /1 linked finding\(s\) still open/);
    assert.deepEqual(
      verdict({ linkedFindings: [{ status: "fixed" }, { status: "dismissed" }] }),
      { retire: true },
    );
  });

  it("never removes an item no finding ever pointed at", () => {
    // A declared deliverable or an owner-written plan step exists on its own
    // terms; a quiet finding queue is not a reason to delete it.
    const v = verdict({ linkedFindings: [] });
    assert.equal(v.retire, false);
    assert.match(v.retire === false ? v.reason : "", /not a remediation item/);
  });

  it("leaves work someone is doing alone", () => {
    const v = verdict({ staffed: true });
    assert.equal(v.retire, false);
    assert.match(v.retire === false ? v.reason : "", /staffed/);
  });

  it("leaves an in-progress item alone even with no worker row yet", () => {
    const v = verdict({ item: { id: "itm_1", status: "in_progress" } });
    assert.equal(v.retire, false);
    assert.match(v.retire === false ? v.reason : "", /status is in_progress/);
  });

  it("never removes completed work, which would erase the record of it", () => {
    const v = verdict({ item: { id: "itm_1", status: "completed" } });
    assert.equal(v.retire, false);
    assert.match(v.retire === false ? v.reason : "", /status is completed/);
  });

  it("checks scope before status, so a deliverable is refused for the honest reason", () => {
    const v = verdict({ item: { id: "itm_1", status: "completed" }, linkedFindings: [] });
    assert.match(v.retire === false ? v.reason : "", /not a remediation item/);
  });
});
