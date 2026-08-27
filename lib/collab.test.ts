import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { COLLAB_TOOL_NAMES, createCollabStore } from "./collab.ts";

const hosts: FakePluginHost[] = [];

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.harness.lifecycle.dispose();
});

function collabHost(options?: {
  discovered?: ReturnType<typeof makeThreadResponse>[];
  prompts?: Record<string, string>;
}) {
  const stopped: string[] = [];
  const prompts: string[] = [];
  let spawnCalls = 0;
  const host = createFakePluginHost({
    pluginId: `collab-strict-${hosts.length}`,
    sdk: {
      threads: {
        get: ({ threadId }) =>
          options?.discovered?.find((thread) => thread.id === threadId) ??
          makeThreadResponse({
            id: threadId,
            projectId: "proj",
            providerId: "acp-opencode",
            environmentId: null,
            status: threadId === "thr_root" ? "idle" : "active",
          }),
        list: () => options?.discovered ?? [],
        timeline: ({ threadId }) => ({
          rows: options?.prompts?.[threadId]
            ? [{ kind: "conversation", role: "user", text: options.prompts[threadId] }]
            : [],
        }),
        spawn: (args) => {
          spawnCalls += 1;
          prompts.push(args.prompt ?? "");
          return makeThreadResponse({
            id: "thr_spawned",
            parentThreadId: "thr_root",
            projectId: "proj",
            providerId: "acp-opencode",
            environmentId: null,
            status: "active",
          });
        },
        stop: ({ threadId }) => {
          stopped.push(threadId);
          return { ok: true };
        },
        update: ({ threadId }) => makeThreadResponse({ id: threadId }),
      },
    },
  });
  hosts.push(host);
  host.bb.storage.database().exec(`
    CREATE TABLE collab_agents (
      thread_id TEXT PRIMARY KEY,
      root_thread_id TEXT NOT NULL,
      parent_thread_id TEXT,
      task_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      display_name TEXT,
      item_id TEXT,
      role TEXT,
      source_thread_id TEXT,
      last_verify_hash TEXT,
      retired_at INTEGER,
      verify_fails INTEGER,
      last_nudge_at INTEGER,
      nudge_count INTEGER,
      report_status TEXT,
      report_evidence TEXT,
      report_item_id TEXT
    );
    CREATE TABLE collab_item_reservations (
      root_thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      claim_token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      slot_limit INTEGER NOT NULL,
      PRIMARY KEY (root_thread_id, item_id)
    );
    CREATE TABLE collab_root_worker_caps (
      root_thread_id TEXT PRIMARY KEY,
      max_workers INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TRIGGER collab_agents_root_capacity_insert
      BEFORE INSERT ON collab_agents
      WHEN NEW.retired_at IS NULL
        AND COALESCE(NEW.role, 'worker') != 'verifier'
        AND EXISTS (
          SELECT 1 FROM collab_root_worker_caps WHERE root_thread_id = NEW.root_thread_id
        )
        AND (
          (SELECT COUNT(*) FROM collab_agents
           WHERE root_thread_id = NEW.root_thread_id
             AND retired_at IS NULL
             AND COALESCE(role, 'worker') != 'verifier')
          +
          (SELECT COUNT(*) FROM collab_item_reservations
           WHERE root_thread_id = NEW.root_thread_id
             AND expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
             AND (NEW.item_id IS NULL OR item_id != NEW.item_id))
        ) >= (SELECT max_workers FROM collab_root_worker_caps
              WHERE root_thread_id = NEW.root_thread_id)
      BEGIN
        SELECT RAISE(ABORT, 'root worker capacity is full');
      END;
  `);
  return { host, stopped, prompts, spawnCalls: () => spawnCalls };
}

