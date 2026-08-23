import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  useBbNavigate,
  useComposerView,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { GoalAgent, GoalItem, GoalSnapshot, NowRow } from "./contract";
import { rpcContract } from "./contract";
import { providerLabel, providerMarkSpec, providerMarkSvg } from "./lib/provider-marks";
import { currentSliceTitle, shortSliceTitle } from "./lib/titles";

const PLAN_ACTION_ID = "ultragoal-plan";

function composerThreadId(
  scope: ReturnType<typeof useComposerView>["scope"],
): string | null {
  if (scope.kind === "thread" || scope.kind === "queued-message") {
    return scope.threadId;
  }
  if (scope.kind === "side-chat") return scope.childThreadId;
  return null;
}

function statusLabel(goal: GoalSnapshot): string {
  if (goal.status === "active") return goal.agentRunning ? "Active" : "Idle";
  if (goal.status === "paused") return "Paused";
  if (goal.status === "complete") return "Complete";
  if (goal.status === "blocked") return "Blocked";
  if (goal.status === "usage_limited") return "Usage limited";
  return "Budget limited";
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => value.toString().padStart(2, "0");
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(secs)}`;
  return `${minutes}:${pad(secs)}`;
}

function formatRelative(timestamp: number | null, now: number): string {
  if (timestamp == null) return "—";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 8) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function liveSeconds(goal: GoalSnapshot, now: number): number {
  if (goal.status !== "active" || !goal.agentRunning) return goal.timeUsedSeconds;
  const lastAt = goal.lastAccountedAt ?? now;
  return goal.timeUsedSeconds + Math.max(0, Math.round((now - lastAt) / 1000));
}

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [enabled]);
  return now;
}

function ProviderMark({
  providerId,
  className = "h-3.5 w-3.5",
}: {
  providerId?: string;
  className?: string;
}) {
  const spec = providerMarkSpec(providerId);
  const label = providerLabel(providerId);
  return (
    <svg
      viewBox={spec.viewBox}
      fill="currentColor"
      fillRule={spec.fillRule}
      className={`shrink-0 ${spec.colorClass} ${className}`}
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      {spec.paths.map((d) => (
        <path key={d.slice(0, 32)} d={d} />
      ))}
    </svg>
  );
}

function useThreadMeta(threadId: string | null) {
  const { threads } = experimental_useSidebarThreads();
  const row = threads.find((thread) => thread.id === threadId);
  return {
    title: row?.title || row?.titleFallback || null,
    providerId: row?.providerId,
  };
}

const ICON_SIZE = 14;

function injectProviderIcons(threads: readonly { id: string; providerId: string }[]) {
  const byId = new Map(threads.map((thread) => [thread.id, thread.providerId]));
  for (const target of Array.from(document.querySelectorAll("[data-sidebar-thread-id]"))) {
    const id = target.getAttribute("data-sidebar-thread-id");
    if (!id) continue;
    const providerId = byId.get(id);
    if (!providerId) continue;

    // [data-sidebar-thread-id] is an `absolute inset-0` click overlay covering
    // the whole row, so anything drawn inside it stacks on top of the title.
    // The row itself is the flex line; its first <span> child is the title
    // container (`flex min-w-0 flex-1 items-center gap-1.5`), which centers and
    // spaces the mark for us.
    const row = target.parentElement;
    if (!row) continue;
    const container = row.querySelector(":scope > span") as HTMLElement | null;
    if (!container) continue;

    let icon = row.querySelector("[data-goal-provider-icon]") as HTMLElement | null;
    if (icon && icon.parentElement !== container) {
      icon.remove();
      icon = null;
    }
    if (!icon) {
      icon = document.createElement("span");
      icon.dataset.goalProviderIcon = "1";
      icon.style.cssText = `display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:${ICON_SIZE}px;height:${ICON_SIZE}px`;
      container.insertBefore(icon, container.firstChild);
    }

    const label = providerLabel(providerId);
    if (icon.dataset.goalProvider !== providerId) {
      icon.dataset.goalProvider = providerId;
      // Host-owned color classes, so the mark matches the provider picker in
      // both themes.
      icon.className = providerMarkSpec(providerId).colorClass;
      icon.innerHTML = providerMarkSvg(providerId, ICON_SIZE);
    }
    if (icon.title !== label) icon.title = label;
  }
}

function SidebarProviderIcons() {
  const { threads } = experimental_useSidebarThreads();
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const signature = threads.map((thread) => `${thread.id}:${thread.providerId}`).join(",");

  useEffect(() => {
    let frame = 0;
    let disposed = false;
    const options: MutationObserverInit = { childList: true, subtree: true };

    // injectProviderIcons writes into document.body, which is the same subtree we
    // observe — staying connected across our own writes re-triggers this callback
    // forever and wedges the main thread. Detach while writing, and coalesce on a
    // frame so a burst of sidebar updates yields to the event loop.
    const apply = () => {
      frame = 0;
      if (disposed) return;
      observer.disconnect();
      try {
        injectProviderIcons(threadsRef.current);
      } finally {
        if (!disposed) observer.observe(document.body, options);
      }
    };

    const schedule = () => {
      if (frame || disposed) return;
      frame = window.requestAnimationFrame(apply);
    };

    const observer = new MutationObserver(schedule);
    schedule();
    observer.observe(document.body, options);

    return () => {
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [signature]);
  return null;
}

const GOAL_MARK_STYLE =
  "display:inline-flex;align-items:center;flex:0 0 auto;height:14px;padding:0 4px;border:1px solid currentColor;border-radius:3px;font-size:9px;font-weight:600;letter-spacing:.04em;line-height:1;opacity:.55";

function injectGoalSidebarMarks(
  crews: Array<{ threadId: string; active?: boolean; agents: GoalAgent[]; workerIds?: string[] }>,
  extraHideIds?: ReadonlySet<string>,
) {
  // Workers of any crew — active or cleared — stay hidden. The pill marks
  // only threads with a live goal.
  const goalIds = new Set(crews.map((crew) => crew.threadId));
  const markIds = new Set(crews.filter((crew) => crew.active !== false).map((crew) => crew.threadId));
  const workerIds = new Set(
    crews.flatMap((crew) => [
      ...(crew.workerIds ?? []),
      ...crew.agents.map((agent) => agent.threadId),
    ]),
  );
  for (const id of extraHideIds ?? []) workerIds.add(id);
  for (const id of goalIds) workerIds.delete(id);

  for (const stale of Array.from(document.querySelectorAll("[data-goal-crew]"))) {
    stale.remove();
  }

  for (const target of Array.from(document.querySelectorAll("[data-sidebar-thread-id]"))) {
    const id = target.getAttribute("data-sidebar-thread-id");
    const row = target.parentElement as HTMLElement | null;
    if (!id || !row) continue;

    if (workerIds.has(id)) {
      row.dataset.goalWorkerHidden = "1";
      row.style.display = "none";
      continue;
    }
    // An empty crew cache after reload used to unhide every worker. Only
    // restore a row when we positively know the active Goal set and this
    // thread is not one of its children.
    if (row.dataset.goalWorkerHidden === "1" && goalIds.size > 0) {
      delete row.dataset.goalWorkerHidden;
      row.style.display = "";
    }

    const container = row.querySelector(":scope > span") as HTMLElement | null;
    if (!container) continue;
    const caret = container.querySelector("button[aria-expanded]") as HTMLElement | null;
    if (caret) {
      if (goalIds.has(id)) {
        caret.dataset.goalCaretHidden = "1";
        caret.style.display = "none";
      } else if (caret.dataset.goalCaretHidden === "1") {
        delete caret.dataset.goalCaretHidden;
        caret.style.display = "";
      }
    }
    let mark = container.querySelector("[data-goal-mark]") as HTMLElement | null;
    if (!markIds.has(id)) {
      mark?.remove();
      continue;
    }
    if (!mark) {
      mark = document.createElement("span");
      mark.dataset.goalMark = "1";
      mark.style.cssText = GOAL_MARK_STYLE;
      mark.textContent = "UltraGoal";
      mark.title = "UltraGoal thread";
      container.appendChild(mark);
    }
  }
}

function descendantWorkerIds(
  threads: readonly { id: string; parentThreadId: string | null; originPluginId?: string | null }[],
  goalIds: ReadonlySet<string>,
): Set<string> {
  const byParent = new Map<string, string[]>();
  for (const thread of threads) {
    if (!thread.parentThreadId) continue;
    const list = byParent.get(thread.parentThreadId) ?? [];
    list.push(thread.id);
    byParent.set(thread.parentThreadId, list);
  }
  const hide = new Set<string>();
  const walk = (id: string) => {
    for (const child of byParent.get(id) ?? []) {
      if (goalIds.has(child) || hide.has(child)) continue;
      hide.add(child);
      walk(child);
    }
  };
  for (const goalId of goalIds) walk(goalId);
  for (const thread of threads) {
    if (
      (thread.originPluginId === "ultragoal" || thread.originPluginId === "goal") &&
      thread.parentThreadId &&
      !goalIds.has(thread.id)
    ) {
      hide.add(thread.id);
    }
  }
  return hide;
}

function SidebarGoalMarks() {
  const rpc = useRpc<typeof rpcContract>();
  const { threads } = experimental_useSidebarThreads();
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const threadTree = threads
    .map((thread) => `${thread.id}:${thread.parentThreadId ?? ""}:${thread.originPluginId ?? ""}`)
    .join(",");
  const [crews, setCrews] = useState<
    Array<{ threadId: string; active?: boolean; agents: GoalAgent[]; workerIds: string[] }>
  >([]);

  const load = useCallback(async () => {
    try {
      const next = await rpc.call("listCrews", {});
      setCrews(
        next.crews.map((crew) => ({
          threadId: crew.threadId,
          active: crew.active,
          agents: crew.agents,
          workerIds: crew.workerIds ?? crew.agents.map((agent) => agent.threadId),
        })),
      );
    } catch {
      // Keep the last known crew so a failed poll cannot unhide workers.
    }
  }, [rpc]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => {
      void load();
    }, 4000);
    return () => window.clearInterval(id);
  }, [load]);

  useRealtime("ultragoal", () => {
    void load();
  });

  useEffect(() => {
    let frame = 0;
    let disposed = false;
    const options: MutationObserverInit = { childList: true, subtree: true };
    const apply = () => {
      frame = 0;
      if (disposed) return;
      observer.disconnect();
      try {
        injectGoalSidebarMarks(
          crews,
          descendantWorkerIds(
            threadsRef.current,
            new Set(crews.map((crew) => crew.threadId)),
          ),
        );
      } finally {
        if (!disposed) observer.observe(document.body, options);
      }
    };
    const observer = new MutationObserver(() => {
      if (frame || disposed) return;
      frame = window.requestAnimationFrame(apply);
    });
    apply();
    return () => {
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [crews, threadTree]);

  return null;
}

function ThreadProviderHeader({ threadId }: { threadId: string }) {
  const meta = useThreadMeta(threadId);
  return (
    <span className="inline-flex h-7 w-7 items-center justify-center">
      <ProviderMark providerId={meta.providerId} className="h-4 w-4" />
    </span>
  );
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border/70 bg-muted/35 px-2.5 py-2">
      <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 truncate font-mono text-[15px] tabular-nums tracking-tight text-foreground">
        {value}
      </div>
      {hint ? <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function useGoal(threadId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [goal, setGoal] = useState<GoalSnapshot | null>(null);

  const load = useCallback(async () => {
    if (!threadId) {
      setGoal(null);
      return;
    }
    try {
      const next = await rpc.call("getGoal", { threadId });
      setGoal(next.goal ? { ...next.goal, agents: next.goal.agents ?? [] } : null);
    } catch {
      setGoal(null);
    }
  }, [rpc, threadId]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime("ultragoal", (payload) => {
    const event = payload as { threadId?: string; goal?: GoalSnapshot | null };
    if (!threadId || event.threadId !== threadId) return;
    setGoal(event.goal ? { ...event.goal, agents: event.goal.agents ?? [] } : null);
  });

  return { rpc, goal, setGoal, refresh: load };
}

function GoalChrome() {
  return (
    <>
      <GoalPaneOpener />
      <SidebarGoalMarks />
    </>
  );
}

function GoalPaneOpener() {
  const view = useComposerView();
  const navigate = useBbNavigate();
  const threadId = composerThreadId(view.scope);
  const { goal } = useGoal(threadId);

  useEffect(() => {
    if (!threadId || !goal || goal.status === "complete") return;
    navigate.openThreadPanel({ actionId: PLAN_ACTION_ID, title: "UltraGoal" });
  }, [navigate, threadId, goal?.status, goal?.objective]);

  return null;
}

function GoalPlanPanel({ threadId }: { threadId: string }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navigate = useBbNavigate();
  const threadMeta = useThreadMeta(threadId);
  const { rpc, goal, setGoal, refresh } = useGoal(threadId);
  const ticking = Boolean(goal && goal.status === "active" && goal.agentRunning);
  const now = useNow(ticking || Boolean(goal));

  useEffect(() => {
    const pane = rootRef.current?.closest("[data-panel]");
    if (!(pane instanceof HTMLElement)) return;
    pane.style.removeProperty("width");
    pane.style.removeProperty("min-width");
    pane.style.removeProperty("max-width");
    delete pane.dataset.goalNarrowed;
    delete pane.dataset.goalFlexNarrowed;
  }, [threadId]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [objectiveDraft, setObjectiveDraft] = useState("");
  const [savingObjective, setSavingObjective] = useState(false);
  const [acting, setActing] = useState<"pause" | "resume" | null>(null);
  const [collapsed, setCollapsed] = useState({
    now: false,
    next: false,
    previous: true,
    settings: true,
  });
  const toggleCollapsed = (key: keyof typeof collapsed) => {
    setCollapsed((current) => ({ ...current, [key]: !current[key] }));
  };

  useEffect(() => {
    const id = window.setInterval(() => {
      void refresh();
    }, 12_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const items = goal?.items ?? [];
  const agents = goal?.agents ?? [];
  const doneItems = items.filter((item) => item.status === "completed");
  const liveAgents = agents.filter((agent) => agent.status === "running" || agent.status === "starting");
  // The pane model is computed server-side (lib/projection.ts) and rendered
  // verbatim; the UI derives nothing.
  const nowRows = goal?.now ?? [];
  const nextItems = goal?.next ?? [];
  const done = doneItems.length;
  const elapsed = goal ? liveSeconds(goal, now) : 0;
  const hours = Math.max(elapsed / 3600, 1 / 60);
  const showResume = Boolean(goal && goal.status !== "complete" && !goal.agentRunning);
  const showPause = Boolean(
    goal &&
      (goal.status === "active" || goal.status === "budget_limited") &&
      goal.agentRunning,
  );

  const apply = (next: GoalSnapshot | null) => {
    setGoal(next);
  };

  const add = async () => {
    const step = draft.trim();
    if (!step || saving) return;
    setSaving(true);
    try {
      const next = await rpc.call("addItem", { threadId, step });
      apply(next.goal);
      setDraft("");
    } finally {
      setSaving(false);
    }
  };

  const startEdit = () => {
    if (!goal) return;
    setObjectiveDraft(goal.objective);
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!goal) return;
    const objective = objectiveDraft.trim();
    if (!objective || objective === goal.objective) {
      setEditing(false);
      return;
    }
    setSavingObjective(true);
    try {
      const next = await rpc.call("edit", { threadId, objective });
      apply(next.goal);
      setEditing(false);
    } finally {
      setSavingObjective(false);
    }
  };

  if (!goal) {
    return (
      <div ref={rootRef} className="flex h-full w-full min-w-0 flex-col justify-center overflow-x-hidden px-4 text-sm text-muted-foreground">
        No UltraGoal is set on this thread.
      </div>
    );
  }

  const tokenHint =
    goal.tokenBudget == null
      ? "unbounded"
      : `${formatTokens(Math.max(0, goal.tokenBudget - goal.tokensUsed))} left`;
  const requirementPct = items.length > 0 ? Math.round((done / items.length) * 100) : 0;

  return (
    <div ref={rootRef} className="flex h-full w-full min-w-0 min-h-0 flex-col overflow-x-hidden bg-background">
      <div className="border-b border-border px-3 pb-3 pt-3">
        {threadMeta.title ? (
          <div className="mb-2 flex min-w-0 items-center gap-1.5 text-[12px] text-foreground">
            <ProviderMark providerId={threadMeta.providerId} />
            <span className="truncate">{threadMeta.title}</span>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                goal.agentRunning && goal.status === "active"
                  ? "animate-pulse bg-foreground"
                  : "bg-muted-foreground/50"
              }`}
            />
            <div className="truncate text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              {statusLabel(goal)}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {editing ? (
              <>
                <button
                  type="button"
                  className="rounded-md px-1.5 py-1 text-[11px] text-foreground hover:bg-state-hover"
                  disabled={savingObjective || objectiveDraft.trim().length === 0}
                  onClick={() => {
                    void saveEdit();
                  }}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-state-hover"
                  disabled={savingObjective}
                  onClick={() => {
                    setEditing(false);
                    setObjectiveDraft(goal.objective);
                  }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="rounded-md px-1.5 py-1 text-[11px] text-foreground hover:bg-state-hover"
                  onClick={startEdit}
                >
                  Edit
                </button>
                {showResume ? (
                  <button
                    type="button"
                    className="rounded-md px-1.5 py-1 text-[11px] text-foreground hover:bg-state-hover"
                    disabled={acting !== null}
                    onClick={() => {
                      setActing("resume");
                      void rpc
                        .call("resume", { threadId })
                        .then((result) => apply(result.goal))
                        .finally(() => setActing(null));
                    }}
                  >
                    {acting === "resume" ? "Starting…" : "Resume"}
                  </button>
                ) : null}
                {showPause ? (
                  <button
                    type="button"
                    className="rounded-md px-1.5 py-1 text-[11px] text-foreground hover:bg-state-hover"
                    disabled={acting !== null}
                    onClick={() => {
                      setActing("pause");
                      void rpc
                        .call("pause", { threadId })
                        .then((result) => apply(result.goal))
                        .finally(() => setActing(null));
                    }}
                  >
                    Pause
                  </button>
                ) : null}
                <button
                  type="button"
                  className="rounded-md px-1.5 py-1 text-[11px] text-destructive hover:bg-state-hover"
                  onClick={() => {
                    void rpc.call("clear", { threadId }).then(() => apply(null));
                  }}
                >
                  Clear
                </button>
              </>
            )}
          </div>
        </div>

        <div className="mt-3 font-mono text-[32px] leading-none tracking-tight tabular-nums text-foreground">
          {formatClock(elapsed)}
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          {ticking ? "Running" : "Stopped"}
        </div>

        {editing ? (
          <textarea
            className="mt-3 w-full min-w-0 resize-none rounded-md border border-border bg-transparent px-2 py-1.5 text-sm leading-snug text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
            rows={3}
            value={objectiveDraft}
            disabled={savingObjective}
            autoFocus
            onChange={(event) => setObjectiveDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
                setObjectiveDraft(goal.objective);
              }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void saveEdit();
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="mt-3 block w-full text-left text-sm leading-snug break-words text-foreground hover:text-foreground/80"
            onClick={startEdit}
          >
            {goal.objective}
          </button>
        )}

        {goal.reason ? (
          <div className="mt-2 text-[11px] leading-snug text-muted-foreground">{goal.reason}</div>
        ) : null}

        <div className="mt-3 grid grid-cols-2 gap-2">
          <Metric
            label="Done"
            value={items.length > 0 ? `${done}/${items.length}` : "—"}
            hint={
              items.length > 0
                ? `${nowRows.length} now · ${nextItems.length} next`
                : liveAgents.length > 0
                  ? `${liveAgents.length} live`
                  : "awaiting plan"
            }
          />
          <Metric
            label="Tokens"
            value={formatTokens(goal.tokensUsed)}
            hint={tokenHint}
          />
          <Metric
            label="Last"
            value={formatRelative(goal.lastContinueAt, now)}
            hint={`age ${formatElapsed(Math.max(0, Math.round((now - goal.startedAt) / 1000)))}`}
          />
          <Metric
            label="Pace"
            value={
              elapsed >= 30 && goal.tokensUsed > 0
                ? `${formatTokens(Math.round(goal.tokensUsed / hours))}/h`
                : "—"
            }
            hint={
              items.length > 0 && elapsed >= 30 && done > 0
                ? `${(done / hours).toFixed(1)} req/h`
                : elapsed >= 30 && goal.tokensUsed > 0
                  ? "token pace"
                  : "warming up"
            }
          />
        </div>

        {items.length > 0 ? (
          <div className="mt-3">
            <div className="mb-1 flex items-baseline justify-between text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              <span>Progress</span>
              <span className="font-mono tabular-nums">{requirementPct}%</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-foreground/70" style={{ width: `${requirementPct}%` }} />
            </div>
          </div>
        ) : null}

        <div className="mt-3 text-[11px] text-muted-foreground">
          {goal.settings.verifyEnabled
            ? `Verify on · ${goal.settings.verifyProvider}/${goal.settings.verifyModel}`
            : "Verify off"}
          {goal.settings.autoContinue ? " · auto-continue" : " · manual continue"}
          {goal.settings.progressUpdateMinutes > 0
            ? ` · update every ${goal.settings.progressUpdateMinutes}m`
            : " · no chat updates"}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {items.length === 0 && agents.length === 0 ? (
          <div className="px-2 py-8 text-sm leading-relaxed text-muted-foreground">
            No requirements yet. Resume the UltraGoal and the agent will fill this list with
            update_plan.
          </div>
        ) : (
          <>
            <NowSection
              rows={nowRows}
              collapsed={collapsed.now}
              onToggleCollapsed={() => toggleCollapsed("now")}
              onOpenThread={(id) => navigate.toThread(id)}
            />
            <ItemGroup
              title="Up next"
              items={nextItems}
              collapsed={collapsed.next}
              onToggleCollapsed={() => toggleCollapsed("next")}
            />
            <ItemGroup
              title="Previous"
              items={doneItems}
              alwaysShow
              emptyLabel="Completed requirements will appear here."
              collapsed={collapsed.previous}
              onToggleCollapsed={() => toggleCollapsed("previous")}
            />
          </>
        )}
        <GoalSettingsPanel
          threadId={threadId}
          goal={goal}
          collapsed={collapsed.settings}
          onToggleCollapsed={() => toggleCollapsed("settings")}
          onApply={apply}
        />
      </div>
      <form
        className="border-t border-border p-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <input
          className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder="Add a requirement"
          value={draft}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
        />
      </form>
    </div>
  );
}

