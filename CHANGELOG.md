# Changelog

## 0.26.1

- Ask the repository whether a slice's branch still adds work, instead of
  reading it out of an error message. 0.25.3 tried to spot an already-merged
  slice by matching "already up to date" in the failure text, and bb never
  passes git's own words through — it reports `HTTP 502: git merge --squash
  <branch> failed` and nothing more. So that fix was inert: 22 no-op merges in
  one hour were still recorded as failures, and after 0.26.0 they would have
  reopened findings whose work was demonstrably already on the branch, undoing
  correct closures. The host entry now runs `git diff --quiet base...branch` and
  the answer comes from the tree. A branch that genuinely adds work still
  records as failed and still reopens its findings.

## 0.26.0

- A finding no longer stays fixed when its fix never reached the base branch.
  `completeItemFor` marks linked findings fixed from the worker's report, and
  `queueIntegration` runs afterwards — so a genuine merge failure left the
  register asserting a fix that exists nowhere main will ship, and nothing ever
  rechecked it. A reviewer put the consequence plainly: a launch decision made
  from the register alone would have shipped a recorded-as-fixed
  segregation-of-duties bypass believing it closed.
  A failed integration now reopens exactly the findings that slice closed and
  returns the slice to the queue, naming the stranded branch in its step so the
  next worker RECOVERS the commits rather than starting over — one slice was
  previously re-implemented against an already-merged predecessor.
  Two things are deliberately left alone: a dismissal is a human judgement
  about the defect and no merge outcome overturns it, and an already-present
  slice ("nothing to squash", 0.25.3) counts as integrated, so this path never
  runs for it.

## 0.25.3

- A slice whose work is already on the base branch is recorded as INTEGRATED,
  not failed. `git merge --squash` exits non-zero when there is nothing to
  stage, and bb surfaces that as `HTTP 502: git merge --squash <branch>
  failed` — so a no-op merge was indistinguishable from a real conflict. On a
  live goal 15 of 17 recorded "failures" were `Already up to date. (nothing to
  squash)`, meaning the provenance table built to answer "did this land?" was
  reporting that work had not landed when it demonstrably had. A real conflict
  still records as failed.

## 0.25.2

- Token history now moves with the goal. `goal_session_tokens` was the fourth
  goal-scoped table this transfer forgot, after the standing brief, the
  completion floors and the staffing holds. Leaving it behind freezes the
  counter rather than resetting it, which is worse: the total is floored at its
  previous high-water mark, so a new root starting from zero recorded sessions
  keeps reporting the OLD number until it independently exceeds it. On a live
  goal that meant 3.38B sitting motionless while 2.48B of real work went
  unattributed. The rows are MERGED rather than moved, because a session can
  already exist under the target and a provider's cumulative counter only rises,
  so the larger reading wins.

## 0.25.1

- An archived worker no longer blocks a root transfer. 0.24.0 started archiving
  worker threads on retirement so their worktrees could be collected, and the
  transfer still treated an archived thread as corruption: 415 collab rows on
  one goal read as live while their threads were gone, and every one refused the
  transfer with a message implying something was broken. Archived means
  finished. The transfer now retires the stale row and carries on, rather than
  inventing a problem out of its own bookkeeping.

## 0.25.0

- Record where a slice actually landed. Nothing did: of 417 register entries a
  reachability audit could attribute only 76 to a commit on main, 75 named a fix
  that is not an ancestor of main, and 256 had no commit attribution at all.
  "Fixed" meant "a worker said so", which is a claim rather than a fact.
  Worse, the claim is written BEFORE the merge is attempted — completion closes
  the finding and integration is queued afterwards — so a failed squash-merge
  left the register asserting a fix provably absent from the tree, and nothing
  recorded the contradiction. Three council reviewers found this independently;
  one noted that a launch decision made from the register alone would have
  shipped a statutory segregation-of-duties bypass believing it closed.
  Integration outcome is now written down either way, so a failed merge is
  visible and the reachability gate has something to check.

## 0.24.1

- **Agent-to-agent messages deliver immediately.** `send_message` used the
  human composer queue, so a follow-up sat until the target went idle and
  looked like a person typed it. Both `send_message` and `followup_task` now
  use `threads.send`: steer a live turn, start a new one if idle. Plugin
  nudges, verifier retries, and root steers use the same path — never
  `queuedMessages.create` or `mode: "auto"`.

## 0.24.0

- **Workers branch from where integration lands, not from the repository
  default.** The root works on its own branch and squash-merges slices into it,
  while every worker was cut from `default` — so a worker spawned after an
  integration could not see any of it. Three of four live workers were
  simultaneously on stale bases, one re-implementing a slice already merged,
  every one heading for a conflict. A worker that starts behind the integration
  point is wasted before it reads a line.
- **Retiring a worker archives its thread.** Retirement was a fact known only to
  this plugin: 201 retired workers still counted as live threads, so the
  worktree collector — correctly refusing to delete a live thread's directory —
  protected 135 worktrees nothing would ever use again. Saying a finished worker
  is finished is what lets its disk come back.
- **`release_slice` and `retire_agent`** give the orchestrator levers to match
  what it can already see. Its only tool was `interrupt_agent`, which ends a
  turn but keeps the slot and the assignment, so a slice it correctly judged
  redundant stayed `in_progress` and the ready queue stayed blocked while it
  reported the problem into the void.

## 0.23.1

- The defect-evidence refusal now reaches the worker too. 0.23.0 fixed the
  deliverable floor and left this one logging into the void, and its ending is
  worse: a slice refused here stays `in_progress`, its worker is released, and
  the scheduler eventually re-staffs it. A second worker then redid work that
  was already committed and integrated, on a stale base, heading for a merge
  conflict with its own predecessor — which the orchestrator spotted and
  reported as a wasted cycle. The worker now gets the finding ids it failed to
  attest and a ready-to-emit `DEFECT_COVERAGE:` line for each, told plainly not
  to start over.

## 0.23.0

- A refused completion now reaches the worker, carrying the exact line that
  would satisfy it. The deliverable floor rejected a closure and told only the
  log: four workers finished their slices, had closure refused three times over,
  and went idle still holding every scheduler slot while twenty-five ready items
  waited. From the worker's side a tool call simply failed, with nothing said
  about why or what to do. It now gets the item id, the paths it did not account
  for, a ready-to-emit `DELIVERABLE:` line per path, and the fact that this is a
  reporting gap rather than a request to redo the work — a worker that cannot
  see the contract cannot meet it.

## 0.22.0

- **Rotate orchestrator**, in the right-pane Settings. A root re-reads its whole
  conversation on every request — one measured at 520,000 cached tokens per
  turn, which is most of what a long goal spends, and the plugin's own injected
  plan block is only about 3,700 of them. Everything durable the goal owns lives
  in this plugin's tables, so handing the goal to a fresh thread costs the
  transcript and nothing else, and takes the orchestrator's per-request cost
  back to zero.
- The CLI's `transfer-root` and the new rotation now run the SAME journalled
  transfer, rather than a second copy of it. A resumable state machine with two
  implementations drifts, and a half-applied transfer is the worst state this
  plugin can be left in.

## 0.21.0

- A slice minted by `--own-slice` now describes its own contract. The step was
  title, file and finding id and nothing else, while the reproduction and the
  done-check sat in the finding's evidence. Workers do see that evidence
  through the linked-defect brief, but anyone reading the PLAN saw an
  empty-looking row — an orchestrator reported one as "check:(none) and a
  one-line step" and could not tell it from an unbriefed item. The step now
  points at the evidence as the contract, and says plainly when no check
  command was filed, because a slice without one can be closed with nothing
  verifying it.
- `bb ultragoal finding` says the same thing at filing time, and names the
  command to attach a check afterwards. The filer is the only person who knows
  what would have proved the defect gone.

## 0.20.5

- `worktree-gc.sh` treats an environment as in use when ANY live thread
  references it, not merely a running one. The old rule — active or starting —
  deleted the worktrees of four review-council threads: they sat idle between
  rounds, they never commit so they read as clean and merged, and they hold no
  work item so the unfinished-slice guard skipped them as well. Their
  transcripts survived, their working directories did not, and a thread with no
  environment errors without being able to say why. A thread that still exists
  is still using its worktree; archive or delete the thread first.

## 0.20.4

- Root transfer now carries the standing worker brief, the per-item completion
  floors and the staffing holds. It moved items, findings, decisions, agents,
  reservations and caps — every table that existed when it was written — and
  silently left behind three that were added later. A live transfer dropped a
  3,485-character standing brief, twenty-eight `requires` floors and six holds
  onto a root that was then deleted. The goal kept running with none of them
  and nothing reported it. Each move is guarded, because these tables are
  created at their use sites and a database that predates one must still
  transfer.

## 0.20.3

- A root transfer can now proceed when the source root is in `error`. It
  waited for the source to reach idle, and an errored thread never does — so
  the transfer froze at `target_released` and re-running it froze again, in
  precisely the case the feature exists for. A root whose provider ran out of
  quota is already released: it holds no runtime and will not take another
  turn. A source that is still RUNNING is still waited out.
  0.20.1, 0.20.2 and this together are what "a dead root is recoverable"
  actually required; each one alone left the goal stuck.

## 0.20.2

- Root transfer no longer requires every worker to share the root's
  environment. A worker gets its own managed worktree by design — that is what
  one agent per slice means — so the check refused every transfer as soon as a
  single worker had been staffed. Combined with 0.20.1, a dead root is now
  actually recoverable. The project must still match.

## 0.20.1

- Root transfer no longer demands the target run `codex/gpt-5.6-sol xhigh
  fast/full`. One vendor and one model name were written into a plugin that is
  meant to be provider-neutral, and it made the transfer useless in the exact
  situation it exists for: when a root dies because ITS provider is
  unavailable, the only permitted rescue thread was one on that same provider.
  A goal whose root was a Codex thread became unrecoverable the moment the
  Codex quota ran out. What has to hold is that the target can BE a root —
  same project and environment, not a child, not archived, idle — and all of
  that was already checked. A provider change is logged, not refused.

## 0.20.0

- `bb ultragoal exec` shows and sets which provider and model workers and
  verifiers run on. The pin was only reachable from the right-pane Settings, so
  nothing on the CLI ever revealed it — a goal ran ninety-nine workers on a
  provider nobody intended and the first sign was an exhausted quota. A pin
  that expensive should be one command away from being read.

## 0.19.2

- Reclaim now diffs `base...HEAD`, not `base`. 0.19.1 traded an ancestor test
  that declined every squash-merge for a two-dot diff that declined almost as
  often for the opposite reason: the base branch keeps moving, and every later
  commit on it reads as a difference from a finished slice. Three dots diff
  from where the branch and the base parted company, which asks the only
  question that matters — does this branch still ADD anything the base lacks.
  On a live goal that is the difference between reclaiming a handful of
  worktrees and reclaiming a hundred and forty-eight.

## 0.19.1

- The reclaim in 0.19.0 declined every worktree it was offered. It asked
  whether the branch's commits were reachable from the base, and a squash-merge
  rewrites the work into a new commit — so after the very merge that triggers
  the reclaim, the answer is always no. It now compares CONTENT instead: an
  empty diff against the base means the base already has the work, however it
  got there. The dirty-checkout guard is unchanged.

## 0.19.0

- **The plugin now cleans up after its own slices.** It creates one worktree
  per slice and removed none of them: 217 worktrees and 9.9 GB accumulated for
  a goal with 177 completed slices, on top of thirteen private copies of the
  same 1.1 GB dependency tree. Reclaiming that was left to whoever noticed the
  disk filling, which is not a reasonable thing to ask of an owner.
  A new host entry does the filesystem work on the daemon that owns the
  directory, because git and rm are not on the server-side API. The moment a
  slice's commits are squash-merged, its worktree is removed and its branch
  deleted — but only after the checkout is confirmed clean and its commits
  confirmed reachable from the base branch, and never for a dirty one, because
  uncommitted work outranks any amount of disk.
  The same entry seeds a `node_modules` store from the checkout it is about to
  delete, and clones from it by reference (APFS clonefile, Btrfs reflink) so
  every later worktree gets a real, independent tree that costs nothing until
  it diverges. Copy-by-reference is required, not preferred: the copy FAILS
  rather than silently writing the 1.1 GB duplicate it exists to prevent.
  Both are settings — `reclaimMergedWorktrees` and `shareWorktreeNodeModules`,
  on by default — and a failure to reclaim disk never fails an integration.

## 0.18.0

- **Automatic approval is now off by default.** The background service was
  resolving command, file-change, permission and plan requests on every thread
  in the goal tree. That is a real approval boundary, and "the goal runs
  unattended" is not a reason to cross it silently. `autoApproveAgentRequests`
  turns it on for a deliberately unattended run; with it off, every request
  reaches the owner exactly as it would without this plugin. User questions
  were never answered automatically and still are not.
- **Spawned agents no longer default to full permissions.**
  `workerPermissionMode` defaults to `auto`, so a worker's risky actions still
  reach the normal approval gate; an unrecognised value falls back to `auto`
  rather than to whatever was meant, because a typo must not hand an agent full
  access. Verifiers are pinned to `auto` and are deliberately NOT configurable:
  a verifier that can edit the work it is judging can make its own verdict come
  true.
- Removed `experimental_statusLabels`, which SDK 0.4.16 rejects at activation.
- New `scripts/worktree-gc.sh` reclaims managed worktrees whose slice is
  finished and whose commits are already on the base branch, and
  `scripts/node-modules-share.sh` gives each worktree an APFS-cloned
  `node_modules` instead of its own 1.1 GB install. One agent = one slice meant
  one worktree per slice and nothing ever removed them: 217 worktrees and
  thirteen private copies of the same dependency tree. Both refuse to touch a
  busy environment, a dirty checkout, or unmerged commits.

## 0.17.29

- `bb ultragoal release <item> --hold` returns a slice AND keeps the scheduler
  off it until the item is edited. Releasing alone was not enough: the
  scheduler picked the slice back up within seconds, under the same brief that
  was wrong, so four separate re-scopings in one session started fresh workers
  on contracts that could not be completed legally. The only workaround was to
  pause the entire goal — stopping every other slice — to edit one.
  Editing the item lifts the hold automatically, because the edit is what the
  hold was waiting for and a hold nobody remembers to lift is just a lost
  slice; `--unhold` lifts one by hand, and a held item says so when read.

## 0.17.28

- `bb ultragoal item --new` creates a plan item with no finding behind it.
  An outside orchestrator could file a defect and get a slice for free, but
  release-gate work — a test that fails only under the full suite, a broken
  check command, CI wiring — is not a product defect, and minting a finding to
  get a work item would put a fiction in the register that then has to be
  explained away at close. Items created this way close on their own report
  rather than on defect coverage, which is what a no-finding item means.

## 0.17.27

- Resolving a finding now retires the slice it minted. A finding fixed in
  someone else's slice, or dismissed, left its own work item behind as a ready,
  unstaffed plan row; the scheduler cannot tell that from real work and staffs a
  worker to re-fix already-guarded code. Two survived a resolve pass and stayed
  ready. The row is REMOVED rather than completed — completion carries
  per-defect evidence rules, and a shortcut through them would cost more than
  the tidiness it buys — and only when every finding that ever pointed at the
  item is resolved, nobody holds it, and it is still pending. An item no
  finding ever pointed at is never touched: a declared deliverable exists on
  its own terms. `bb ultragoal item <id> --remove` applies the same rule by
  hand for rows orphaned before this shipped.

## 0.17.26

- An external orchestrator can now reconcile a plan, not just add to it.
  `bb ultragoal finding` let an auditor outside the goal file defects, but
  every follow-through — correcting an item's scope, sharpening its check,
  closing a finding whose fix landed in someone else's slice — needed a tool
  only threads inside the goal have. So triage arrived as prose asking the root
  to retype it, and the register drifted from the code: two findings sat open
  against surfaces already guarded on main.
  `bb ultragoal item <id>` edits a work item's step, files and check, and
  `bb ultragoal resolve <finding-id>` closes a finding with evidence. Item
  status stays uneditable — completion carries per-defect evidence rules, and a
  flag that skipped them would be the shortest path around the whole contract —
  and, like `requires`, an item already in progress is refused rather than
  rewritten underneath the worker briefed on it.

## 0.17.25

- The token metric now reads in billions past a billion. A long-running goal
  went by 1,000M and kept counting, and "1680.7M" stops reading as a quantity
  at a glance — the tier exists so the number can be taken in, and above a
  billion it no longer was.

## 0.17.24

- Work items can now declare outputs they cannot close without.
  An item's `files` was only ever a ceiling — the scope a worker may touch —
  and nothing was a floor, so a slice closed as soon as its linked defects were
  attested whether or not it produced the artifact it was scoped to produce.
  A declared audit script was never written and its slice still closed clean.
  `bb ultragoal requires <item-id> <paths>` sets the floor: the worker's brief
  names the paths, and completion is refused unless the report carries a
  `DELIVERABLE:` line per path with nonempty proof, on the same terms as
  `DEFECT_COVERAGE`. Opt-in, so an item that declares nothing behaves exactly
  as before, and requirements are refused on an item already in progress rather
  than changing the contract its worker was briefed under.

## 0.17.23

- Removed a project-specific path from defect coalescing.
  `schema/canonical-baseline.test.ts` was hardcoded into the shared-file set,
  which applied one repository's layout to every project running this plugin.
  The built-in set is now only ecosystem manifests, and a new
  `sharedInfrastructureFiles` setting lets an installation name the files its
  own repository shares. Which files those are is a property of the repository,
  so it is configuration, not code.

## 0.17.22

- New `bb ultragoal brief` sets standing rules that every worker on a goal
  inherits, instead of the orchestrator retyping them into each slice. The rules
  it forgot were the expensive ones: a critical concurrency fix landed with
  ninety-five lines of code and no committed regression because its reproduction
  was ephemeral, and workers kept starting private PostgreSQL containers on
  majors the product does not ship on. A rule that depends on someone
  remembering to repeat it is not a rule. Per goal, not global, because house
  rules belong to the repository being worked on.

## 0.17.21

- The 0.17.20 token table never actually got created. `bb.storage.migrate`
  records progress by array INDEX, so the statement was first added mid-array —
  landing on an index already marked applied — and even once appended it did not
  apply on reload, leaving every accounting pulse throwing "no such table".
  The session-token store now creates its own table where it is used, so it is
  self-healing and independent of that ordering scheme, and the migration list
  carries an append-only warning.

## 0.17.20

- The goal token counter no longer freezes. A goal's usage is the sum across
  every provider session it ever ran, but that per-session map lived only in
  memory, and "one agent = one slice" retires sessions constantly — this run had
  216 retired workers against 8 live. After a plugin reload the map could only
  be rebuilt from the live handful, whose sum never again exceeded the
  historical high-water mark the total was floored to with `Math.max`, so the
  displayed number stopped moving permanently. It sat at 1,065,788,395 for
  hours. Per-session totals are now durable in `goal_session_tokens`, so a
  retired session keeps contributing exactly what it spent and a new one
  contributes its own growth. Live threads are re-read each tick; retired ones
  are backfilled a bounded few per tick and then never re-read.

## 0.17.19

Four failures an independent review found on 0.17.18 despite 112/112 green.

- A failed or deleted child's durable row is now retired. `thread.failed` and
  `thread.deleted` left the row live, so a crashed worker kept consuming root
  capacity and a crashed VERIFIER blocked its source worker's retirement for the
  life of the goal, since `verifiersFor` counts rows regardless of host state.
  A verifier also stops blocking once it records a verdict or outlives the
  rescue window without producing one.
- Retirement no longer infers liveness from the in-memory projection. That
  projection drops exactly the workers this pass collects, so absence read as
  "not live" would retire and stop a genuinely running worker on any transient
  host-read failure. The pass now confirms each candidate's host directly and
  fails closed when it cannot: `finishedWorkerRetirements` is split into
  `finishedWorkerRetirementCandidates` plus `retirementPermittedByHost`.
- `bb ultragoal release` validates every target before mutating any of them, so
  an item held by several rows can no longer be half-released. It also rejects
  `starting` hosts and verifier ids, neither of which it previously refused.
- `--own-slice` normalizes DECLARED fix files, not just the fallback. Scopes are
  compared as exact paths, so a line-qualified `src/x.ts:99` was stored
  literally and never overlapped `src/x.ts`, defeating the very serialization
  guard the scope default exists to preserve.

## 0.17.18

- Finished-worker cleanup now reconciles against the durable `collab_agents`
  rows instead of the projected agent list. `oneWorkerPerItem` drops any non-live
  worker whose item is completed — exactly the set 0.17.16 was written to retire
  — so reading the projection made that fix a no-op that still looked correct.
  A worker whose host is still running is left alone.
- A verifier's durable row is retired when its verdict lands. `verifiersFor`
  counts every non-retired verifier row regardless of host status, so a terminal
  row left behind blocked its source worker from ever being retired. A later
  VERIFY_FAIL cycle spawns a fresh verifier as before.
- `--own-slice` defaults the minted item's file scope to the finding's evidence
  file when no `--fix-files` are declared. The scheduler serializes overlapping
  work through `item.files` alone, so an empty scope silently opted the slice out
  of that guard and allowed a second worker into the same file.
- New `bb ultragoal release <worker-thread-id|item-id>`. An orchestrator that
  deliberately stops a worker had no supported way to get the slice back:
  `bb thread stop` leaves the host `idle`, not `stopped`, so the durable row is
  never retired, the item stays `in_progress` and held, `reclaimOrphanInProgress`
  refuses to demote a held item, and the capacity fence keeps counting the row.
  Release retires the row, returns the slice to `pending` and restaffs. It
  refuses a worker whose host is still active or that already reported done.

## 0.17.17

- Worker completion now reads the `DEFECT_COVERAGE:` contract out of the slice
  report, not only out of the `slice_done` tool. Providers that cannot dispose a
  tool call as the turn ends close with that contract plus the `ULTRAGOAL_DONE`
  sentinel; completion discarded it, so every such slice stayed unattended and
  `in_progress` with its finding open, and the stall healer kept re-running
  workers that had already finished. The evidence bar is unchanged — exact
  finding id, status pass, nonempty proof — and a bare sentinel with no coverage
  lines still closes nothing. The worker brief now documents the fallback, and
  the parser is renamed `parseDefectCoverageEvidence` because both roles use it.
- `bb ultragoal finding --own-slice` mints a dedicated work item for a filed
  defect instead of coalescing it into an older item that happens to share one
  file. Coalescing is right for keeping two workers out of the same file and
  wrong for a distinct blocker with its own reproduction and done-check. The
  minted item carries an explicit `CONTEXT (audit findings: fnd_…)` declaration,
  so the link survives stale-link detachment and duplicate healing.

## 0.17.16

- Finished workers now release their root slot by reconciling against the plan
  instead of waiting for a later sweep to observe a `stopped` host. Retirement
  previously depended on a best-effort `threads.stop` whose failures are
  swallowed, so each swallowed failure left an idle durable row that the SQL
  capacity fence counted forever while the in-memory scheduler did not — enough
  of them and no reservation could be granted again, wedging the whole crew. An
  idle worker is retired once its slice is `completed` or gone from the plan,
  and never while a verifier still reads it as a source.

## 0.17.15

- Scheduler startup now reconstructs durable worker ownership before counting
  capacity or rescuing old work. Active, idle, completed-but-unharvested, and
  temporarily unknown holders survive reload; only explicitly stopped/error
  workers are eligible for delayed rescue.
- Scheduler-internal spawning is item-strict. A held requested work item fails
  closed without entering the user-facing new-item fallback. A durable SQLite
  reservation is acquired before any external thread spawn and atomically
  committed only when no live worker owns the item, protecting overlapping
  plugin generations and abandoned-item rescue. The same transaction enforces
  the root's `maxWorkers` cap across live workers and reservations, including
  different items. Spawn failures restore pending work, and every returned
  item ID is verified before staffing or logging.
- Root-capacity triggers fence late INSERT/UPDATE calls from a pre-reload plugin
  generation. If its BB child already exists, active-event and repeated-tree
  discovery immediately stop and tombstone the unowned child and return its
  optimistic work item to pending.
- Generated migration artifacts such as
  `schema/migrations/generated/0001_baseline.sql` no longer provide semantic
  evidence for later defect coalescing, even when line-stripped paths match.
  The durable oldest-primary exception remains intact, and concrete domain
  repair files or structured CONTEXT IDs still validate intentional links.
- Every remediation worker and verifier brief now includes a bounded dossier
  of all open linked defects: exact ID, title, evidence file, evidence, and
  done-check. The dossier has a hard 64 KB ceiling without silently omitting
  IDs, including for public verifier spawns.
- `slice_done` and verifier reports now carry structured, durable affirmative
  proof for every exact linked defect ID. Negative prose, prefixes, duplicate
  or conflicting coverage, and ambiguous verdicts fail closed. A verifier must
  end with one exact verdict line; missing coverage or malformed output clears
  the verification digest and retries or safely assigns a replacement under a
  durable three-attempt budget before handing the open work back to the root.
- Restart reconciliation closes linked defects only from preserved qualifying
  evidence, including evidence on retired workers. Otherwise it reopens the
  remediation work, and plan completion repairs stale links before enforcing
  coverage.
- Added fake-host reload and prompt regressions plus two-connection reservation
  races, real scheduler rollback, verifier retry, monolithic-baseline,
  large-dossier, restart-evidence, and exact structured-coverage tests.

## 0.17.14

- Exact concrete-path matching now treats square-bracket route segments such
  as Next.js `[entity]` directories as literal repository paths while still
  rejecting wildcard syntax, broad directories, and shared infrastructure.
- A work item may explicitly own a later defect through its structured
  `CONTEXT (audit finding[s] ... fnd_...)` clause. Arbitrary mentions elsewhere
  in the work brief remain non-authoritative, including auditor notes that
  describe an earlier coalescing decision as wrong.
- Startup repair conservatively moves v0.17.13's scheduler-minted pending
  singleton duplicates back to the oldest strong matching work item, removes
  the orphan duplicates, and continues scanning linked work at full capacity.
  The three live OpenBooks false-negative shapes now heal without growing the
  remediation work-item count.
- Added regressions for dynamic routes, both multi-defect context clauses,
  negative auditor mentions, restart recovery, oldest-target selection, full
  capacity, and duplicate cleanup.

## 0.17.13

- Added a durable stale-link audit at startup and on every progress pulse. Each
  work item's oldest linked defect across all statuses remains its primary
  creator association, so resolving it cannot promote a later stale link;
  later coalesced defects stay linked only when their evidence or declared
  repair files exactly overlap a concrete file owned or named by the work item.
- Broad directories and shared infrastructure no longer validate later defect
  links. Missing-item and invalid links detach safely and re-enter the existing
  oldest-first remediation queue without losing their repair scope or check.
- Added the same primary-aware guard to every completion path so a completed
  work item cannot automatically mark unrelated defects fixed. Fixing the
  validated group is transactional, and detached work backfills immediately.
- Consolidated the main pane metrics into two compact Work items/Defects rows
  and one three-column Tokens/Last/Pace strip, preserving the distinction
  between linked defects and work assignment with substantially less height.
- Added regressions for exact concrete matches, declared repair scopes,
  primary evidence/repair mismatches, later broad-directory mislinks, missing
  work, completion-time repair, oldest-first backfill, and the real first
  startup pulse.

## 0.17.12

- UltraGoal now exposes one canonical root-control surface on Codex, OpenCode,
  Claude Code, Cursor, and Pi: `ultragoal_start`, `ultragoal_state`,
  `ultragoal_patch`, and `ultragoal_finish`.
- Retired the short slash command. `/ultragoal` is now the sole invocation and
  lifecycle command on every provider.
- Removed the former Goal-named root controls from registration, provider
  configuration, prompts, the installed skill, and documentation. Provider-native
  goal state remains separate and untouched.
- Added fake-host coverage proving every provider receives the same canonical
  skill/tool surface and none of the removed controls, plus parser coverage for
  the canonical slash command.

## 0.17.11

Large-goal prompt and plan scaling (field case: OpenBooks at 192 work items and
9.1M characters of repeated UltraGoal turns):

- Automatic continuation and progress prompts use a bounded working set of
  in-progress, ready, and blocked work items. Completed bodies collapse to counts;
  the dynamic plan section is hard-capped at 6,000 characters even at 1,000
  work items.
- The recurring continuation template is a compact wake-up (about 1.8KB
  static) instead of replaying the full 9.4KB UltraGoal constitution on every
  turn.
- `ultragoal_state` defaults to 40 open work items and exposes status/cursor/limit paging
  up to 100 rows, plus compact plan and active-agent counts. CLI status is
  bounded too.
- `ultragoal_patch` is patch-style: omitted work remains durable, one call
  changes at most 200 rows, and large imports can be submitted in batches.
  Every supplied existing/removal ID is preflighted, and removals, dependency
  repair, and upserts commit or roll back in one SQLite transaction.
- Introduced provider-neutral `ultragoal_*` root controls for the one-time root
  transfer and the canonical-only follow-up.
- Recorded overflow defects now persist repair files/check metadata. Capacity
  counts distinct assigned repair work rather than every open defect, and an
  oldest-first reconciler assigns waiting defects whenever capacity frees or
  after restart without double-minting.
- The primary pane labels Work items and Defects separately, reports assigned
  and awaiting-assignment defects accurately, and explains why totals differ.
- Added restartable `bb ultragoal transfer-root <source> <target> [--dry-run]`:
  strict preflight, a durable phase journal, one IMMEDIATE transaction for all
  root-owned plugin state, source archive before live-worker reparent, preserved
  provider pins/settings/tokens/cursors, and exactly-once target wake.
- Added 1,000-item regressions for prompt size, completed-body exclusion,
  paged reads, compact status, and single-row plan patching.
- Added rollback, unknown-ID, defect backfill/restart, canonical provider-tool,
  and crash-repair root-transfer regressions.

## 0.17.10

- Finding coalescing now requires an exact concrete domain file. Broad worker
  scopes such as `schema/migrations/generated` still serialize potentially
  conflicting edits, but no longer assign unrelated defects to the same fix
  slice. Shared package manifests, lockfiles, and the canonical schema test are
  likewise non-authoritative for semantic ownership.

## 0.17.9

- Report cap-exceeded findings as recorded but unstaffed instead of falsely
  claiming that a `null` fix slice was staffed by the scheduler.

## 0.17.8

OpenCode ghost-turn recovery (field case: openbooks `thr_rdmh8waewz`):

- After a wedged-root stop, compact and continue are both `turn.submit`. OpenCode can still hold the previous turn after BB marks the thread error, so every recovery attempt failed with "A turn is already active" and the goal stayed blocked.
- Starting a new turn now accepts idle/error/stopped threads. Error roots are stopped and waited out before compact or continue. A leftover-turn error settles and retries once.
- Compact finishes (or is skipped) before resume, so continue cannot collide with the compact turn.
- The progress pulse still revives blocked goals whose reason is a transient `turn.submit` / "already active" failure. Previously those sat blocked forever after `thread.failed`.
- A rejected second submit no longer marks the goal blocked. The first turn is still running; blocking here made compact/continue pile on.
- "No active ACP session" after a released ghost process is treated as recoverable, not a blocked goal.
- Resume/revive always start a turn on a dead root (`force`), even when the event-gate would skip.
- Wedge restart and progress check-in no longer both `turn.submit` in the same pulse. A start lock holds for 8s so only one new turn is in flight.
- The left-sidebar UltraGoal chip now follows the durable goal record, matching the right pane: it remains for paused, blocked, limited, and completed goals until the goal is cleared. The crew RPC no longer includes legacy plan-item rows that could invalidate the entire chip refresh.

## 0.17.7

- Settings uses the composer's multi-provider model picker for verifier and worker: provider icon tabs, brand-stripped model list, reasoning levels, and Fast mode. The saved tuple (provider/model/reasoning/service tier) is what workers and verifiers spawn with.
- Pi models stay in the list. `routeProviderId` is the nested route (openrouter/anthropic/…), not a filter against the agent provider — the old filter emptied the Pi tab.

## 0.17.6

- Defaults: 5 worker slots, 50 open findings. The 0.17.5 containment still holds; the finding cap is just less tight than the first field fix.

## 0.17.5

Containment after a live openbooks runaway (35-wide crew, 95-finding mill, 41 Now rows, pause left workers running):

- Worker slots count assignment, not just an active provider turn. Idle Codex workers holding an open slice occupy a slot; uncached crew defaults to unknown (not completed) so a 24-row status refresh cannot hide a running fleet.
- Findings no longer mint unbounded fix slices: same-file reports attach to the existing slice; distinct files stop minting at the open-finding cap (default 50 as of 0.17.6).
- Pause stops every child (collab rows + parent listing, not the status cache), retires crew claims, and parks in-progress slices back to pending so resume re-staffs from the ready queue within the slot cap.
- Steering skips archived/stopping/error threads. The progress pulse skips archived roots (errored roots still revive).
- Concurrent verifiers are capped at the same worker-slot count. Scheduler re-checks goal status before each spawn so an in-flight staff cannot outrun pause.

## 0.17.4

- Landed work is recorded even while the goal reads blocked. "Blocked" almost always means the ROOT thread died, but slice completion and the ready-queue scheduler both refused to run in that state — so a worker could fix a defect, commit it, and call slice_done while the plugin silently discarded the completion and never merged the branch. Completion, integration, and staffing now proceed for blocked goals; only paused/complete stop the machinery.

## 0.17.3

- Repeated root deaths trigger context compaction: a root that needs reviving more than once is usually drowning in its own session (turn submission fails under giant-context load — the openbooks root died three times in an hour at 800M+ tokens). The second and later revivals request bb's thread compaction before resuming.

## 0.17.2

- Errored roots revive themselves: a provider turn failure left the orchestrator thread in error state indefinitely — auto-resume (0.16.3) only reconciled the goal once the root ran again, and nothing restarted it. The pulse now revives an errored root with exponential backoff (2m doubling to a 30m cap, reset on a real turn), completing the self-healing set: workers three-strike restaff, wedged root turns get stopped, blocked goals reconcile on recovery, and dead roots restart.

## 0.17.1

- Decision cards raise for long questions: the interaction title caps at 160 characters and a full-length question was rejected outright — the keeper retried every pulse for ten minutes while the owner saw nothing. Titles now truncate (the card body always renders the full question from the payload), and a failing prompt backs off ten minutes instead of retry-spamming.

## 0.17.0

Completion is a report, not a status label:

- Completion now REQUIRES a delivery summary — what shipped, where it lives (URLs, final HEAD SHA, deploy state), and how it was verified. It is stored durably on the goal.
- The pane renders a completion report when a goal finishes: a check header with the objective, a stats grid (slices delivered, findings fixed, decisions answered, workers, tokens, duration), the delivery summary as Markdown, and the full Delivered list. `bb ultragoal status` prints the summary.

## 0.16.4

- Root-turn watchdog: an orchestrator that stays "active" while its timeline stops growing for 10 minutes is wedged in a provider turn, with queued steers piling up unprocessed behind it. Workers already had the three-strike retire; the root now gets stopped and auto-continued, which also flushes its message queue. (Field case: a root sat "Working…" for 20 minutes with zero output and a growing steer backlog while its goal showed no open work.)

## 0.16.3

- A blocked or usage-limited goal auto-resumes when its root thread runs again. thread.failed marked the goal blocked on any turn error (including transient infrastructure failures like "Command turn.submit failed"), but nothing flipped it back when the root recovered — the pane read Blocked/Stopped over a healthy, restarted thread. Recovery counts as a wake event; paused goals stay paused (user intent).

## 0.16.2

- The intake cursor is durable (goals.intake_row_id): the in-memory cursor re-baselined on every plugin reload and silently swallowed the first owner message after each reload — during active plugin development that was most of them. First-ever sighting per goal still baselines without replaying history; after that, no owner message is ever skipped.

## 0.16.1

- The worker brief names the integration branch precisely: rebase onto the LOCAL default branch (worktrees share the project checkout's refs), never onto origin/* — origin lags the integration branch by design (pushing is the orchestrator's act) and can deliberately diverge from it during a history rewrite. (Field case: "rebase onto the latest default branch" was ambiguous; a worker resolved it as origin/main mid-rewrite-prep, hit unrelated histories, and had to abort — the orchestrator papered over it with a per-goal memory note that is now the contract.)

## 0.16.0

Owner messages are ingested by the plugin, not by hoping the orchestrator notices:

- Intake: every real owner message to the goal thread spawns a dedicated triage agent that files each described defect via report_finding and each feature/UX request via the new add_slice tool, then retires (runtime released). Provenance filters keep it honest — composer-origin user rows only: no inter-thread sends (senderThreadId), no child-outcome system rows (systemMessageKind), no slash commands, and none of the plugin's own steers (now marked [ultragoal]).
- New add_slice tool: workers and intake can add one self-contained plan slice (feature/follow-up work; defects stay report_finding).
- Orchestrator contract updated: acknowledge and coordinate owner messages; Intake owns the filing. (Field case: the owner playtested and typed three defects into the goal thread; the orchestrator ignored them and a human had to file them by hand — twice.)

## 0.15.0

Slice completion is a formal tool call, not a text sentinel:

- New worker tools slice_done (evidence: commit SHAs + passing check output) and slice_blocked (the specific blocker). The claim is recorded durably at call time; completion, verification, integration, and runtime release trigger off the recorded claim at turn end. The old "end your message with exactly one line ULTRAGOAL_DONE: ..." contract was the last prose protocol in the system — models mangle sentinels, wrap them, or forget the format, and the plugin was regexing the final 2,000 characters to find out what happened.
- Verifiers receive the recorded evidence ahead of the worker's output; slice_blocked wakes the orchestrator immediately.
- Sentinel parsing survives only as a transitional fallback for workers briefed before the tools existed, and is removed once current goals finish.

## 0.14.1

- Integration-failure escalations are rate-limited to one per goal per 30 minutes — a persistently dirty base checkout produced a dozen identical conflict steers in ninety minutes, which reads as noise and buries real signal. The warn log still records every failure.

## 0.14.0

External auditors are first-class finding sources:

- New CLI: `bb ultragoal finding "<title>" --file <path[:line]> --evidence "<proof>" [--fix-files a,b] [--check <cmd>]` files a finding directly from outside the goal — scheduled audit bots and humans no longer depend on the orchestrator noticing a handoff message. Same fingerprint dedupe, auto fix slice, scheduler staffing, and completion gate as the report_finding tool (both now share one registration path).
- Orchestrator contract: inbound defect reports and audit handoffs from ANY thread, automation, or human are work, not FYI — each defect becomes report_finding immediately with a visible acknowledgment. (Field case: a scheduled read-only audit thread messaged five serious defects — including a P0 payment-amount bug — and the root let them scroll by; only owner messages were first-class before.)

## 0.13.1

- Scope-width guidance: files scopes gate concurrency, so they must be the narrow set a slice actually touches — overlapping scopes serialize deliberately (slices sharing files belong in one queue), and a whole-app scope serializes the entire goal. Observed live: one slice scoped "apps/web" blocked eight ready slices; narrowing restored 4-wide staffing in seconds. Prefer an empty scope over a broad guess.

## 0.13.0

Active supervision without the poll spam. Event gating (0.9.0) over-corrected: it killed the busy-poll loop but also idled the orchestrator's judgment — nobody reviewed worker direction, merged branches promptly, or narrated substance:

- The 5-minute heartbeat is now a SUPERVISION PASS with explicit duties, in order: inspect each live worker's recent output and steer drift with one targeted follow-up (direction is the orchestrator's job; liveness is the plugin's); merge landed branches rebase-train and push the remote; reconcile the plan with reality; end with a substantive visible update (SHAs, one line per worker on what it is actually doing, what is next, risks) — never a bare "no change".
- More things count as wake events: the scheduler staffing new workers, and a successful auto-integration (the root's cue to push the remote). The gate still blocks empty polling turns.

## 0.12.2

- Goal workers get their worker tools on every provider. The native-goal exclusion (Codex has its own Goal) applied to whole providers, so codex WORKERS had no report_finding/spawn tools — a hunt worker improvised eight prose findings as chat messages the machinery could not act on. The exclusion now applies only to threads that are not registered goal workers.
- Orchestrator contract: the owner's mid-goal steering messages immediately become plan slices with a short visible acknowledgment — user feedback must never scroll by under worker traffic.

## 0.12.1

- Progress clears the strike count: a worker seen actually running resets its nudge tally, so the three-strike retire measures wedged-ness, not work style. (Codex workers legitimately work in short turns; under the old rule they collected three resume-nudges while making real progress and got retired mid-slice.)

## 0.12.0

Clicking a Now row opens the worker's chat history right in the pane — the drill-in behavior adopted from the subagents plugin (its panel is the exemplar; the transcript components are composed the same way):

- A worker row click replaces the pane with that worker's transcript: assistant messages render as Markdown, steering/user messages, thinking, and collapsible shell/tool/edit steps, live-polled while the thread runs, with a "Showing the most recent N steps" cap.
- Back returns to the goal pane; "Open thread ↗" in the detail header is the full-thread jump that row clicks used to do.
- New workerTranscript rpc maps the worker thread's timeline into the shared entry shape, scoped to threads in the goal's own tree.

## 0.11.1

- Restaffed workers are pointed at their predecessor's slice branch (bb names worker branches after the item id), so a continuation checks out or cherry-picks the furthest prior work instead of redoing the slice in a fresh worktree. (Field case: a provider upgrade made every pre-upgrade session unresumable — steering them died instantly; the three-strike retire converges such zombies onto fresh sessions, and continuations must inherit the stranded branch work.)

## 0.11.0

Worker execution is pinned — changing the composer's model can no longer hijack a goal's crew:

- bb's spawn API drops provider/model fields that carry no provenance and re-derives them from the project's stored defaults, which track the composer. When the user switched the composer to Codex to start a manual thread, every subsequently scheduled worker spawned as Codex instead of the goal's model. All plugin spawns (workers and verifiers) now pass executionInputSources: explicit, so the requested execution always survives.
- Resolution order for a worker's execution: spawn_agent's model arg, then the goal's Worker-model pin, then the goal thread's own provider (inherit — the default).
- Settings panel gains a "Worker model" control beside the verifier's: Inherit (goal thread's provider/model) or Pin with the same provider/model picker.

## 0.10.2

Finished workers release their provider runtime. Every completed slice left its agent session loaded, and after a day of goals the host hit memory saturation (93 provider processes, ~64MB free) — at which point NEW worker spawns silently failed at turn start, presenting as workers that "complete" without ever running. Now: a worker's runtime is stopped after its slice integrates (the worktree environment outlives the thread, so the Refinery is unaffected), wedged workers retired by the nudge cap release theirs too, and errored workers were already stopped. One live sweep freed ~2.9GB.

## 0.10.1

Owner decisions moved from a sidebar card to the native center-pane question surface:

- request_decision now raises a real pending interaction in the user's thread (bb.ui.requestInput + a plugin pending-interaction renderer): question, consequences, clickable option buttons, a custom-answer field, and "Dismiss for now". Clicking an answer resolves the durable decision and wakes the orchestrator with it.
- Interactions cap at one hour, so a keeper re-raises the card until the decision is answered (dismissal stops the nagging for the session; the decision stays open and answerable via bb ultragoal decide, which also aborts any live card). Cards survive plugin/server restarts via the pulse sweep.
- The right-pane "Needs you" section is deleted — the status card and state response keep reporting open decisions.

## 0.10.0

Owner decisions are first-class ("Needs you"). A parked decision was one sentence inside one progress note, then buried under poll turns — invisible to the person it waited on:

- New request_decision / resolve_decision tools: anything only the owner can decide (irreversible actions, spend, scope, preference calls) becomes a durable decision record — deduplicated by question, never re-asked, never assumed.
- The pane opens with a "Needs you" section: question, context, options, and the exact answer command. `bb ultragoal status` prints NEEDS YOU lines; the state response returns openDecisions.
- `bb ultragoal decide <decision_id> <answer>` records the answer, wakes the orchestrator with it (event-gated continuation counts it as an event), and steers it to act.
- Open decisions block completion, like open findings. The orchestrator keeps working everything that does not depend on the answer.
- Templates: orchestrators route owner calls through request_decision with one visible chat note; workers escalate owner-only questions instead of guessing.

## 0.9.0

Two live-monitoring findings become architecture — completed work integrates itself, and the orchestrator stops busy-polling:

- **The Refinery.** Completed ≠ integrated: verified slices were stranding in worker worktree branches while local main and the remote stayed stale. Every slice completion (ULTRAGOAL_DONE, or VERIFY_PASS when verification is on) now squash-merges its worker's managed worktree into the base branch through a per-goal serial queue — one merge at a time; merge conflicts escalate to the orchestrator with the branch named. Pushing the remote remains the orchestrator's job.
- **Event-gated continuation.** The root was re-prompted on every idle, so a goal correctly waiting on one long slice degenerated into a 20-30s poll loop ("HEAD unchanged…" ~50 times). The root now gets a turn only when something it must act on happened — slice completed, finding reported, worker blocked/failed, verification cap reached — or on the progress heartbeat. Waiting on live workers is the scheduler's business.

## 0.8.4

- Stall-nudge state is durable (last_nudge_at / nudge_count on the worker row): the cooldown lived in in-memory maps that reset on every plugin reload, which turned "at most one nudge per 15 minutes" into a nudge per release during rapid shipping — one worker collected 11 identical resumes.
- Nudges cap at three: a worker that still never reports is wedged — it is retired and the scheduler restaffs the slice with a fresh worker, which also moves old crews onto the current single-run brief contract.

## 0.8.3

- Worker briefs demand single-run slices: never end a turn to ask to continue, narrate interim progress, or breathe between batches — a turn ends at ULTRAGOAL_DONE or ULTRAGOAL_BLOCKED. (Observed: a worker pausing after every file group, the orchestrator hand-prodding it each time, and the parent feed filling with identical per-turn completion notifications.)

## 0.8.2

The verification loop stops fighting the stall machinery (observed live on the parlour greenfield goal as the same workers "finishing" over and over while auditors multiplied past the name pool):

- A verifier judges a completion claim, not every pause: verifiers spawn only when a worker's report ends with ULTRAGOAL_DONE. Mid-work idles mint no auditors.
- A worker under live verification is not stalled — the stall nudge skips it; the verdict drives the next step.
- VERIFY_FAIL is routed back to the worker WITH the verifier's findings (a blind resume just repeats the mistake), capped at three failed cycles before the slice is left to the orchestrator.
- Auditor names derive from the work under audit ("The Scaffold Skeptic", "Inspector Deploy") instead of exhausting an 8-name pool into "Auditor 20 the Unconvinced".

## 0.8.1

Live cutover of the running goal surfaced four defects; all fixed structurally:

- Plugin-staffed workers are fresh spawns into isolated managed worktrees (hostId from the parent environment) — forking a very large root session fails at thread.start, and sharing the root's directory would put concurrent writers in one checkout. Slice briefs are self-contained by design, so no conversation fork is needed.
- Worker rows are retired, never deleted: a deleted row let child-thread discovery resurrect a dead worker and re-claim its slice, blocking restaffs forever. All readers filter retired rows; discovery's seen-set includes them.
- A failed staffing spawn rolls back its claim, so the slice returns to pending instead of stranding in_progress until the stale window; scheduler spawn errors are caught per-item and heal passes log failures instead of dying as unhandled rejections.
- Verifiers now inspect their worker's environment, not the root's — the worker's edits may not exist anywhere else yet.
- Commit-subject discipline in the worker quality bar: subjects describe the actual change and never repeat an existing subject verbatim; slices rebase onto the latest default branch before final verification; restaffed continuation workers are told to check the log and title their commits by what they add. (Observed in the field: parallel halves of one slice landing as identical-subject commit pairs across a merge.)

## 0.8.0

Clean cut: the DAG contract is the only path. Every compatibility shim is deleted, not deprecated:

- The `managed` opt-in distinction is gone — every plan item is scheduler-managed. Pending slices staff the moment their deps are complete; abandoned in_progress slices restaff after the stale window, whatever their origin. The legacy STAFFING nudge that told the model to spawn workers itself is deleted.
- The native-todo plan mirror (turn/plan/updated projection) is deleted. UltraGoal is the single plan source on every provider; a model using its native todo tool gets an empty pane and a nudge that demands the real contract. Native Task calls still render in Now as live work — observability stays; state authority does not.
- Prose report parsing is deleted (done/blocked signal regexes, the harvest of native session reports by title match). A slice completes on ULTRAGOAL_DONE (or VERIFY_PASS when verification is on) — full stop.
- Output-seeding shims are deleted (seeding an empty plan from previous output prose, hydrating completed items from output text; lib/plan-seed.ts removed).

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

- **Dependency-DAG plan.** Work items now carry `deps` (item_ids or `"#N"` list positions; `[]` = ready now), `files` (the disjoint file scope the slice owns), and `check` (a runnable done-gate). Omitted fields keep the item's existing metadata; deps pointing outside the plan are dropped so a typo cannot deadlock a slice. Items with no metadata stay on the compatibility nudge-staffing path, so live pre-0.5 goals migrate on their next full plan update.
- **Ready-queue scheduler.** The plugin staffs one fresh worker per ready slice — deps complete, file scopes disjoint from in-flight work — up to the goal's worker slots (setting + per-goal override, default 5), and re-staffs managed slices whose workers died (husk detection distinguishes dead workers from idle ones awaiting close). Dispatch is event-driven: a finishing worker immediately unblocks and staffs its dependents. Under-parallelization stops being a model-memory problem: the orchestrator's job is to plan wide (the WIDTH nudge demands further decomposition while slots sit idle, and never padding fake parallelism onto sequential work); staffing is no longer its job at all.
- **Streaming findings queue.** Hunt/audit workers call the new report_finding tool per confirmed defect — fingerprint-deduplicated across sweeps (same file + same defect = same finding) — and each fresh finding auto-creates a ready, file-scoped fix slice that the scheduler staffs while the hunt continues. This kills the serial "fix whatever the hunt proves" tail. Open findings hard-block completion; resolve_finding (with evidence) handles non-defects, and completed repair work closes its findings automatically.
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

- Durable objective orchestration for Cursor, OpenCode, Claude Code, and Pi.
- Orchestrator root with named hidden workers and plan items; sidebar stays a single Goal row.
- Optional second-model verification after each worker returns.
- Per-goal Settings: verify, verifier model, progress chat, auto-continue, token budget.
- `bb goal` CLI for status, set, edit, pause, resume, and clear.
