---
name: goal
description: Set a durable Codex-style Goal and keep working until it is done. Use whenever the user types /goal, asks to follow a goal, keep going until a target is met, pause/resume/clear a goal, or wants long-horizon autonomous work on Cursor, OpenCode, Claude Code, or Pi.
---

# Goal

The user wants a durable completion contract, not a one-off turn. The text after `/goal` is the objective.

This skill is for Cursor, OpenCode, Claude Code, and Pi. Codex already has native Goal — do not duplicate it there.

## Default: orchestrator + subagents

The root thread is the orchestrator. It does not implement the Goal itself.

1. Call `update_plan` with concrete remaining work.
2. Mark independent slices `in_progress`.
3. `spawn_agent` one worker per in-progress slice (several in the same turn). Give each a humorous `display_name` (e.g. "Sir Syncs-a-Lot") and pass `item_id` from `get_goal` so they nest under that Now task.
4. Stay on the root: `list_agents` / `wait_agent`, merge results, `update_plan` as steps complete or the next best action changes, spawn the next slices.
5. When verification is on, a second model (default Codex GPT-5.6-Sol) is launched after each worker returns. Do not mark that slice complete until the verifier reports `VERIFY_PASS`. On `VERIFY_FAIL`, spawn a fix worker.
6. Do implementation, edits, and deep investigation on workers. On the root, only plan, spawn, wait, verify, and unblock.

Spawn even for a single remaining slice. Work locally on the root only when a slice is too small to hand off (one obvious edit) or spawn failed.

Workers complete their assigned slice and report evidence. They do not call `update_goal`, take over the parent plan, or re-orchestrate the whole Goal.

## Commands

- `/goal <objective>` — set or replace the Goal, then start orchestrating.
- `/goal` — report the current Goal with `get_goal`.
- `/goal edit <objective>` — user-edited contract; keep working toward the new objective.
- `/goal pause` / `/goal resume` / `/goal clear` — user or system controls. Do not implement these with tools.

## Tools

- `get_goal` — read status, token budget, tokens used, elapsed time, the requirement plan, and live subagents.
- `create_goal` — only when the user or system explicitly asked to start a Goal, and only when no unfinished Goal exists. Do not infer a Goal from an ordinary task. Set `token_budget` only when the user asked for one.
- `update_goal` — `complete` or `blocked` only. You cannot pause, resume, clear, or budget-limit a Goal.
- `update_plan` — same contract as Codex. Provide `plan` (and optional `explanation`). Each item is `{ id?, step, status }`. Pass `id` from `get_goal` when updating an existing slice so its Now title changes in place. Keep status `in_progress` for live workers. Next is only work that has not started — do not park a worker's current slice there.
- `spawn_agent`, `send_message`, `followup_task`, `list_agents`, `wait_agent`, `interrupt_agent` — Codex MultiAgentV2. This is the default execution path. `send_message` queues without starting a turn; `followup_task` wakes a non-root agent.

## How to run

The Goal persists across turns. Ending a turn does not shrink the objective. If it cannot be finished now, leave workers running or spawn the next slices, keep the Goal active, and do not redefine success around a smaller task.

Work from current evidence in the worktree. Do not treat memory, intent, or a plausible summary as proof of completion.

Do not stop to ask whether you should continue. A later plugin turn will continue the Goal while it is active. Treat that as permission to keep orchestrating, not as a new task.

Do not narrate ordinary orchestration turns. The Goal pane already shows Now and crew. Write a short visible chat update only when a slice actually completed, a worker failed, you are blocked, or a progress-check-in turn explicitly asks for one. Never post a "still in flight" / "nothing new has shipped" note.

## Completion

Call `update_goal` with status `complete` only when current evidence proves every requirement and no required work remains. If the Goal has a token budget, report the final consumed tokens after that call succeeds.

## Blocked

Do not call `update_goal` with status `blocked` the first time a blocker appears. Use `blocked` only when the same blocking condition has repeated for at least three consecutive Goal turns and you cannot make meaningful progress without the user or an external-state change. Never use `blocked` because the work is hard, slow, uncertain, or would benefit from clarification.

Do not mark a Goal complete because the budget is nearly exhausted or because you are stopping work.
