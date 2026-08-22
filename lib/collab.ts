import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { GoalAgent, GoalAgentRole, GoalAgentStatus } from "../contract.js";
import { nextAuditorName, nextHumorousName, slugFromName } from "./names.js";

const MIN_WAIT_TIMEOUT_MS = 1_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_WAIT_TIMEOUT_MS = 600_000;

const SPAWN_AGENT_DESCRIPTION = `
        Spawns an agent to work on the specified task. If your current task is \`/root/task1\` and you spawn_agent with task_name "task_3" the agent will have canonical task name \`/root/task1/task_3\`.
You are then able to refer to this agent as \`task_3\` or \`/root/task1/task_3\` interchangeably. However an agent \`/root/task2/task_3\` would only be able to communicate with this agent via its canonical name \`/root/task1/task_3\`.
The spawned agent will have the same tools as you and the ability to spawn its own subagents.
This is the default way Goal work gets done. The root thread is the orchestrator; spawn one worker per in-progress slice, several in one turn. Do not implement those slices on the root.
Give every worker a short humorous display_name (for example "Sir Syncs-a-Lot") and pass item_id from get_goal so they nest under that Now task.
When verification is on, a separate verifier is launched after each worker returns. Do not mark that slice complete until the verifier reports VERIFY_PASS.
It will be able to send you and other running agents messages, and its final answer will be provided to you when it finishes.
The new agent's canonical task name will be provided to it along with the message.

Note that passing \`fork_turns="none"\` will not pass any surrounding context to the spawned subagent, which may cause the agent to lack the context it needs to complete its task, whereas \`fork_turns="all"\` will provide the subagent with all surrounding context.`;

type AgentStatus =
  | "pending_init"
  | "running"
  | "interrupted"
  | "shutdown"
  | "not_found"
  | { completed: string | null }
  | { errored: string };

interface CollabRow {
  thread_id: string;
  root_thread_id: string;
  parent_thread_id: string | null;
  task_name: string;
  created_at: number;
  display_name: string | null;
  item_id: string | null;
  role: GoalAgentRole | null;
  source_thread_id: string | null;
  last_verify_hash: string | null;
}

function needsHumorousName(name: string | null | undefined): boolean {
  const value = name?.trim() ?? "";
  if (!value) return true;
  if (/^thr_[a-z0-9]+$/i.test(value)) return true;
  if (/^[a-z0-9_]+$/.test(value)) return true;
  if (/^(new thread|subagent|agent|background agent|child thread|worker)$/i.test(value)) return true;
  return false;
}

function nicknameOf(taskName: string, fallback?: string | null): string {
  const leaf = taskName.split("/").filter(Boolean).at(-1);
  return fallback?.trim() || leaf || taskName;
}

function mapThreadStatus(status: string | undefined, output?: string | null): {
  status: GoalAgentStatus;
  summary: string | null;
} {
  if (status === "active") return { status: "running", summary: null };
  if (status === "starting" || status === "provisioning") return { status: "starting", summary: null };
  if (status === "stopping") return { status: "stopped", summary: null };
  if (status === "error") return { status: "error", summary: "Turn error" };
  if (status === "idle") {
    const summary = output?.trim() ? output.trim().slice(0, 160) : null;
    return { status: summary ? "completed" : "idle", summary };
  }
  return { status: "unknown", summary: null };
}

