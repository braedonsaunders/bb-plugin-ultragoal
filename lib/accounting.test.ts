import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createSessionTokenStore } from "./accounting.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function db() {
  const dir = mkdtempSync(join(tmpdir(), "ultragoal-tokens-"));
  dirs.push(dir);
  const handle = new Database(join(dir, "data.db"));
  handle.exec(`
    CREATE TABLE goal_session_tokens (
      goal_thread_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tokens INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (goal_thread_id, session_id)
    );
  `);
  return handle as unknown as Parameters<typeof createSessionTokenStore>[0];
}

describe("session token accounting", () => {
  it("sums every session the goal ever ran, not just the live ones", () => {
    const sessions = createSessionTokenStore(db());
    sessions.record("thr_goal", "root", 1_000);
    sessions.record("thr_goal", "worker_a", 400);
    sessions.record("thr_goal", "worker_b", 600);
    assert.equal(sessions.total("thr_goal"), 2_000);
  });

  it("keeps a retired session's spend after its worker is gone", () => {
    // This is the whole defect. One agent = one slice, so sessions retire
    // constantly. Holding the per-session map in memory meant a reload rebuilt
    // it from the live handful alone, their sum never again passed the
    // historical high-water mark the total was floored to, and the counter
    // froze — it sat at 1,065,788,395 for hours across 216 retired workers.
    const handle = db();
    createSessionTokenStore(handle).record("thr_goal", "retired_worker", 900_000);

    // A fresh store stands in for the plugin reload that used to lose this.
    const afterReload = createSessionTokenStore(handle);
    assert.equal(afterReload.total("thr_goal"), 900_000);

    afterReload.record("thr_goal", "live_worker", 100_000);
    assert.equal(afterReload.total("thr_goal"), 1_000_000);
  });

  it("advances a session's total and never lets a lower reading refund it", () => {
    const sessions = createSessionTokenStore(db());
    sessions.record("thr_goal", "worker", 500);
    sessions.record("thr_goal", "worker", 900);
    assert.equal(sessions.total("thr_goal"), 900);
    // A partial or restarted provider report reads low; it is not a refund.
    sessions.record("thr_goal", "worker", 100);
    assert.equal(sessions.total("thr_goal"), 900);
  });

  it("keeps goals separate so one goal's spend never lands on another", () => {
    const sessions = createSessionTokenStore(db());
    sessions.record("thr_a", "shared_name", 700);
    sessions.record("thr_b", "shared_name", 300);
    assert.equal(sessions.total("thr_a"), 700);
    assert.equal(sessions.total("thr_b"), 300);
  });

  it("reports which sessions are already recorded, so they are never re-read", () => {
    // The backfill is bounded per tick only because a recorded session is
    // skipped forever after. Without this, a long goal would re-read hundreds
    // of dead threads on every tick.
    const sessions = createSessionTokenStore(db());
    sessions.record("thr_goal", "seen", 1);
    const recorded = sessions.recordedSessions("thr_goal");
    assert.equal(recorded.has("seen"), true);
    assert.equal(recorded.has("unseen"), false);
  });

  it("totals zero for a goal that has run nothing, without throwing", () => {
    assert.equal(createSessionTokenStore(db()).total("thr_empty"), 0);
  });
});
