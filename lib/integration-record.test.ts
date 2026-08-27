import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createIntegrationRecordStore } from "./integration-record.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function store() {
  const dir = mkdtempSync(join(tmpdir(), "ultragoal-integration-"));
  dirs.push(dir);
  const db = new Database(join(dir, "data.db")) as unknown as Parameters<
    typeof createIntegrationRecordStore
  >[0];
  return createIntegrationRecordStore(db);
}

describe("integration provenance", () => {
  it("creates its own table so a missed migration cannot lose the record", () => {
    const s = store();
    s.record("thr_g", { itemId: "itm_1", commit: null, branch: "bb/x", status: "integrated", detail: "into main" }, 1);
    assert.equal(s.get("thr_g", "itm_1")?.status, "integrated");
  });

  it("remembers a failed merge, which is the case that was silent", () => {
    // A finding is closed on the worker's report BEFORE the merge is attempted,
    // so a failure used to leave the register asserting a fix that is not in
    // the tree, with nothing written down anywhere.
    const s = store();
    s.record("thr_g", { itemId: "itm_1", commit: null, branch: "bb/x", status: "failed", detail: "dirty checkout" }, 1);
    assert.deepEqual(s.unintegrated("thr_g"), [{ itemId: "itm_1", branch: "bb/x", detail: "dirty checkout" }]);
  });

  it("lists only the slices whose work is genuinely not on the base branch", () => {
    const s = store();
    s.record("thr_g", { itemId: "ok", commit: "abc", branch: "bb/a", status: "integrated", detail: null }, 1);
    s.record("thr_g", { itemId: "bad", commit: null, branch: "bb/b", status: "failed", detail: "conflict" }, 2);
    assert.deepEqual(s.unintegrated("thr_g").map((r) => r.itemId), ["bad"]);
  });

  it("lets a retry overwrite a failure, so a fixed merge stops being reported", () => {
    const s = store();
    s.record("thr_g", { itemId: "itm_1", commit: null, branch: "bb/x", status: "failed", detail: "conflict" }, 1);
    s.record("thr_g", { itemId: "itm_1", commit: "def", branch: "bb/x", status: "integrated", detail: null }, 2);
    assert.deepEqual(s.unintegrated("thr_g"), []);
    assert.equal(s.get("thr_g", "itm_1")?.commit_sha, "def");
  });

  it("keeps records per goal", () => {
    const s = store();
    s.record("thr_a", { itemId: "itm_1", commit: null, branch: null, status: "failed", detail: null }, 1);
    assert.equal(s.unintegrated("thr_b").length, 0);
  });
});