export function createCollabStore(
  bb: BbPluginApi,
  hooks?: {
    onChange?: (rootThreadId: string) => void;
    nextItemId?: (rootThreadId: string) => string | null;
  },
) {
  const db = bb.storage.database();
  const insert = db.prepare(`
    INSERT INTO collab_agents (
      thread_id, root_thread_id, parent_thread_id, task_name, created_at, display_name, item_id,
      role, source_thread_id, last_verify_hash
    )
    VALUES (
      @thread_id, @root_thread_id, @parent_thread_id, @task_name, @created_at, @display_name, @item_id,
      @role, @source_thread_id, @last_verify_hash
    )
  `);
  const setMeta = db.prepare(`
    UPDATE collab_agents
    SET display_name = COALESCE(@display_name, display_name),
        item_id = COALESCE(@item_id, item_id)
    WHERE thread_id = @thread_id
  `);
  const byThread = db.prepare("SELECT * FROM collab_agents WHERE thread_id = ?");
  const byRoot = db.prepare("SELECT * FROM collab_agents WHERE root_thread_id = ?");
  const byName = db.prepare(
    "SELECT * FROM collab_agents WHERE root_thread_id = ? AND task_name = ?",
  );
  const bySource = db.prepare(
    "SELECT * FROM collab_agents WHERE source_thread_id = ? AND role = 'verifier'",
  );
  const setHash = db.prepare(
    "UPDATE collab_agents SET last_verify_hash = @last_verify_hash WHERE thread_id = @thread_id",
  );

  function rowOf(threadId: string): CollabRow | null {
    return (byThread.get(threadId) as CollabRow | undefined) ?? null;
  }

  function rootId(threadId: string): string {
    return rowOf(threadId)?.root_thread_id ?? threadId;
  }

  function canonicalName(threadId: string): string {
    return rowOf(threadId)?.task_name ?? "/root";
  }

  function resolve(fromThreadId: string, target: string): CollabRow | null {
    const root = rootId(fromThreadId);
    const exact = byName.get(root, target) as CollabRow | undefined;
    if (exact) return exact;
    const byId = byThread.get(target) as CollabRow | undefined;
    if (byId && byId.root_thread_id === root) return byId;
    const suffix = `/${target.replace(/^\/+/, "")}`;
    const match = (byRoot.all(root) as CollabRow[]).find(
      (row) => row.task_name === target || row.task_name.endsWith(suffix),
    );
    return match ?? null;
  }

  async function statusOf(threadId: string): Promise<AgentStatus> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.status === "active" || thread.status === "starting") return "running";
      if (thread.status === "stopping") return "interrupted";
      if (thread.status === "error") {
        return { errored: "Turn error" };
      }
      if (thread.status === "idle") {
        const output = await bb.sdk.threads.output({ threadId }).catch(() => ({ output: null }));
        return { completed: output.output ?? null };
      }
      return "shutdown";
    } catch {
      return "not_found";
    }
  }

  async function discoverChildren(root: string): Promise<
    Array<{
      id: string;
      title: string | null;
      titleFallback: string | null;
      parentThreadId: string | null;
      createdAt: number;
    }>
  > {
    const found = new Map<
      string,
      {
        id: string;
        title: string | null;
        titleFallback: string | null;
        parentThreadId: string | null;
        createdAt: number;
      }
    >();
    const take = (
      children: Array<{
        id: string;
        title: string | null;
        titleFallback: string | null;
        parentThreadId: string | null;
        createdAt: number;
      }>,
    ) => {
      for (const child of children) {
        if (child.id === root) continue;
        found.set(child.id, child);
      }
    };
    try {
      take(
        await bb.sdk.threads.list({
          parentThreadId: root,
          includeHidden: true,
          limit: 80,
        }),
      );
    } catch {
      // parent filter is best-effort
    }
    try {
      const rootThread = await bb.sdk.threads.get({ threadId: root });
      if (rootThread.projectId) {
        const listed = await bb.sdk.threads.list({
          projectId: rootThread.projectId,
          includeHidden: true,
          hasParent: true,
          limit: 200,
        });
        const tree = new Set<string>([root, ...found.keys()]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const child of listed) {
            if (!child.parentThreadId || tree.has(child.id)) continue;
            if (!tree.has(child.parentThreadId)) continue;
            tree.add(child.id);
            found.set(child.id, child);
            grew = true;
          }
        }
      }
    } catch {
      // Project-wide listing is a fallback for hidden native children.
    }
    return [...found.values()];
  }

  async function listForRoot(threadId: string): Promise<GoalAgent[]> {
    const root = rootId(threadId);
    const rows = byRoot.all(root) as CollabRow[];
    const seen = new Set(rows.map((row) => row.thread_id));
    const extras: CollabRow[] = [];
    try {
      const children = await discoverChildren(root);
      for (const child of children) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        const extra: CollabRow = {
          thread_id: child.id,
          root_thread_id: root,
          parent_thread_id: child.parentThreadId ?? root,
          task_name: child.title || child.titleFallback || child.id,
          created_at: child.createdAt ?? 0,
          display_name: child.title || child.titleFallback || null,
          item_id: null,
          role: "worker",
          source_thread_id: null,
          last_verify_hash: null,
        };
        extras.push(extra);
        try {
          insert.run({
            thread_id: extra.thread_id,
            root_thread_id: extra.root_thread_id,
            parent_thread_id: extra.parent_thread_id,
            task_name: extra.task_name,
            created_at: extra.created_at,
            display_name: extra.display_name,
            item_id: extra.item_id,
            role: extra.role,
            source_thread_id: extra.source_thread_id,
            last_verify_hash: extra.last_verify_hash,
          });
        } catch {
          // Row may already exist from a concurrent spawn.
        }
      }
    } catch {
      // Listing children is best-effort; collab rows still render.
    }

    const usedNames = new Set(
      [...rows, ...extras]
        .map((row) => row.display_name?.trim())
        .filter((name): name is string => Boolean(name)),
    );
    for (const row of [...rows, ...extras]) {
      if (!needsHumorousName(row.display_name)) continue;
      const displayName = nextHumorousName(usedNames);
      usedNames.add(displayName);
      row.display_name = displayName;
      setMeta.run({ thread_id: row.thread_id, display_name: displayName, item_id: row.item_id });
      try {
        await bb.sdk.threads.update({ threadId: row.thread_id, title: displayName });
      } catch {
        // Display name in the Goal store is enough if the thread title cannot change.
      }
    }

    const agents = await Promise.all(
      [...rows, ...extras].map(async (row) => {
        let mapped: { status: GoalAgentStatus; summary: string | null };
        try {
          const thread = await bb.sdk.threads.get({ threadId: row.thread_id });
          const output =
            thread.status === "idle"
              ? await bb.sdk.threads.output({ threadId: row.thread_id }).catch(() => ({ output: null }))
              : { output: null };
          mapped = mapThreadStatus(thread.status, output.output);
        } catch {
          mapped = { status: "unknown", summary: null };
        }
        return {
          threadId: row.thread_id,
          taskName: row.task_name,
          nickname: row.display_name?.trim() || nicknameOf(row.task_name, null),
          itemId: row.item_id,
          role: row.role === "verifier" ? "verifier" : "worker",
          status: mapped.status,
          summary: mapped.summary,
        };
      }),
    );

    const rank: Record<GoalAgentStatus, number> = {
      running: 0,
      starting: 1,
      error: 2,
      idle: 3,
      stopped: 4,
      completed: 5,
      unknown: 6,
    };
    return agents.sort((a, b) => rank[a.status] - rank[b.status] || a.nickname.localeCompare(b.nickname));
  }

  return {
    rootId,
    rowOf,
    listForRoot,
    setMeta(threadId: string, patch: { displayName?: string | null; itemId?: string | null }) {
      setMeta.run({
        thread_id: threadId,
        display_name: patch.displayName ?? null,
        item_id: patch.itemId ?? null,
      });
    },

    setVerifyHash(threadId: string, hash: string) {
      setHash.run({ thread_id: threadId, last_verify_hash: hash });
    },

    verifiersFor(sourceThreadId: string): CollabRow[] {
      return bySource.all(sourceThreadId) as CollabRow[];
    },

    async spawnVerifier(args: {
      rootThreadId: string;
      sourceThreadId: string;
      itemId: string | null;
      providerId: string;
      model: string;
      prompt: string;
    }): Promise<{ threadId: string; nickname: string } | null> {
      const root = await bb.sdk.threads.get({ threadId: args.rootThreadId });
      if (!root.projectId) {
        throw new Error("Goal root thread has no project; cannot spawn a verifier");
      }
      const usedNames = (byRoot.all(args.rootThreadId) as CollabRow[])
        .map((row) => row.display_name)
        .filter((name): name is string => Boolean(name));
      const displayName = nextAuditorName(usedNames);
      const slug = slugFromName(displayName);
      const taskName = `/root/${slug}`;
      const child = await bb.sdk.threads.spawn({
        projectId: root.projectId,
        parentThreadId: args.rootThreadId,
        providerId: args.providerId,
        model: args.model,
        environment: root.environmentId
          ? { type: "reuse" as const, environmentId: root.environmentId }
          : { type: "project-default" as const },
        prompt: [
          args.prompt,
          `The new agent's canonical task name is ${taskName}.`,
          `Your call sign is ${displayName}.`,
          "You are a Goal verifier. Inspect the worktree. Do not implement fixes.",
          "Do not call update_goal or update_plan.",
        ].join("\n\n"),
        title: displayName,
        visibility: "hidden" as const,
        startedOnBehalfOf: { initiator: "system" as const, senderThreadId: args.rootThreadId },
      });
      insert.run({
        thread_id: child.id,
        root_thread_id: args.rootThreadId,
        parent_thread_id: args.rootThreadId,
        task_name: taskName,
        created_at: Date.now(),
        display_name: displayName,
        item_id: args.itemId,
        role: "verifier",
        source_thread_id: args.sourceThreadId,
        last_verify_hash: null,
      });
      try {
        await bb.sdk.threads.update({ threadId: child.id, title: displayName });
      } catch {
        // Title from spawn is enough if update is unavailable.
      }
      hooks?.onChange?.(args.rootThreadId);
      return { threadId: child.id, nickname: displayName };
    },

    registerTools() {
      bb.agents.registerTool({
        name: "spawn_agent",
        description: SPAWN_AGENT_DESCRIPTION,
        experimental_statusLabels: { pending: "Spawning agent", completed: "Spawned agent" },
        parameters: z.object({
          task_name: z
            .string()
            .min(1)
            .describe(
              "Stable id slug: lowercase letters, digits, and underscores. The humorous display name goes in display_name.",
            ),
          display_name: z
            .string()
            .optional()
            .describe(
              "Short humorous name shown in the Goal pane and sidebar, such as 'Sir Syncs-a-Lot'. The orchestrator should always set this.",
            ),
          item_id: z
            .string()
            .optional()
            .describe("Goal plan item id from get_goal. Nests this worker under that Now task."),
          role: z
            .enum(["worker", "verifier"])
            .optional()
            .describe("worker implements a slice. verifier audits a finished worker. Omit for a worker."),
          message: z.string().min(1).describe("Initial plain-text task for the new agent."),
          agent_type: z
            .string()
            .optional()
            .describe("Agent type override for the new agent. Omit unless explicitly asked."),
          fork_turns: z
            .string()
            .optional()
            .describe(
              "Optional number of turns to fork. Defaults to `all`. Use `none`, `all`, or a positive integer string such as `3` to fork only the most recent turns.",
            ),
          model: z.string().optional().describe("Model override for the new agent. Omit unless an explicit override is needed."),
          reasoning_effort: z
            .string()
            .optional()
            .describe("Reasoning effort override for the new agent. Omit to inherit the parent effort."),
        }),
        async execute(
          { task_name, display_name, item_id, role, message, fork_turns, model },
          { threadId, projectId },
        ) {
          const trimmed = message.trim();
          if (!trimmed) {
            return { content: [{ type: "text", text: "Empty message can't be sent to an agent" }], isError: true };
          }
          const parent = await bb.sdk.threads.get({ threadId });
          const parentPath = canonicalName(threadId);
          const usedNames = (byRoot.all(rootId(threadId)) as CollabRow[])
            .map((row) => row.display_name)
            .filter((name): name is string => Boolean(name));
          const displayName = (display_name?.trim() || nextHumorousName(usedNames)).slice(0, 64);
          const slug = /^[a-z0-9_]+$/.test(task_name) ? task_name : slugFromName(displayName);
          const taskName = `${parentPath === "/root" ? "/root" : parentPath}/${slug}`;
          const rootThreadId = rootId(threadId);
          const itemId = item_id?.trim() || hooks?.nextItemId?.(rootThreadId) || null;
          if (byName.get(rootId(threadId), taskName)) {
            return {
              content: [{ type: "text", text: `An agent named ${taskName} already exists.` }],
              isError: true,
            };
          }
          const prompt = [
            trimmed,
            `The new agent's canonical task name is ${taskName}.`,
            `Your call sign is ${displayName}.`,
            role === "verifier"
              ? "You are a Goal verifier. Inspect the worktree and report VERIFY_PASS or VERIFY_FAIL. Do not implement fixes."
              : "You are a Goal subagent for this assigned slice only. Do the work and report evidence.",
            "Do not call update_goal, do not manage the parent Goal plan, and do not re-orchestrate the whole objective.",
          ].join("\n\n");
          const spawnArgs = {
            projectId: parent.projectId ?? projectId,
            parentThreadId: threadId,
            providerId: parent.providerId,
            model: model ?? parent.model ?? undefined,
            environment: parent.environmentId
              ? { type: "reuse" as const, environmentId: parent.environmentId }
              : { type: "project-default" as const },
            prompt,
            title: displayName,
            visibility: "hidden" as const,
            startedOnBehalfOf: { initiator: "agent" as const, senderThreadId: threadId },
          };
          const child =
            fork_turns === "none"
              ? await bb.sdk.threads.spawn(spawnArgs)
              : await bb.sdk.threads
                  .fork({
                    sourceThreadId: threadId,
                    parentThreadId: threadId,
                    prompt,
                    title: displayName,
                    visibility: "hidden",
                    workspace: "reuse",
                  })
                  .catch(() => bb.sdk.threads.spawn(spawnArgs));
          insert.run({
            thread_id: child.id,
            root_thread_id: rootId(threadId),
            parent_thread_id: threadId,
            task_name: taskName,
            created_at: Date.now(),
            display_name: displayName,
            item_id: itemId,
            role: role === "verifier" ? "verifier" : "worker",
            source_thread_id: null,
            last_verify_hash: null,
          });
          try {
            await bb.sdk.threads.update({ threadId: child.id, title: displayName });
          } catch {
            // Title from spawn/fork is enough if update is unavailable.
          }
          hooks?.onChange?.(rootThreadId);
          return { task_name: taskName, nickname: displayName, item_id: itemId };
        },
      });

      bb.agents.registerTool({
        name: "send_message",
        description:
          "Send a message to an existing agent. The message will be delivered promptly. Does not trigger a new turn.",
        experimental_statusLabels: { pending: "Sending message", completed: "Sent message" },
        parameters: z.object({
          target: z
            .string()
            .min(1)
            .describe("Relative or canonical task name to message (from spawn_agent)."),
          message: z.string().min(1).describe("Message text to queue on the target agent."),
        }),
        async execute({ target, message }, { threadId }) {
          const trimmed = message.trim();
          if (!trimmed) {
            return { content: [{ type: "text", text: "Empty message can't be sent to an agent" }], isError: true };
          }
          const agent = resolve(threadId, target);
          if (!agent) {
            return { content: [{ type: "text", text: `Agent not found: ${target}` }], isError: true };
          }
          await bb.sdk.threads.queuedMessages.create({
            threadId: agent.thread_id,
            input: [{ type: "text", text: trimmed }],
          });
          return "";
        },
      });

      bb.agents.registerTool({
        name: "followup_task",
        description:
          "Send a follow-up task to an existing non-root target agent and trigger a turn if it is idle. If the target is already running, deliver the task promptly at message boundaries while sampling, or after the pending tool call completes.",
        experimental_statusLabels: { pending: "Sending follow-up", completed: "Sent follow-up" },
        parameters: z.object({
          target: z
            .string()
            .min(1)
            .describe("Agent id or canonical task name to send a follow-up task to (from spawn_agent)."),
          message: z.string().min(1).describe("Message text to send to the target agent."),
        }),
        async execute({ target, message }, { threadId }) {
          const trimmed = message.trim();
          if (!trimmed) {
            return { content: [{ type: "text", text: "Empty message can't be sent to an agent" }], isError: true };
          }
          if (target === "/root" || target === rootId(threadId)) {
            return {
              content: [{ type: "text", text: "Follow-up tasks can't target the root agent" }],
              isError: true,
            };
          }
          const agent = resolve(threadId, target);
          if (!agent) {
            return { content: [{ type: "text", text: `Agent not found: ${target}` }], isError: true };
          }
          await bb.sdk.threads.send({
            threadId: agent.thread_id,
            mode: "auto",
            input: [{ type: "text", text: trimmed }],
          });
          return "";
        },
      });

      bb.agents.registerTool({
        name: "list_agents",
        description: "List live agents in the current root thread tree. Optionally filter by task-path prefix.",
        experimental_statusLabels: { pending: "Listing agents", completed: "Listed agents" },
        parameters: z.object({
          path_prefix: z
            .string()
            .optional()
            .describe("Task-path prefix filter without a trailing slash. Omit to list all live agents."),
        }),
        async execute({ path_prefix }, { threadId }) {
          const root = rootId(threadId);
          const prefix = path_prefix?.replace(/\/$/, "");
          const rows = (byRoot.all(root) as CollabRow[]).filter((row) =>
            prefix ? row.task_name === prefix || row.task_name.startsWith(`${prefix}/`) : true,
          );
          const agents = await Promise.all(
            rows.map(async (row) => ({
              agent_name: row.task_name,
              agent_status: await statusOf(row.thread_id),
            })),
          );
          return { agents };
        },
      });

      bb.agents.registerTool({
        name: "wait_agent",
        description:
          "Wait for a mailbox update from any live agent, including queued messages and final-status notifications. The wait also ends early when new user input is steered into the active turn. Does not return the content; returns either a summary of which agents have updates (if any), an interruption summary for steered input, or a timeout summary if no activity arrives before the deadline.",
        experimental_statusLabels: { pending: "Waiting for agent", completed: "Waited for agent" },
        parameters: z.object({
          timeout_ms: z
            .number()
            .optional()
            .describe(
              `Timeout in milliseconds. Defaults to ${DEFAULT_WAIT_TIMEOUT_MS}, min ${MIN_WAIT_TIMEOUT_MS}, max ${MAX_WAIT_TIMEOUT_MS}.`,
            ),
        }),
        async execute({ timeout_ms }, { threadId, signal }) {
          if (timeout_ms != null && timeout_ms > MAX_WAIT_TIMEOUT_MS) {
            return {
              content: [{ type: "text", text: `timeout_ms must be at most ${MAX_WAIT_TIMEOUT_MS}` }],
              isError: true,
            };
          }
          const timeout = Math.max(MIN_WAIT_TIMEOUT_MS, timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS);
          const rows = byRoot.all(rootId(threadId)) as CollabRow[];
          if (rows.length === 0) {
            return { message: "No live agents.", timed_out: false };
          }
          const deadline = Date.now() + timeout;
          const updated: string[] = [];
          await Promise.all(
            rows.map(async (row) => {
              const remaining = Math.max(1, deadline - Date.now());
              try {
                await bb.sdk.threads.wait({
                  threadId: row.thread_id,
                  status: "idle",
                  timeoutMs: remaining,
                  signal,
                });
                updated.push(row.task_name);
              } catch {
                // Timed out or interrupted for this agent.
              }
            }),
          );
          if (updated.length === 0) {
            return { message: "Timed out before any mailbox update.", timed_out: true };
          }
          return {
            message: `Updates from ${updated.join(", ")}.`,
            timed_out: false,
          };
        },
      });

      bb.agents.registerTool({
        name: "interrupt_agent",
        description:
          "Interrupt an agent's current turn, if any, and return its previous status. The agent remains available for messages and follow-up tasks.",
        experimental_statusLabels: { pending: "Interrupting agent", completed: "Interrupted agent" },
        parameters: z.object({
          target: z
            .string()
            .min(1)
            .describe("Agent id or canonical task name to interrupt (from spawn_agent)."),
        }),
        async execute({ target }, { threadId }) {
          const agent = resolve(threadId, target);
          if (!agent) {
            return { previous_status: "not_found" };
          }
          const previous_status = await statusOf(agent.thread_id);
          await bb.sdk.threads.stop({ threadId: agent.thread_id });
          return { previous_status };
        },
      });
    },
  };
}

export const COLLAB_TOOL_NAMES = [
  "spawn_agent",
  "send_message",
  "followup_task",
  "list_agents",
  "wait_agent",
  "interrupt_agent",
] as const;
