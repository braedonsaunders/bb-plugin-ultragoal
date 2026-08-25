# Orchestration architecture research — saturating UltraGoal

*2026-08-23. Research sweep across Anthropic guidance, shipped industry systems, academic scheduling literature, and verification/integration patterns, motivated by the observed under-parallelization of a live goal (2 workers instead of 4–5, blocking native task calls, serial "fix whatever the hunt proves" tails, silent worker deaths).*

## The problem, precisely

Observed on goal `thr_cj88rjtsfu` (11h, 44 items):

- Width 5 in the first wave, then ≤2 for the rest of the goal.
- The staffing nudge ("spawn one worker per open slice") parallelizes exactly as wide as the plan
  exposes — and the orchestrator plans narrow dependent waves: *[hunt A, hunt B, "fix whatever the
  hunts prove"]*. Staffable width ≈ 2 by construction.
- The orchestrator drifts to OpenCode's **blocking** native Task tool despite "prefer spawn_agent"
  guidance; while blocked it cannot receive staffing nudges (they queue until the turn ends).
- Native workers died silently; before v0.4.11 harvest/rescue nothing noticed.
- Structural root cause in the plugin: `goalItemSchema = {id, step, status}` — **no dependency
  field**, so the plugin cannot distinguish "ready" from "blocked" and cannot schedule anything
  itself. Staffing is prompt-nudge-only; the plugin never spawns for pending items (rescue only
  re-staffs dead in-progress ones).

## What the field does

### 1. Anthropic's own guidance

- [How we built our multi-agent research system](https://www.anthropic.com/engineering/built-multi-agent-research-system):
  numeric effort-scaling tiers live **in the orchestrator prompt** (simple = 1 agent/3–10 calls;
  comparison = 2–4 agents/10–15 calls; complex = 10+ agents with "clearly divided
  responsibilities") because without them the lead under/over-invests. Every delegation carries an
  **objective, output format, tool guidance, and task boundaries** — vague specs caused duplicate
  work and gaps. Their lead waits **synchronously** and they name that as the main bottleneck.
  Multi-agent ≈ 15× chat tokens.
- [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents):
  orchestrator-workers = runtime decomposition; parallelization = sectioning (independent subtasks)
  + voting; evaluator-optimizer loop when criteria are checkable.
- Claude Code itself ([subagents](https://code.claude.com/docs/en/sub-agents),
  [workflows](https://code.claude.com/docs/en/workflows),
  [best practices](https://code.claude.com/docs/en/best-practices)): background-by-default
  subagents (cap 20), and a **Workflow tool that moves scheduling out of the model into a
  deterministic script** — `pipeline()` (no barrier, per-item chains) is the default; every
  `parallel()` barrier must be justified; loop-until-two-rounds-dry; adversarial fresh-context
  verification; `/batch` = 5–30 workers, one worktree + PR each, disjoint file ownership; every
  worker gets **a check it can run**.

### 2. Shipped coding-agent systems

- [Cognition — Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents): the
  counterargument. Actions carry implicit decisions; parallel writers without shared context
  produce incompatible results. Refined 2026 position: **reads parallel, writes single-threaded**.
  Yet Cognition ships MultiDevin (manager + ≤10 workers) for "repeated, isolated, objectively
  verifiable" tasks — parallelism is gated on *task independence*, not banned.
- OpenAI Codex cloud / Cursor cloud agents / Copilot coding agent / Google Jules: all
  **fire-and-forget** — container-or-worktree per task, branch + PR out, no inter-task deps,
  integration serialized through merge queues / human review. Jules exposes literal concurrency
  slots (3/15/60); a community queue feeds it.
- [Steve Yegge's Gas Town + beads](https://yegge.ai/gastown): 20–30 concurrent agents kept busy by
  a **persistent git-backed work queue (beads) that idle workers claim** — saturation comes from
  the queue, not planner foresight. A dedicated **Refinery serializes all merges**; a Deacon
  watchdog patrols for stuck agents. Works brilliantly on independent well-specced tasks, falls
  apart on ambiguous ones.
- [AgenticFlict](https://arxiv.org/abs/2604.03551): 142k agent PRs — **27.67% merge-conflict
  rate**, rising ~10%→33% with PR size. Practitioner consensus: 2–5 concurrent writers, disjoint
  file domains up front, merge one branch at a time, rebase train.

### 3. Academic scheduling literature

- [LLMCompiler](https://arxiv.org/abs/2312.04511) (ICML 2024) — the key reference. **Planner LLM
  emits a task DAG** (task + args + deps, `$k` placeholders for upstream outputs, streamed);
  a deterministic **Task Fetching Unit** dispatches every dep-satisfied task immediately;
  an async executor runs them concurrently; the LLM re-enters only to **replan** when results
  invalidate the graph. 1.8–3.7× faster, up to 6.7× cheaper, more accurate than ReAct-style
  "ask the LLM what's next after each step".
- [HuggingGPT](https://arxiv.org/abs/2303.17580) (`dep` fields + resource placeholders),
  [ADaPT](https://arxiv.org/abs/2311.05772) (**decompose lazily — only when a worker fails**),
  [TDAG](https://arxiv.org/abs/2402.10178) (incremental re-decomposition).
- SWE systems: [Agentless](https://arxiv.org/abs/2407.01489) (fixed pipeline beats autonomous
  agents), [MASAI](https://arxiv.org/abs/2406.11638) (bounded per-stage agency),
  [CodeR](https://arxiv.org/abs/2406.01304) (pre-defined task graphs beat on-the-fly control),
  [MAGIS](https://arxiv.org/abs/2403.17927) (file-level subtasks are the parallel unit; QA agent
  worth measurable points).
- [Towards a Science of Scaling Agent Systems](https://arxiv.org/abs/2512.08296) (Google, 180
  configs): coordination gains **up to +81% on parallelizable tasks, −39…−70% on sequential
  ones**; **optimal team 3–4**; independent agents amplify errors **17.2×** vs **4.4×** under
  centralized orchestration. Don't pad fake width.
- [MAST — Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657): failures are
  architectural — specification 41.8%, inter-agent misalignment 36.9%, **verification/termination
  21.3%**.
- Async execution: [AsyncLM](https://arxiv.org/abs/2412.07017) (interrupt-driven non-blocking
  calls, 1.6–5.4× latency win), futures-style runtimes — never block the root.

### 4. Verification & integration

- [False success](https://arxiv.org/pdf/2606.09863): **44–52% of agent failures are confident
  completion claims contradicted by environment state** — verify programmatic state, never the
  claim. Attestation = commit SHA + fresh test output, re-run by an independent check.
- [CodeMonkeys](https://arxiv.org/abs/2501.14723) / TRAE / Agentless selection: sample + vote with
  model-generated tests; fingerprint/normalize findings before treating them as new.
- Claude Code best practices: **test-first slicing** — worker commits the failing test first
  (tamper-evidence), then fixes with "don't modify tests"; fresh-context adversarial review sees
  only diff + criteria.
- Streaming discover→fix: producer-consumer queues (schema-validated findings, dedup by
  fingerprint, DLQ to the root) so fixers start per-finding instead of waiting for the hunt
  barrier.
- [Ralph loop](https://ghuntley.com/ralph/): loop-until-done converges only under **verification
  back-pressure** + a machine-checkable "done"; guard with max iterations and K-consecutive-clean.

## Convergent principles

1. **The LLM plans; deterministic code schedules.** Every working system separates these
   (LLMCompiler, HuggingGPT, CodeR, Gas Town's queue, Claude Code's Workflow runtime). Asking the
   orchestrator model to also be the scheduler is the ReAct anti-pattern — it under-parallelizes,
   blocks, and forgets.
2. **Saturation comes from a ready queue with slots, not from planner foresight.** Completion
   events dispatch newly-unblocked work immediately. The model is consulted only to (re)plan.
3. **Parallelize by independence, not by count.** Unit of parallelism = file-disjoint slice.
   Width target 3–5 (evidence: optimum 3–4, tool ceilings ~8, gains saturate); genuinely
   sequential phases should *run* narrow rather than be padded.
4. **Reads parallel, writes serialized at the integration point.** Disjoint scopes up front +
   one-at-a-time merge/rebase (Refinery pattern); ~28% of agent PRs conflict otherwise.
5. **Never block the root.** All delegation is fire-and-forget with completion events; a watchdog
   (not the root) handles stalls.
6. **Kill barrier tails with streaming.** Hunt→fix becomes a findings queue: fingerprinted,
   schema-validated findings spawn fix slices while the hunt is still running.
7. **Verification is a schedulable node + attestation, not a vibe.** Failing-test-first slices,
   commit-SHA + test-output attestation independently re-run, fresh-context review,
   K-consecutive-clean convergence with a seen-set. (~half of failures are false success; 21% of
   multi-agent failures are verification/termination.)
8. **Spec quality is the top failure cause (41.8%)** — every slice carries objective, output
   format, boundaries/file-scope, and a runnable check. Decompose further only on failure (ADaPT).

## Target architecture for UltraGoal

```
        ┌────────────────────────── root orchestrator (LLM) ──────────────────────────┐
        │  plans/replans only: ultragoal_patch emits {step, deps, files, check}       │
        │  integrates results, resolves conflicts, decides done                        │
        └──────────────▲───────────────────────────────────────────────▲──────────────┘
            replan nudge (queue empty / plan width < slots            harvest of worker
            while independent scopes exist / finding needs triage)    reports + attestations
        ┌──────────────┴───────────────────────────────────────────────┴──────────────┐
        │                     plugin scheduler (deterministic code)                    │
        │  ready = pending ∧ deps completed ∧ no live holder ∧ no file-overlap w/ live │
        │  while workers < maxWorkers(5): spawn(ready.next())   [same path as rescue]  │
        │  completion event → verify attestation → mark done → dispatch newly-ready    │
        │  watchdog: heartbeat + progress (commits/log) → reap, respawn, ADaPT-split   │
        └──────▲───────────────────────▲───────────────────────────▲───────────────────┘
        ┌──────┴──────┐         ┌──────┴──────┐             ┌──────┴──────┐
        │ worker (wt) │         │ worker (wt) │    ...      │ verifier    │  + findings queue:
        │ test-first  │         │ file-scoped │             │ fresh ctx   │  hunters stream
        │ attest SHA  │         │ slice       │             │ re-runs chk │  fingerprinted
        └─────────────┘         └─────────────┘             └─────────────┘  findings → fix slices
                                     merge serialized one-at-a-time (rebase train)
```

The root keeps doing what LLMs are good at (decomposition, triage, integration judgment) and
stops doing what it is bad at (remembering to staff, waiting without blocking, honest liveness).

## Phased implementation (mapped to this repo)

**Phase 1 — DAG schema + ready-queue scheduler** (`contract.ts`, `server.ts`, `lib/collab.ts`)
- `goalItemSchema` += `deps: string[]` (item ids), `files: string[]` (scope globs, optional),
  `check: string` (runnable done-criterion, optional). `ultragoal_patch` and the
  internal item store accept them.
- Scheduler in `server.ts`: on plan update, worker completion, or heartbeat tick — compute the
  ready set, spawn workers through the existing shared spawn path up to `maxWorkers`
  (goal setting, default 5). This replaces staffing-by-nudge; the STAFFING prompt becomes a
  fallback for providers where spawning is unavailable.
- Deps also fix the pane: blocked items render as "blocked on N", not silently unstaffable.

**Phase 2 — planner prompt contract** (`templates/goals/*.md`, `lib/prompts.ts`)
- Few-shot DAG examples (LLMCompiler-style) + Anthropic-style numeric tiers; demand disjoint
  `files` scopes; **width check**: if plan width < min(maxWorkers, open items) while independent
  scopes plausibly exist, nudge "split further or mark deps explicitly" (never pad fake width).
- Worker briefs: objective / output format / boundaries / runnable check; failing-test-first;
  report must end with attestation (commit SHA + check output). Ban native Task for slice work.

**Phase 3 — streaming findings queue** (`lib/collab.ts` tool + `server.ts`)
- `report_finding` tool for hunt workers: schema-validated `{fingerprint, file, symptom,
  evidence}`; dedup against the goal's seen-set; each fresh finding auto-appends a dep-free,
  file-scoped fix item → the scheduler staffs it immediately while the hunt continues.
- Convergence: sweeps by fresh-context hunters; goal-tail rule = K=2 consecutive clean sweeps.

**Phase 4 — attested verification + serialized integration** (`server.ts`)
- Completion requires attestation; scheduler (or a verifier worker) re-runs `check` on a clean
  checkout before marking done — a false claim reopens the item (44–52% false-success rate says
  this pays for itself).
- Integration serialization: a single merge token — one worker merges/rebases to main at a time
  (Refinery); on repeated failure, ADaPT-split the item instead of respawning identically.

## Risks / honest caveats

- **Token cost**: saturated multi-agent ≈ 15× chat usage; slots + budget caps are the guardrail.
- **Fake width**: forcing 4–5 on genuinely sequential tails *hurts* (−39…−70% in the scaling
  study). The width check must ask for decomposition, never manufacture busywork.
- **Merge conflicts** scale with diff size and overlap — small slices + file-ownership + rebase
  train are load-bearing, not optional.
- **Verifier gaming**: agents edit tests to pass and judges prefer clean-looking patches — commit
  tests first, verify state not claims, keep verifiers fresh-context.
