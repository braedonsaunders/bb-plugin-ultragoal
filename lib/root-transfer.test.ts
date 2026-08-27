import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { createDecisionStore } from "./decisions.ts";
import { createFindingStore } from "./findings.ts";
import { createItemStore } from "./items.ts";
import { createRootTransferStore, executeRootTransfer } from "./root-transfer.ts";
import { createGoalStore } from "./store.ts";

const hosts: FakePluginHost[] = [];

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.harness.lifecycle.dispose();
});

function migratedHost(sdk?: Parameters<typeof createFakePluginHost>[0] extends infer O
  ? O extends { sdk?: infer S } ? S : never
  : never) {
  const host = createFakePluginHost({
    pluginId: `root-transfer-test-${hosts.length}`,
    sdk,
  });
  hosts.push(host);
  const db = host.bb.storage.database();
  db.exec(`
    CREATE TABLE goals (
      thread_id TEXT PRIMARY KEY,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      turn_count INTEGER NOT NULL,
      max_turns INTEGER NOT NULL,
      max_minutes INTEGER NOT NULL,
      last_continue_at INTEGER,
      last_assistant_hash TEXT
    );
    INSERT INTO goals VALUES ('thr_sentinel', 'test', 'complete', NULL, 1, 1, 1, 0, 0, 0, NULL, NULL);
  `);
  const goals = createGoalStore(host.bb);
  db.prepare("DELETE FROM goals WHERE thread_id = 'thr_sentinel'").run();
  return { host, db, goals };
}

function seedState(state: ReturnType<typeof migratedHost>) {
  const { host, db, goals } = state;
  goals.replace({ threadId: "thr_source", objective: "Finish every defect", status: "paused" });
  goals.update("thr_source", {
    tokensUsed: 1_065_788_395,
    timeUsedSeconds: 999,
    workerProviderOverride: "acp-opencode",
    workerModelOverride: "openrouter/stealth/ox-alpha",
    workerReasoningOverride: "medium",
    workerServiceTierOverride: "default",
    verifyProviderOverride: "acp-opencode",
    verifyModelOverride: "openrouter/stealth/ox-alpha",
  });
  goals.setIntakeRow("thr_source", "row_old_intake");
  const items = createItemStore(host.bb);
  const [item] = items.upsert("thr_source", [
    { step: "Fix durable transfer", status: "in_progress", files: ["src/root.ts"], check: "npm test" },
    { step: "Verify durable transfer", status: "pending", deps: ["#1"] },
  ]);
  const findings = createFindingStore(host.bb);
  findings.report("thr_source", {
    title: "Transfer loses metadata",
    file: "src/root.ts:1",
    evidence: "reproduction",
    fixFiles: ["src/root.ts", "test/root.test.ts"],
    check: "npm test -- root",
  });
  const decisions = createDecisionStore(host.bb);
  decisions.request("thr_source", { question: "Proceed?", options: ["Yes", "No"] });
  const insertAgent = db.prepare(`
    INSERT INTO collab_agents (
      thread_id, root_thread_id, parent_thread_id, task_name, created_at,
      display_name, item_id, role, retired_at
    ) VALUES (?, 'thr_source', 'thr_source', ?, 1, ?, ?, 'worker', ?)
  `);
  insertAgent.run("thr_live", "/root/live", "Live", item!.id, null);
  insertAgent.run("thr_retired", "/root/retired", "Retired", null, 10);
  db.prepare(
    "UPDATE collab_agents SET report_status = 'done', report_evidence = 'sha abc123; npm test passed' WHERE thread_id = 'thr_live'",
  ).run();
  db.prepare(`
    INSERT INTO collab_root_worker_caps (root_thread_id, max_workers, updated_at)
    VALUES ('thr_source', 2, 1)
  `).run();
  return { items, findings, decisions, itemId: item!.id };
}

