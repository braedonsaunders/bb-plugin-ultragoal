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
  it("deduplicates the exact durable tuple and survives store recreation", () => {
    const db = database();
    const store = createInvalidBaseSuppressionStore(db);
    assert.equal(store.suppress(invalid), true);
    assert.equal(store.suppress({ ...invalid, suppressedAt: 2000 }), false);
    assert.equal(createInvalidBaseSuppressionStore(db).get(
      invalid.rootThreadId,
      invalid.itemId,
      invalid.repository,
      invalid.requestedRef,
    )?.suppressedAt, 1000);
  });

  it("does not suppress a changed repository or ref", () => {
    const store = createInvalidBaseSuppressionStore(database());
    store.suppress(invalid);
    assert.equal(store.get("thr_goal", "itm_slice", "/srv/other", "missing"), null);
    assert.equal(store.get("thr_goal", "itm_slice", "/srv/project", "fixed"), null);
  });

  it("requires explicit item revalidation for the unchanged tuple", () => {
    const store = createInvalidBaseSuppressionStore(database());
    store.suppress(invalid);
    assert.equal(store.revalidate("thr_goal", "itm_slice"), 1);
    assert.equal(store.get("thr_goal", "itm_slice", "/srv/project", "missing"), null);
  });
});
