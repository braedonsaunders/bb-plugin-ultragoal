import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  catalogModelsFromOptions,
  reconcileReasoningLevel,
  selectionForModel,
  selectionForProvider,
  stripBrandPrefix,
  type CatalogProvider,
} from "./execution.ts";

describe("reconcileReasoningLevel", () => {
  it("keeps a supported level", () => {
    assert.equal(reconcileReasoningLevel("high", ["low", "medium", "high"]), "high");
  });

  it("picks the closest higher level on a tie", () => {
    assert.equal(reconcileReasoningLevel("medium", ["low", "high"]), "high");
  });

  it("treats ultracode as xhigh", () => {
    assert.equal(reconcileReasoningLevel("ultracode", ["high", "xhigh", "max"]), "xhigh");
  });
});

describe("stripBrandPrefix", () => {
  it("drops the Codex GPT- prefix", () => {
    assert.equal(stripBrandPrefix("GPT-5.6-Sol", "codex"), "5.6-Sol");
  });

  it("drops a declared Claude prefix", () => {
    assert.equal(stripBrandPrefix("Claude Sonnet 4.6", "claude-code", "Claude "), "Sonnet 4.6");
  });
});

const catalog: CatalogProvider = {
  id: "codex",
  displayName: "Codex",
  available: true,
  supportsServiceTier: true,
  models: [
    {
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      isDefault: true,
      defaultReasoning: "medium",
      reasoning: ["medium", "high", "xhigh"],
    },
    {
      id: "gpt-light",
      displayName: "GPT Light",
      reasoning: ["low"],
    },
  ],
};

describe("selectionForProvider / selectionForModel", () => {
  it("pins the default model and keeps a supported service tier", () => {
    assert.deepEqual(selectionForProvider(catalog, "high", "fast"), {
      providerId: "codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
      serviceTier: "fast",
    });
  });

  it("reconciles reasoning and drops service tier on a model without it", () => {
    const claude: CatalogProvider = {
      ...catalog,
      id: "claude-code",
      displayName: "Claude Code",
      supportsServiceTier: false,
    };
    assert.deepEqual(selectionForModel(claude, "gpt-light", "high", "fast"), {
      providerId: "claude-code",
      model: "gpt-light",
      reasoningLevel: "low",
      serviceTier: null,
    });
  });
});

describe("catalogModelsFromOptions", () => {
  it("keeps Pi nested routes instead of filtering them out", () => {
    const models = catalogModelsFromOptions(
      {
        models: [
          {
            id: "openrouter/anthropic/claude-sonnet-4.6",
            model: "openrouter/anthropic/claude-sonnet-4.6",
            displayName: "Anthropic: Claude Sonnet 4.6",
            routeProviderId: "openrouter",
            supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
          },
        ],
      },
      "pi",
    );
    assert.equal(models.length, 1);
    assert.equal(models[0].routeProviderId, "openrouter");
    assert.equal(models[0].id, "openrouter/anthropic/claude-sonnet-4.6");
  });
});
