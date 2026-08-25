import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createFindingStore } from "./findings.ts";
import { reconcileFindingQueue } from "./finding-queue.ts";
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
    state.findings.markFixedByItem("thr_root", firstItemId, "completed");

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
});
