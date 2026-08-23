import type { GoalAgent, GoalItem, NowRow } from "../contract.js";
import { shortSliceTitle } from "./titles.js";

// The pane model is computed here and nowhere else. One fold, one set of
// rules, shipped to the UI inside the snapshot so server and pane can never
// disagree:
//   - Now is all in-progress work, attributed to whoever is on it. Live worker
//     agents get worker/task rows. A started item no live worker holds belongs
//     to the orchestrator while the root turn is running (the model marked it
//     active and is working it itself); only when the root is idle too is it
//     honestly unattended. An in-progress slice never sits under "Up next".
//   - A worker row's title is its claimed plan item's step (authoritative),
//     else the worker thread's own title, else an honest "Subagent task".
//     Titles are never guessed from prose here.
//   - Next is untouched work only: pending items no live worker holds.

function isLive(agent: GoalAgent): boolean {
  return agent.status === "running" || agent.status === "starting";
}

export interface PaneModel {
  now: NowRow[];
  next: GoalItem[];
}

export function projectPane(
  rootThreadId: string,
  items: GoalItem[],
  agents: GoalAgent[],
  rootRunning: boolean,
): PaneModel {
  const open = new Map(
    items.filter((item) => item.status !== "completed").map((item) => [item.id, item]),
  );
  const now: NowRow[] = [];
  const seen = new Set<string>();
  const heldByLive = new Set<string>();
  for (const agent of agents) {
    if (agent.role === "verifier" || !isLive(agent)) continue;
    const isChildThread = agent.threadId !== rootThreadId;
    const key = isChildThread ? agent.threadId : agent.taskName;
    if (seen.has(key)) continue;
    seen.add(key);
    const item = agent.itemId ? open.get(agent.itemId) : undefined;
    if (item) heldByLive.add(item.id);
    const title =
      (item ? shortSliceTitle(item.step) || item.step.trim() : "") ||
      (agent.title && agent.title.trim() !== agent.nickname ? agent.title.trim() : "") ||
      "Subagent task";
    now.push({
      key,
      title,
      nickname: agent.nickname,
      threadId: isChildThread ? agent.threadId : null,
      itemId: item?.id ?? null,
      kind: isChildThread ? "worker" : "task",
    });
  }
  for (const item of items) {
    if (item.status !== "in_progress" || heldByLive.has(item.id)) continue;
    const title = shortSliceTitle(item.step) || item.step.trim();
    // A known holder always wins the attribution, even when the root turn is
    // running: this slice belongs to that worker (now idle — likely reported,
    // awaiting close), not to the orchestrator.
    const holder = agents.find(
      (agent) => agent.role !== "verifier" && agent.itemId === item.id,
    );
    if (holder) {
      now.push({
        key: `item:${item.id}`,
        title,
        nickname: holder.nickname,
        threadId: holder.threadId !== rootThreadId ? holder.threadId : null,
        itemId: item.id,
        kind: "unattended",
      });
      continue;
    }
    if (rootRunning) {
      // No worker ever held this slice and the root turn is running: the
      // orchestrator marked it active and is working it itself.
      now.push({
        key: `item:${item.id}`,
        title,
        nickname: "Orchestrator",
        threadId: null,
        itemId: item.id,
        kind: "orchestrator",
      });
      continue;
    }
    now.push({
      key: `item:${item.id}`,
      title,
      nickname: "",
      threadId: null,
      itemId: item.id,
      kind: "unattended",
    });
  }
  const next = items.filter((item) => item.status === "pending" && !heldByLive.has(item.id));
  return { now, next };
}
