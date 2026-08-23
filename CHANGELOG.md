# Changelog

## 0.4.1

- UltraGoal no longer spawns workers itself. Auto-staffing raced the orchestrator's own agentic spawning — it launched premature workers for unbriefed pending slices with thin one-line briefs and silently dropped their failures. The orchestrator spawns every worker via spawn_agent (or native spawns, which are tracked); the plugin only cleans up errored worker threads and keeps nudging the model to staff open slices.
- Crew hiding in the sidebar outlives the goal: clearing an UltraGoal no longer dumps its hidden worker subthreads into the thread list. The UltraGoal pill disappears on clear; the workers stay tucked away.

## 0.4.0

Architecture consolidation: rows are projected liveness, semantics are structured annotations, and nothing is guessed from prose.

- The pane model (Now rows and Up next) is computed in exactly one server-side fold (lib/projection.ts) and shipped inside the snapshot; the UI renders it verbatim and derives nothing. Server and pane can no longer disagree.
- Titles come only from structure: a claimed plan item's own step text (authoritative, never rewritten from messages), the first line of a spawn_agent call, or an explicit "SLICE (item_id=...):" marker in a spawn prompt. Free-line guessing — which turned context like "HEAD is 38b9e4ed" into row titles — is gone; an unclaimed native subagent shows honestly as "Subagent task".
- Machine-readable completion: every spawned worker is instructed to end with ULTRAGOAL_DONE: <evidence> or ULTRAGOAL_BLOCKED: <blocker>; the completion loop honors the contract first and falls back to prose only for workers spawned without it.
- spawn_agent no longer auto-claims an arbitrary unassigned Next item when item_id is omitted; it claims by explicit id, exact text match, or creates a fresh row.

## 0.3.9

- Slice extraction skips bullet lines, so a prompt's file list can no longer become the Now row title.

## 0.3.8

- Slice titles are extracted from the first informative line of a spawn prompt, not just line one — prompts that open with "You are a Goal worker..." boilerplate now yield the real task, so Now rows stop repeating the agent name.

## 0.3.7

- Recently finished workers without a slice link also claim from their spawn prompt (link-only, never minting new items), so their done reports close the right slice via reconcile.
- Slice claims match an existing unheld open item by text before creating a new one, preventing duplicate plan rows.

## 0.3.6

- Discovered native children claim their slice from the spawn prompt (SLICE item_id and text), so their Now rows show the task instead of repeating the agent name, the plan item leaves Up next while it is worked, and idle completion closes it.
- An explicit item reference in a spawn prompt claims even when no slice title can be extracted.

## 0.3.5

- Children the orchestrator spawns natively (outside spawn_agent) are discovered on every pane refresh, so they get Now rows and — critically — auto-approval. Their approval prompts (command runs, file changes) no longer sit waiting for the user.
- The approval sweep reads registered children from the store directly instead of a cache that could lag behind discovery.

## 0.3.4

- One agent = one slice, permanently. Workers are never reused across slices: followup_task no longer reassigns work, refuses retired workers whose slice is completed, and the orchestrator is instructed to spawn a fresh agent per slice. Thread reuse was why Now rows opened onto chats full of unrelated finished slices.
- Live native Task calls are no longer guess-paired onto plan items; they render as their own honest rows instead of borrowing a stale title and an idle named lead.
- A live agent always fronts its Now row; an idle named worker can no longer be shown as the lead of someone else's running work.

## 0.3.3

- Now is strictly the live list: one row per running subagent, titled by its slice. Open slices without a running worker move to Next until a worker picks them up.
- Crew thread statuses refresh on every pane update so liveness reflects reality, not cache defaults.

## 0.3.2

- A finished worker now finishes its slice: with verification off, the worker's own done report completes the plan item; with verification on, only VERIFY_PASS does. A reconcile sweep also closes slices whose workers finished earlier.
- Now rows never point at an unrelated thread: agents keep only the item links they actually claimed. Rows without a real worker say "Waiting for a worker" instead of borrowing an idle agent.

