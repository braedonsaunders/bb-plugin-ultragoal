import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizePermissionMode } from "./goal-settings.ts";

describe("spawned agent permission mode", () => {
  it("accepts the two modes that deliberately weaken the approval gate", () => {
    assert.equal(normalizePermissionMode("full"), "full");
    assert.equal(normalizePermissionMode("accept-edits"), "accept-edits");
    assert.equal(normalizePermissionMode(" FULL "), "full");
  });

  it("falls back to auto for anything it does not recognise", () => {
    // A typo must never silently hand a spawned agent full access. Every
    // unrecognised value resolves to the mode that still asks.
    for (const value of ["", "  ", "yes", "true", "always", "full-access", "none", null, undefined]) {
      assert.equal(normalizePermissionMode(value), "auto", `for ${JSON.stringify(value)}`);
    }
  });
});
