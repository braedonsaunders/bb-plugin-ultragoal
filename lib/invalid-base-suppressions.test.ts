import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createInvalidBaseSuppressionStore } from "./invalid-base-suppressions.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function database() {
  const dir = mkdtempSync(join(tmpdir(), "ultragoal-invalid-base-"));
  dirs.push(dir);
  return new Database(join(dir, "data.db")) as unknown as Parameters<
    typeof createInvalidBaseSuppressionStore
  >[0];
}

const invalid = {
  rootThreadId: "thr_goal",
  itemId: "itm_slice",
  repository: "/srv/project",
  requestedRef: "missing",
  diagnostic: "Reference missing is not a commit",
  suppressedAt: 1000,
};

describe("invalid base suppressions", () => {
  it("deduplicates an identical goal/item/repository/ref tuple", () => {
    const store = createInvalidBaseSuppressionStore(database());
    assert.equal(store.suppress(invalid), true);
    assert.equal(store.suppress({ ...invalid, suppressedAt: 2000 }), false);
    assert.equal(store.list("thr_goal").length, 1);
  });

  it("survives store recreation and preserves the first suppression time", () => {
    const db = database();
    createInvalidBaseSuppressionStore(db).suppress(invalid);
    const restored = createInvalidBaseSuppressionStore(db).get(
      invalid.rootThreadId,
      invalid.itemId,
      invalid.repository,
      invalid.requestedRef,
    );
    assert.equal(restored?.suppressedAt, 1000);
  });

  it("treats a changed repository or ref as a different request", () => {
    const store = createInvalidBaseSuppressionStore(database());
    store.suppress(invalid);
    assert.equal(store.get("thr_goal", "itm_slice", "/srv/other", "missing"), null);
    assert.equal(store.get("thr_goal", "itm_slice", "/srv/project", "fixed"), null);
  });

  it("requires an explicit item revalidation for the unchanged tuple", () => {
    const store = createInvalidBaseSuppressionStore(database());
    store.suppress(invalid);
    assert.equal(store.revalidate("thr_goal", "itm_slice"), 1);
    assert.equal(
      store.get("thr_goal", "itm_slice", "/srv/project", "missing"),
      null,
    );
  });
});
