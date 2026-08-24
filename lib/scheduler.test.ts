import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  filesOverlap,
  findingAction,
  freeSlots,
  liveVerifierCount,
  occupyingWorkerIds,
  orphanInProgressIds,
  threadAcceptsSteer,
} from "./scheduler.ts";

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

describe("findingAction", () => {
  const openItems = [
    { id: "itm_search", status: "in_progress" as const, files: ["web/lib/search.ts"] },
    { id: "itm_pay", status: "pending" as const, files: ["engine/src/payments.ts"] },
  ];

  it("attaches a same-file finding to the existing slice", () => {
    const result = findingAction({
      file: "web/lib/search.ts:88",
      openFindingCount: 95,
      maxOpenFindings: 50,
      openItems,
    });
    assert.deepEqual(result, { action: "attach", attachItemId: "itm_search" });
  });

  it("records without minting once the open-finding cap is hit", () => {
    const result = findingAction({
      file: "web/lib/authz.ts",
      openFindingCount: 50,
      maxOpenFindings: 50,
      openItems,
    });
    assert.deepEqual(result, { action: "record-only" });
  });

  it("mints a slice for a new file under the cap", () => {
    const result = findingAction({
      file: "web/lib/authz.ts",
      openFindingCount: 3,
      maxOpenFindings: 50,
      openItems,
    });
    assert.deepEqual(result, { action: "mint" });
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