describe("scheduler-strict collaboration spawns", () => {
  it("fails closed before claim fallback when the requested item already has a worker", async () => {
    const state = collabHost();
    state.host.bb.storage.database().prepare(`
      INSERT INTO collab_agents (
        thread_id, root_thread_id, parent_thread_id, task_name, created_at,
        display_name, item_id, role
      ) VALUES ('thr_existing', 'thr_root', 'thr_root', '/root/existing', 1,
        'Existing worker', 'itm_held', 'worker')
    `).run();
    let claimCalls = 0;
    const collab = createCollabStore(state.host.bb, {
      claimItem: (_root, args) => {
        claimCalls += 1;
        return args.createIfMissing === false ? null : "itm_duplicate";
      },
    });

    const result = await collab.spawnWorker({
      parentThreadId: "thr_root",
      itemId: "itm_held",
      maxWorkers: 1,
      displayName: "Strict Scheduler",
      message: "SLICE (item_id=itm_held): repair the held work",
    });
    assert.ok("error" in result);
    assert.match(result.error, /already has a durable worker/);
    assert.equal(claimCalls, 0);
    assert.equal(state.spawnCalls(), 0);
    assert.equal(
      (state.host.bb.storage.database().prepare(
        "SELECT COUNT(*) AS n FROM collab_agents WHERE retired_at IS NULL",
      ).get() as { n: number }).n,
      1,
    );
  });

  it("retires and stops a spawned worker whose durable item differs from the request", async () => {
    const state = collabHost();
    state.host.bb.storage.database().exec(`
      CREATE TRIGGER rewrite_scheduler_item
      AFTER INSERT ON collab_agents
      WHEN NEW.thread_id = 'thr_spawned'
      BEGIN
        UPDATE collab_agents SET item_id = 'itm_wrong' WHERE thread_id = NEW.thread_id;
      END;
    `);
    const collab = createCollabStore(state.host.bb, {
      claimItem: (_root, args) => args.itemId,
    });

    const result = await collab.spawnWorker({
      parentThreadId: "thr_root",
      itemId: "itm_intended",
      maxWorkers: 1,
      displayName: "Claim Inspector",
      message: "SLICE (item_id=itm_intended): inspect the durable claim",
    });
    assert.ok("error" in result);
    assert.match(result.error, /did not retain scheduler item/);
    assert.equal(state.spawnCalls(), 1);
    assert.deepEqual(state.stopped, ["thr_spawned"]);
    const row = state.host.bb.storage.database().prepare(
      "SELECT item_id, retired_at FROM collab_agents WHERE thread_id = 'thr_spawned'",
    ).get() as { item_id: string | null; retired_at: number | null };
    assert.equal(row.item_id, null);
    assert.ok(row.retired_at);
  });

  it("does not convert a null strict claim back into the requested item", async () => {
    const state = collabHost();
    const collab = createCollabStore(state.host.bb, {
      claimItem: () => null,
    });

    const result = await collab.spawnWorker({
      parentThreadId: "thr_root",
      itemId: "itm_unclaimable",
      maxWorkers: 1,
      displayName: "Claim Refuser",
      message: "SLICE (item_id=itm_unclaimable): do not spawn without a claim",
    });
    assert.ok("error" in result);
    assert.match(result.error, /resolved to no item/);
    assert.equal(state.spawnCalls(), 0);
    assert.equal(
      (state.host.bb.storage.database().prepare(
        "SELECT COUNT(*) AS n FROM collab_item_reservations",
      ).get() as { n: number }).n,
      0,
      "failed claims must release the pre-spawn reservation",
    );
  });

  it("injects the full item dossier into the public verifier spawn path", async () => {
    const state = collabHost();
    const collab = createCollabStore(state.host.bb, {
      itemBrief: () => ({
        files: ["src/domain.ts"],
        check: "npm test -- domain",
        linkedDefects: "LINKED DEFECTS: fnd_public_verifier — full evidence and done-check",
      }),
    });
    collab.registerTools();

    const result = await state.host.harness.behavior.callAgentTool(
      "spawn_agent",
      {
        task_name: "verify_domain",
        item_id: "itm_domain",
        role: "verifier",
        message: "Verify the domain repair",
        fork_turns: "none",
      },
      { threadId: "thr_root", projectId: "proj" },
    );
    assert.equal(
      typeof result === "object" && result !== null && "isError" in result
        ? (result as { isError?: boolean }).isError
        : false,
      false,
    );
    assert.equal(state.prompts.length, 1);
    assert.match(state.prompts[0]!, /src\/domain\.ts/);
    assert.match(state.prompts[0]!, /npm test -- domain/);
    assert.match(state.prompts[0]!, /fnd_public_verifier/);
    assert.match(state.prompts[0]!, /DEFECT_COVERAGE/);
  });

  it("keeps structured item evidence available after the reporting row retires", () => {
    const state = collabHost();
    state.host.bb.storage.database().prepare(`
      INSERT INTO collab_agents (
        thread_id, root_thread_id, parent_thread_id, task_name, created_at,
        display_name, item_id, role
      ) VALUES ('thr_reporter', 'thr_root', 'thr_root', '/root/reporter', 1,
        'Evidence Keeper', 'itm_proven', 'worker')
    `).run();
    const collab = createCollabStore(state.host.bb);
    assert.equal(
      collab.setReport("thr_reporter", "done", "commit abc; test passed", [
        { findingId: "fnd_retired", proof: "regression test passed" },
      ]),
      true,
    );
    collab.forget("thr_reporter");

    assert.deepEqual(collab.findingEvidenceForItem("thr_root", "itm_proven"), [
      { findingId: "fnd_retired", proof: "regression test passed" },
    ]);
    const row = state.host.bb.storage.database().prepare(
      "SELECT item_id, report_item_id, retired_at FROM collab_agents WHERE thread_id='thr_reporter'",
    ).get() as { item_id: string | null; report_item_id: string | null; retired_at: number | null };
    assert.equal(row.item_id, null);
    assert.equal(row.report_item_id, "itm_proven");
    assert.ok(row.retired_at);
  });

  it("tombstones and stops a capacity-rejected discovered legacy child", async () => {
    const legacyChild = makeThreadResponse({
      id: "thr_legacy_b",
      parentThreadId: "thr_root",
      projectId: "proj",
      providerId: "acp-opencode",
      environmentId: null,
      status: "active",
      title: "Late legacy worker",
    });
    const state = collabHost({
      discovered: [legacyChild],
      prompts: { thr_legacy_b: "SLICE (item_id=itm_b): late old-generation work" },
    });
    const db = state.host.bb.storage.database();
    db.prepare(`
      INSERT INTO collab_root_worker_caps (root_thread_id, max_workers, updated_at)
      VALUES ('thr_root', 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO collab_agents (
        thread_id, root_thread_id, parent_thread_id, task_name, created_at,
        display_name, item_id, role
      ) VALUES ('thr_a', 'thr_root', 'thr_root', '/root/a', 1,
        'Worker A', 'itm_a', 'worker')
    `).run();
    const rejected: Array<{ threadId: string; itemId: string | null }> = [];
    const collab = createCollabStore(state.host.bb, {
      onRejectedChild: (_root, threadId, itemId) => rejected.push({ threadId, itemId }),
    });

    const listed = await collab.listForRoot("thr_root", { discover: true, refreshLimit: 8 });
    assert.deepEqual(listed.map((agent) => agent.threadId), ["thr_a"]);
    assert.deepEqual(state.stopped, ["thr_legacy_b"]);
    assert.deepEqual(rejected, [{ threadId: "thr_legacy_b", itemId: "itm_b" }]);
    const tombstone = db.prepare(`
      SELECT item_id, retired_at FROM collab_agents WHERE thread_id='thr_legacy_b'
    `).get() as { item_id: string | null; retired_at: number };
    assert.equal(tombstone.item_id, null);
    assert.ok(tombstone.retired_at > 0);

    await collab.listForRoot("thr_root", { discover: true, refreshLimit: 8 });
    assert.deepEqual(state.stopped, ["thr_legacy_b"], "the tombstone prevents repeated adoption");
  });
});

describe("fleet management tool surface", () => {
  it("exposes the levers an orchestrator needs to act on what it can see", () => {
    // It could describe a redundant worker on a stale base and had only
    // interrupt_agent, which ends a turn while keeping the slot and the
    // assignment — so the slice stayed in_progress and the queue stayed blocked.
    for (const name of ["release_slice", "retire_agent"]) {
      assert.ok(
        (COLLAB_TOOL_NAMES as readonly string[]).includes(name),
        `${name} must be registered for the orchestrator`,
      );
    }
  });

  it("keeps interrupt_agent, which is a different thing from giving work up", () => {
    assert.ok((COLLAB_TOOL_NAMES as readonly string[]).includes("interrupt_agent"));
  });
});
