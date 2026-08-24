export const REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
export type ServiceTier = "default" | "fast";

export const DEFAULT_REASONING_LEVEL: ReasoningLevel = "medium";

export const REASONING_LABELS: Record<ReasoningLevel, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  ultracode: "Ultracode",
  max: "Max",
  ultra: "Ultra",
};

/** Composer brand prefixes, used when the catalog does not declare one. */
export const BRAND_PREFIX: Record<string, string> = {
  codex: "GPT-",
  "claude-code": "Claude ",
};

export interface CatalogModel {
  id: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
  defaultReasoning?: ReasoningLevel;
  reasoning: ReasoningLevel[];
  selectedOnly?: boolean;
  /** Nested route (Pi openrouter/anthropic/…). Qualifier only — never a filter. */
  routeProviderId?: string;
}

export interface CatalogProvider {
  id: string;
  displayName: string;
  available: boolean;
  supportsServiceTier: boolean;
  brandPrefix?: string;
  models: CatalogModel[];
}

export interface ExecutionSelection {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  serviceTier: ServiceTier | null;
}

export function isReasoningLevel(value: string | null | undefined): value is ReasoningLevel {
  return REASONING_LEVELS.includes(value as ReasoningLevel);
}

export function isServiceTier(value: string | null | undefined): value is ServiceTier {
  return value === "default" || value === "fast";
}

export function parseReasoningLevel(
  value: string | null | undefined,
  fallback: ReasoningLevel = DEFAULT_REASONING_LEVEL,
): ReasoningLevel {
  return isReasoningLevel(value) ? value : fallback;
}

export function parseServiceTier(value: string | null | undefined): ServiceTier | null {
  return isServiceTier(value) ? value : null;
}

export function stripBrandPrefix(
  label: string,
  providerId: string,
  declared?: string,
): string {
  const prefix = declared || BRAND_PREFIX[providerId];
  if (!prefix) return label;
  return label.toLowerCase().startsWith(prefix.toLowerCase())
    ? label.slice(prefix.length).trimStart()
    : label;
}

export function formatModelLabel(value: string): string {
  return value
    .split("-")
    .map((part) => {
      if (part.toLowerCase() === "gpt") return "GPT";
      if (/^\d+(\.\d+)*$/.test(part)) return part;
      if (/^[a-z]+$/i.test(part)) {
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      }
      return part;
    })
    .join("-");
}

/**
 * Composer policy: keep the previous level when the new model supports it;
 * otherwise pick the closest supported level, breaking ties upward.
 */
export function reconcileReasoningLevel(
  previous: ReasoningLevel,
  supported: readonly ReasoningLevel[],
): ReasoningLevel {
  if (supported.length === 0) return previous;
  if (supported.includes(previous)) return previous;
  const effectivePrevious = previous === "ultracode" ? "xhigh" : previous;
  if (supported.includes(effectivePrevious)) return effectivePrevious;

  const previousRank = REASONING_LEVELS.indexOf(effectivePrevious);
  let bestLevel = supported[0];
  let bestDistance = Math.abs(REASONING_LEVELS.indexOf(bestLevel) - previousRank);
  for (const candidate of supported.slice(1)) {
    const distance = Math.abs(REASONING_LEVELS.indexOf(candidate) - previousRank);
    if (distance < bestDistance) {
      bestLevel = candidate;
      bestDistance = distance;
      continue;
    }
    if (
      distance === bestDistance &&
      REASONING_LEVELS.indexOf(candidate) > REASONING_LEVELS.indexOf(bestLevel)
    ) {
      bestLevel = candidate;
    }
  }
  return bestLevel;
}

export function defaultModelOf(provider: CatalogProvider | undefined): CatalogModel | undefined {
  if (!provider || provider.models.length === 0) return undefined;
  return provider.models.find((model) => model.isDefault && !model.selectedOnly) ??
    provider.models.find((model) => !model.selectedOnly) ??
    provider.models[0];
}

export function selectionForProvider(
  provider: CatalogProvider,
  preferredReasoning: ReasoningLevel = DEFAULT_REASONING_LEVEL,
  serviceTier: ServiceTier | null = null,
): ExecutionSelection | null {
  const model = defaultModelOf(provider);
  if (!model) return null;
  return {
    providerId: provider.id,
    model: model.id,
    reasoningLevel: reconcileReasoningLevel(
      preferredReasoning,
      model.reasoning.length > 0
        ? model.reasoning
        : [model.defaultReasoning ?? preferredReasoning],
    ),
    serviceTier: provider.supportsServiceTier ? serviceTier ?? "default" : null,
  };
}

export function catalogModelsFromOptions(
  options: {
    models?: readonly CatalogOptionRow[];
    selectedOnlyModels?: readonly CatalogOptionRow[];
  },
  providerId: string,
): CatalogModel[] {
  const selectedOnly = new Set(
    (options.selectedOnlyModels ?? []).map((model) => model.model || model.id),
  );
  const rows = [...(options.models ?? []), ...(options.selectedOnlyModels ?? [])];
  const seen = new Set<string>();
  const mapped: CatalogModel[] = [];
  for (const model of rows) {
    const reasoning = (model.supportedReasoningEfforts ?? [])
      .map((effort) => effort.reasoningEffort)
      .filter(isReasoningLevel);
    const defaultReasoning = isReasoningLevel(model.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : undefined;
    const id = model.model || model.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const routeProviderId =
      model.routeProviderId && model.routeProviderId !== providerId
        ? model.routeProviderId
        : undefined;
    mapped.push({
      id,
      displayName: model.displayName || id,
      reasoning,
      ...(model.description ? { description: model.description } : {}),
      ...(model.isDefault ? { isDefault: true } : {}),
      ...(defaultReasoning ? { defaultReasoning } : {}),
      ...(selectedOnly.has(id) ? { selectedOnly: true } : {}),
      ...(routeProviderId ? { routeProviderId } : {}),
    });
  }
  return mapped;
}

export interface CatalogOptionRow {
  id: string;
  model?: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  routeProviderId?: string;
  supportedReasoningEfforts?: readonly { reasoningEffort: string }[];
}

export function selectionForModel(
  provider: CatalogProvider,
  modelId: string,
  preferredReasoning: ReasoningLevel,
  serviceTier: ServiceTier | null,
): ExecutionSelection {
  const model =
    provider.models.find((entry) => entry.id === modelId) ?? defaultModelOf(provider);
  return {
    providerId: provider.id,
    model: model?.id ?? modelId,
    reasoningLevel: reconcileReasoningLevel(preferredReasoning, model?.reasoning ?? []),
    serviceTier: provider.supportsServiceTier ? serviceTier : null,
  };
}
