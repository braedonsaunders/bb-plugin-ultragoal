import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createFindingStore } from "./findings.ts";
import { closeFindingsForCompletedItem, reconcileFindingQueue } from "./finding-queue.ts";
import { createItemStore } from "./items.ts";

const hosts: FakePluginHost[] = [];

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.harness.lifecycle.dispose();
});

function stores() {
  const host = createFakePluginHost({ pluginId: `finding-queue-test-${hosts.length}` });
  hosts.push(host);
  const db = host.bb.storage.database();
  db.exec(`
    CREATE TABLE goal_items (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      step TEXT NOT NULL,
      status TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      origin TEXT,
      deps TEXT,
      files TEXT,
      check_cmd TEXT
    );
    CREATE TABLE goal_findings (
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
  return {
    host,
    db,
    items: createItemStore(host.bb),
    findings: createFindingStore(host.bb),
  };
}

describe("durable finding remediation queue", () => {
  it("backfills the oldest unassigned finding after completion and restart", () => {
    const state = stores();
    const ids = [
      state.findings.report("thr_root", {
        title: "First defect",
        file: "src/first.ts:1",
        evidence: "first proof",
        fixFiles: ["src/first.ts", "test/first.test.ts"],
        check: "npm test -- first",
      }).finding.id,
      state.findings.report("thr_root", {
        title: "Second defect",
        file: "src/second.ts:2",
        evidence: "second proof",
        fixFiles: ["src/second.ts", "test/second.test.ts"],
        check: "npm test -- second",
      }).finding.id,
      state.findings.report("thr_root", {
        title: "Third defect",
        file: "src/third.ts:3",
        evidence: "third proof",
        fixFiles: ["src/third.ts"],
        check: "npm test -- third",
      }).finding.id,
    ];
    ids.forEach((id, index) => {
      state.db.prepare("UPDATE goal_findings SET created_at = ? WHERE id = ?").run(index + 1, id);
    });

    const initial = reconcileFindingQueue({
      threadId: "thr_root",
      findings: state.findings,
      items: state.items,
      maxStaffed: 1,
    });
    assert.equal(initial.minted, 1);
    assert.equal(initial.remediationWorkItems, 1);
    assert.equal(initial.awaitingAssignment, 2);
    const firstItemId = state.findings.get("thr_root", ids[0]!)!.itemId!;
    assert.equal(state.findings.get("thr_root", ids[1]!)!.itemId, null);
    assert.equal(state.findings.get("thr_root", ids[2]!)!.itemId, null);

    state.items.setStatus("thr_root", firstItemId, "completed");
    const closed = closeFindingsForCompletedItem({
      threadId: "thr_root",
      itemId: firstItemId,
      note: "completed",
      findings: state.findings,
      items: state.items,
    });
    assert.equal(closed.fixed, 1);

    // Recreate the stores over the same database: the backlog must recover
    // from durable metadata, not an in-memory registration callback.
    const restartedItems = createItemStore(state.host.bb);
    const restartedFindings = createFindingStore(state.host.bb);
    const afterRestart = reconcileFindingQueue({
      threadId: "thr_root",
      findings: restartedFindings,
      items: restartedItems,
      maxStaffed: 1,
    });
    assert.equal(afterRestart.minted, 1);
    assert.equal(afterRestart.remediationWorkItems, 1);
    assert.equal(afterRestart.awaitingAssignment, 1);
    const secondItemId = restartedFindings.get("thr_root", ids[1]!)!.itemId!;
    assert.ok(secondItemId);
    assert.equal(restartedFindings.get("thr_root", ids[2]!)!.itemId, null);
    const secondItem = restartedItems.list("thr_root").find((item) => item.id === secondItemId)!;
    assert.deepEqual(secondItem.files, ["src/second.ts", "test/second.test.ts"]);
    assert.equal(secondItem.check, "npm test -- second");

    const idempotent = reconcileFindingQueue({
      threadId: "thr_root",
      findings: restartedFindings,
      items: restartedItems,
      maxStaffed: 1,
    });
    assert.equal(idempotent.minted, 0);
    assert.equal(restartedItems.list("thr_root").length, 2);
    const counts = restartedFindings.counts("thr_root");
    assert.equal(counts.open, counts.assignedDefects + counts.awaitingAssignment);
    assert.equal(counts.assignedDefects, 1);
    assert.equal(counts.remediationWorkItems, 1);
  });

  it("coalesces related defects onto one exact-file remediation work item", () => {
    const state = stores();
    const first = state.findings.report("thr_root", {
      title: "First recurring defect",
      file: "schema/migrations/generated",
      evidence: "proof one",
      fixFiles: ["engine/src/recurring.ts", "schema/migrations/generated"],
    }).finding;
    const second = state.findings.report("thr_root", {
      title: "Second recurring defect",
      file: "schema/migrations/generated/other",
      evidence: "proof two",
      fixFiles: ["engine/src/recurring.ts", "schema/migrations/generated"],
    }).finding;

    const result = reconcileFindingQueue({
      threadId: "thr_root",
      findings: state.findings,
      items: state.items,
      maxStaffed: 1,
    });
    assert.equal(result.minted, 1);
    assert.equal(result.linked, 1);
    assert.equal(result.remediationWorkItems, 1);
    assert.equal(result.awaitingAssignment, 0);
    assert.equal(state.findings.get("thr_root", first.id)!.itemId, state.findings.get("thr_root", second.id)!.itemId);
    assert.equal(state.items.list("thr_root").length, 1);
  });

  it("repairs stale links after restart while preserving the oldest primary creator", () => {
    const state = stores();
    const item = state.items.add(
      "thr_root",
      "Repair segment ownership in schema/src/segments.ts",
      "pending",
      { files: ["schema/src/segments.ts", "schema/migrations/generated"] },
    )!;
    const primary = state.findings.report("thr_root", {
      title: "Segment ownership baseline defect",
      file: "schema/migrations/generated/0041_baseline.sql:91",
      evidence: "The baseline exposes the segment ownership defect.",
      fixFiles: ["schema/migrations/generated"],
    }).finding;
    const stale = state.findings.report("thr_root", {
      title: "Unrelated tenant foreign-key defect",
      file: "schema/migrations/generated",
      evidence: "A later broad scope was incorrectly coalesced.",
      fixFiles: ["schema/migrations/generated"],
    }).finding;
    state.db.prepare("UPDATE goal_findings SET created_at = ? WHERE id = ?").run(1, primary.id);
    state.db.prepare("UPDATE goal_findings SET created_at = ? WHERE id = ?").run(2, stale.id);
    assert.equal(state.findings.linkItem("thr_root", primary.id, item.id), true);
    assert.equal(state.findings.linkItem("thr_root", stale.id, item.id), true);

    // Reconstructing the stores models a plugin reload. The oldest link
    // remains the item's durable creator even though its evidence lives in a
    // generated migration; only the later broad-directory coalescing is stale.
    const restartedItems = createItemStore(state.host.bb);
    const restartedFindings = createFindingStore(state.host.bb);
    const repaired = reconcileFindingQueue({
      threadId: "thr_root",
      findings: restartedFindings,
      items: restartedItems,
      maxStaffed: 1,
    });
    assert.equal(repaired.requeuedInvalid, 1);
    assert.equal(restartedFindings.get("thr_root", primary.id)!.itemId, item.id);
    assert.equal(restartedFindings.get("thr_root", stale.id)!.itemId, null);
    assert.equal(restartedItems.list("thr_root").length, 1);
  });

  it("detaches invalid later links before completion, then backfills them oldest-first", () => {
    const state = stores();
    const item = state.items.add(
      "thr_root",
      "Repair rate-book behavior in schema/src/pricing.ts",
      "pending",
      { files: ["schema/src/pricing.ts", "schema/migrations/generated"] },
    )!;
    const primary = state.findings.report("thr_root", {
      title: "Rate-book baseline defect",
      file: "schema/migrations/generated/0041_baseline.sql:144",
      evidence: "The generated baseline proves the rate-book defect.",
      fixFiles: ["schema/migrations/generated"],
    }).finding;
    const valid = state.findings.report("thr_root", {
      title: "Second pricing defect",
      file: "schema/migrations/generated/0042_pricing.sql:8",
      evidence: "A distinct pricing problem with the same concrete repair file.",
      fixFiles: ["schema/src/pricing.ts"],
    }).finding;
    const stale = state.findings.report("thr_root", {
      title: "Unrelated sandbox wipe defect",
      file: "schema/migrations/generated",
      evidence: "This broad migration scope does not belong to pricing work.",
      fixFiles: ["schema/migrations/generated"],
    }).finding;
    [primary, valid, stale].forEach((finding, index) => {
      state.db.prepare("UPDATE goal_findings SET created_at = ? WHERE id = ?").run(index + 1, finding.id);
      assert.equal(state.findings.linkItem("thr_root", finding.id, item.id), true);
    });

    state.items.setStatus("thr_root", item.id, "completed");
    const closed = closeFindingsForCompletedItem({
      threadId: "thr_root",
      itemId: item.id,
      note: "completed with proof",
      findings: state.findings,
      items: state.items,
    });
    assert.deepEqual(closed, { fixed: 2, requeuedMissing: 0, requeuedInvalid: 1 });
    assert.equal(state.findings.get("thr_root", primary.id)!.status, "fixed");
    assert.equal(state.findings.get("thr_root", valid.id)!.status, "fixed");
    assert.equal(state.findings.get("thr_root", stale.id)!.status, "open");
    assert.equal(state.findings.get("thr_root", stale.id)!.itemId, null);

    const backfilled = reconcileFindingQueue({
      threadId: "thr_root",
      findings: state.findings,
      items: state.items,
      maxStaffed: 1,
    });
    assert.equal(backfilled.minted, 1);
    const replacementId = state.findings.get("thr_root", stale.id)!.itemId;
    assert.ok(replacementId);
    assert.notEqual(replacementId, item.id);
    assert.equal(state.items.list("thr_root").find((entry) => entry.id === replacementId)!.status, "pending");
  });

  it("does not promote an open stale link after the true primary was fixed", () => {
    const state = stores();
    const item = state.items.add(
      "thr_root",
      "Repair segment ownership in schema/src/segments.ts",
      "completed",
      { files: ["schema/src/segments.ts", "schema/migrations/generated"] },
    )!;
    const primary = state.findings.report("thr_root", {
      title: "Original segment defect",
      file: "schema/migrations/generated/0041_baseline.sql:91",
      evidence: "This historical finding created the remediation item.",
      fixFiles: ["schema/src/segments.ts"],
    }).finding;
    const stale = state.findings.report("thr_root", {
      title: "Later unrelated approved-lines defect",
      file: "schema/migrations/generated",
      evidence: "This broad migration scope was incorrectly coalesced later.",
      fixFiles: ["schema/migrations/generated"],
    }).finding;
    state.db.prepare("UPDATE goal_findings SET created_at = ? WHERE id = ?").run(1, primary.id);
    state.db.prepare("UPDATE goal_findings SET created_at = ? WHERE id = ?").run(2, stale.id);
    assert.equal(state.findings.linkItem("thr_root", primary.id, item.id), true);
    assert.equal(state.findings.linkItem("thr_root", stale.id, item.id), true);
    assert.equal(state.findings.resolve("thr_root", primary.id, "fixed", "fixed earlier")!.status, "fixed");

    const restartedItems = createItemStore(state.host.bb);
    const restartedFindings = createFindingStore(state.host.bb);
    const repaired = reconcileFindingQueue({
      threadId: "thr_root",
      findings: restartedFindings,
      items: restartedItems,
      maxStaffed: 0,
    });
    assert.equal(repaired.requeuedInvalid, 1);
    assert.equal(repaired.autoFixed, 0);
    assert.equal(restartedFindings.get("thr_root", primary.id)!.status, "fixed");
    assert.equal(restartedFindings.get("thr_root", stale.id)!.status, "open");
    assert.equal(restartedFindings.get("thr_root", stale.id)!.itemId, null);
  });

  it("always detaches a link to a missing work item", () => {
    const state = stores();
    const finding = state.findings.report("thr_root", {
      title: "Orphaned defect",
      file: "src/orphaned.ts:3",
      evidence: "Its old work item no longer exists.",
      fixFiles: ["src/orphaned.ts"],
    }).finding;
    state.db.prepare("UPDATE goal_findings SET item_id = ? WHERE id = ?").run("itm_missing", finding.id);

    const result = reconcileFindingQueue({
      threadId: "thr_root",
      findings: state.findings,
      items: state.items,
      maxStaffed: 0,
    });
    assert.equal(result.requeuedMissing, 1);
    assert.equal(state.findings.get("thr_root", finding.id)!.itemId, null);
  });
});
