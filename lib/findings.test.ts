import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  createFindingStore,
  findingRegistrationCliMessage,
  findingRegistrationOutcome,
} from "./findings.ts";

const hosts: FakePluginHost[] = [];
afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.harness.lifecycle.dispose();
});

function freshFindings() {
  const host = createFakePluginHost({ pluginId: `findings-test-${hosts.length}` });
  hosts.push(host);
  host.bb.storage.database().exec(`CREATE TABLE goal_findings (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      title TEXT NOT NULL,
      file TEXT NOT NULL,
      evidence TEXT NOT NULL,
      status TEXT NOT NULL,
      item_id TEXT,
      resolution_note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      fix_files TEXT,
      check_cmd TEXT,
      UNIQUE(thread_id, fingerprint)
    )
  `);
  return createFindingStore(host.bb);
}

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

describe("a fix that never reached the base branch", () => {
  it("reopens findings this slice closed, because the fix is provably not there", () => {
    // Closure happens on the worker's report, BEFORE the merge is attempted.
    // A genuine integration failure used to leave the register asserting a fix
    // that does not exist anywhere main will ship.
    const findings = freshFindings();
    const rec = findings.report("thr_g", { title: "t", file: "a.ts:1", evidence: "e" });
    findings.linkItem("thr_g", rec.finding.id, "itm_1");
    findings.markFixedByItem("thr_g", "itm_1", "worker said so");
    assert.equal(findings.get("thr_g", rec.finding.id)?.status, "fixed");

    const reopened = findings.reopenForFailedIntegration("thr_g", "itm_1", "merge conflict");
    assert.equal(reopened, 1);
    assert.equal(findings.get("thr_g", rec.finding.id)?.status, "open");
  });

  it("never overturns a dismissal, which was a judgement about the defect", () => {
    const findings = freshFindings();
    const rec = findings.report("thr_g", { title: "t", file: "a.ts:1", evidence: "e" });
    findings.linkItem("thr_g", rec.finding.id, "itm_1");
    findings.resolve("thr_g", rec.finding.id, "dismissed", "not a real defect");
    assert.equal(findings.reopenForFailedIntegration("thr_g", "itm_1", "merge conflict"), 0);
    assert.equal(findings.get("thr_g", rec.finding.id)?.status, "dismissed");
  });

  it("touches only the slice that failed", () => {
    const findings = freshFindings();
    const mine = findings.report("thr_g", { title: "mine", file: "a.ts:1", evidence: "e" });
    const other = findings.report("thr_g", { title: "other", file: "b.ts:1", evidence: "e" });
    findings.linkItem("thr_g", mine.finding.id, "itm_1");
    findings.linkItem("thr_g", other.finding.id, "itm_2");
    findings.markFixedByItem("thr_g", "itm_1", "n");
    findings.markFixedByItem("thr_g", "itm_2", "n");
    findings.reopenForFailedIntegration("thr_g", "itm_1", "conflict");
    assert.equal(findings.get("thr_g", mine.finding.id)?.status, "open");
    assert.equal(findings.get("thr_g", other.finding.id)?.status, "fixed");
  });

  it("leaves an already-present slice closed, since its work IS on the branch", () => {
    // 0.25.3: "Already up to date (nothing to squash)" records as integrated,
    // so this reopen path must never run for it.
    const findings = freshFindings();
    const rec = findings.report("thr_g", { title: "t", file: "a.ts:1", evidence: "e" });
    findings.linkItem("thr_g", rec.finding.id, "itm_1");
    findings.markFixedByItem("thr_g", "itm_1", "n");
    assert.equal(findings.get("thr_g", rec.finding.id)?.status, "fixed");
  });
});