## 0.3.1

- Approval gates on the goal tree are bypassed: workers and verifiers spawn with full permissions, steering and follow-ups carry full permissions, and any approval interaction that still appears (command, file change, permission, plan) is auto-resolved within seconds, session-wide when the provider allows it. User questions still reach the user.
- Workers fork as plugin-origin children, so bb no longer posts "needs help" / active-child notifications into the root chat; crew state lives in the UltraGoal pane.
- Now lists every open in-progress slice again (plus any live agent without a slice), so the Now count always reconciles with the done/total counter.

## 0.3.0

- Codex-Goal-style event projection: Now derives live subagents from the root thread's own tool-call events, scoped to the open turn, so every native Cursor Task shows as its own row while it runs and disappears when it finishes or the turn ends.
- The model-owned plan (turn/plan/updated) is mirrored into the UltraGoal plan, latest snapshot wins, without touching completed history.
- UltraGoal no longer steers a progress check-in while native Task subagents are pending; those injections were interrupting Cursor's spawned workers mid-run.
- Pending Task calls orphaned by a steering interrupt age out instead of lingering as ghost Now rows.

## 0.2.7

- spawn_agent and followup_task open a new Now row when the old slice is taken or finished, so the pane tracks the current leftovers.

## 0.2.6

- Now is one row per open plan item. In-thread Cursor Task calls no longer appear as extra Now workers.

## 0.2.5

- Now ignores leftover Cursor timeline Task rows. A Task only stays in Now when its thread event is still open.

## 0.2.4

- Now is one live subagent per row. Finished workers and duplicate Cursor Task events no longer pile up.
- Token totals follow the current Cursor session sum instead of freezing on an old maximum.

## 0.2.3

- Now lists every live Cursor Task / subagent on the root thread, not just one in-progress plan item.

## 0.2.2

- Now shows the assigned worker even when Cursor reports the thread idle.
- Now and worker thread titles use a short generated slice title, not the full prompt.

## 0.2.1

- Register only `bb ultragoal` so a leftover `bb goal` command cannot block startup.

## 0.2.0

- The plugin is UltraGoal: `/ultragoal`, `bb ultragoal`, plugin id `ultragoal`.
- Now titles drop leftover `NEXT: shipped` wrappers so the current slice stays visible.

## 0.1.6

- Plan items keep a stable id when their step text changes, so Now titles update in place.
- Next is only unstarted work. A live worker's current slice stays in Now, not a reused slot.

## 0.1.5

- Sidebar stays a single Goal-marked row. Crew no longer reappears after a plugin reload.
- The host expand/collapse caret is hidden on Goal threads.

## 0.1.4

- Auto-continue stays on, but the root thread no longer posts a status dump every turn.
- Visible chat updates only when a slice finishes, a worker fails, or the progress interval is due.

## 0.1.3

- Goal pane returns the stored plan immediately; crew and tokens fill in over realtime.
- Cursor token totals use cursortrack (ACP session stores and IDE composers), not visible-text estimates.
- Continuation prompts stay agent-only. A busy thread no longer dumps the prompt into chat.
- Crew listing no longer refetches every historical worker on each pane or sidebar poll.

## 0.1.2

- Previous starts collapsed.

## 0.1.1

- Plan rows are read-only; only the agent updates them. Now rows expand for worker detail.
- Sidebar stays a single Goal-marked thread. Crew details stay in the Goal pane.
- Finished slices complete automatically so Done/Now stay in sync with live workers.
- Goal stays Active and the timer runs while any worker is in flight.

## 0.1.0

- Durable `/goal` for Cursor, OpenCode, Claude Code, and Pi (Codex uses native Goal).
- Orchestrator root with named hidden workers and plan items; sidebar stays a single Goal row.
- Optional second-model verification after each worker returns.
- Per-goal Settings: verify, verifier model, progress chat, auto-continue, token budget.
- `bb goal` CLI for status, set, edit, pause, resume, and clear.
