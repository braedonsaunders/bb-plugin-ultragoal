# Goal

A [BB](https://getbb.app) plugin that adds Codex-style durable Goals on Cursor, OpenCode, Claude Code, and Pi. Codex already has native Goal, so this plugin leaves those threads alone.

The root thread is the orchestrator. It keeps a durable objective, a requirement plan, and a crew of named subagents. Workers implement slices. Optional verifiers check finished work on a second model.

## Install

After the community marketplace listing is approved:

```bash
bb plugin install goal@bb-community
```

Until then, install the tagged release from this repository:

```bash
bb plugin install 'git:https://github.com/braedonsaunders/bb-plugin-goal.git@v0.1.5'
```

Or from a local checkout:

```bash
cd bb-plugin-goal
npm install
bb plugin install . --yes
```

Reload after source edits with `bb plugin reload goal`.

## Use

In a thread on Cursor, OpenCode, Claude Code, or Pi:

```text
/goal Ship the ledger export with tests and a reviewable PR
```

Other commands:

```text
/goal                  # status
/goal edit <objective> # change the contract
/goal pause
/goal resume
/goal clear
```

CLI (from a thread, or pass `--thread`):

```bash
bb goal
bb goal set "Ship the ledger export"
bb goal pause
bb goal resume
bb goal clear
```

The Goal pane lists **Now** (expand a row for the live worker), **Up next**, and **Previous**. The plan is read-only in the pane; the agent updates it. Settings control verification, the verifier model, progress-chat interval, auto-continue, and the token budget.

## How it runs

1. The orchestrator calls `update_plan` with concrete remaining work and marks independent slices `in_progress`.
2. It `spawn_agent`s one worker per in-flight slice, with a short display name and the plan `item_id`.
3. Workers stay hidden and implement only their slice. They do not call `update_goal` or rewrite the parent plan.
4. When verification is on (default), a second model audits each finished worker. The orchestrator should not mark that slice complete until `VERIFY_PASS`.
5. If several minutes pass with no visible main-thread update, the plugin nudges the orchestrator to post one.

## Requirements

- BB `>= 0.39`
- Plugin SDK `>= 0.4.8`

## License

MIT
