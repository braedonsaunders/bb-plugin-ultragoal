import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  coalescingFilesOverlap,
  findingFilesMatchItem,
  findingMatchesItem,
  filesOverlap,
  findingAction,
  finishedWorkerRetirementCandidates,
  ownSliceScope,
  planWorkerRelease,
  retirementPermittedByHost,
  setSharedInfrastructureFiles,
  freeSlots,
  liveVerifierCount,
  occupyingWorkerIds,
  orphanInProgressIds,
  isTransientTurnFailure,
  isTurnAlreadyActiveError,
  itemContextDeclaresFinding,
  threadAcceptsStart,
  threadAcceptsSteer,
  immediateSendMode,
  threadIsSettledForSubmit,
  verifierStillDeciding,
} from "./scheduler.ts";

describe("planWorkerRelease", () => {
  const ROOT = "thr_root";
  const worker = (over: Record<string, unknown> = {}) => ({
    threadId: "thr_w",
    rootThreadId: ROOT,
    role: "worker" as string | null,
    itemId: "itm_1" as string | null,
    reportStatus: null as string | null,
    hostStatus: "idle" as string | null,
    ...over,
  });

  it("releases an idle worker's slice", () => {
    assert.deepEqual(planWorkerRelease([worker()], ROOT), {
      ok: true,
      release: [{ threadId: "thr_w", itemId: "itm_1" }],
    });
  });

  it("releases a worker whose host could not be read", () => {
    // An unreadable host is not proof of life, and refusing there would make the
    // command useless in exactly the situation it exists for.
    const plan = planWorkerRelease([worker({ hostStatus: null })], ROOT);
    assert.equal(plan.ok, true);
  });

  it("refuses an active or starting worker", () => {
    for (const hostStatus of ["active", "starting"]) {
      const plan = planWorkerRelease([worker({ hostStatus })], ROOT);
      assert.equal(plan.ok, false);
      assert.match((plan as { reason: string }).reason, new RegExp(hostStatus));
    }
  });

  it("refuses a verifier, which holds no slice of its own", () => {
    const plan = planWorkerRelease([worker({ role: "verifier" })], ROOT);
    assert.equal(plan.ok, false);
    assert.match((plan as { reason: string }).reason, /verifier/);
  });

  it("refuses a worker that already reported done", () => {
    const plan = planWorkerRelease([worker({ reportStatus: "done" })], ROOT);
    assert.equal(plan.ok, false);
    assert.match((plan as { reason: string }).reason, /completion path/);
  });

  it("refuses a worker belonging to another root", () => {
    const plan = planWorkerRelease([worker({ rootThreadId: "thr_other" })], ROOT);
    assert.equal(plan.ok, false);
  });

  it("refuses the whole batch when any later target is invalid", () => {
    // Partial release is the failure mode this two-phase shape exists to
    // prevent: the caller could not tell which half of a held item was freed.
    const plan = planWorkerRelease(
      [worker(), worker({ threadId: "thr_w2", hostStatus: "active" })],
      ROOT,
    );
    assert.equal(plan.ok, false);
    assert.match((plan as { reason: string }).reason, /thr_w2/);
  });

  it("refuses an empty target set rather than reporting success", () => {
    assert.equal(planWorkerRelease([], ROOT).ok, false);
  });
});

