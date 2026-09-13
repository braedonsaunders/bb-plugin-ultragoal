import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createItemStore, type PlanPatchItem } from "./items.ts";

const hosts: FakePluginHost[] = [];

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.harness.lifecycle.dispose();
});

function itemStore() {
  const host = createFakePluginHost({ pluginId: `items-test-${hosts.length}` });
  hosts.push(host);
  host.bb.storage.database().exec(`
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
    )
  `);
  return { host, store: createItemStore(host.bb), db: host.bb.storage.database() };
}

describe("patch-style plans", () => {
  it("updates one row of a 1,000-item goal without dropping the other 999", () => {
    const { store } = itemStore();
    const created = store.upsert(
      "thr_root",
      Array.from({ length: 1_000 }, (_, index) => ({
        step: `Slice ${index}`,
        status: "pending" as const,
        deps: [],
        files: [`src/${index}.ts`],
        check: `test ${index}`,
      })),
    );
    assert.equal(created.length, 1_000);
    const target = created[500]!;
    store.upsert("thr_root", [
      { id: target.id, step: "Slice 500 revised", status: "completed" },
    ]);
    const all = store.list("thr_root");
    assert.equal(all.length, 1_000);
    assert.equal(all[500]!.id, target.id);
    assert.equal(all[500]!.step, "Slice 500 revised");
    assert.equal(all[500]!.status, "completed");
    assert.deepEqual(all[501]!.files, ["src/501.ts"]);
  });

  it("resolves patch-local dependencies and repairs them when rows are removed", () => {
    const { store } = itemStore();
    const [first, second] = store.upsert("thr_root", [
      { step: "First new slice", status: "pending", deps: [] },
      { step: "Second new slice", status: "pending", deps: ["#1"] },
    ]);
    assert.deepEqual(second!.deps, [first!.id]);
    assert.equal(store.removeMany("thr_root", [first!.id]), 1);
    assert.deepEqual(store.list("thr_root")[0]!.deps, []);
  });

  it("rejects unknown update and removal ids without changing the plan", () => {
    const { store } = itemStore();
    const [first, second] = store.upsert("thr_root", [
      { step: "First", status: "pending", deps: [] },
      { step: "Second", status: "pending", deps: ["#1"] },
    ]);
    const before = store.list("thr_root");

    assert.throws(
      () => store.patch("thr_root", [{ id: "itm_typo", step: "Retitled", status: "completed" }], []),
      /unknown plan item id/,
    );
    assert.deepEqual(store.list("thr_root"), before);

    assert.throws(
      () => store.patch("thr_root", [], ["itm_missing"]),
      /unknown remove_item_ids/,
    );
    assert.deepEqual(store.list("thr_root"), before);
    assert.deepEqual(second!.deps, [first!.id]);
  });

  it("rolls removals and dependency repairs back when a later upsert fails", () => {
    const { store, db } = itemStore();
    const [first] = store.upsert("thr_root", [
      { step: "First", status: "completed", deps: [] },
      { step: "Second", status: "pending", deps: ["#1"] },
    ]);
    const before = store.list("thr_root");
    db.exec(`
      CREATE TRIGGER fail_plan_patch_insert
      BEFORE INSERT ON goal_items
      WHEN NEW.step = 'Explode'
      BEGIN
        SELECT RAISE(ABORT, 'forced patch failure');
      END
    `);

    assert.throws(
      () => store.patch("thr_root", [{ step: "Explode", status: "pending" }], [first!.id]),
      /forced patch failure/,
    );
    assert.deepEqual(store.list("thr_root"), before);
  });
});

describe("durable item provenance", () => {
  it("persists finding origin across a patch, a transfer rewrite and a store restart", () => {
    const { host, store, db } = itemStore();
    const minted = store.addRemediation("thr_root", "Fix: a defect [src/a.ts]", {
      files: ["src/a.ts"],
      check: "npm test -- a",
    })!;
    assert.equal(store.origin("thr_root", minted.id), "finding");
    const storedOrigin = () =>
      (db.prepare("SELECT origin FROM goal_items WHERE id = ?").get(minted.id) as {
        origin: string | null;
      }).origin;
    assert.equal(storedOrigin(), "finding");

    store.patch(
      "thr_root",
      [{ id: minted.id, step: "Fix: a defect [src/a.ts]", status: "in_progress" }],
      [],
    );
    assert.equal(storedOrigin(), "finding", "a status patch must carry provenance, not reset it");

    // The store's full-rewrite path deletes and reinserts every row; a naive
    // rewrite that forgot the column would silently un-own the item.
    store.replace("thr_root", [
      { id: minted.id, step: "Fix: a defect [src/a.ts]", status: "pending" },
    ]);
    assert.equal(storedOrigin(), "finding");

    // Root transfer moves items with an in-place thread_id rewrite (the same
    // statement lib/root-transfer.ts runs), so the row must read as owned under
    // its new thread and not as a fresh, unowned row.
    db.prepare("UPDATE goal_items SET thread_id = ? WHERE thread_id = ?").run(
      "thr_moved",
      "thr_root",
    );
    assert.equal(store.origin("thr_moved", minted.id), "finding");

    assert.equal(createItemStore(host.bb).origin("thr_moved", minted.id), "finding");
  });

  it("never lets an ordinary plan patch claim finding ownership", () => {
    const { store, db } = itemStore();
    // The untrusted shape a tool call reaches the store with: a plan entry that
    // carries an origin key. Ordinary patches create and edit work, so an
    // origin they supply must never count as durable finding ownership.
    const untrusted = { step: "Owner-declared slice", status: "pending", origin: "finding" };
    const forged = untrusted as PlanPatchItem;
    const [created] = store.patch("thr_root", [forged], []).items;
    assert.equal(store.origin("thr_root", created!.id), null);

    store.patch("thr_root", [{ ...forged, id: created!.id } as PlanPatchItem], []);
    const stored = db.prepare("SELECT origin FROM goal_items WHERE id = ?").get(created!.id) as {
      origin: string | null;
    };
    assert.equal(stored.origin, null);
    assert.equal(store.origin("thr_root", created!.id), null);

    assert.equal(store.origin("thr_root", "itm_missing"), null);
  });

  it("reads provenance an older build wrote — or a null legacy row — as none", () => {
    const { store, db } = itemStore();
    const legacy = store.add("thr_root", "Native-plan mirror left behind by an older build")!;
    assert.equal(store.origin("thr_root", legacy.id), null);
    // 0.8.0 removed the native mirror but left its rows behind; "native" is not
    // remediation provenance, so the retirement gate must not read it as any.
    db.prepare("UPDATE goal_items SET origin = 'native' WHERE id = ?").run(legacy.id);
    assert.equal(store.origin("thr_root", legacy.id), null);
    // Fail closed is not the same as rewrite: an ordinary patch must carry the
    // stored bytes through untouched rather than normalizing the column.
    store.patch(
      "thr_root",
      [{ id: legacy.id, step: "Legacy mirror, retitled", status: "pending" }],
      [],
    );
    const stored = db.prepare("SELECT origin FROM goal_items WHERE id = ?").get(legacy.id) as {
      origin: string | null;
    };
    assert.equal(stored.origin, "native");
  });
});