describe("durable root transfer", () => {
  it("moves every owned row atomically while preserving metadata and retired history", () => {
    const state = migratedHost();
    const seeded = seedState(state);
    const originalGoal = state.goals.get("thr_source")!;
    const originalItems = seeded.items.list("thr_source");
    const transfers = createRootTransferStore(state.host.bb);
    const before = transfers.inspect("thr_source", "thr_target");
    assert.deepEqual(before.counts, {
      goals: 1,
      items: 2,
      findings: 1,
      decisions: 1,
      agents: 2,
      reservations: 0,
      workerCaps: 1,
    });
    assert.deepEqual(before.directChildren, [{ threadId: "thr_live" }]);
    transfers.prepare("thr_source", "thr_target", "row_target_bootstrap", "wake-marker");
    transfers.setPhase("thr_source", "thr_target", "target_released");
    const after = transfers.commit("thr_source", "thr_target", {
      providerId: "acp-opencode",
      model: "openrouter/stealth/ox-alpha",
      reasoningLevel: "medium",
      serviceTier: "default",
    });

    assert.equal(after.mode, "repair-target");
    assert.deepEqual(after.counts, before.counts);
    assert.deepEqual(transfers.inspect("thr_source", "thr_target").directChildren, [{ threadId: "thr_live" }]);
    const sourceCounts = ["goals", "goal_items", "goal_findings", "goal_decisions"].map((table) =>
      (state.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE thread_id = 'thr_source'`).get() as { n: number }).n,
    );
    assert.deepEqual(sourceCounts, [0, 0, 0, 0]);
    const movedGoal = state.goals.get("thr_target")!;
    assert.equal(movedGoal.status, "paused");
    assert.equal(movedGoal.tokensUsed, 1_065_788_395);
    assert.equal(movedGoal.intakeRowId, "row_target_bootstrap");
    assert.deepEqual(movedGoal.accountingThreadIds, ["thr_source"]);
    assert.equal(movedGoal.workerProviderOverride, "acp-opencode");
    assert.equal(movedGoal.workerModelOverride, "openrouter/stealth/ox-alpha");
    const omitTransferredKeys = (goal: typeof movedGoal) => {
      const {
        threadId: _threadId,
        intakeRowId: _intakeRowId,
        accountingThreadIds: _accountingThreadIds,
        ...preserved
      } = goal;
      return preserved;
    };
    assert.deepEqual(omitTransferredKeys(movedGoal), omitTransferredKeys(originalGoal));
    assert.deepEqual(seeded.items.list("thr_target"), originalItems);
    const movedFinding = state.db.prepare("SELECT fix_files, check_cmd FROM goal_findings").get() as {
      fix_files: string;
      check_cmd: string;
    };
    assert.deepEqual(JSON.parse(movedFinding.fix_files), ["src/root.ts", "test/root.test.ts"]);
    assert.equal(movedFinding.check_cmd, "npm test -- root");
    const agents = state.db.prepare(
      "SELECT thread_id, root_thread_id, parent_thread_id, item_id, report_status, report_evidence FROM collab_agents ORDER BY thread_id",
    ).all() as Array<Record<string, string | null>>;
    assert.deepEqual(agents, [
      {
        thread_id: "thr_live",
        root_thread_id: "thr_target",
        parent_thread_id: "thr_target",
        item_id: seeded.itemId,
        report_status: "done",
        report_evidence: "sha abc123; npm test passed",
      },
      {
        thread_id: "thr_retired",
        root_thread_id: "thr_target",
        parent_thread_id: "thr_source",
        item_id: null,
        report_status: null,
        report_evidence: null,
      },
    ]);
    assert.deepEqual(
      state.db.prepare(
        "SELECT root_thread_id, max_workers FROM collab_root_worker_caps",
      ).all(),
      [{ root_thread_id: "thr_target", max_workers: 2 }],
    );
  });

  it("rolls the entire IMMEDIATE transaction back on a forced goal update failure", () => {
    const state = migratedHost();
    seedState(state);
    const transfers = createRootTransferStore(state.host.bb);
    transfers.prepare("thr_source", "thr_target", "row_target", "marker");
    transfers.setPhase("thr_source", "thr_target", "target_released");
    state.db.exec(`
      CREATE TRIGGER fail_root_transfer
      BEFORE UPDATE OF thread_id ON goals
      WHEN NEW.thread_id = 'thr_target'
      BEGIN SELECT RAISE(ABORT, 'forced root transfer failure'); END
    `);
    assert.throws(
      () => transfers.commit("thr_source", "thr_target", {
        providerId: "acp-opencode",
        model: "openrouter/stealth/ox-alpha",
        reasoningLevel: "medium",
        serviceTier: "default",
      }),
      /forced root transfer failure/,
    );
    assert.equal(transfers.inspect("thr_source", "thr_target").mode, "transfer");
    assert.equal(transfers.journal("thr_source", "thr_target")!.phase, "target_released");
    assert.equal(
      (state.db.prepare(
        "SELECT COUNT(*) AS n FROM goal_items WHERE thread_id='thr_source'",
      ).get() as { n: number }).n,
      2,
    );
    assert.equal(
      (state.db.prepare(
        "SELECT COUNT(*) AS n FROM goal_items WHERE thread_id='thr_target'",
      ).get() as { n: number }).n,
      0,
    );
  });

  it("rejects a destination that is already any collaboration child id", () => {
    const state = migratedHost();
    seedState(state);
    state.db.prepare(`
      INSERT INTO collab_agents (thread_id, root_thread_id, parent_thread_id, task_name, created_at)
      VALUES ('thr_target', 'thr_other', 'thr_other', '/root/collision', 1)
    `).run();
    assert.throws(
      () => createRootTransferStore(state.host.bb).inspect("thr_source", "thr_target"),
      /collab child thread_id/,
    );
  });

  it("archives before reparenting and repairs a partial external move without a duplicate wake", async () => {
    const threads = new Map([
      ["thr_source", makeThreadResponse({
        id: "thr_source", projectId: "proj", environmentId: "env", providerId: "acp-opencode", status: "active",
      })],
      ["thr_target", makeThreadResponse({
        id: "thr_target", projectId: "proj", environmentId: "env", providerId: "codex", status: "idle",
      })],
      ["thr_live", makeThreadResponse({
        id: "thr_live", projectId: "proj", environmentId: "env", providerId: "acp-opencode", status: "idle", parentThreadId: "thr_source",
      })],
      ["thr_live2", makeThreadResponse({
        id: "thr_live2", projectId: "proj", environmentId: "env", providerId: "acp-opencode", status: "idle", parentThreadId: "thr_source",
      })],
    ]);
    let failSecondMove = true;
    const state = migratedHost({
      threads: {
        get: ({ threadId }) => threads.get(threadId)!,
        defaultExecutionOptions: () => ({
          providerId: "codex", model: "gpt-5.6-sol", reasoningLevel: "xhigh",
          serviceTier: "fast", permissionMode: "full",
        }),
        stop: ({ threadId }) => {
          threads.set(threadId, { ...threads.get(threadId)!, status: "idle" });
          return { ok: true };
        },
        wait: ({ threadId }) => ({ matched: true, target: { kind: "status", status: "idle" }, threadId, thread: threads.get(threadId)! }),
        archive: ({ threadId }) => {
          threads.set(threadId, { ...threads.get(threadId)!, archivedAt: 10 });
          threads.set("thr_live", { ...threads.get("thr_live")!, parentThreadId: null });
          threads.set("thr_live2", { ...threads.get("thr_live2")!, parentThreadId: null });
          return { archivedThreadIds: [threadId] };
        },
        update: ({ threadId, parentThreadId }) => {
          if (threadId === "thr_live2" && failSecondMove) {
            failSecondMove = false;
            throw new Error("synthetic second-child move failure");
          }
          threads.set(threadId, { ...threads.get(threadId)!, parentThreadId: parentThreadId ?? null });
          return threads.get(threadId)!;
        },
      },
    });
    const seeded = seedState(state);
    state.db.prepare(`
      INSERT INTO collab_agents (
        thread_id, root_thread_id, parent_thread_id, task_name, created_at,
        display_name, item_id, role, retired_at
      ) VALUES ('thr_live2', 'thr_source', 'thr_source', '/root/live2', 1, 'Live 2', ?, 'worker', NULL)
    `).run(seeded.items.list("thr_source")[1]!.id);
    const transfers = createRootTransferStore(state.host.bb);
    let wakeCount = 0;
    const dryRun = await executeRootTransfer({
      bb: state.host.bb,
      store: transfers,
      sourceThreadId: "thr_source",
      targetThreadId: "thr_target",
      dryRun: true,
      targetIntakeRowId: async () => "row_target",
      workerExecution: () => { throw new Error("dry-run must not snapshot execution"); },
      finalAccount: async () => { throw new Error("dry-run must not account"); },
      wakeSeen: async () => { throw new Error("dry-run must not inspect a wake"); },
      wakeTarget: async () => { throw new Error("dry-run must not wake"); },
    });
    assert.equal(dryRun.dryRun, true);
    assert.equal(transfers.journal("thr_source", "thr_target"), null);
    assert.equal(state.goals.get("thr_source")?.status, "paused");
    assert.equal(state.goals.get("thr_target"), null);

    const execute = () => executeRootTransfer({
      bb: state.host.bb,
      store: transfers,
      sourceThreadId: "thr_source",
      targetThreadId: "thr_target",
      targetIntakeRowId: async () => "row_target",
      workerExecution: () => ({
        providerId: "acp-opencode", model: "openrouter/stealth/ox-alpha",
        reasoningLevel: "medium", serviceTier: "default",
      }),
      finalAccount: async () => {},
      wakeSeen: async () => wakeCount > 0,
      wakeTarget: async () => { wakeCount += 1; },
    });
    await assert.rejects(execute(), /synthetic second-child move failure/);
    assert.equal(transfers.journal("thr_source", "thr_target")!.phase, "source_archived");
    assert.equal(threads.get("thr_live")!.parentThreadId, "thr_target");
    assert.equal(threads.get("thr_live2")!.parentThreadId, null);
    const report = await execute();
    assert.equal(report.awakened, true);
    assert.equal(wakeCount, 1);
    assert.equal(threads.get("thr_live")!.parentThreadId, "thr_target");
    assert.equal(threads.get("thr_live2")!.parentThreadId, "thr_target");
    const calls = state.host.harness.inspection.sdk.calls.map((call) => call.path);
    assert.ok(calls.indexOf("threads.archive") < calls.indexOf("threads.update"));
    const stopArgs = state.host.harness.inspection.sdk.callsTo("threads.stop") as Array<[
      { threadId: string },
    ]>;
    assert.equal(stopArgs[0]![0].threadId, "thr_target");

    const repaired = await executeRootTransfer({
      bb: state.host.bb,
      store: transfers,
      sourceThreadId: "thr_source",
      targetThreadId: "thr_target",
      targetIntakeRowId: async () => "unused",
      workerExecution: () => { throw new Error("must not resnapshot"); },
      finalAccount: async () => { throw new Error("must not re-account"); },
      wakeSeen: async () => true,
      wakeTarget: async () => { wakeCount += 1; },
    });
    assert.equal(repaired.journal!.phase, "complete");
    assert.equal(wakeCount, 1);
  });
});

describe("a worker that already ended", () => {
  it("does not block a transfer just because its thread was archived", () => {
    // Workers are archived when they retire and the plugin's row can lag, so a
    // normal fleet accumulates rows marked live whose threads are gone — 415 on
    // one goal, every one refusing the transfer with a message implying
    // corruption. Archived means finished, not broken.
    const { host, db } = migratedHost();
    const store = createRootTransferStore(host.bb);
    db.prepare(
      "INSERT INTO collab_agents (thread_id, root_thread_id, parent_thread_id, task_name, created_at, role) VALUES (?,?,?,?,?,?)",
    ).run("thr_gone", "thr_src", "thr_src", "/root/gone", 1, "worker");
    assert.equal(
      (db.prepare("SELECT retired_at FROM collab_agents WHERE thread_id = ?").get("thr_gone") as { retired_at: number | null }).retired_at,
      null,
    );
    store.retireMissingChild("thr_gone");
    assert.notEqual(
      (db.prepare("SELECT retired_at FROM collab_agents WHERE thread_id = ?").get("thr_gone") as { retired_at: number | null }).retired_at,
      null,
    );
  });

  it("leaves an already-retired row alone rather than restamping it", () => {
    const { host, db } = migratedHost();
    const store = createRootTransferStore(host.bb);
    db.prepare(
      "INSERT INTO collab_agents (thread_id, root_thread_id, parent_thread_id, task_name, created_at, role, retired_at) VALUES (?,?,?,?,?,?,?)",
    ).run("thr_old", "thr_src", "thr_src", "/root/old", 1, "worker", 500);
    store.retireMissingChild("thr_old");
    assert.equal(
      (db.prepare("SELECT retired_at FROM collab_agents WHERE thread_id = ?").get("thr_old") as { retired_at: number | null }).retired_at,
      500,
    );
  });
});