describe("verifierStillDeciding", () => {
  const GRACE = 10 * 60_000;
  const NOW = 1_000_000_000;
  const noneLive = () => false;

  it("blocks retirement while a verifier is live", () => {
    assert.equal(
      verifierStillDeciding(
        [{ threadId: "thr_v", createdAt: NOW - GRACE * 5, reportStatus: null }],
        (id) => id === "thr_v",
        NOW,
        GRACE,
      ),
      true,
    );
  });

  it("blocks retirement for a young verifier whose verdict may be unharvested", () => {
    assert.equal(
      verifierStillDeciding(
        [{ threadId: "thr_v", createdAt: NOW - 1_000, reportStatus: null }],
        noneLive,
        NOW,
        GRACE,
      ),
      true,
    );
  });

  it("stops blocking once a crashed verifier is past the grace window", () => {
    // verifiersFor returns every non-retired row regardless of host state, so a
    // verifier that died before emitting a verdict used to hold its source
    // worker's slot for the life of the goal.
    assert.equal(
      verifierStillDeciding(
        [{ threadId: "thr_v", createdAt: NOW - GRACE - 1, reportStatus: null }],
        noneLive,
        NOW,
        GRACE,
      ),
      false,
    );
  });

  it("stops blocking as soon as a verifier has recorded its verdict", () => {
    for (const reportStatus of ["done", "blocked"]) {
      assert.equal(
        verifierStillDeciding(
          [{ threadId: "thr_v", createdAt: NOW, reportStatus }],
          () => true,
          NOW,
          GRACE,
        ),
        false,
        `report ${reportStatus} should not block`,
      );
    }
  });

  it("does not block when there is no verifier at all", () => {
    assert.equal(verifierStillDeciding([], noneLive, NOW, GRACE), false);
  });
});

describe("occupyingWorkerIds", () => {
  const open = new Set(["itm_a", "itm_b"]);

  it("counts running workers even without an item", () => {
    const ids = occupyingWorkerIds(
      [{ role: "worker", status: "running", itemId: null, threadId: "thr_1" }],
      open,
    );
    assert.deepEqual(ids, ["thr_1"]);
  });

  it("counts idle workers that still hold an open slice", () => {
    const ids = occupyingWorkerIds(
      [{ role: "worker", status: "idle", itemId: "itm_a", threadId: "thr_1" }],
      open,
    );
    assert.deepEqual(ids, ["thr_1"]);
  });

  it("counts unknown holders so uncached crew cannot leak slots", () => {
    const ids = occupyingWorkerIds(
      [{ role: "worker", status: "unknown", itemId: "itm_a", threadId: "thr_1" }],
      open,
    );
    assert.deepEqual(ids, ["thr_1"]);
  });

  it("does not count idle workers whose slice is already closed", () => {
    const ids = occupyingWorkerIds(
      [{ role: "worker", status: "idle", itemId: "itm_done", threadId: "thr_1" }],
      open,
    );
    assert.deepEqual(ids, []);
  });

  it("does not count verifiers or stopped/error husks", () => {
    const ids = occupyingWorkerIds(
      [
        { role: "verifier", status: "running", itemId: "itm_a", threadId: "thr_v" },
        { role: "worker", status: "stopped", itemId: "itm_a", threadId: "thr_s" },
        { role: "worker", status: "error", itemId: "itm_b", threadId: "thr_e" },
      ],
      open,
    );
    assert.deepEqual(ids, []);
  });

  it("keeps a 5-slot crew at 5 when Codex workers idle mid-slice", () => {
    const agents = [1, 2, 3, 4, 5].map((n) => ({
      role: "worker" as const,
      status: n <= 2 ? ("running" as const) : ("idle" as const),
      itemId: `itm_${n}`,
      threadId: `thr_${n}`,
    }));
    const openFive = new Set(agents.map((agent) => agent.itemId!));
    assert.equal(occupyingWorkerIds(agents, openFive).length, 5);
    assert.equal(freeSlots(5, occupyingWorkerIds(agents, openFive).length), 0);
  });
});

describe("retirementPermittedByHost", () => {
  it("refuses to retire when the host could not be read", () => {
    // Unknown is not proof of death. The in-memory projection drops exactly the
    // workers this pass collects, so treating absence as "not live" would stop
    // a genuinely running worker on any transient host-read failure.
    assert.equal(retirementPermittedByHost(null), false);
  });

  it("refuses to retire a live host in either status vocabulary", () => {
    for (const status of ["active", "running", "starting"]) {
      assert.equal(retirementPermittedByHost(status), false, status);
    }
  });

  it("permits retiring a settled host", () => {
    for (const status of ["idle", "stopped", "error", "completed"]) {
      assert.equal(retirementPermittedByHost(status), true, status);
    }
  });
});

