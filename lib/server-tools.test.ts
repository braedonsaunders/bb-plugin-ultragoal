import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { createFindingStore } from "./findings.ts";
import { createItemStore } from "./items.ts";

const hosts: FakePluginHost[] = [];

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.harness.lifecycle.dispose();
});

function registeredHost() {
  const host = createFakePluginHost({
    pluginId: `ultragoal-tools-${hosts.length}`,
    agentSkillIds: ["ultragoal"],
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
});
