# Changelog

## 0.7.0

Every worker brief now carries a generalized engineering quality bar (templates/goals/worker_brief.md), distilled from production AGENTS.md standards and kept repo-agnostic — the repository's own agent docs win wherever they conflict:

- Reuse before building: name the exemplar file, compose its exact primitives, extend shared code instead of forking it, never a parallel source of truth.
- Complete production-grade slices: no stubs/placeholders/TODO behavior/fake success paths; real error or disabled states; invariants enforced at the deepest boundary; deterministic, idempotent, fail-closed.
- Clean cutover: replaced code gets deleted — no shims, dead files, unused exports, or shadow systems.
- Honest gates: run the repo's own format/typecheck/lint/test/build; never commit on red; never ts-ignore/eslint-disable/--no-verify/weaken a test to pass; costly-if-silently-wrong changes ship invariant + boundary tests in the same change; UI slices verified in the running app.
- Crew-safe git: focused atomic commits, stage only intentionally-changed files, never revert or reformat files you did not edit.
- Unrelated bugs: fix small ones, report_finding the rest — never silently ignore.

Verifiers audit the same bar (fail stubs, weakened tests, dead code, out-of-slice edits), and planner guidance now prefers the repo's own gates as slice checks.

## 0.6.1

Live-goal monitoring caught a restaff hazard; two structural guards close it:

- A slice whose step declares a live thread ("— thr_x running") is held — the declared owner just claimed a different item id from its spawn prompt — and is never double-staffed. Orchestrators even write "SOLE owner thr_x" into their todos; the scheduler now believes them.
- An unmanaged in_progress slice the crew never touched is a native-todo mirror line, often a ghost of work already live under another item id. While the root runs free it stays the orchestrator's to staff; the scheduler takes it over only when the root is blocked (the original rescue semantics). Previously-held slices whose workers all died still restaff unconditionally.

## 0.6.0