describe("ownSliceScope", () => {
  it("normalizes declared fix files so line-qualified paths still overlap", () => {
    // The scheduler compares scopes as exact paths, so a stored
    // "src/shared.ts:99" would never overlap another slice's "src/shared.ts".
    assert.deepEqual(
      ownSliceScope("src/x.ts:12", ["src/shared.ts:99", "src/other.ts"]),
      ["src/shared.ts", "src/other.ts"],
    );
  });

  it("deduplicates declared files that normalize to the same path", () => {
    assert.deepEqual(
      ownSliceScope("src/x.ts", ["src/a.ts:1", "src/a.ts:2", "src/a.ts"]),
      ["src/a.ts"],
    );
  });

  it("falls back to the normalized evidence file when nothing is declared", () => {
    assert.deepEqual(ownSliceScope("src/x.ts:12", undefined), ["src/x.ts"]);
    assert.deepEqual(ownSliceScope("src/x.ts:12", []), ["src/x.ts"]);
  });

  it("returns an empty scope only when there is genuinely nothing to scope", () => {
    assert.deepEqual(ownSliceScope("", []), []);
  });
});

describe("finishedWorkerRetirementCandidates", () => {
  const noVerifier = () => false;
  const items = [
    { id: "itm_open", status: "in_progress" as const },
    { id: "itm_done", status: "completed" as const },
    { id: "itm_waiting", status: "pending" as const },
  ];

  it("retires a worker whose slice completed but whose host stop failed", () => {
    // The stop is best-effort, so the host can stay `idle` forever. The SQL
    // capacity fence counts the row regardless; without this reconciliation it
    // holds a root slot permanently.
    const retire = finishedWorkerRetirementCandidates(
      [{ role: "worker", itemId: "itm_done", threadId: "thr_done" }],
      items,
      noVerifier,
    );
    assert.deepEqual(retire, ["thr_done"]);
  });

  it("retires a worker whose slice vanished from the plan", () => {
    const retire = finishedWorkerRetirementCandidates(
      [{ role: "worker", itemId: "itm_gone", threadId: "thr_gone" }],
      items,
      noVerifier,
    );
    assert.deepEqual(retire, ["thr_gone"]);
  });

  it("collects a finished worker the agent projection would have dropped", () => {
    // oneWorkerPerItem drops any non-live worker whose item is completed, so the
    // projected list cannot contain this row at all. Reconciling against the
    // projection instead of the durable rows made this function a no-op that
    // still looked correct: the one case it exists for was invisible to it.
    const durableOnly = [{ role: null, itemId: "itm_done", threadId: "thr_invisible" }];
    assert.deepEqual(
      finishedWorkerRetirementCandidates(durableOnly, items, noVerifier),
      ["thr_invisible"],
    );
  });

  it("keeps workers whose slice is still in progress or still pending", () => {
    const retire = finishedWorkerRetirementCandidates(
      [
        { role: "worker", itemId: "itm_open", threadId: "thr_open" },
        { role: "worker", itemId: "itm_waiting", threadId: "thr_waiting" },
      ],
      items,
      noVerifier,
    );
    assert.deepEqual(retire, []);
  });


  it("keeps a finished worker a verifier still reads as its source", () => {
    const retire = finishedWorkerRetirementCandidates(
      [{ role: "worker", itemId: "itm_done", threadId: "thr_done" }],
      items,
      (threadId) => threadId === "thr_done",
    );
    assert.deepEqual(retire, []);
  });

  it("never retires verifiers or itemless crew", () => {
    const retire = finishedWorkerRetirementCandidates(
      [
        { role: "verifier", itemId: "itm_done", threadId: "thr_verifier" },
        { role: "worker", itemId: null, threadId: "thr_itemless" },
      ],
      items,
      noVerifier,
    );
    assert.deepEqual(retire, []);
  });

  it("frees every leaked slot so a wedged full crew can staff again", () => {
    const workers = [1, 2, 3, 4, 5].map((n) => ({
      role: "worker" as const,
      itemId: `itm_${n}`,
      threadId: `thr_${n}`,
    }));
    const closed = workers.map((worker) => ({
      id: worker.itemId,
      status: "completed" as const,
    }));
    assert.equal(
      finishedWorkerRetirementCandidates(workers, closed, noVerifier).length,
      5,
    );
  });
});

