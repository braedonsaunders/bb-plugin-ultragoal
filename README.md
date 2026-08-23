# UltraGoal

A [BB](https://getbb.app) plugin that adds Codex-style durable UltraGoals on Cursor, OpenCode, Claude Code, and Pi. Codex already has native Goal, so this plugin leaves those threads alone.

The root thread is the orchestrator. It keeps a durable objective, a requirement plan, and a crew of named subagents. Workers implement slices. Optional verifiers check finished work on a second model.

## Install

After the community marketplace listing is approved:

```bash
bb plugin install ultragoal@bb-community
```

Until then, install the tagged release from this repository:

```bash
bb plugin install 'git:https://github.com/braedonsaunders/bb-plugin-ultragoal.git@v0.4.11'
```

Or from a local checkout:

```bash
cd bb-plugin-ultragoal
npm install
bb plugin install . --yes
```

Reload after source edits with `bb plugin reload ultragoal`.

## Use

In a thread on Cursor, OpenCode, Claude Code, or Pi:

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

The UltraGoal pane lists **Now** (expand a row for the live worker), **Up next** (blocked slices get a chip), and **Previous**. The plan is read-only in the pane; the agent updates it. Settings control verification, the verifier model, progress-chat interval, worker slots, auto-continue, and the token budget.

Agent tools keep the Codex names (`get_goal`, `create_goal`, `update_goal`, `update_plan`) so orchestrators and Codex-style skills stay compatible.

## How it runs

The split follows the research in [docs/architecture-research.md](docs/architecture-research.md): the model plans, deterministic code schedules.

1. The orchestrator calls `update_plan` with the remaining work as a dependency DAG: every slice carries `files` (the disjoint file scope it owns), `check` (a runnable done-gate), and `deps` (what it waits for; `[]` = ready now).
2. The plugin's ready-queue scheduler staffs one fresh worker per ready slice — deps complete, file scopes disjoint — up to the goal's worker slots (default 5), re-staffs slices whose workers die silently, and dispatches newly-unblocked slices the moment a worker finishes. Workers get humorous names derived from their slice's work.
3. Hunt/audit slices stream: workers call `report_finding` per confirmed defect (fingerprint-deduplicated across sweeps), and each fresh finding auto-creates a ready fix slice that is staffed while the hunt continues. Open findings block goal completion.
4. Workers stay hidden and implement only their slice, reporting evidence (commit SHAs, check output). Every brief carries a generalized quality bar ([templates/goals/worker_brief.md](templates/goals/worker_brief.md)) — reuse-first, complete production-grade slices, clean cutover, honest gates, crew-safe atomic commits — with the repo's own AGENTS.md taking precedence. They do not call `update_goal` or rewrite the parent plan.
5. When verification is on (default), a second model audits each finished worker. The orchestrator should not mark that slice complete until `VERIFY_PASS`.
6. If several minutes pass with no visible main-thread update, the plugin nudges the orchestrator to post one.

Plans written before the DAG contract (no `deps`/`files`/`check` on any item) keep the old behavior: the orchestrator is nudged to staff slices itself and to re-emit the plan with DAG metadata.

## Requirements

- BB `>= 0.39`
- Plugin SDK `>= 0.4.8`

## License

MIT
