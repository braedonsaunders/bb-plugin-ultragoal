import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GoalItemStatus } from "../contract.js";

// Mirrors how the native Codex Goal works inside bb: the harness never asks
// the model to mirror state into plugin tools. It passively projects thread
// events, latest sequence wins. Two projections matter here:
//   1. turn/plan/updated — the model-owned plan (Cursor "Update TODOs",
//      Codex update_plan) folded into a snapshot, exactly like bb's
//      thread-view/todo-snapshot-extraction.
//   2. item/started + item/completed toolCall events for native subagent
//      Task calls, scoped to the open turn. A task is live iff it started in
//      the open turn and has not completed. When the turn ends, liveness is
//      empty by construction — stale ghosts are impossible.

export interface NativePlanStep {
  step: string;
  status: GoalItemStatus;
}

export interface NativePlanSnapshot {
  seq: number;
  createdAt: number;
  steps: NativePlanStep[];
}

export interface LiveNativeTask {
  /** Provider item id of the Task tool call — stable for started/completed pairing. */
  key: string;
  startedSeq: number;
  startedAt: number;
  tool: string;
}

const PAGE_SIZE = 1000;
const MAX_PAGES_PER_SYNC = 8;
// Cursor interrupts pending Task calls when steered input lands mid-turn and
// never emits item/completed for them (measured: every orphaned Task start on
// the reference thread had a turn/input/accepted right after it). Survivors
// that do outlive a steering boundary complete within ~7 minutes of it. So a
// pending task stays live for GRACE_MS after the latest steering input, and
// for HARD_TTL_MS when no steering has landed since it started.
const STEER_GRACE_MS = 5 * 60_000;
const HARD_TTL_MS = 30 * 60_000;

