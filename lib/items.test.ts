import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createItemStore } from "./items.ts";

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
  return { store: createItemStore(host.bb), db: host.bb.storage.database() };
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
