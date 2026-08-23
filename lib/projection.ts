import type { GoalAgent, GoalItem, NowRow } from "../contract.js";
import { shortSliceTitle } from "./titles.js";

// The pane model is computed here and nowhere else. One fold, one set of
// rules, shipped to the UI inside the snapshot so server and pane can never
// disagree:
//   - Now is all in-progress work. A live row (live: true) exists iff a worker
//     agent is genuinely live. Every started item no live worker holds also
//     gets a row (live: false) — begun, then left unattended — so an
//     in-progress slice can never sit under "Up next".
//   - A live row's title is its claimed plan item's step (authoritative), else
//     the worker thread's own title, else an honest "Subagent task". Titles
//     are never guessed from prose here.
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
      live: true,
    });
  }
  for (const item of items) {
    if (item.status !== "in_progress" || heldByLive.has(item.id)) continue;
    // The idle holder, if one claimed this slice, gives the row a name and a
    // thread to open; the row still renders as idle, never as running.
    const holder = agents.find(
      (agent) => agent.role !== "verifier" && agent.itemId === item.id,
    );
    now.push({
      key: `item:${item.id}`,
      title: shortSliceTitle(item.step) || item.step.trim(),
      nickname: holder?.nickname ?? "",
      threadId: holder && holder.threadId !== rootThreadId ? holder.threadId : null,
      itemId: item.id,
      live: false,
    });
  }
  const next = items.filter((item) => item.status === "pending" && !heldByLive.has(item.id));
  return { now, next };
}
