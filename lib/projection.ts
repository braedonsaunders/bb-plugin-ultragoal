import type { GoalAgent, GoalItem, NowRow } from "../contract.js";
import { shortSliceTitle } from "./titles.js";

// The pane model is computed here and nowhere else. One fold, one set of
// rules, shipped to the UI inside the snapshot so server and pane can never
// disagree:
//   - A Now row exists iff a worker agent is genuinely live. Rows are never
//     synthesized from stored state.
//   - A row's title is its claimed plan item's step (authoritative), else the
//     worker thread's own title, else an honest "Subagent task". Titles are
//     never guessed from prose here.
//   - Next is every open item no live worker holds.

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
    });
  }
  const next = items.filter(
    (item) =>
      (item.status === "pending" || item.status === "in_progress") && !heldByLive.has(item.id),
  );
  return { now, next };
}
