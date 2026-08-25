---
name: ultragoal
description: Start and run a durable UltraGoal until it is genuinely finished. Use on every provider, including Codex, OpenCode, Claude Code, Cursor, and Pi, whenever the user invokes /ultragoal or /goal, asks to keep going until a target is met, or asks to pause, resume, edit, clear, or inspect an UltraGoal.
---

# UltraGoal

UltraGoal is one provider-neutral completion contract backed by the plugin's durable database, work-item scheduler, defect queue, and pane. Use the canonical `ultragoal_*` tools on every provider.

On Codex, never create or update a native Codex Goal for UltraGoal work. Native `create_goal`, `get_goal`, `update_goal`, and `update_plan` names collide with UltraGoal's former names and operate on different state. Non-Codex providers may temporarily expose those old names as migration aliases, but new work and instructions use only the canonical controls below.

## Canonical controls

- `ultragoal_start` — start a durable UltraGoal only when the user or system/developer instructions explicitly request one. Do not infer an UltraGoal from an ordinary task. Set `token_budget` only when explicitly requested. It fails while an unfinished UltraGoal exists.
- `ultragoal_state` — read status, usage, settings, counts, active workers, open decisions and defects, and a bounded work-item page. It defaults to 40 open work items. Continue with `plan_status`, `plan_cursor`, and `plan_limit` (maximum 100).
- `ultragoal_patch` — atomically patch the dependency plan. Send only new or changed work items, at most 200 per call; omitted work remains durable. Each row is `{ id?, step, status, deps?, files?, check? }`. Pass an existing `id` from `ultragoal_state` when updating it. Use `remove_item_ids` only for obsolete, unstaffed work; unknown IDs and partial patches are rejected.
- `ultragoal_finish` — mark an UltraGoal `complete` or genuinely `blocked`. Completion requires a substantive delivery summary and no remaining work, open defects, or owner decisions. It cannot pause, resume, clear, or budget-limit an UltraGoal.

Supporting controls are `report_finding`, `resolve_finding`, `request_decision`, and `resolve_decision`. Collaboration tools are available for ad-hoc helpers and worker steering; scheduled work items are staffed by UltraGoal itself.

## Start and user commands

- `/ultragoal <objective>` or `/goal <objective>` sets or replaces the user-owned objective and begins orchestration.
- `/ultragoal` reports the current state with `ultragoal_state`.
- `/ultragoal edit <objective>` changes the contract; reconcile the plan to the new objective.
- `/ultragoal pause`, `/ultragoal resume`, and `/ultragoal clear` are user or system controls. Do not simulate them with agent tools.

If the user explicitly asks for an UltraGoal through normal language instead of a slash command, call `ultragoal_start`. Merely having the skill and tools available does not authorize creating one. With no stored UltraGoal, stay inert until explicit invocation.

## Plan; let the scheduler staff

The root thread orchestrates. Implementation belongs to automatically staffed workers by default.

1. Call `ultragoal_patch` with independent work items. Give each item a complete objective and boundaries in `step`, a narrow disjoint `files` scope, a runnable `check`, and only real `deps`. Use `[]` when it is ready now.
2. The scheduler starts one fresh worker per ready, file-disjoint work item, up to the configured worker limit, and replaces workers that fail. Do not manually spawn workers for plan items.
3. Plan wide when the work genuinely splits. Prefer independent file scopes over a few coarse items, but never manufacture parallelism for sequential work.
4. Keep the plan current as evidence changes. Patch only affected rows. A worker's current item stays `in_progress`; do not create a second pending row for work already underway.
5. Stay on the root to inspect, integrate, verify, wait, and unblock. Do not implement scheduled work on the root and do not use a provider-native Task tool for it.

Workers close assigned work through `slice_done` with commit and passing-check evidence, or `slice_blocked` when they cannot proceed. One worker owns one work item. Retired workers are not reused. Repository instructions such as `AGENTS.md` or `CLAUDE.md` take precedence over the general worker brief where they conflict.

## Defects

Hunt, audit, and review workers call `report_finding` for each confirmed defect as soon as it is proven. Related defects can share one work item, so Defect and Work item totals differ.

UltraGoal deduplicates defects, assigns same-file defects to existing repair work where safe, and creates new repair work until remediation capacity is full. Additional defects wait durably and are assigned oldest-first as capacity frees, including after restart. Use `resolve_finding` with evidence only when a defect was fixed outside its assigned work or is not actually a defect. Open defects block completion.

Use `request_decision` only for a choice the user must make. Continue everything that does not depend on an unanswered decision; do not repeatedly ask or silently assume an answer.

## Durable operation

An UltraGoal persists across turns. Ending a turn does not narrow its objective. Work from the current worktree, checks, commits, deployed state, and tool results; a memory or prior summary is context, not proof.

Do not narrate routine orchestration. The pane already shows work and workers. Send a visible update when something lands, a worker fails, a decision is needed, or a progress-check turn requests one.

## Completion and blocked state

Call `ultragoal_finish` with `status: "complete"` only when current evidence proves every requirement and no required work, open defect, or owner decision remains. Include `summary` with what shipped, where it lives (such as final SHA, URL, or deploy state), and how it was verified. If a token budget exists, report final consumed tokens from the returned state.

Call `ultragoal_finish` with `status: "blocked"` only after the same blocking condition has repeated for at least three consecutive UltraGoal turns and no meaningful work can continue without user input or an external change. Do not use blocked merely because work is difficult, slow, uncertain, incomplete, or would benefit from clarification. Do not finish or block an UltraGoal just because its budget is nearly exhausted.
