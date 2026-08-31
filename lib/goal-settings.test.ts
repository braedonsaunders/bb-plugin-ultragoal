import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizePermissionMode, resolveGoalSettings, type GoalSettingDefaults } from "./goal-settings.ts";

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

describe("safety-sensitive goal defaults", () => {
  it("keeps repository mutation and provider-store reads off without explicit overrides", () => {
    const defaults: GoalSettingDefaults = {
      verifyByDefault: true,
      verifyProvider: "codex",
      verifyModel: "gpt-5.6-sol",
      autoContinue: true,
      progressUpdateMinutes: 5,
      maxWorkers: 5,
      maxOpenFindings: 50,
      autoApproveAgentRequests: false,
      workerPermissionMode: "auto",
      autoIntegrateCompletedSlices: false,
      reclaimMergedWorktrees: false,
      readLocalProviderData: false,
      shareWorktreeNodeModules: true,
    };
    const settings = resolveGoalSettings(
      {
        verifyEnabled: null,
        verifyProvider: null,
        verifyModel: null,
        verifyReasoning: null,
        verifyServiceTier: null,
        autoContinue: null,
        progressUpdateMinutes: null,
        maxWorkers: null,
        maxOpenFindings: null,
        workerProvider: null,
        workerModel: null,
        workerReasoning: null,
        workerServiceTier: null,
        autoIntegrateCompletedSlices: null,
        reclaimMergedWorktrees: null,
        readLocalProviderData: null,
      },
      defaults,
    );
    assert.equal(settings.autoIntegrateCompletedSlices, false);
    assert.equal(settings.reclaimMergedWorktrees, false);
    assert.equal(settings.readLocalProviderData, false);
  });
});