describe("findingAction", () => {
  const openItems = [
    {
      id: "itm_search",
      step: "Repair search behavior in web/lib/search.ts",
      status: "in_progress" as const,
      files: ["web/lib/search.ts"],
    },
    {
      id: "itm_pay",
      step: "Repair payment behavior in engine/src/payments.ts",
      status: "pending" as const,
      files: ["engine/src/payments.ts"],
    },
  ];

  it("attaches a same-file finding to the existing slice", () => {
    const result = findingAction({
      findingId: "fnd_search",
      file: "web/lib/search.ts:88",
      staffedRemediationCount: 50,
      maxStaffedRemediations: 50,
      openItems,
    });
    assert.deepEqual(result, { action: "attach", attachItemId: "itm_search" });
  });

  it("records without minting once remediation work capacity is hit", () => {
    const result = findingAction({
      findingId: "fnd_authz",
      file: "web/lib/authz.ts",
      staffedRemediationCount: 50,
      maxStaffedRemediations: 50,
      openItems,
    });
    assert.deepEqual(result, { action: "record-only" });
  });

  it("mints a slice for a new file under the cap", () => {
    const result = findingAction({
      findingId: "fnd_authz",
      file: "web/lib/authz.ts",
      staffedRemediationCount: 3,
      maxStaffedRemediations: 50,
      openItems,
    });
    assert.deepEqual(result, { action: "mint" });
  });

  it("does not attach unrelated findings through a shared migration directory", () => {
    const result = findingAction({
      findingId: "fnd_documents",
      file: "schema/migrations/generated",
      fixFiles: ["schema/src/documents.ts", "schema/migrations/generated"],
      staffedRemediationCount: 3,
      maxStaffedRemediations: 50,
      openItems: [
        {
          id: "itm_recurring",
          step: "Repair recurring logic in engine/src/recurring.ts",
          status: "in_progress" as const,
          files: ["engine/src/recurring.ts", "schema/migrations/generated"],
        },
      ],
    });
    assert.deepEqual(result, { action: "mint" });
  });

  it("does not coalesce distinct lines in a monolithic generated baseline", () => {
    const result = findingAction({
      findingId: "fnd_tenant_fk",
      file: "schema/migrations/generated/0001_baseline.sql:30655",
      fixFiles: ["schema/migrations/generated/0001_baseline.sql"],
      staffedRemediationCount: 3,
      maxStaffedRemediations: 50,
      openItems: [
        {
          id: "itm_tax_rate",
          step:
            "Repair tax-rate persistence [schema/migrations/generated/0001_baseline.sql:1200]",
          status: "in_progress" as const,
          files: ["schema/migrations/generated/0001_baseline.sql"],
        },
      ],
    });
    assert.deepEqual(result, { action: "mint" });
  });

  it("attaches when fix scope shares a concrete domain file", () => {
    const result = findingAction({
      findingId: "fnd_recurring",
      file: "schema/migrations/generated",
      fixFiles: ["engine/src/recurring.ts", "schema/migrations/generated"],
      staffedRemediationCount: 50,
      maxStaffedRemediations: 50,
      openItems: [
        {
          id: "itm_recurring",
          step: "Repair recurring logic in engine/src/recurring.ts",
          status: "in_progress" as const,
          files: ["engine/src/recurring.ts", "schema/migrations/generated"],
        },
      ],
    });
    assert.deepEqual(result, { action: "attach", attachItemId: "itm_recurring" });
  });

  it("attaches an exact Next dynamic-route file", () => {
    const result = findingAction({
      findingId: "fnd_mt97llmk_73ao2v",
      file: "web/app/api/admin/setup/[entity]/route.ts:42",
      staffedRemediationCount: 50,
      maxStaffedRemediations: 50,
      openItems: [
        {
          id: "itm_setup",
          step: "Fix tax setup in web/app/api/admin/setup/[entity]/route.ts",
          status: "pending" as const,
          files: ["web/app/api/admin/setup/[entity]/route.ts"],
        },
      ],
    });
    assert.deepEqual(result, { action: "attach", attachItemId: "itm_setup" });
  });

  it("attaches only ids named by a structured CONTEXT audit-findings clause", () => {
    const item = {
      id: "itm_payment",
      step:
        "Fix payment durability. CONTEXT (audit findings #42 fnd_mt97oet5_3vwaph + #43 fnd_mt97oqxt_pkqakx): both failures share one transaction boundary.",
      status: "pending" as const,
      files: [],
    };
    assert.deepEqual(
      findingAction({
        findingId: "fnd_mt97oqxt_pkqakx",
        file: "schema/migrations/generated",
        staffedRemediationCount: 50,
        maxStaffedRemediations: 50,
        openItems: [item],
      }),
      { action: "attach", attachItemId: "itm_payment" },
    );
    assert.deepEqual(
      findingAction({
        findingId: "fnd_mt97dd9k_xl8bc6",
        file: "schema/migrations/generated",
        staffedRemediationCount: 1,
        maxStaffedRemediations: 50,
        openItems: [
          {
            ...item,
            step:
              "AUDITOR TIGHTENING: fnd_mt97dd9k_xl8bc6 proves broad migration coalescing is WRONG.",
          },
        ],
      }),
      { action: "mint" },
    );
  });
});

