# Changelog

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
