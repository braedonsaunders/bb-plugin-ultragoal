import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createStaffingHoldStore } from "./staffing-hold.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function store() {
  const dir = mkdtempSync(join(tmpdir(), "ultragoal-hold-"));
  dirs.push(dir);
  const db = new Database(join(dir, "data.db")) as unknown as Parameters<
    typeof createStaffingHoldStore
  >[0];
  return createStaffingHoldStore(db);
}

describe("staffing holds", () => {
  it("creates its own table so a missed migration cannot drop the hold", () => {
    const holds = store();
    holds.hold("thr_g", "itm_1", "released for re-scoping", 1000);
    assert.equal(holds.isHeld("thr_g", "itm_1"), true);
  });

  it("reports nothing held by default, which is every existing item", () => {
    assert.equal(store().isHeld("thr_g", "itm_untouched"), false);
  });

  it("holds one item without holding the rest of the goal", () => {
    // The whole point: editing one slice used to require pausing every slice.
    const holds = store();
    holds.hold("thr_g", "itm_1", null, 1000);
    assert.equal(holds.isHeld("thr_g", "itm_1"), true);
    assert.equal(holds.isHeld("thr_g", "itm_2"), false);
  });

  it("keeps holds per goal", () => {
    const holds = store();
    holds.hold("thr_a", "itm_1", null, 1000);
    assert.equal(holds.isHeld("thr_a", "itm_1"), true);
    assert.equal(holds.isHeld("thr_b", "itm_1"), false);
  });

  it("is idempotent, so re-holding does not stack or throw", () => {
    const holds = store();
    holds.hold("thr_g", "itm_1", "first", 1000);
    holds.hold("thr_g", "itm_1", "second", 2000);
    assert.deepEqual(holds.list("thr_g"), [{ itemId: "itm_1", reason: "second" }]);
  });

  it("reports whether a lift actually did anything, so callers can say so", () => {
    const holds = store();
    holds.hold("thr_g", "itm_1", null, 1000);
    assert.equal(holds.lift("thr_g", "itm_1"), true);
    assert.equal(holds.lift("thr_g", "itm_1"), false);
    assert.equal(holds.isHeld("thr_g", "itm_1"), false);
  });

  it("lifts only the item asked for", () => {
    const holds = store();
    holds.hold("thr_g", "itm_1", null, 1000);
    holds.hold("thr_g", "itm_2", null, 1000);
    holds.lift("thr_g", "itm_1");
    assert.equal(holds.isHeld("thr_g", "itm_2"), true);
  });

  it("normalizes a blank reason to none rather than storing whitespace", () => {
    const holds = store();
    holds.hold("thr_g", "itm_1", "   ", 1000);
    assert.deepEqual(holds.list("thr_g"), [{ itemId: "itm_1", reason: null }]);
  });

  it("lists every held slice so a forgotten hold is visible, not silent", () => {
    const holds = store();
    holds.hold("thr_g", "itm_b", "re-scoping", 1000);
    holds.hold("thr_g", "itm_a", null, 1000);
    assert.deepEqual(holds.list("thr_g"), [
      { itemId: "itm_a", reason: null },
      { itemId: "itm_b", reason: "re-scoping" },
    ]);
  });
});
