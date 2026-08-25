# UltraGoal

A [BB](https://getbb.app) plugin that adds one provider-neutral durable UltraGoal system on Codex, Cursor, OpenCode, Claude Code, and Pi.

The root thread is the orchestrator. It keeps a durable objective, a requirement plan, and a crew of named subagents. Workers implement slices. Optional verifiers check finished work on a second model.

## Install

After the community marketplace listing is approved:

```bash
bb plugin install ultragoal@bb-community
```

Until then, install the tagged release from this repository:

```bash
bb plugin install 'git:https://github.com/braedonsaunders/bb-plugin-ultragoal.git@v0.17.8'
```

Or from a local checkout:

```bash
cd bb-plugin-ultragoal
npm install
bb plugin install . --yes
```

Reload after source edits with `bb plugin reload ultragoal`.

## Use

In a thread on any supported provider:

```text
/ultragoal Ship the ledger export with tests and a reviewable PR
```

Other commands:

```text
/ultragoal                  # status
/ultragoal edit <objective> # change the contract
/ultragoal pause
/ultragoal resume
/ultragoal clear
```

CLI (from a thread, or pass `--thread`):

```bash
bb ultragoal
bb ultragoal set "Ship the ledger export"
bb ultragoal pause
bb ultragoal resume
bb ultragoal clear
```

The UltraGoal pane lists **Now** (expand a row for the live worker), **Up next** (blocked work gets a chip), and **Previous**. Its headline metrics distinguish **Work items** from **Defects** because related defects can share one repair item. The plan is read-only in the pane; the agent updates it. Settings control verification, verifier and worker models, progress-chat interval, worker slots, auto-continue, remediation capacity, and the token budget.

The canonical agent controls are `ultragoal_start`, `ultragoal_state`, `ultragoal_patch`, and `ultragoal_finish` on every provider. Codex never receives the legacy Goal-named controls because those names collide with native Codex tools and mutate unrelated state. Non-Codex providers temporarily retain `create_goal`, `get_goal`, `update_plan`, and `update_goal` as migration aliases.

## How it runs

The split follows the research in [docs/architecture-research.md](docs/architecture-research.md): the model plans, deterministic code schedules.

1. The orchestrator calls `ultragoal_patch` with new or changed work as a dependency-DAG patch: every work item carries `files` (its disjoint file scope), `check` (a runnable done-gate), and `deps` (what it waits for; `[]` = ready now). Omitted work remains durable, batches cap at 200, and `ultragoal_state` pages large plans 40 rows at a time by default.
2. The ready-queue scheduler staffs one fresh worker per ready work item — deps complete, file scopes disjoint — up to the worker limit (default 5). Assigned workers occupy a slot until their item closes, including idle Codex turns. Pause stops the whole crew and parks in-progress work.
3. Hunt/audit work streams defects through `report_finding`. Exact-file related defects share repair work; new repair work is created until remediation capacity (the persisted `maxOpenFindings` setting) is full. Overflow waits durably and backfills oldest-first as capacity frees, including after restart. Open defects block completion.
4. Workers stay hidden and implement only their item, reporting evidence (commit SHAs, check output). Every brief carries a generalized quality bar ([templates/goals/worker_brief.md](templates/goals/worker_brief.md)) — reuse-first, complete production-grade work, clean cutover, honest gates, crew-safe atomic commits — with the repo's own AGENTS.md taking precedence. They do not call `ultragoal_finish` or rewrite the parent plan.
5. When verification is on (default), a second model audits each finished worker. The orchestrator should not mark that work item complete until `VERIFY_PASS`.
6. If several minutes pass with no visible main-thread update, the plugin nudges the orchestrator to post one.

`ultragoal_patch` is the only plan source: there is no provider-native todo mirror, prose report parsing, or legacy staffing path. It atomically patches only supplied rows, so a one-item status change never retransmits a 1,000-item UltraGoal. Every ready item is the scheduler's to staff.

## Root transfer

An unfinished UltraGoal can move to a replacement root in the same project and environment without changing its workers or durable history:

```bash
bb ultragoal transfer-root <source-thread> <target-thread> --dry-run
bb ultragoal transfer-root <source-thread> <target-thread>
```

The target must be an idle empty root with no UltraGoal-owned rows or worker identity collision. Transfer uses a durable, restartable journal: it stops both runtimes, atomically moves plugin-owned state, archives the source, reparents only live direct workers, verifies parity, then wakes the target once. Existing worker/provider pins, settings, tokens, plan, defect metadata, decisions, and cursors are preserved.

## Requirements

- BB `>= 0.39`
- Plugin SDK `>= 0.4.8`

## License

MIT
