import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  createItemRequirementStore,
  missingDeliverables,
  parseDeliverableEvidence,
} from "./deliverables.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function db() {
  const dir = mkdtempSync(join(tmpdir(), "ultragoal-requires-"));
  dirs.push(dir);
  return new Database(join(dir, "data.db")) as unknown as Parameters<
    typeof createItemRequirementStore
  >[0];
}

describe("required outputs", () => {
  it("creates its own table so a missed migration cannot drop the floor", () => {
    const store = createItemRequirementStore(db());
    assert.deepEqual(store.set("thr_g", "itm_1", ["scripts/audit.mjs"]), ["scripts/audit.mjs"]);
    assert.deepEqual(store.list("thr_g", "itm_1"), ["scripts/audit.mjs"]);
  });

  it("normalizes, deduplicates and sorts declared paths", () => {
    const store = createItemRequirementStore(db());
    assert.deepEqual(
      store.set("thr_g", "itm_1", ["b/x.ts:12", " a/y.ts ", "b/x.ts", ""]),
      ["a/y.ts", "b/x.ts"],
    );
  });

  it("replaces rather than accumulates, so editing cannot leave a stale requirement", () => {
    const store = createItemRequirementStore(db());
    store.set("thr_g", "itm_1", ["old.ts"]);
    store.set("thr_g", "itm_1", ["new.ts"]);
    assert.deepEqual(store.list("thr_g", "itm_1"), ["new.ts"]);
  });

  it("keeps requirements per item and per goal", () => {
    const store = createItemRequirementStore(db());
    store.set("thr_a", "itm_1", ["a.ts"]);
    store.set("thr_a", "itm_2", ["b.ts"]);
    store.set("thr_b", "itm_1", ["c.ts"]);
    assert.deepEqual(store.list("thr_a", "itm_1"), ["a.ts"]);
    assert.deepEqual(store.list("thr_a", "itm_2"), ["b.ts"]);
    assert.deepEqual(store.list("thr_b", "itm_1"), ["c.ts"]);
  });

  it("reports nothing for an item that declared no outputs, which is the default", () => {
    // Every existing item is in this state. The floor is opt-in precisely so
    // that adding it cannot retroactively block work already in flight.
    assert.deepEqual(createItemRequirementStore(db()).list("thr_g", "itm_untouched"), []);
    assert.deepEqual(missingDeliverables([], []), []);
  });

  it("clears only the item asked for", () => {
    const store = createItemRequirementStore(db());
    store.set("thr_g", "itm_1", ["a.ts"]);
    store.set("thr_g", "itm_2", ["b.ts"]);
    assert.equal(store.clear("thr_g", "itm_1"), true);
    assert.deepEqual(store.list("thr_g", "itm_1"), []);
    assert.deepEqual(store.list("thr_g", "itm_2"), ["b.ts"]);
    assert.equal(store.clear("thr_g", "itm_1"), false);
  });
});

describe("deliverable evidence", () => {
  const required = ["scripts/audit.mjs", "package.json"];

  it("accepts a complete report and leaves nothing missing", () => {
    const claims = parseDeliverableEvidence([
      "Built the audit and wired it in.",
      'DELIVERABLE: {"path":"scripts/audit.mjs","proof":"scans every outbound fetch; red at f261f465~1"}',
      'DELIVERABLE: {"path":"package.json","proof":"npm test now runs the audit"}',
      "ULTRAGOAL_DONE",
    ].join("\n"));
    assert.deepEqual(missingDeliverables(claims, required), []);
  });

  it("names exactly the outputs a partial report omitted", () => {
    // The failure this exists for: one declared artifact silently never written.
    const claims = parseDeliverableEvidence(
      'DELIVERABLE: {"path":"package.json","proof":"wired"}',
    );
    assert.deepEqual(missingDeliverables(claims, required), ["scripts/audit.mjs"]);
  });

  it("does not accept prose describing the work, however convincing", () => {
    const claims = parseDeliverableEvidence(
      "I wrote scripts/audit.mjs and it scans every outbound fetch in the repository.",
    );
    assert.deepEqual(claims, []);
    assert.deepEqual(missingDeliverables(claims, required), required);
  });

  it("rejects a claim with no proof rather than counting the path alone", () => {
    const claims = parseDeliverableEvidence('DELIVERABLE: {"path":"scripts/audit.mjs","proof":"  "}');
    assert.deepEqual(missingDeliverables(claims, ["scripts/audit.mjs"]), ["scripts/audit.mjs"]);
  });

  it("normalizes a line-qualified path so it still satisfies its requirement", () => {
    const claims = parseDeliverableEvidence('DELIVERABLE: {"path":"scripts/audit.mjs:1","proof":"written"}');
    assert.deepEqual(missingDeliverables(claims, ["scripts/audit.mjs"]), []);
  });

  it("invalidates a path claimed twice with conflicting or malformed lines", () => {
    const conflicting = parseDeliverableEvidence([
      'DELIVERABLE: {"path":"scripts/audit.mjs","proof":"written"}',
      'DELIVERABLE: {"path":"scripts/audit.mjs","proof":""}',
    ].join("\n"));
    assert.deepEqual(missingDeliverables(conflicting, ["scripts/audit.mjs"]), ["scripts/audit.mjs"]);

    const malformed = parseDeliverableEvidence([
      'DELIVERABLE: {"path":"scripts/audit.mjs","proof":"written"}',
      'DELIVERABLE: {"path":"scripts/audit.mjs","proof":}',
    ].join("\n"));
    assert.deepEqual(missingDeliverables(malformed, ["scripts/audit.mjs"]), ["scripts/audit.mjs"]);
  });

  it("ignores an unrequired extra deliverable instead of failing on it", () => {
    const claims = parseDeliverableEvidence([
      'DELIVERABLE: {"path":"scripts/audit.mjs","proof":"written"}',
      'DELIVERABLE: {"path":"package.json","proof":"wired"}',
      'DELIVERABLE: {"path":"docs/extra.md","proof":"bonus"}',
    ].join("\n"));
    assert.deepEqual(missingDeliverables(claims, required), []);
  });
});