- Sidebar provider marks moved out into their own plugin, [Thread Provider Icons](https://github.com/braedonsaunders/bb-plugin-thread-provider-icons). Drawing every thread's provider logo was generic chrome that had nothing to do with goals, and bundling it meant you could not have the icons without UltraGoal or UltraGoal without the icons. Install `thread-provider-icons` to keep them. UltraGoal's own sidebar marks — the goal pill and worker-row hiding — are unchanged, as is the provider icon in the thread header.

## 0.5.1

Provenance over heuristics — structural facts replace string classifiers:

- Worker nicknames are provenance-based: an explicit display_name is used verbatim; everything else (discovered natives, scheduler/rescue spawns) gets a work-related name generated from its slice text. The linguistic "is this string name-like?" classifier is gone; discovery no longer copies thread titles into display_name, and a one-time migration renames existing crew whose display_name was that copy.
- Restaffing is one rule in one place: any in_progress slice unheld past the stale window is restaffed by the scheduler, whatever its origin — the special-cased "rescue only while the root is blocked" branch is deleted. Pending slices still require the DAG contract; legacy plans keep model staffing.
- The prose done-report fallback is provenance-gated: workers spawned through the plugin's contract must report ULTRAGOAL_DONE; prose interpretation remains only for native/discovered workers that never received the contract.
- Twin-item fix: a discovered worker's prompt-source claim re-links an open slice whose previous workers are all dead, instead of minting a duplicate item (orchestrators respawn died natives under the same title, which put two live workers on the same work).
- New CLI: `bb ultragoal workers <0-16>` sets the goal's concurrent worker slots.

## 0.5.0

The model plans, deterministic code schedules. Research synthesis across Anthropic's multi-agent guidance, shipped industry systems (Codex cloud, Gas Town/beads, MultiDevin), and the academic scheduling literature (LLMCompiler, ADaPT, MAST) is in docs/architecture-research.md; this release implements it:

- **Dependency-DAG plan.** update_plan items now carry `deps` (item_ids or `"#N"` list positions; `[]` = ready now), `files` (the disjoint file scope the slice owns), and `check` (a runnable done-gate). Omitted fields keep the item's existing metadata; deps pointing outside the plan are dropped so a typo cannot deadlock a slice. Items with no metadata stay on the legacy nudge-staffing path, so live pre-0.5 goals migrate on their next full plan update.
- **Ready-queue scheduler.** The plugin staffs one fresh worker per ready slice — deps complete, file scopes disjoint from in-flight work — up to the goal's worker slots (setting + per-goal override, default 5), and re-staffs managed slices whose workers died (husk detection distinguishes dead workers from idle ones awaiting close). Dispatch is event-driven: a finishing worker immediately unblocks and staffs its dependents. Under-parallelization stops being a model-memory problem: the orchestrator's job is to plan wide (the WIDTH nudge demands further decomposition while slots sit idle, and never padding fake parallelism onto sequential work); staffing is no longer its job at all.
- **Streaming findings queue.** Hunt/audit workers call the new report_finding tool per confirmed defect — fingerprint-deduplicated across sweeps (same file + same defect = same finding) — and each fresh finding auto-creates a ready, file-scoped fix slice that the scheduler staffs while the hunt continues. This kills the serial "fix whatever the hunt proves" tail. Open findings hard-block update_goal complete; resolve_finding (with evidence) handles non-defects, and a completed fix slice closes its findings automatically.
- **Attestation-grade reports.** Worker briefs demand evidence — commit SHAs and the slice's check output — and inject the slice's scope and done-check into the spawn prompt. ULTRAGOAL_DONE without evidence is a claim, not a completion.
- **Work-related humorous names.** Plugin-spawned workers derive their display names from the slice's own text ("Captain Suites", "The Idempotency Reckoning") instead of a generic pool, and the orchestrator guidance asks for the same.
- Pane: Up next shows a "blocked" chip for slices with unmet deps; Settings gains a Worker slots input; the header shows the slot count; `bb ultragoal pane` includes findings counts.

## 0.4.11

Now is verified against the provider's own subagent lifecycle, and stalls get healed instead of displayed:

- Task calls pair to OpenCode's part state by call id (bb's toolCall id equals OpenCode's callID), making the provider store the liveness authority. This kills two phantom-row bugs: OpenCode rewrites the tool name on completion (so bb-side scans left every finished task dangling open), and killed subagents never emit a completion at all. Running task rows are titled from the call's own description.
- Completed task reports are harvested: a finished subagent's final report (returned to the parent task call) closes its slice when it says done, instead of waiting minutes for the orchestrator's todo list to catch up while it is blocked inside the next task call.
- Stalled workers are nudged: a worker that goes idle holding an open slice without reporting gets a direct follow-up to resume, finish, and report.
- Abandoned slices are rescued: when a slice's worker died and the root turn is blocked on open task calls (so the orchestrator cannot re-staff), UltraGoal spawns a rescue worker through the same machinery as spawn_agent, with error cleanup and retry cooldown. When the root is free, staffing stays with the orchestrator.
- Fuzzy title-to-item linking: provider-paraphrased task titles ("Wave 2c hunt: org-scoping sweep") link to their plan items by token overlap, so a running slice cannot also sit in Up next.
- "Orchestrator" attribution only applies while the root turn runs free; a root blocked on task calls is not hand-working other slices. A slice with a known holder is never attributed to the orchestrator.
- OpenCode token accounting sums the whole session tree — task subagents run as child sessions whose usage was previously invisible.
- New debug command: `bb ultragoal pane` dumps the exact sidebar projection as JSON.

## 0.4.10

- Live native subagents are named from the provider's own lifecycle store. OpenCode records every task subagent as a child session (with its real title) in opencode.db the moment it starts, so running task rows now show that title instead of an anonymous "Subagent task" — even when bb never materializes a thread for the subagent. A named row whose title matches an open plan item links to it, so the same slice can't render twice.

## 0.4.9

- New workers register the moment their thread starts. bb's thread.active lifecycle event now triggers immediate crew registration for goal-tree children, so a freshly spawned subagent renders as a named worker right away instead of flashing through anonymous "Subagent task" rows until the next discovery poll.
- A slice with a known holder is always attributed to that worker. "Orchestrator" is reserved for slices no worker ever claimed while the root turn is running — it can no longer steal a slice whose worker just went idle awaiting close.

## 0.4.8

- Parallelize by default, enforced concretely. Continuation and progress prompts now enumerate every open slice with no live worker and demand one fresh spawn_agent per slice in the same turn, instead of stating an abstract "don't implement on the root" rule the model can ignore. Skill and templates updated to match: spawning is the default for all work; inline root work is reserved for genuinely one-edit slices.

## 0.4.7

- Now rows are attributed to whoever is actually on the work. A started slice no live worker holds is the orchestrator's own work while the root turn is running — it renders live as "Orchestrator", not "idle". Only when the root is idle too does a slice show as unattended.

## 0.4.6

- Up next is untouched work only. Started slices no live worker holds now render in Now as dimmed idle rows ("begun, then left unattended") instead of sitting under Up next, where they read as not started — or worse, as checked off. Idle rows link to their last worker's thread when one claimed the slice.

## 0.4.5

- Up next rows that are started but unattended now carry an explicit "in progress" label. The dot-in-box marker alone read like a checked checkbox, making in-progress items look completed.

## 0.4.4

- Zero type errors against the pinned SDK; the repo typechecks and builds clean. Real fixes, not suppressions: collab tools return proper tool-result payloads, spawn/fork/send calls match the SDK's exact argument shapes, pending interactions are checked through the interactions API instead of a nonexistent thread flag, provider/model listing passes well-formed scopes, and the stored goal type no longer pretends to carry live snapshot fields.

## 0.4.3

- Token accounting works on every provider, not just Cursor. Usage is read straight from each provider's own session store — OpenCode's opencode.db message tokens, Claude Code's ~/.claude/projects JSONL usage lines, Codex's rollout total_token_usage — keyed by the thread's provider session id, on top of the existing Cursor readers. Goals orchestrated by OpenCode/Claude/Codex no longer sit at "Tokens 0".
- Providers with no local store fall back to bb's context-window usage snapshot instead of freezing at zero.

## 0.4.2

- Plan steps that declare their worker ("Hunt B: … — worker thr_x") now link that worker to the slice. Orchestrators that write assignments into the plan instead of passing item_id get correctly titled Now rows, and the declared slice leaves Up next. The "worker thr_x" annotation is stripped from displayed titles.
- Generic "Subagent task" rows are no longer synthesized for native Task calls that materialize real child threads (OpenCode ACP does this): the discovered child already renders a named row, so synthetics only cover the surplus of live calls over live child workers. Cursor, whose Task calls spawn no threads, is unaffected.
- Slice titles keep their descriptive half: "Hunt B: feature-gate holes outside dashboard chips" no longer collapses to "Hunt B".

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
