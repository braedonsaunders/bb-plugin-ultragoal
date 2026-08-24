---
name: ultragoal
description: Set a durable Codex-style UltraGoal and keep working until it is done. Use whenever the user types /ultragoal or /goal, asks to follow an UltraGoal, keep going until a target is met, pause/resume/clear an UltraGoal, or wants long-horizon autonomous work on Cursor, OpenCode, Claude Code, or Pi.
---

# UltraGoal

The user wants a durable completion contract, not a one-off turn. The text after `/ultragoal` (or `/goal`) is the objective.

This skill is for Cursor, OpenCode, Claude Code, and Pi. Codex already has native Goal — do not duplicate it there.

## Default: you plan, the scheduler staffs

The root thread is the orchestrator and PLANNER. It does not implement the UltraGoal itself, and it does not staff plan slices — the UltraGoal scheduler does.

1. Call `update_plan` with the remaining work as a dependency DAG. Every item is a self-contained slice brief: `step` (objective + boundaries), `files` (the disjoint file scope it owns), `check` (a runnable command that proves it done), `deps` (item_ids or `"#N"` list positions it must wait for; `[]` = ready now).
2. The scheduler spawns one FRESH worker per READY slice automatically — deps complete, file scopes disjoint — up to the goal's worker slots (default 5), and re-staffs slices whose workers die. Do not spawn workers for plan items yourself.
3. Plan WIDE: many independent, file-disjoint slices beat few coarse ones. Declare `deps` only for genuinely sequential work; never pad fake parallelism onto truly sequential work. When worker slots sit idle, the highest-value move is splitting remaining work into more independent slices via `update_plan`.
4. Hunts stream. Never write catch-all tail items like "fix whatever the hunt proves": hunt/audit workers call `report_finding` per confirmed defect, each finding auto-creates a ready fix slice, and fixes are staffed while the hunt continues. Open findings block completion; `resolve_finding` (with evidence) anything that is not a real defect.
5. Stay on the root: `list_agents` / `wait_agent`, merge results, `update_plan` as steps complete or the next best action changes. Never use the native Task tool for slice work — it blocks the root thread, and a blocked orchestrator is the slowest possible path.
6. When verification is on, a second model (default Codex GPT-5.6-Sol) is launched after each worker returns. Do not mark that slice complete until the verifier reports `VERIFY_PASS`. On `VERIFY_FAIL`, add a fix slice.
7. One agent = one slice, always: retired workers refuse follow-ups; `followup_task` only steers a worker about the slice it already owns. `spawn_agent` remains for ad-hoc helpers outside the plan — give each a humorous `display_name` related to its work (e.g. "Captain Typecheck"), and begin any worker prompt spawned another way with one line `SLICE (item_id=<id>): <one-line task>` so UltraGoal can track it.

Workers complete their assigned slice and signal completion via the slice_done tool (evidence: commit SHAs + their check's passing output) or slice_blocked — formal tool calls, never prose sentinels. Every worker brief carries a generalized engineering quality bar (reuse-first with a named exemplar, complete production-grade slices, clean cutover, green gates without weakening tests, atomic commits that never touch unedited files, report_finding for unrelated bugs) — the repo's own AGENTS.md/CLAUDE.md wins where they conflict. Workers do not call `update_goal`, take over the parent plan, or re-orchestrate the whole UltraGoal.

## Commands

- `/ultragoal <objective>` — set or replace the UltraGoal, then start orchestrating.
- `/ultragoal` — report the current UltraGoal with `get_goal`.
- `/ultragoal edit <objective>` — user-edited contract; keep working toward the new objective.
- `/ultragoal pause` / `/ultragoal resume` / `/ultragoal clear` — user or system controls. Do not implement these with tools.

## Tools

- `get_goal` — read status, token budget, tokens used, elapsed time, the requirement plan, and live subagents.
- `create_goal` — only when the user or system explicitly asked to start an UltraGoal, and only when no unfinished UltraGoal exists. Do not infer an UltraGoal from an ordinary task. Set `token_budget` only when the user asked for one.
- `update_goal` — `complete` or `blocked` only. You cannot pause, resume, clear, or budget-limit an UltraGoal.
- `update_plan` — the dependency DAG the scheduler executes. Provide `plan` (and optional `explanation`). Each item is `{ id?, step, status, deps?, files?, check? }`. Pass `id` from `get_goal` when updating an existing slice so its Now title changes in place. Keep status `in_progress` for live workers. Next is only work that has not started — do not park a worker's current slice there.
- `report_finding` / `resolve_finding` — the streaming defect queue. One `report_finding` per confirmed defect, at the moment of confirmation; duplicates are fingerprint-deduped across sweeps; each fresh finding auto-creates a staffed fix slice. Open findings block `update_goal complete`.
- `spawn_agent`, `send_message`, `followup_task`, `list_agents`, `wait_agent`, `interrupt_agent` — Codex MultiAgentV2, for ad-hoc helpers and steering. Plan slices are staffed by the scheduler, not by you. `send_message` queues without starting a turn; `followup_task` steers a non-root agent about its own slice only (retired workers refuse it).

## How to run

The UltraGoal persists across turns. Ending a turn does not shrink the objective. If it cannot be finished now, leave workers running or spawn the next slices, keep the UltraGoal active, and do not redefine success around a smaller task.

Work from current evidence in the worktree. Do not treat memory, intent, or a plausible summary as proof of completion.

Do not stop to ask whether you should continue. A later plugin turn will continue the UltraGoal while it is active. Treat that as permission to keep orchestrating, not as a new task.

Do not narrate ordinary orchestration turns. The UltraGoal pane already shows Now and crew. Write a short visible chat update only when a slice actually completed, a worker failed, you are blocked, or a progress-check-in turn explicitly asks for one. Never post a "still in flight" / "nothing new has shipped" note.

## Completion

Call `update_goal` with status `complete` only when current evidence proves every requirement and no required work remains. If the UltraGoal has a token budget, report the final consumed tokens after that call succeeds.

## Blocked

Do not call `update_goal` with status `blocked` the first time a blocker appears. Use `blocked` only when the same blocking condition has repeated for at least three consecutive UltraGoal turns and you cannot make meaningful progress without the user or an external-state change. Never use `blocked` because the work is hard, slow, uncertain, or would benefit from clarification.

Do not mark an UltraGoal complete because the budget is nearly exhausted or because you are stopping work.
