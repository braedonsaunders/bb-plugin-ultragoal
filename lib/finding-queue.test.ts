import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createFindingStore } from "./findings.ts";
import {
  closeFindingsForCompletedItem,
  healAutoMintedFindingDuplicates,
  reconcileFindingQueue,
} from "./finding-queue.ts";
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

  it("does not preserve a later defect merely because it shares a generated baseline file", () => {
    const state = stores();
    const item = state.items.add(
      "thr_root",
      "Repair tax-rate persistence exposed by the generated baseline",
      "pending",
      { files: ["schema/migrations/generated/0001_baseline.sql"] },
    )!;
    const primary = state.findings.report("thr_root", {
      title: "Tax-rate baseline defect",
      file: "schema/migrations/generated/0001_baseline.sql:1200",
      evidence: "The primary creator may retain its historical baseline evidence.",
      fixFiles: ["schema/migrations/generated/0001_baseline.sql"],
    }).finding;
    const unrelated = state.findings.report("thr_root", {
      title: "Tenant foreign-key graph defect",
      file: "schema/migrations/generated/0001_baseline.sql:30655",
      evidence: "A different line in a monolithic artifact is not shared domain ownership.",
      fixFiles: ["schema/migrations/generated/0001_baseline.sql"],
    }).finding;
    state.db.prepare("UPDATE goal_findings SET created_at = ? WHERE id = ?").run(1, primary.id);
    state.db.prepare("UPDATE goal_findings SET created_at = ? WHERE id = ?").run(2, unrelated.id);
    assert.equal(state.findings.linkItem("thr_root", primary.id, item.id), true);
    assert.equal(state.findings.linkItem("thr_root", unrelated.id, item.id), true);

    const repaired = reconcileFindingQueue({
      threadId: "thr_root",
      findings: createFindingStore(state.host.bb),
      items: createItemStore(state.host.bb),
      maxStaffed: 1,
    });
    assert.equal(repaired.requeuedInvalid, 1);
    assert.equal(state.findings.get("thr_root", primary.id)!.itemId, item.id);
    assert.equal(state.findings.get("thr_root", unrelated.id)!.itemId, null);
    assert.equal(repaired.awaitingAssignment, 1);
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

  it("requeues open findings on completed work when no structured proof survives", () => {
    const state = stores();
    const item = state.items.add(
      "thr_root",
      "Repair the completed domain work",
      "completed",
      { files: ["src/domain.ts"] },
    )!;
    const finding = state.findings.report("thr_root", {
      title: "Domain defect still needs proof",
      file: "src/domain.ts:10",
      evidence: "The open row survived a restart after item completion.",
      fixFiles: ["src/domain.ts"],
    }).finding;
    assert.equal(state.findings.linkItem("thr_root", finding.id, item.id), true);

    const repaired = reconcileFindingQueue({
      threadId: "thr_root",
      findings: state.findings,
      items: state.items,
      maxStaffed: 1,
    });
    assert.equal(repaired.autoFixed, 0);
    assert.equal(repaired.requeuedCompleted, 1);
    assert.equal(state.findings.get("thr_root", finding.id)!.status, "open");
    assert.notEqual(state.findings.get("thr_root", finding.id)!.itemId, item.id);
  });

  it("recovers closure only from persisted exact per-defect affirmative proof", () => {
    const state = stores();
    const item = state.items.add(
      "thr_root",
      "Repair the proven completed domain work",
      "completed",
      { files: ["src/proven.ts"] },
    )!;
    const finding = state.findings.report("thr_root", {
      title: "Proven defect",
      file: "src/proven.ts:20",
      evidence: "The implementation and regression test already landed.",
      fixFiles: ["src/proven.ts"],
    }).finding;
    assert.equal(state.findings.linkItem("thr_root", finding.id, item.id), true);

    const repaired = reconcileFindingQueue({
      threadId: "thr_root",
      findings: state.findings,
      items: state.items,
      maxStaffed: 1,
      completionEvidence: () => [
        { findingId: finding.id, proof: "commit abc123; npm test -- proven passed" },
      ],
    });
    assert.equal(repaired.autoFixed, 1);
    assert.equal(repaired.requeuedCompleted, 0);
    assert.equal(state.findings.get("thr_root", finding.id)!.status, "fixed");
  });

  it("preserves later links named by #42+#43 and #57+#58 CONTEXT clauses", () => {
    const state = stores();
    const pairs = [
      { numbers: [42, 43], domain: "payment scheduler" },
      { numbers: [57, 58], domain: "app runtime" },
    ] as const;

    for (const [pairIndex, pair] of pairs.entries()) {
      const primary = state.findings.report("thr_root", {
        title: `${pair.domain} primary defect`,
        file: "schema/migrations/generated",
        evidence: "Primary evidence",
        fixFiles: ["schema/migrations/generated"],
      }).finding;
      const later = state.findings.report("thr_root", {
        title: `${pair.domain} later defect`,
        file: "schema/migrations/generated",
        evidence: "Later evidence",
        fixFiles: ["schema/migrations/generated"],
      }).finding;
      const item = state.items.add(
        "thr_root",
        `Fix ${pair.domain}. CONTEXT (audit findings #${pair.numbers[0]} ${primary.id} + #${pair.numbers[1]} ${later.id}): implement one shared boundary.`,
        "pending",
        { files: [] },
      )!;
      state.db.prepare("UPDATE goal_findings SET created_at = ? WHERE id = ?").run(
        pairIndex * 2 + 1,
        primary.id,
      );
      state.db.prepare("UPDATE goal_findings SET created_at = ? WHERE id = ?").run(
        pairIndex * 2 + 2,
        later.id,
      );
      assert.equal(state.findings.linkItem("thr_root", primary.id, item.id), true);
      assert.equal(state.findings.linkItem("thr_root", later.id, item.id), true);
    }

    const result = reconcileFindingQueue({
      threadId: "thr_root",
      findings: state.findings,
      items: state.items,
      maxStaffed: 2,
    });
    assert.equal(result.requeuedInvalid, 0);
    assert.equal(result.remediationWorkItems, 2);
    assert.equal(result.awaitingAssignment, 0);
  });

  it("rejects a WRONG auditor mention outside structured CONTEXT", () => {
    const state = stores();
    const primary = state.findings.report("thr_root", {
      title: "Recurring primary defect",
      file: "schema/migrations/generated",
      evidence: "Primary evidence",
      fixFiles: ["schema/migrations/generated"],
    }).finding;
    const stale = state.findings.report("thr_root", {
      title: "Unrelated recurring attachment",
      file: "schema/migrations/generated",
      evidence: "Broad scope is not ownership evidence.",
      fixFiles: ["schema/migrations/generated"],
    }).finding;
    const item = state.items.add(
      "thr_root",
      `Repair recurring work. AUDITOR TIGHTENING: ${stale.id} confirms the old broad-directory coalescing is WRONG.`,
      "pending",
      { files: ["schema/migrations/generated"] },
    )!;
    state.db.prepare("UPDATE goal_findings SET created_at = ? WHERE id = ?").run(1, primary.id);
    state.db.prepare("UPDATE goal_findings SET created_at = ? WHERE id = ?").run(2, stale.id);
    assert.equal(state.findings.linkItem("thr_root", primary.id, item.id), true);
    assert.equal(state.findings.linkItem("thr_root", stale.id, item.id), true);

    const result = reconcileFindingQueue({
      threadId: "thr_root",
      findings: state.findings,
      items: state.items,
      maxStaffed: 1,
    });
    assert.equal(result.requeuedInvalid, 1);
    assert.equal(state.findings.get("thr_root", primary.id)!.itemId, item.id);
    assert.equal(state.findings.get("thr_root", stale.id)!.itemId, null);
  });

  it("heals the three v0.17.13 live false-negative shapes without duplicating capacity", () => {
    const state = stores();
    const findingWithId = (
      id: string,
      input: { title: string; file: string; evidence: string; fixFiles: string[] },
    ) => {
      const reported = state.findings.report("thr_root", input).finding;
      state.db.prepare("UPDATE goal_findings SET id = ? WHERE id = ?").run(id, reported.id);
      return state.findings.get("thr_root", id)!;
    };
    const itemWithId = (id: string, step: string, files: string[], createdAt: number) => {
      const item = state.items.add("thr_root", step, "pending", { files })!;
      state.db.prepare("UPDATE goal_items SET id = ? WHERE id = ?").run(id, item.id);
      state.db.prepare("UPDATE goal_items SET created_at = ? WHERE id = ?").run(createdAt, id);
      return state.items.list("thr_root").find((entry) => entry.id === id)!;
    };

    const routePrimary = findingWithId("fnd_mt97d1r9_d2c31r", {
      title: "Tax setup persists unusable negative rates",
      file: "web/app/api/admin/setup/[entity]/route.ts:674",
      evidence: "The calculation engine cannot consume the stored rate.",
      fixFiles: ["web/app/api/admin/setup/[entity]/route.ts"],
    });
    const route = findingWithId("fnd_mt97llmk_73ao2v", {
      title: "Concurrent Setup creates can duplicate authoritative tax and dimension codes",
      file: "web/app/api/admin/setup/[entity]/route.ts:672",
      evidence: "Concurrent creates pass the setup boundary.",
      fixFiles: ["web/app/api/admin/setup/[entity]/route.ts"],
    });
    const paymentPrimary = findingWithId("fnd_mt97oet5_3vwaph", {
      title: "Payment scheduler loses a run",
      file: "schema/migrations/generated",
      evidence: "The cursor advances before the run commits.",
      fixFiles: ["schema/migrations/generated"],
    });
    const paymentLater = findingWithId("fnd_mt97oqxt_pkqakx", {
      title: "Scheduled payment runs impersonate the schedule creator and break maker-checker evidence",
      file: "engine/src/payment-operations.ts:1144",
      evidence: "The scheduler impersonates a historical actor.",
      fixFiles: ["engine/src/payment-operations.ts"],
    });
    const appPrimary = findingWithId("fnd_mt97wk5r_6qlleu", {
      title: "App invocation duplicates writes",
      file: "schema/migrations/generated",
      evidence: "Retries repeat a committed financial effect.",
      fixFiles: ["schema/migrations/generated"],
    });
    const appLater = findingWithId("fnd_mt97wkcv_xyihvs", {
      title: "App audit is best effort",
      file: "web/lib/apps/store.ts:448",
      evidence: "Material effects can commit without audit evidence.",
      fixFiles: ["web/lib/apps/store.ts"],
    });
    const unrelated = findingWithId("fnd_unrelated_older", {
      title: "An unrelated defect is waiting at full capacity",
      file: "src/unrelated.ts:10",
      evidence: "It needs distinct remediation work.",
      fixFiles: ["src/unrelated.ts"],
    });
    [
      routePrimary,
      route,
      paymentPrimary,
      paymentLater,
      appPrimary,
      unrelated,
      appLater,
    ].forEach((finding, index) => {
      state.db.prepare("UPDATE goal_findings SET created_at = ? WHERE id = ?").run(
        index + 1,
        finding.id,
      );
    });

    const routeItem = itemWithId(
      "itm_mt97d1rc_wplodu",
      "Fix: Tax setup persists negative rates [web/app/api/admin/setup/[entity]/route.ts]",
      ["web/app/api/admin/setup/[entity]/route.ts"],
      1,
    );
    const paymentItem = itemWithId(
      "itm_mt98pay_2a7b4c",
      `Fix payment scheduler durability. CONTEXT (audit findings #42 ${paymentPrimary.id} + #43 ${paymentLater.id}): preserve both defects.`,
      [],
      2,
    );
    const appItem = itemWithId(
      "itm_mt98app_7b8d0e",
      `Fix app invocation atomicity. CONTEXT (audit findings #57 ${appPrimary.id} + #58 ${appLater.id}): preserve both defects.`,
      [],
      3,
    );
    const routeDuplicate = itemWithId(
      "itm_mt9bn3r7_tn9ooy",
      `Fix: ${route.title} [web/app/api/admin/setup/[entity]/route.ts]`,
      ["web/app/api/admin/setup/[entity]/route.ts"],
      10,
    );
    const paymentDuplicate = itemWithId(
      "itm_mt9br6ki_shr60e",
      `Fix: ${paymentLater.title} [engine/src/payment-operations.ts]`,
      ["engine/src/payment-operations.ts"],
      11,
    );
    assert.equal(state.findings.linkItem("thr_root", routePrimary.id, routeItem.id), true);
    assert.equal(state.findings.linkItem("thr_root", route.id, routeDuplicate.id), true);
    assert.equal(state.findings.linkItem("thr_root", paymentPrimary.id, paymentItem.id), true);
    assert.equal(state.findings.linkItem("thr_root", paymentLater.id, paymentDuplicate.id), true);
    assert.equal(state.findings.linkItem("thr_root", appPrimary.id, appItem.id), true);

    const restartedItems = createItemStore(state.host.bb);
    const restartedFindings = createFindingStore(state.host.bb);
    const repaired = reconcileFindingQueue({
      threadId: "thr_root",
      findings: restartedFindings,
      items: restartedItems,
      maxStaffed: 3,
    });
    assert.equal(repaired.linked, 1);
    assert.equal(repaired.healedDuplicates, 2);
    assert.equal(repaired.minted, 0);
    assert.equal(repaired.requeuedInvalid, 0);
    assert.equal(repaired.remediationWorkItems, 3);
    assert.equal(repaired.awaitingAssignment, 1);
    assert.equal(restartedFindings.get("thr_root", route.id)!.itemId, routeItem.id);
    assert.equal(restartedFindings.get("thr_root", paymentLater.id)!.itemId, paymentItem.id);
    assert.equal(restartedFindings.get("thr_root", appLater.id)!.itemId, appItem.id);
    assert.equal(restartedFindings.get("thr_root", unrelated.id)!.itemId, null);
    assert.equal(restartedItems.list("thr_root").some((item) => item.id === routeDuplicate.id), false);
    assert.equal(restartedItems.list("thr_root").some((item) => item.id === paymentDuplicate.id), false);
    assert.equal(restartedItems.list("thr_root").length, 3);
  });

  it("moves an auto-minted singleton to the oldest strong match, not plan order", () => {
    const state = stores();
    const finding = state.findings.report("thr_root", {
      title: "Dynamic route singleton",
      file: "web/app/api/[entity]/route.ts:44",
      evidence: "The exact route owns the failure.",
      fixFiles: ["web/app/api/[entity]/route.ts"],
    }).finding;
    const oldest = state.items.add(
      "thr_root",
      "Repair the established dynamic route",
      "pending",
      { files: ["web/app/api/[entity]/route.ts"] },
    )!;
    const newer = state.items.add(
      "thr_root",
      "Repair a second exact route boundary",
      "pending",
      { files: ["web/app/api/[entity]/route.ts"] },
    )!;
    const duplicate = state.items.add(
      "thr_root",
      `Fix: ${finding.title} [web/app/api/[entity]/route.ts]`,
      "pending",
      { files: ["web/app/api/[entity]/route.ts"] },
    )!;
    state.db.prepare("UPDATE goal_items SET created_at = ?, sort_order = ? WHERE id = ?").run(
      1,
      100,
      oldest.id,
    );
    state.db.prepare("UPDATE goal_items SET created_at = ?, sort_order = ? WHERE id = ?").run(
      2,
      0,
      newer.id,
    );
    state.db.prepare("UPDATE goal_items SET created_at = ?, sort_order = ? WHERE id = ?").run(
      3,
      1,
      duplicate.id,
    );
    assert.equal(state.findings.linkItem("thr_root", finding.id, duplicate.id), true);

    assert.equal(
      healAutoMintedFindingDuplicates({
        threadId: "thr_root",
        findings: state.findings,
        items: state.items,
      }),
      1,
    );
    assert.equal(state.findings.get("thr_root", finding.id)!.itemId, oldest.id);
    assert.equal(state.items.list("thr_root").some((item) => item.id === duplicate.id), false);
    assert.equal(state.items.list("thr_root").some((item) => item.id === newer.id), true);
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