describe("findingFilesMatchItem", () => {
  it("matches exact concrete finding and declared repair files", () => {
    const item = {
      step: "Repair segment ownership",
      files: ["schema/src/segments.ts", "schema/migrations/generated"],
    };
    assert.equal(findingFilesMatchItem("schema/src/segments.ts:88", [], item), true);
    assert.equal(
      findingFilesMatchItem(
        "schema/migrations/generated/baseline.sql:12",
        ["schema/src/segments.ts"],
        item,
      ),
      true,
    );
  });

  it("uses concrete files named in the item step", () => {
    assert.equal(
      findingFilesMatchItem(
        "schema/src/pricing.ts:41",
        [],
        {
          step: "Correct rate-book generation in schema/src/pricing.ts.",
          files: ["schema/migrations/generated"],
        },
      ),
      true,
    );
  });

  it("rejects broad directories, shared infrastructure, and unrelated files", () => {
    assert.equal(
      findingFilesMatchItem(
        "schema/migrations/generated",
        ["schema/migrations/generated"],
        {
          step: "Regenerate schema/migrations/generated",
          files: ["schema/src/segments.ts", "schema/migrations/generated"],
        },
      ),
      false,
    );
    assert.equal(
      findingFilesMatchItem(
        "package.json",
        ["schema/canonical-baseline.test.ts"],
        { step: "Update package.json", files: ["package.json"] },
      ),
      false,
    );
    assert.equal(
      findingFilesMatchItem(
        "schema/src/pricing.ts",
        [],
        { step: "Repair schema/src/segments.ts", files: ["schema/src/segments.ts"] },
      ),
      false,
    );
    assert.equal(
      findingFilesMatchItem(
        "schema/migrations/generated/0001_baseline.sql:29912",
        ["schema/migrations/generated/0001_baseline.sql"],
        {
          step: "Repair another baseline line in schema/migrations/generated/0001_baseline.sql",
          files: ["schema/migrations/generated/0001_baseline.sql"],
        },
      ),
      false,
    );
  });

  it("treats square-bracket route segments as literal concrete paths", () => {
    assert.equal(
      findingFilesMatchItem(
        "web/app/api/admin/setup/[entity]/route.ts:19",
        [],
        {
          step: "Repair web/app/api/admin/setup/[entity]/route.ts.",
          files: [],
        },
      ),
      true,
    );
  });
});