type CatalogProvider = {
  id: string;
  displayName: string;
  available?: boolean;
  models: Array<{ id: string; displayName: string; description?: string }>;
};

function VerifierModelSwitcher({
  providers,
  providerId,
  model,
  disabled,
  onChange,
}: {
  providers: CatalogProvider[];
  providerId: string;
  model: string;
  disabled: boolean;
  onChange: (providerId: string, model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [browseId, setBrowseId] = useState(providerId);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setBrowseId(providerId);
  }, [providerId]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, [open]);

  const currentProvider =
    providers.find((provider) => provider.id === providerId) ??
    providers.find((provider) => provider.models.some((entry) => entry.id === model));
  const currentModel = currentProvider?.models.find((entry) => entry.id === model);
  const browsing =
    providers.find((provider) => provider.id === browseId) ?? currentProvider ?? providers[0];

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        className="flex w-full items-center gap-2 rounded-md border border-border px-2 py-1.5 text-left text-sm hover:bg-state-hover disabled:opacity-50"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <ProviderMark providerId={currentProvider?.id ?? providerId} />
        <span className="min-w-0 flex-1 truncate">
          {currentProvider?.displayName ?? providerLabel(providerId)}
          <span className="text-muted-foreground"> · </span>
          {currentModel?.displayName ?? model}
        </span>
        <span className="text-[10px] text-muted-foreground">{open ? "▾" : "▴"}</span>
      </button>
      {open ? (
        <div className="absolute bottom-full z-20 mb-1 flex max-h-72 w-full min-w-[16rem] overflow-hidden rounded-md border border-border bg-background shadow-md">
          <ul className="w-[38%] shrink-0 overflow-y-auto border-r border-border py-1">
            {providers.map((provider) => {
              const active = browsing?.id === provider.id;
              return (
                <li key={provider.id}>
                  <button
                    type="button"
                    disabled={provider.available === false && provider.models.length === 0}
                    className={`flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[12px] disabled:opacity-40 ${
                      active ? "bg-state-hover text-foreground" : "text-muted-foreground hover:bg-state-hover"
                    }`}
                    onClick={() => setBrowseId(provider.id)}
                  >
                    <ProviderMark providerId={provider.id} className="h-3 w-3" />
                    <span className="truncate">{provider.displayName}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <ul className="min-w-0 flex-1 overflow-y-auto py-1">
            {(browsing?.models ?? []).map((entry) => {
              const selected = browsing?.id === providerId && entry.id === model;
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    className={`flex w-full flex-col items-start px-2.5 py-1.5 text-left hover:bg-state-hover ${
                      selected ? "bg-state-hover" : ""
                    }`}
                    onClick={() => {
                      if (browsing) onChange(browsing.id, entry.id);
                      setOpen(false);
                    }}
                  >
                    <span className="text-[13px] text-foreground">{entry.displayName}</span>
                    {entry.description ? (
                      <span className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                        {entry.description}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
            {providers.length === 0 ? (
              <li className="px-2.5 py-2 text-[12px] text-muted-foreground">Loading models…</li>
            ) : (browsing?.models.length ?? 0) === 0 ? (
              <li className="px-2.5 py-2 text-[12px] text-muted-foreground">
                No models on this provider.
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function GoalSettingsPanel({
  threadId,
  goal,
  collapsed,
  onToggleCollapsed,
  onApply,
}: {
  threadId: string;
  goal: GoalSnapshot;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onApply: (goal: GoalSnapshot | null) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [providers, setProviders] = useState<CatalogProvider[]>([]);
  const [budget, setBudget] = useState(goal.tokenBudget == null ? "" : String(goal.tokenBudget));
  const [progressMinutes, setProgressMinutes] = useState(String(goal.settings.progressUpdateMinutes));
  const [saving, setSaving] = useState(false);
  const settings = goal.settings;

  useEffect(() => {
    setBudget(goal.tokenBudget == null ? "" : String(goal.tokenBudget));
  }, [goal.tokenBudget]);

  useEffect(() => {
    setProgressMinutes(String(goal.settings.progressUpdateMinutes));
  }, [goal.settings.progressUpdateMinutes]);

  useEffect(() => {
    void rpc
      .call("listModels", { threadId })
      .then((result) => setProviders(result.providers))
      .catch(() => {
        setProviders([]);
      });
  }, [rpc, threadId]);

  const save = async (patch: {
    verifyEnabled?: boolean;
    verifyProvider?: string;
    verifyModel?: string;
    autoContinue?: boolean;
    progressUpdateMinutes?: number;
    tokenBudget?: number | null;
  }) => {
    setSaving(true);
    try {
      const next = await rpc.call("updateSettings", { threadId, ...patch });
      onApply(next.goal);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-2 border-t border-border px-1 pb-2 pt-1">
      <SectionHeading
        title="Settings"
        count={settings.verifyEnabled ? "verify on" : "verify off"}
        collapsed={collapsed}
        onToggle={onToggleCollapsed}
      />
      {collapsed ? null : (
        <div className="space-y-3 px-1 pt-1">
          <label className="flex items-center justify-between gap-3 text-[13px] text-foreground">
            <span>Verify workers</span>
            <input
              type="checkbox"
              checked={settings.verifyEnabled}
              disabled={saving}
              onChange={(event) => {
                void save({ verifyEnabled: event.target.checked });
              }}
            />
          </label>
          <div className="text-[13px] text-foreground">
            <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              Verifier model
            </div>
            <VerifierModelSwitcher
              providers={providers}
              providerId={settings.verifyProvider}
              model={settings.verifyModel}
              disabled={saving || !settings.verifyEnabled}
              onChange={(providerId, model) => {
                void save({ verifyProvider: providerId, verifyModel: model });
              }}
            />
          </div>
          <label className="block text-[13px] text-foreground">
            <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              Progress chat (minutes)
            </span>
            <input
              className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              inputMode="numeric"
              placeholder="5"
              value={progressMinutes}
              disabled={saving}
              onChange={(event) => setProgressMinutes(event.target.value)}
              onBlur={() => {
                const trimmed = progressMinutes.trim();
                const next = trimmed === "" ? 5 : Number.parseInt(trimmed, 10);
                if (!Number.isFinite(next) || next < 0 || next > 240) {
                  setProgressMinutes(String(goal.settings.progressUpdateMinutes));
                  return;
                }
                if (next === goal.settings.progressUpdateMinutes) return;
                void save({ progressUpdateMinutes: next });
              }}
            />
            <span className="mt-1 block text-[11px] text-muted-foreground">
              0 turns this off. Default 5. Posts a visible update on this thread.
            </span>
          </label>
          <label className="flex items-center justify-between gap-3 text-[13px] text-foreground">
            <span>Auto-continue</span>
            <input
              type="checkbox"
              checked={settings.autoContinue}
              disabled={saving}
              onChange={(event) => {
                void save({ autoContinue: event.target.checked });
              }}
            />
          </label>
          <label className="block text-[13px] text-foreground">
            <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              Token budget
            </span>
            <input
              className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              inputMode="numeric"
              placeholder="unbounded"
              value={budget}
              disabled={saving}
              onChange={(event) => setBudget(event.target.value)}
              onBlur={() => {
                const trimmed = budget.trim();
                const next = trimmed === "" ? null : Number.parseInt(trimmed, 10);
                if (trimmed !== "" && (!Number.isFinite(next) || (next ?? 0) <= 0)) {
                  setBudget(goal.tokenBudget == null ? "" : String(goal.tokenBudget));
                  return;
                }
                if (next === goal.tokenBudget || (next == null && goal.tokenBudget == null)) return;
                void save({ tokenBudget: next });
              }}
            />
          </label>
        </div>
      )}
    </section>
  );
}

function SectionHeading({
  title,
  count,
  collapsed,
  onToggle,
}: {
  title: string;
  count: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-baseline justify-between px-1 pb-0.5 pt-1.5 text-left text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground"
      onClick={onToggle}
      aria-expanded={!collapsed}
    >
      <span className="flex items-center gap-1.5">
        <span className="inline-block w-2 text-[9px]">{collapsed ? "▸" : "▾"}</span>
        <span>{title}</span>
      </span>
      <span className="font-mono tabular-nums">{count}</span>
    </button>
  );
}

// Now rows arrive fully computed from the server (lib/projection.ts): one row
// per live subagent, already titled. The UI only renders.
function NowRowView({
  row,
  onOpenThread,
}: {
  row: NowRow;
  onOpenThread: (threadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-md">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-state-hover"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="w-2 shrink-0 text-[9px] text-muted-foreground">{open ? "▾" : "▸"}</span>
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-foreground" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-foreground">
          {row.title}
        </span>
        <span className="max-w-[7.5rem] shrink-0 truncate text-right text-[11px] leading-5 text-muted-foreground">
          {row.nickname}
        </span>
      </button>
      {open ? (
        <div className="mb-1 ml-5 space-y-1.5 border-l border-border/70 py-1 pl-2.5">
          {row.threadId ? (
            <button
              type="button"
              className="block w-full min-w-0 text-left hover:text-foreground"
              onClick={() => onOpenThread(row.threadId as string)}
            >
              <div className="truncate text-[12px] leading-4 text-foreground">
                {row.nickname}
                <span className="ml-1.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                  running
                </span>
              </div>
              <div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                {row.title}
              </div>
            </button>
          ) : (
            <div className="text-[11px] text-muted-foreground">
              Native subagent running inside the root thread.
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}

function NowSection({
  rows,
  collapsed,
  onToggleCollapsed,
  onOpenThread,
}: {
  rows: NowRow[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="px-1 pb-1">
      <SectionHeading
        title="Now"
        count={String(rows.length)}
        collapsed={collapsed}
        onToggle={onToggleCollapsed}
      />
      {collapsed ? null : (
        <ul>
          {rows.map((row) => (
            <NowRowView key={row.key} row={row} onOpenThread={onOpenThread} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ItemGroup({
  title,
  items,
  collapsed,
  onToggleCollapsed,
  alwaysShow,
  emptyLabel,
}: {
  title: string;
  items: GoalItem[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  alwaysShow?: boolean;
  emptyLabel?: string;
}) {
  if (items.length === 0 && !alwaysShow) return null;
  return (
    <section className="px-1 pb-2">
      <SectionHeading
        title={title}
        count={String(items.length)}
        collapsed={collapsed}
        onToggle={onToggleCollapsed}
      />
      {collapsed ? null : items.length === 0 ? (
        <div className="px-2 py-3 text-[13px] text-muted-foreground">{emptyLabel}</div>
      ) : (
      <ul className="space-y-0.5">
        {items.map((item) => {
          const completed = item.status === "completed";
          const active = item.status === "in_progress";
          return (
            <li key={item.id} className="flex items-start gap-2 rounded-md px-1 py-1.5">
              <span
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border ${
                  completed
                    ? "border-foreground bg-foreground text-background"
                    : active
                      ? "border-foreground"
                      : "border-muted-foreground/50"
                }`}
              >
                {completed ? (
                  <span className="text-[10px] leading-none">✓</span>
                ) : active ? (
                  <span className="h-1.5 w-1.5 rounded-full bg-foreground" />
                ) : null}
              </span>
              <span
                className={`min-w-0 flex-1 truncate text-[13px] leading-snug ${
                  completed
                    ? "text-muted-foreground line-through"
                    : active
                      ? "text-foreground"
                      : "text-foreground/90"
                }`}
              >
                {shortSliceTitle(item.step) || currentSliceTitle(item.step)}
              </span>
            </li>
          );
        })}
      </ul>
      )}
    </section>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "ultragoal-provider-icon",
    title: "Provider",
    component: ThreadProviderHeader,
  });
  app.slots.experimental_threadList({
    id: "ultragoal-thread-list",
    title: "Threads",
    description: "Built-in list with provider icons before titles.",
    component: (props) => {
      const Original = props.experimental_Original;
      return (
        <>
          <SidebarProviderIcons />
          <SidebarGoalMarks />
          <Original {...props} />
        </>
      );
    },
  });
  app.slots.threadPanelAction({
    id: PLAN_ACTION_ID,
    title: "UltraGoal",
    icon: "ListChecks",
    layout: "flush",
    component: GoalPlanPanel,
    run: ({ openPanel }) => {
      openPanel({ title: "UltraGoal" });
    },
  });
  app.composer.customize({
    id: "ultragoal",
    scopes: ["thread", "queued-message"],
    banners: [{ id: "ultragoal-banner", chrome: "bare", component: GoalChrome }],
    plusMenu: [
      {
        id: "start-ultragoal",
        label: "Start an UltraGoal",
        description: "Keep working toward one durable objective",
        run: ({ composer }) => {
          const current = composer.text.trim();
          if (/^\/(?:ultra)?goal\b/i.test(current)) {
            composer.focus();
            return;
          }
          composer.setText(current ? `/ultragoal ${current}` : "/ultragoal ");
          composer.focus();
        },
      },
    ],
  });
});
