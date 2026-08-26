import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  makeThreadResponse,
  type CreateFakePluginHostOptions,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { createFindingStore } from "./findings.ts";
import { createItemStore } from "./items.ts";
import { createItemReservationStore } from "./item-reservations.ts";

const hosts: FakePluginHost[] = [];

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.harness.lifecycle.dispose();
});

function registeredHost(sdk?: CreateFakePluginHostOptions["sdk"]) {
  const host = createFakePluginHost({
    pluginId: `ultragoal-tools-${hosts.length}`,
    agentSkillIds: ["ultragoal"],
    sdk,
  });
  hosts.push(host);
  // Keep this registration test isolated from the developer machine's
  // optional ~/.bb/plugins/goal legacy database import. A sentinel row makes
  // createGoalStore skip that one-time import while still running migrations.
  host.bb.storage.database().exec(`
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
  plugin(host.bb);
  return host;
}

function registeredTools() {
  const host = registeredHost();
  return new Map(
    host.harness.inspection.registrations.agentTools.map((tool) => [tool.name, tool]),
  );
}

describe("large-plan agent tool contracts", () => {
  it("accepts paged ultragoal_state reads and caps them at 100 rows", () => {
    const tool = registeredTools().get("ultragoal_state")!;
    assert.equal(tool.parse({}).ok, true);
    assert.equal(
      tool.parse({ plan_status: "completed", plan_cursor: 900, plan_limit: 100 }).ok,
      true,
    );
    assert.equal(tool.parse({ plan_limit: 101 }).ok, false);
  });

  it("accepts patch-style ultragoal_patch batches and rejects oversized calls", () => {
    const tool = registeredTools().get("ultragoal_patch")!;
    assert.equal(tool.parse({ plan: [], remove_item_ids: ["itm_old"] }).ok, true);
    const item = { step: "A self-contained scalable slice", status: "pending" };
    assert.equal(tool.parse({ plan: Array.from({ length: 200 }, () => item) }).ok, true);
    assert.equal(tool.parse({ plan: Array.from({ length: 201 }, () => item) }).ok, false);
  });

  const context = (providerId: string, threadId: string) => ({
    thread: { id: threadId, title: "UltraGoal root", parentThreadId: null, sourceThreadId: null },
    project: { id: "proj", kind: "standard" as const, name: "Project", gitRemoteUrl: null },
    environment: {
      id: "env",
      name: null,
      path: "/tmp/project",
      workspaceProvisionType: "unmanaged" as const,
      branchName: "main",
    },
    host: { id: "host", name: "Host" },
    provider: {
      id: providerId,
      model: providerId === "codex" ? "gpt-5.6-sol" : "openrouter/stealth/ox-alpha",
      capabilities: { supportsNativeUserQuestion: true },
    },
    origin: { kind: null, pluginId: null },
  });

  const isToolError = (result: unknown): boolean =>
    typeof result === "object" && result !== null && "isError" in result
      ? (result as { isError?: boolean }).isError === true
      : false;

  it("gives every provider only the canonical UltraGoal skill and root controls", async () => {
    const host = registeredHost();
    const canonical = ["ultragoal_start", "ultragoal_state", "ultragoal_patch", "ultragoal_finish"];
    const removed = ["create_goal", "get_goal", "update_plan", "update_goal"];
    const registered = new Set(
      host.harness.inspection.registrations.agentTools.map((tool) => tool.name),
    );
    for (const name of canonical) assert.ok(registered.has(name), `tool registry missing ${name}`);
    for (const name of removed) assert.ok(!registered.has(name), `tool registry still contains ${name}`);
    const providers = [
      ["codex", "thr_codex"],
      ["cursor", "thr_cursor"],
      ["acp-opencode", "thr_opencode"],
      ["claude-code", "thr_claude"],
      ["pi", "thr_pi"],
    ] as const;
    const configured = new Map<string, Awaited<ReturnType<typeof host.harness.behavior.resolveAgentConfiguration>>>();
    for (const [providerId, threadId] of providers) {
      const result = await host.harness.behavior.resolveAgentConfiguration(
        context(providerId, threadId),
      );
      configured.set(providerId, result);
      const names = result.tools.map((tool) => tool.name);
      for (const name of canonical) assert.ok(names.includes(name), `${providerId} missing ${name}`);
      assert.equal(result.skills.length, 1, `${providerId} missing the unified UltraGoal skill`);
      for (const name of removed) {
        assert.ok(!names.includes(name), `${providerId} must not receive removed control ${name}`);
      }
    }
    const codex = configured.get("codex")!;
    assert.equal(codex.instructions, null);
    assert.equal(
      (host.bb.storage.database().prepare(
        "SELECT COUNT(*) AS n FROM goals WHERE thread_id = 'thr_codex'",
      ).get() as { n: number }).n,
      0,
      "configuration alone must not create an UltraGoal",
    );
  });

  it("routes canonical start/state/patch/finish through the plugin database on Codex", async () => {
    const host = registeredHost();
    const started = await host.harness.behavior.callAgentTool(
      "ultragoal_start",
      { objective: "Prove canonical UltraGoal controls mutate only plugin state" },
      { threadId: "thr_codex" },
    );
    assert.equal(isToolError(started), false);
    const stored = host.bb.storage.database().prepare(
      "SELECT objective, status FROM goals WHERE thread_id = 'thr_codex'",
    ).get() as { objective: string; status: string };
    assert.equal(stored.objective, "Prove canonical UltraGoal controls mutate only plugin state");
    assert.equal(stored.status, "active");

    const patched = await host.harness.behavior.callAgentTool(
      "ultragoal_patch",
      {
        plan: [
          {
            step: "Canonical work",
            status: "pending",
            deps: [],
            files: ["src/canonical.ts"],
            check: "npm test",
          },
        ],
      },
      { threadId: "thr_codex" },
    );
    assert.equal(isToolError(patched), false);
    const itemCount = host.bb.storage.database()
      .prepare("SELECT COUNT(*) AS n FROM goal_items WHERE thread_id = 'thr_codex'")
      .get() as { n: number };
    assert.equal(itemCount.n, 1);

    const state = await host.harness.behavior.callAgentTool(
      "ultragoal_state",
      { plan_status: "all", plan_limit: 100 },
      { threadId: "thr_codex" },
    );
    assert.equal(isToolError(state), false);

    const premature = await host.harness.behavior.callAgentTool(
      "ultragoal_finish",
      {
        status: "complete",
        summary: "This deliberately premature summary must be rejected while canonical work remains open.",
      },
      { threadId: "thr_codex" },
    );
    assert.equal(isToolError(premature), true);
    const item = host.bb.storage.database()
      .prepare("SELECT id FROM goal_items WHERE thread_id = 'thr_codex'")
      .get() as { id: string };
    const completed = await host.harness.behavior.callAgentTool(
      "ultragoal_patch",
      { plan: [{ id: item.id, step: "Canonical work", status: "completed" }] },
      { threadId: "thr_codex" },
    );
    assert.equal(isToolError(completed), false);

    const finished = await host.harness.behavior.callAgentTool(
      "ultragoal_finish",
      {
        status: "complete",
        summary: "Canonical UltraGoal controls wrote the plugin database and passed the fake-host integration test.",
      },
      { threadId: "thr_codex" },
    );
    assert.equal(isToolError(finished), false);
    assert.equal(
      (host.bb.storage.database().prepare(
        "SELECT status FROM goals WHERE thread_id = 'thr_codex'",
      ).get() as { status: string }).status,
      "complete",
    );
  });

  it("reconstructs a transferred Codex root with canonical tools and live instructions", async () => {
    const host = registeredHost();
    host.bb.storage.database().prepare(
      "UPDATE goals SET thread_id = 'thr_target', status = 'active' WHERE thread_id = 'thr_sentinel'",
    ).run();
    const configured = await host.harness.behavior.resolveAgentConfiguration(
      context("codex", "thr_target"),
    );
    const names = configured.tools.map((tool) => tool.name);
    assert.ok(names.includes("ultragoal_start"));
    assert.ok(names.includes("ultragoal_state"));
    assert.ok(names.includes("ultragoal_patch"));
    assert.ok(names.includes("ultragoal_finish"));
    assert.ok(!names.includes("create_goal"));
    assert.ok(!names.includes("get_goal"));
    assert.ok(!names.includes("update_plan"));
    assert.ok(!names.includes("update_goal"));
    assert.equal(configured.skills.length, 1);
    assert.match(configured.instructions ?? "", /canonical ultragoal_\* controls/);
  });

  it("audits stale finding links on the first startup pulse", async () => {
    const host = registeredHost();
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE goals SET thread_id = 'thr_startup', status = 'paused' WHERE thread_id = 'thr_sentinel'",
    ).run();
    const items = createItemStore(host.bb);
    const findings = createFindingStore(host.bb);
    const item = items.add(
      "thr_startup",
      "Repair segment ownership in schema/src/segments.ts",
      "pending",
      { files: ["schema/src/segments.ts", "schema/migrations/generated"] },
    )!;
    const primary = findings.report("thr_startup", {
      title: "Segment baseline defect",
      file: "schema/migrations/generated/0041_baseline.sql:91",
      evidence: "The generated baseline exposes a source-model defect.",
      fixFiles: ["schema/migrations/generated"],
    }).finding;
    const stale = findings.report("thr_startup", {
      title: "Unrelated tenant foreign-key defect",
      file: "schema/migrations/generated",
      evidence: "A broad migration directory was incorrectly coalesced later.",
      fixFiles: ["schema/migrations/generated"],
    }).finding;
    db.prepare("UPDATE goal_findings SET created_at = ? WHERE id = ?").run(1, primary.id);
    db.prepare("UPDATE goal_findings SET created_at = ? WHERE id = ?").run(2, stale.id);
    assert.equal(findings.linkItem("thr_startup", primary.id, item.id), true);
    assert.equal(findings.linkItem("thr_startup", stale.id, item.id), true);

    const service = host.harness.behavior.runService("progress-pulse");
    service.controller.abort();
    await service.done;

    assert.equal(findings.get("thr_startup", primary.id)!.itemId, item.id);
    const repairedItemId = findings.get("thr_startup", stale.id)!.itemId;
    assert.ok(repairedItemId);
    assert.notEqual(repairedItemId, item.id);
    assert.equal(items.list("thr_startup").length, 2);
  });

  it("retains an active durable worker across reload before scheduling new backlog work", async () => {
    let spawnCalls = 0;
    const host = registeredHost({
      threads: {
        get: async ({ threadId }) => makeThreadResponse({
          id: threadId,
          projectId: "proj",
          providerId: "acp-opencode",
          environmentId: null,
          status: "active",
          parentThreadId: threadId === "thr_existing_worker" ? "thr_reload" : null,
        }),
        list: () => [],
        spawn: () => {
          spawnCalls += 1;
          return makeThreadResponse({ id: `thr_unexpected_${spawnCalls}` });
        },
        update: ({ threadId }) => makeThreadResponse({ id: threadId }),
        send: () => ({ ok: true }),
      },
    });
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE goals SET thread_id = 'thr_reload', status = 'active', max_workers = 1 WHERE thread_id = 'thr_sentinel'",
    ).run();
    const items = createItemStore(host.bb);
    const held = items.add(
      "thr_reload",
      "Repair the already-running reload-safe slice",
      "in_progress",
      { files: ["src/held.ts"], check: "npm test -- held" },
    )!;
    db.prepare("UPDATE goal_items SET updated_at = 1 WHERE id = ?").run(held.id);
    db.prepare(`
      INSERT INTO collab_agents (
        thread_id, root_thread_id, parent_thread_id, task_name, created_at,
        display_name, item_id, role
      ) VALUES ('thr_existing_worker', 'thr_reload', 'thr_reload', '/root/existing', 1,
        'Reload Keeper', ?, 'worker')
    `).run(held.id);

    const reloaded = await host.harness.lifecycle.reload(plugin);
    hosts.push(reloaded);
    const reported = await reloaded.harness.behavior.callAgentTool(
      "report_finding",
      {
        title: "A separate reload defect needs work",
        file: "src/new-reload-defect.ts:10",
        evidence: "The separate defect is real and should wait behind the retained worker.",
        fix_files: ["src/new-reload-defect.ts"],
        check: "npm test -- reload-defect",
      },
      { threadId: "thr_reload" },
    );
    assert.equal(isToolError(reported), false);
    for (let index = 0; index < 6; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const liveDb = reloaded.bb.storage.database();
    assert.equal(spawnCalls, 0, "cold-cache scheduling must not spawn over a live owner");
    assert.equal(
      (liveDb.prepare("SELECT COUNT(*) AS n FROM goal_items WHERE thread_id = 'thr_reload'").get() as { n: number }).n,
      2,
      "only the held item and the newly minted remediation item should exist",
    );
    const agents = liveDb.prepare(`
      SELECT thread_id, item_id FROM collab_agents
      WHERE root_thread_id = 'thr_reload' AND retired_at IS NULL
    `).all() as Array<{ thread_id: string; item_id: string | null }>;
    assert.deepEqual(agents, [{ thread_id: "thr_existing_worker", item_id: held.id }]);
    assert.equal(
      (liveDb.prepare("SELECT status FROM goal_items WHERE id = ?").get(held.id) as { status: string }).status,
      "in_progress",
    );
    assert.ok(
      reloaded.harness.inspection.sdk.callsTo("threads.get").some(
        (call) => (call[0] as { threadId?: string }).threadId === "thr_existing_worker",
      ),
      "reload hydration must refresh the durable holder",
    );
  });

  it("rolls a failed real scheduler spawn back to pending and releases its reservation", async () => {
    let spawnCalls = 0;
    const host = registeredHost({
      threads: {
        get: ({ threadId }) => makeThreadResponse({
          id: threadId,
          projectId: "proj",
          providerId: "acp-opencode",
          environmentId: null,
          status: "idle",
        }),
        list: () => [],
        spawn: () => {
          spawnCalls += 1;
          throw new Error("forced external spawn failure");
        },
        update: ({ threadId }) => makeThreadResponse({ id: threadId }),
      },
    });
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE goals SET thread_id='thr_spawn_fail', status='active', max_workers=1 WHERE thread_id='thr_sentinel'",
    ).run();

    const result = await host.harness.behavior.callAgentTool(
      "ultragoal_patch",
      {
        plan: [{
          step: "Exercise scheduler rollback after failed spawn",
          status: "pending",
          deps: [],
          files: ["src/spawn-failure.ts"],
          check: "npm test -- spawn-failure",
        }],
      },
      { threadId: "thr_spawn_fail" },
    );
    assert.equal(isToolError(result), false);
    for (let index = 0; index < 8; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(spawnCalls, 1);
    assert.equal(
      (db.prepare(
        "SELECT status FROM goal_items WHERE thread_id='thr_spawn_fail'",
      ).get() as { status: string }).status,
      "pending",
    );
    assert.equal(
      (db.prepare(
        "SELECT COUNT(*) AS n FROM collab_item_reservations WHERE root_thread_id='thr_spawn_fail'",
      ).get() as { n: number }).n,
      0,
    );
    assert.equal(
      (db.prepare(
        "SELECT COUNT(*) AS n FROM collab_agents WHERE root_thread_id='thr_spawn_fail' AND retired_at IS NULL",
      ).get() as { n: number }).n,
      0,
    );
  });

  it("stops and tombstones a legacy child that returns after the root slot commits", async () => {
    const stopped: string[] = [];
    let legacyPrompt = "";
    const legacyChild = makeThreadResponse({
      id: "thr_late_legacy_b",
      parentThreadId: "thr_capacity_root",
      projectId: "proj",
      providerId: "acp-opencode",
      environmentId: null,
      status: "active",
      title: "Late legacy B",
    });
    const host = registeredHost({
      threads: {
        get: ({ threadId }) =>
          threadId === legacyChild.id
            ? legacyChild
            : makeThreadResponse({
                id: threadId,
                projectId: "proj",
                providerId: "acp-opencode",
                environmentId: null,
                status: "idle",
              }),
        list: () => [legacyChild],
        timeline: ({ threadId }) => ({
          rows: threadId === legacyChild.id
            ? [{
                kind: "conversation",
                role: "user",
                text: legacyPrompt,
              }]
            : [],
        }),
        output: () => ({ output: null }),
        stop: ({ threadId }) => {
          stopped.push(threadId);
          return { ok: true };
        },
        update: ({ threadId }) => makeThreadResponse({ id: threadId }),
        interactions: { list: async () => [] },
      },
    });
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE goals SET thread_id='thr_capacity_root', status='active', max_workers=1 WHERE thread_id='thr_sentinel'",
    ).run();
    const items = createItemStore(host.bb);
    const itemA = items.add(
      "thr_capacity_root",
      "Current generation item A",
      "in_progress",
      { files: ["src/a.ts"] },
    )!;
    const itemB = items.add(
      "thr_capacity_root",
      "Old generation item B",
      "in_progress",
      { files: ["src/b.ts"] },
    )!;
    legacyPrompt = `SLICE (item_id=${itemB.id}): old generation B`;
    const reservations = createItemReservationStore(db);
    const token = reservations.acquire("thr_capacity_root", itemA.id, 1);
    assert.ok(token);
    assert.equal(
      reservations.commit("thr_capacity_root", itemA.id, token, () => {
        db.prepare(`
          INSERT INTO collab_agents (
            thread_id, root_thread_id, parent_thread_id, task_name, created_at,
            display_name, item_id, role
          ) VALUES (
            'thr_current_a', 'thr_capacity_root', 'thr_capacity_root', '/root/a', 1,
            'Current A', ?, 'worker'
          )
        `).run(itemA.id);
      }),
      true,
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO collab_agents (
          thread_id, root_thread_id, parent_thread_id, task_name, created_at,
          display_name, item_id, role
        ) VALUES (
          'thr_late_legacy_b', 'thr_capacity_root', 'thr_capacity_root', '/root/b', 2,
          'Legacy B', ?, 'worker'
        )
      `).run(itemB.id),
      /root worker capacity is full/,
    );

    await host.harness.behavior.emitThreadEvent("thread.active", { thread: legacyChild });
    for (let index = 0; index < 6; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    assert.deepEqual(stopped, ["thr_late_legacy_b"]);
    assert.equal(items.list("thr_capacity_root").find((item) => item.id === itemB.id)!.status, "pending");
    assert.deepEqual(
      db.prepare(`
        SELECT thread_id, item_id FROM collab_agents
        WHERE root_thread_id='thr_capacity_root' AND retired_at IS NULL
        ORDER BY thread_id
      `).all(),
      [{ thread_id: "thr_current_a", item_id: itemA.id }],
    );
    const tombstone = db.prepare(`
      SELECT item_id, retired_at FROM collab_agents WHERE thread_id='thr_late_legacy_b'
    `).get() as { item_id: string | null; retired_at: number };
    assert.equal(tombstone.item_id, null);
    assert.ok(tombstone.retired_at > 0);
  });

  it("repairs stale generated-migration links before ultragoal_patch completion checks", async () => {
    const host = registeredHost();
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE goals SET thread_id='thr_patch_repair', status='active', max_workers=0 WHERE thread_id='thr_sentinel'",
    ).run();
    const items = createItemStore(host.bb);
    const findings = createFindingStore(host.bb);
    const item = items.add(
      "thr_patch_repair",
      "Repair tax-rate domain behavior in schema/src/tax-rates.ts",
      "in_progress",
      { files: ["schema/src/tax-rates.ts"] },
    )!;
    const primary = findings.report("thr_patch_repair", {
      title: "Tax-rate primary defect",
      file: "schema/src/tax-rates.ts:10",
      evidence: "The domain source created this work item.",
      fixFiles: ["schema/src/tax-rates.ts"],
    }).finding;
    const stale = findings.report("thr_patch_repair", {
      title: "Unrelated tenant foreign-key defect",
      file: "schema/migrations/generated/0001_baseline.sql:30655",
      evidence: "A monolithic generated baseline line was falsely coalesced.",
      fixFiles: ["schema/migrations/generated/0001_baseline.sql"],
    }).finding;
    db.prepare("UPDATE goal_findings SET created_at=1 WHERE id=?").run(primary.id);
    db.prepare("UPDATE goal_findings SET created_at=2 WHERE id=?").run(stale.id);
    assert.equal(findings.linkItem("thr_patch_repair", primary.id, item.id), true);
    assert.equal(findings.linkItem("thr_patch_repair", stale.id, item.id), true);
    assert.equal(
      findings.resolve("thr_patch_repair", primary.id, "fixed", "primary fixed with proof")!.status,
      "fixed",
    );

    const result = await host.harness.behavior.callAgentTool(
      "ultragoal_patch",
      { plan: [{ id: item.id, step: item.step, status: "completed" }] },
      { threadId: "thr_patch_repair" },
    );
    assert.equal(isToolError(result), false);
    assert.equal(items.list("thr_patch_repair").find((entry) => entry.id === item.id)!.status, "completed");
    const repaired = findings.get("thr_patch_repair", stale.id)!;
    assert.equal(repaired.status, "open");
    assert.notEqual(repaired.itemId, item.id);
  });

  it("puts every coalesced defect in worker and verifier briefs and rejects partial evidence", async () => {
    const prompts: string[] = [];
    let spawnCount = 0;
    const host = registeredHost({
      threads: {
        get: async ({ threadId }) => makeThreadResponse({
          id: threadId,
          projectId: "proj",
          providerId: "acp-opencode",
          environmentId: null,
          status: threadId === "thr_brief" ? "idle" : "idle",
          parentThreadId: threadId.startsWith("thr_worker") ? "thr_brief" : null,
        }),
        list: () => [],
        spawn: (args) => {
          prompts.push(args.prompt ?? "");
          spawnCount += 1;
          return makeThreadResponse({
            id: spawnCount === 1 ? "thr_worker_brief" : "thr_verifier_brief",
            projectId: "proj",
            providerId: "acp-opencode",
            environmentId: null,
            parentThreadId: "thr_brief",
            status: "active",
          });
        },
        update: ({ threadId }) => makeThreadResponse({ id: threadId }),
        output: () => ({ output: "Worker finished the linked remediation." }),
        send: () => ({ ok: true }),
        timeline: () => ({ rows: [] }),
        interactions: { list: async () => [] },
      },
    });
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE goals SET thread_id = 'thr_brief', status = 'active', max_workers = 1, verify_enabled = 1 WHERE thread_id = 'thr_sentinel'",
    ).run();
    const items = createItemStore(host.bb);
    const findings = createFindingStore(host.bb);
    const item = items.add(
      "thr_brief",
      "Repair downgrade and actor provenance together",
      "pending",
      { files: ["src/subscriptions.ts"], check: "npm test -- subscriptions" },
    )!;
    const first = findings.report("thr_brief", {
      title: "Downgrade drops the original actor",
      file: "src/subscriptions.ts:91",
      evidence: "Downgrade overwrites actor provenance before the audit insert.",
      fixFiles: ["src/subscriptions.ts"],
      check: "npm test -- downgrade",
    }).finding;
    const second = findings.report("thr_brief", {
      title: "Audit rows omit actor provenance",
      file: "src/subscriptions.ts:118",
      evidence: "The persisted audit row has a null actor for an authenticated request.",
      fixFiles: ["src/subscriptions.ts"],
      check: "npm test -- actor-provenance",
    }).finding;
    assert.equal(findings.linkItem("thr_brief", first.id, item.id), true);
    assert.equal(findings.linkItem("thr_brief", second.id, item.id), true);

    await host.harness.behavior.callAgentTool(
      "report_finding",
      {
        title: "Separate trigger defect",
        file: "src/scheduler-trigger.ts:1",
        evidence: "This separate item triggers a scheduler pass after both links exist.",
        fix_files: ["src/scheduler-trigger.ts"],
      },
      { threadId: "thr_brief" },
    );
    for (let index = 0; index < 6; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(prompts.length, 1);
    for (const finding of [first, second]) {
      assert.match(prompts[0]!, new RegExp(finding.id));
      assert.match(prompts[0]!, new RegExp(finding.title));
      assert.match(prompts[0]!, new RegExp(finding.file));
      assert.match(prompts[0]!, new RegExp(finding.evidence));
    }
    assert.match(prompts[0]!, /slice_done must satisfy every linked defect/i);

    const negativeProse = await host.harness.behavior.callAgentTool(
      "slice_done",
      {
        evidence: `commit abc123; ${first.id} is NOT fixed and ${second.id} check failed`,
        finding_evidence: [],
      },
      { threadId: "thr_worker_brief" },
    );
    assert.equal(isToolError(negativeProse), true);

    const partial = await host.harness.behavior.callAgentTool(
      "slice_done",
      {
        evidence: "commit abc123; npm test -- downgrade passed",
        finding_evidence: [
          { finding_id: first.id, proof: "downgrade regression passed" },
        ],
      },
      { threadId: "thr_worker_brief" },
    );
    assert.equal(isToolError(partial), true);
    assert.match(JSON.stringify(partial), new RegExp(second.id));
    const complete = await host.harness.behavior.callAgentTool(
      "slice_done",
      {
        evidence: "commit abc123; npm test -- subscriptions passed",
        finding_evidence: [
          { finding_id: first.id, proof: "downgrade regression passed" },
          { finding_id: second.id, proof: "actor provenance regression passed" },
        ],
      },
      { threadId: "thr_worker_brief" },
    );
    assert.equal(isToolError(complete), false);

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thr_worker_brief",
        projectId: "proj",
        providerId: "acp-opencode",
        environmentId: null,
        parentThreadId: "thr_brief",
        status: "idle",
      }),
      lastAssistantText: "Worker finished and called slice_done.",
    });
    assert.equal(
      prompts.length,
      2,
      JSON.stringify({
        logs: host.harness.inspection.logEntries,
        calls: host.harness.inspection.sdk.calls.map((call) => call.path),
      }),
    );
    for (const [finding, check] of [
      [first, "npm test -- downgrade"],
      [second, "npm test -- actor-provenance"],
    ] as const) {
      assert.match(prompts[1]!, new RegExp(finding.id));
      assert.match(prompts[1]!, new RegExp(finding.evidence));
      assert.match(prompts[1]!, new RegExp(check));
    }
    assert.match(prompts[1]!, /DEFECT_COVERAGE/);
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thr_verifier_brief",
        projectId: "proj",
        providerId: "acp-opencode",
        environmentId: null,
        parentThreadId: "thr_brief",
        status: "idle",
      }),
      lastAssistantText: [
        `DEFECT_COVERAGE: {"finding_id":"${first.id}","status":"pass","proof":"downgrade check passed"}`,
        `DEFECT_COVERAGE: {"finding_id":"${second.id}","status":"pass","proof":"actor provenance check passed"}`,
        "VERIFY_PASS: initially looked good",
        "VERIFY_FAIL: contradictory trailing verdict",
      ].join("\n"),
    });
    assert.equal(
      items.list("thr_brief").find((entry) => entry.id === item.id)!.status,
      "in_progress",
      "ambiguous verifier output must not complete the work item",
    );
    assert.equal(
      (db.prepare(
        "SELECT last_verify_hash FROM collab_agents WHERE thread_id='thr_worker_brief'",
      ).get() as { last_verify_hash: string | null }).last_verify_hash,
      null,
      "an invalid verifier verdict must not suppress replacement verification",
    );
    let verifierRetries = host.harness.inspection.sdk.callsTo("threads.send").filter(
      (call) => (call[0] as { threadId?: string }).threadId === "thr_verifier_brief",
    );
    assert.equal(verifierRetries.length, 1);
    assert.match(JSON.stringify(verifierRetries[0]), /missing, malformed, or ambiguous/i);

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thr_verifier_brief",
        projectId: "proj",
        providerId: "acp-opencode",
        environmentId: null,
        parentThreadId: "thr_brief",
        status: "idle",
      }),
      lastAssistantText: [
        `DEFECT_COVERAGE: {"finding_id":"${first.id}","status":"pass","proof":"downgrade check passed"}`,
        `${second.id} is NOT fixed; check failed`,
        "VERIFY_PASS: stale verifier thought the old scope passed",
      ].join("\n"),
    });
    assert.equal(
      items.list("thr_brief").find((entry) => entry.id === item.id)!.status,
      "in_progress",
      "a stale verifier pass must not close newly linked scope",
    );
    assert.equal(
      (db.prepare(
        "SELECT last_verify_hash FROM collab_agents WHERE thread_id='thr_worker_brief'",
      ).get() as { last_verify_hash: string | null }).last_verify_hash,
      null,
      "invalid verifier coverage must not suppress replacement verification",
    );
    verifierRetries = host.harness.inspection.sdk.callsTo("threads.send").filter(
      (call) => (call[0] as { threadId?: string }).threadId === "thr_verifier_brief",
    );
    assert.equal(verifierRetries.length, 2);
    assert.match(JSON.stringify(verifierRetries[1]), new RegExp(second.id));

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thr_verifier_brief",
        projectId: "proj",
        providerId: "acp-opencode",
        environmentId: null,
        parentThreadId: "thr_brief",
        status: "idle",
      }),
      lastAssistantText: [
        `DEFECT_COVERAGE: {"finding_id":"${first.id}","status":"pass","proof":"downgrade check passed"}`,
        `DEFECT_COVERAGE: {"finding_id":"${second.id}","status":"pass","proof":"actor provenance check passed"}`,
        "VERIFY_PASS: all current linked defects passed",
      ].join("\n"),
    });
    assert.equal(items.list("thr_brief").find((entry) => entry.id === item.id)!.status, "completed");
    assert.equal(findings.get("thr_brief", first.id)!.status, "fixed");
    assert.equal(findings.get("thr_brief", second.id)!.status, "fixed");
    // The event deliberately publishes/steers through fire-and-forget hooks;
    // let those bounded promises settle before the fake database is disposed.
    for (let index = 0; index < 8; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });

  it("bounds invalid verifier protocol retries and leaves the item open for root handoff", async () => {
    const host = registeredHost({
      threads: {
        get: ({ threadId }) => makeThreadResponse({
          id: threadId,
          projectId: "proj",
          providerId: "acp-opencode",
          environmentId: null,
          parentThreadId: threadId === "thr_protocol_root" ? null : "thr_protocol_root",
          status: "idle",
        }),
        list: () => [],
        send: () => ({ ok: true }),
        stop: () => ({ ok: true }),
        output: () => ({ output: "Worker claims completion." }),
        timeline: () => ({ rows: [] }),
        interactions: { list: async () => [] },
      },
    });
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE goals SET thread_id='thr_protocol_root', status='active', max_workers=1, verify_enabled=1, auto_continue=1 WHERE thread_id='thr_sentinel'",
    ).run();
    const item = createItemStore(host.bb).add(
      "thr_protocol_root",
      "Keep malformed verifier output from stranding this work",
      "in_progress",
      { files: ["src/protocol.ts"] },
    )!;
    db.prepare(`
      INSERT INTO collab_agents (
        thread_id, root_thread_id, parent_thread_id, task_name, created_at,
        display_name, item_id, role, source_thread_id, last_verify_hash
      ) VALUES
        ('thr_protocol_worker', 'thr_protocol_root', 'thr_protocol_root', '/root/protocol', 10,
          'Protocol worker', ?, 'worker', NULL, 'stale-digest'),
        ('thr_protocol_verifier', 'thr_protocol_root', 'thr_protocol_root', '/root/protocol/verifier', 11,
          'Protocol verifier', ?, 'verifier', 'thr_protocol_worker', NULL)
    `).run(item.id, item.id);

    const malformedIdle = {
      thread: makeThreadResponse({
        id: "thr_protocol_verifier",
        projectId: "proj",
        providerId: "acp-opencode",
        environmentId: null,
        parentThreadId: "thr_protocol_root",
        status: "idle",
      }),
      lastAssistantText: "I inspected the work but omitted the required final verdict.",
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await host.harness.behavior.emitThreadEvent("thread.idle", malformedIdle);
    }
    for (let index = 0; index < 8; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    assert.equal(
      createItemStore(host.bb).list("thr_protocol_root").find((entry) => entry.id === item.id)!.status,
      "in_progress",
    );
    const workerState = db.prepare(
      "SELECT verify_fails, last_verify_hash FROM collab_agents WHERE thread_id='thr_protocol_worker'",
    ).get() as { verify_fails: number; last_verify_hash: string | null };
    assert.equal(workerState.verify_fails, 3);
    assert.equal(workerState.last_verify_hash, null);
    assert.notEqual(
      (db.prepare(
        "SELECT retired_at FROM collab_agents WHERE thread_id='thr_protocol_verifier'",
      ).get() as { retired_at: number | null }).retired_at,
      null,
    );
    const sends = host.harness.inspection.sdk.callsTo("threads.send");
    assert.equal(
      sends.filter((call) => (call[0] as { threadId?: string }).threadId === "thr_protocol_verifier").length,
      2,
      "the third protocol failure must hit the durable cap instead of retrying forever",
    );
    assert.ok(
      sends.some((call) => (call[0] as { threadId?: string }).threadId === "thr_protocol_root"),
      "the root must be awakened after the retry budget is exhausted",
    );
  });
});