describe("structured audit finding declarations", () => {
  const paymentStep =
    "Fix payments. CONTEXT (audit findings #42 fnd_mt97oet5_3vwaph + #43 fnd_mt97oqxt_pkqakx): durable claim required.";
  const appStep =
    "Fix apps. CONTEXT (audit findings #57 fnd_mt97wk5r_6qlleu + #58 fnd_mt97wkcv_xyihvs): make writes atomic.";

  it("accepts exact ids in singular or plural CONTEXT audit clauses", () => {
    assert.equal(itemContextDeclaresFinding(paymentStep, "fnd_mt97oet5_3vwaph"), true);
    assert.equal(itemContextDeclaresFinding(paymentStep, "fnd_mt97oqxt_pkqakx"), true);
    assert.equal(itemContextDeclaresFinding(appStep, "fnd_mt97wk5r_6qlleu"), true);
    assert.equal(itemContextDeclaresFinding(appStep, "fnd_mt97wkcv_xyihvs"), true);
    assert.equal(
      itemContextDeclaresFinding(
        "CONTEXT (audit finding #29, fnd_mt97dwj1_u541eg): enforce credit limits.",
        "fnd_mt97dwj1_u541eg",
      ),
      true,
    );
  });

  it("rejects ids mentioned outside the structured CONTEXT clause", () => {
    const tightening =
      "AUDITOR TIGHTENING: the old attachment of fnd_mt97dd9k_xl8bc6 was WRONG and must be detached.";
    assert.equal(itemContextDeclaresFinding(tightening, "fnd_mt97dd9k_xl8bc6"), false);
    assert.equal(
      findingMatchesItem(
        "fnd_mt97dd9k_xl8bc6",
        "schema/migrations/generated",
        ["schema/migrations/generated"],
        { step: tightening, files: ["schema/migrations/generated"] },
      ),
      false,
    );
  });
});

describe("filesOverlap", () => {
  it("treats a directory scope as overlapping its children", () => {
    assert.equal(filesOverlap(["web/lib"], ["web/lib/search.ts"]), true);
  });

  it("does not overlap sibling files", () => {
    assert.equal(filesOverlap(["web/lib/search.ts"], ["web/lib/authz.ts"]), false);
  });
});

describe("coalescingFilesOverlap", () => {
  it("requires an exact concrete file instead of directory ancestry", () => {
    assert.equal(coalescingFilesOverlap(["web/lib"], ["web/lib/search.ts"]), false);
    assert.equal(coalescingFilesOverlap(["web/lib/search.ts"], ["web/lib/search.ts:42"]), true);
  });

  it("does not use ecosystem manifests as semantic ownership", () => {
    // Only files nearly every repository has are built in. A path meaningful to
    // one project used to sit in this list, which applied that project's layout
    // to every other one.
    for (const manifest of ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
      assert.equal(coalescingFilesOverlap([manifest], [manifest]), false, manifest);
    }
  });

  it("treats a configured repository file as shared, and stops when it is unconfigured", () => {
    const repoFile = "schema/canonical-baseline.test.ts";
    // Unconfigured, it is an ordinary file and may anchor ownership.
    setSharedInfrastructureFiles([]);
    assert.equal(coalescingFilesOverlap([repoFile], [repoFile]), true);
    // Configured, it can no longer merge two unrelated defects.
    setSharedInfrastructureFiles([repoFile]);
    assert.equal(coalescingFilesOverlap([repoFile], [repoFile]), false);
    // The built-ins survive configuration rather than being replaced by it.
    assert.equal(coalescingFilesOverlap(["package.json"], ["package.json"]), false);
    setSharedInfrastructureFiles([]);
  });

  it("normalizes configured paths, so a line-qualified entry still matches", () => {
    setSharedInfrastructureFiles(["schema/inventory.ts:42"]);
    assert.equal(coalescingFilesOverlap(["schema/inventory.ts"], ["schema/inventory.ts"]), false);
    setSharedInfrastructureFiles([]);
  });
});