async function listEvents(
  bb: BbPluginApi,
  args: {
    threadId: string;
    types?: readonly [string, ...string[]];
    order?: "asc" | "desc";
    limit?: string;
    afterSeq?: string;
  },
): Promise<Array<Record<string, unknown>>> {
  try {
    const result = await bb.sdk.threads.events.list(args as never);
    if (Array.isArray(result)) return result as unknown as Array<Record<string, unknown>>;
    const wrapped = result as { events?: unknown[]; items?: unknown[] };
    return (wrapped.events ?? wrapped.items ?? []) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

function seqOf(row: Record<string, unknown>): number {
  const seq = row.seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : 0;
}

function toolCallOf(
  row: Record<string, unknown>,
): { id: string; tool: string } | null {
  const data = row.data;
  if (!data || typeof data !== "object") return null;
  const item = (data as Record<string, unknown>).item;
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  if (rec.type !== "toolCall") return null;
  const id = typeof rec.id === "string" ? rec.id : "";
  const tool = typeof rec.tool === "string" ? rec.tool : "";
  if (!id || !tool) return null;
  return { id, tool };
}

function isNativeTaskTool(tool: string): boolean {
  return /^task\b/i.test(tool) || /^delegate\b/i.test(tool);
}

interface TurnScan {
  boundarySeq: number;
  cursorSeq: number;
  lastInputSeq: number;
  lastInputAt: number;
  open: Map<string, { seq: number; at: number; tool: string }>;
}

const scans = new Map<string, TurnScan>();

function createdAtOf(row: Record<string, unknown>): number {
  const value = row.createdAt;
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

/**
 * One live entry per native subagent Task call in the open turn, in start
 * order. Incremental: each call only reads events after the last scanned
 * sequence, so long turns are paged through once and then tailed cheaply.
 */
export async function listLiveNativeTasks(
  bb: BbPluginApi,
  threadId: string,
): Promise<LiveNativeTask[]> {
  const boundary = await listEvents(bb, {
    threadId,
    types: ["turn/started", "turn/completed"],
    order: "desc",
    limit: "1",
  });
  const latest = boundary[0];
  if (!latest || latest.type !== "turn/started") {
    scans.delete(threadId);
    return [];
  }
  const boundarySeq = seqOf(latest);
  let scan = scans.get(threadId);
  if (!scan || scan.boundarySeq !== boundarySeq) {
    scan = {
      boundarySeq,
      cursorSeq: boundarySeq,
      lastInputSeq: 0,
      lastInputAt: 0,
      open: new Map(),
    };
    scans.set(threadId, scan);
  }

  for (let page = 0; page < MAX_PAGES_PER_SYNC; page += 1) {
    const rows = await listEvents(bb, {
      threadId,
      types: ["item/started", "item/completed", "turn/completed", "turn/input/accepted"],
      order: "asc",
      afterSeq: String(scan.cursorSeq),
      limit: String(PAGE_SIZE),
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const seq = seqOf(row);
      if (seq > scan.cursorSeq) scan.cursorSeq = seq;
      if (row.type === "turn/completed") {
        scans.delete(threadId);
        return [];
      }
      if (row.type === "turn/input/accepted") {
        scan.lastInputSeq = seq;
        scan.lastInputAt = createdAtOf(row);
        continue;
      }
      const call = toolCallOf(row);
      if (!call) continue;
      if (row.type === "item/started") {
        if (isNativeTaskTool(call.tool)) {
          scan.open.set(call.id, { seq, at: createdAtOf(row), tool: call.tool });
        }
      } else {
        // Completion may carry a rewritten tool name (OpenCode retitles the
        // task call with the subagent's title), so match by id only —
        // filtering by tool here left every completed task dangling open.
        scan.open.delete(call.id);
      }
    }
    if (rows.length < PAGE_SIZE) break;
  }

  const now = Date.now();
  const live: Array<[string, { seq: number; at: number; tool: string }]> = [];
  for (const entry of scan.open.entries()) {
    const [, value] = entry;
    const steeredSince = scan.lastInputSeq > value.seq;
    const alive = steeredSince
      ? now - scan.lastInputAt < STEER_GRACE_MS
      : now - value.at < HARD_TTL_MS;
    if (alive) live.push(entry);
  }
  return live
    .sort((a, b) => a[1].seq - b[1].seq)
    .map(([key, value]) => ({
      key,
      startedSeq: value.seq,
      startedAt: value.at,
      tool: value.tool,
    }));
}

/** True when any native Task call is pending in the open turn (pre-grace). */
export function hasPendingNativeTasks(threadId: string): boolean {
  const scan = scans.get(threadId);
  if (!scan) return false;
  const now = Date.now();
  for (const value of scan.open.values()) {
    const steeredSince = scan.lastInputSeq > value.seq;
    const alive = steeredSince
      ? now - scan.lastInputAt < STEER_GRACE_MS
      : now - value.at < HARD_TTL_MS;
    if (alive) return true;
  }
  return false;
}

export function forgetNativeScan(threadId: string): void {
  scans.delete(threadId);
}

function planStatus(value: unknown): GoalItemStatus {
  if (value === "completed") return "completed";
  if (value === "active" || value === "in_progress" || value === "failed") {
    return "in_progress";
  }
  return "pending";
}

/**
 * Latest model-owned plan snapshot (turn/plan/updated), or null when the
 * provider has never emitted one.
 */
export async function readNativePlan(
  bb: BbPluginApi,
  threadId: string,
): Promise<NativePlanSnapshot | null> {
  const rows = await listEvents(bb, {
    threadId,
    types: ["turn/plan/updated"],
    order: "desc",
    limit: "1",
  });
  const row = rows[0];
  if (!row) return null;
  const data = row.data;
  if (!data || typeof data !== "object") return null;
  const plan = (data as Record<string, unknown>).plan;
  if (!Array.isArray(plan)) return null;
  const steps: NativePlanStep[] = [];
  for (const entry of plan) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const step = typeof rec.step === "string" ? rec.step.trim() : "";
    if (!step) continue;
    steps.push({ step, status: planStatus(rec.status) });
  }
  if (steps.length === 0) return null;
  const createdAt =
    typeof row.createdAt === "number" && Number.isFinite(row.createdAt) ? row.createdAt : 0;
  return { seq: seqOf(row), createdAt, steps };
}
