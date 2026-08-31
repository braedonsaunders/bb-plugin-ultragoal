import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  MAX_WORKER_BRIEF_CHARS,
  createWorkerBriefStore,
  withStandingBrief,
} from "./worker-brief.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function db() {
  const dir = mkdtempSync(join(tmpdir(), "ultragoal-brief-"));
  dirs.push(dir);
  return new Database(join(dir, "data.db")) as unknown as Parameters<
    typeof createWorkerBriefStore
  >[0];
}

describe("standing worker brief", () => {
  it("creates its own table so a missed migration cannot lose the rules", () => {
    const handle = db();
    const store = createWorkerBriefStore(handle);
    assert.equal(store.setFromPane("thr_goal", "no private databases"), null);
    assert.equal(store.get("thr_goal"), "no private databases");
    assert.equal(store.getRecord("thr_goal")?.provenance, "user-pane");
    assert.ok((store.getRecord("thr_goal")?.updatedAt ?? 0) > 0);
  });

  it("keeps rules per goal, so one goal's house rules never bind another", () => {
    const store = createWorkerBriefStore(db());
    store.setFromPane("thr_a", "rule A");
    store.setFromPane("thr_b", "rule B");
    assert.equal(store.get("thr_a"), "rule A");
    assert.equal(store.get("thr_b"), "rule B");
  });

  it("replaces rather than appends, so editing does not accumulate stale rules", () => {
    const store = createWorkerBriefStore(db());
    store.setFromPane("thr_goal", "first");
    store.setFromPane("thr_goal", "second");
    assert.equal(store.get("thr_goal"), "second");
  });

  it("refuses an empty brief instead of silently storing nothing", () => {
    const store = createWorkerBriefStore(db());
    assert.match(store.setFromPane("thr_goal", "   ") ?? "", /pane/);
    assert.equal(store.get("thr_goal"), null);
  });

  it("refuses a brief too long to belong in every worker prompt", () => {
    const store = createWorkerBriefStore(db());
    const error = store.setFromPane("thr_goal", "x".repeat(MAX_WORKER_BRIEF_CHARS + 1));
    assert.match(error ?? "", /too long/);
    assert.equal(store.get("thr_goal"), null);
  });

  it("clears only the goal asked for", () => {
    const store = createWorkerBriefStore(db());
    store.setFromPane("thr_a", "rule A");
    store.setFromPane("thr_b", "rule B");
    assert.equal(store.clear("thr_a"), true);
    assert.equal(store.get("thr_a"), null);
    assert.equal(store.get("thr_b"), "rule B");
    assert.equal(store.clear("thr_a"), false);
  });

  it("appends the rules to a worker's instructions, labelled as binding", () => {
    const out = withStandingBrief("Complete only your slice.", "Never start your own database.");
    assert.match(out, /Complete only your slice\./);
    assert.match(out, /STANDING RULES/);
    assert.match(out, /Never start your own database\./);
  });

  it("leaves instructions untouched when a goal has no rules", () => {
    // A goal without house rules must not gain an empty, confusing header.
    assert.equal(withStandingBrief("Complete only your slice.", null), "Complete only your slice.");
    assert.equal(withStandingBrief("Complete only your slice.", "   "), "Complete only your slice.");
  });
});