describe("liveVerifierCount / threadAcceptsSteer / orphanInProgressIds", () => {
  it("counts only live verifiers", () => {
    assert.equal(
      liveVerifierCount([
        { role: "verifier", status: "running" },
        { role: "verifier", status: "idle" },
        { role: "worker", status: "starting" },
      ]),
      1,
    );
  });

  it("refuses archived, deleted, and terminal threads", () => {
    assert.equal(threadAcceptsSteer({ status: "idle" }), true);
    assert.equal(threadAcceptsSteer({ status: "active" }), true);
    assert.equal(threadAcceptsSteer({ status: "error" }), false);
    assert.equal(threadAcceptsSteer({ status: "idle", archivedAt: 1 }), false);
    assert.equal(threadAcceptsSteer({ status: "idle", deletedAt: 1 }), false);
    assert.equal(threadAcceptsSteer({ status: "stopping" }), false);
  });

  it("starts a new turn on idle or errored threads, not live ones", () => {
    assert.equal(threadAcceptsStart({ status: "idle" }), true);
    assert.equal(threadAcceptsStart({ status: "error" }), true);
    assert.equal(threadAcceptsStart({ status: "stopped" }), true);
    assert.equal(threadAcceptsStart({ status: "active" }), false);
    assert.equal(threadAcceptsStart({ status: "starting" }), false);
    assert.equal(threadAcceptsStart({ status: "stopping" }), false);
    assert.equal(threadAcceptsStart({ status: "idle", archivedAt: 1 }), false);
    assert.equal(threadAcceptsStart({ status: "error", deletedAt: 1 }), false);
  });

  it("picks start for idle threads and steer for live ones, never a queue path", () => {
    assert.equal(immediateSendMode({ status: "idle" }), "start");
    assert.equal(immediateSendMode({ status: "error" }), "start");
    assert.equal(immediateSendMode({ status: "stopped" }), "start");
    assert.equal(immediateSendMode({ status: "active" }), "steer");
    assert.equal(immediateSendMode({ status: "starting" }), "steer");
    assert.equal(immediateSendMode({ status: "stopping" }), null);
    assert.equal(immediateSendMode({ status: "idle", archivedAt: 1 }), null);
  });

  it("treats only non-running statuses as settled for submit", () => {
    assert.equal(threadIsSettledForSubmit("idle"), true);
    assert.equal(threadIsSettledForSubmit("error"), true);
    assert.equal(threadIsSettledForSubmit("stopped"), true);
    assert.equal(threadIsSettledForSubmit("active"), false);
    assert.equal(threadIsSettledForSubmit("starting"), false);
    assert.equal(threadIsSettledForSubmit("stopping"), false);
  });

  it("classifies OpenCode ghost-turn submit failures", () => {
    assert.equal(isTurnAlreadyActiveError("A turn is already active"), true);
    assert.equal(isTurnAlreadyActiveError(new Error("Command turn.submit failed: A turn is already active")), true);
    assert.equal(isTurnAlreadyActiveError("HTTP 409: Thread is already active"), false);
    assert.equal(isTransientTurnFailure("Command turn.submit failed"), true);
    assert.equal(isTransientTurnFailure("A turn is already active"), true);
    assert.equal(isTransientTurnFailure("No active ACP session"), true);
    assert.equal(isTransientTurnFailure("Usage limited"), false);
  });

  it("lists in_progress slices nobody holds", () => {
    assert.deepEqual(
      orphanInProgressIds(
        [
          { id: "itm_held", status: "in_progress" },
          { id: "itm_ghost", status: "in_progress" },
          { id: "itm_next", status: "pending" },
        ],
        new Set(["itm_held"]),
      ),
      ["itm_ghost"],
    );
  });
});
