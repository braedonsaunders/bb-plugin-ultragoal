import {
  DEFAULT_REASONING_LEVEL,
  parseReasoningLevel,
  parseServiceTier,
  type ReasoningLevel,
  type ServiceTier,
} from "./execution.js";

export const DEFAULT_VERIFY_PROVIDER = "codex";
export const DEFAULT_VERIFY_MODEL = "gpt-5.6-sol";
export const DEFAULT_PROGRESS_UPDATE_MINUTES = 5;
// Evidence-backed slot count: coordination gains for LLM agent teams peak
// around 3-5 workers and industry tooling caps near 8 (docs/architecture-research.md).
export const DEFAULT_MAX_WORKERS = 5;
export { DEFAULT_MAX_OPEN_FINDINGS } from "./scheduler.js";

export interface GoalSettingOverrides {
  verifyEnabled: boolean | null;
  verifyProvider: string | null;
  verifyModel: string | null;
  verifyReasoning: string | null;
  verifyServiceTier: string | null;
  autoContinue: boolean | null;
  progressUpdateMinutes: number | null;
  maxWorkers: number | null;
  maxOpenFindings: number | null;
  workerProvider: string | null;
  workerModel: string | null;
  workerReasoning: string | null;
  workerServiceTier: string | null;
}

export interface ResolvedGoalSettings {
  verifyEnabled: boolean;
  verifyProvider: string;
  verifyModel: string;
  verifyReasoning: ReasoningLevel;
  verifyServiceTier: ServiceTier | null;
  autoContinue: boolean;
  progressUpdateMinutes: number;
  maxWorkers: number;
  maxOpenFindings: number;
  workerProvider: string;
  workerModel: string;
  workerReasoning: ReasoningLevel | "";
  workerServiceTier: ServiceTier | null;
}

/** The three permission modes bb exposes for a spawned thread. */
export type AgentPermissionMode = "auto" | "accept-edits" | "full";

/**
 * Anything but `auto` weakens the approval gate a spawned agent runs behind, so
 * an unrecognised value must fall back to the safe one rather than to whatever
 * the operator meant to type.
 */
export function normalizePermissionMode(value: string | null | undefined): AgentPermissionMode {
  const mode = (value ?? "").trim().toLowerCase();
  return mode === "full" || mode === "accept-edits" ? mode : "auto";
}

export interface GoalSettingDefaults {
  verifyByDefault: boolean;
  verifyProvider: string;
  verifyModel: string;
  autoContinue: boolean;
  progressUpdateMinutes: number;
  maxWorkers: number;
  maxOpenFindings: number;
  /** Off unless an operator deliberately opts in; see the setting's description. */
  autoApproveAgentRequests: boolean;
  workerPermissionMode: AgentPermissionMode;
}

export function resolveGoalSettings(
  overrides: GoalSettingOverrides,
  defaults: GoalSettingDefaults,
): ResolvedGoalSettings {
  const workerProvider = overrides.workerProvider?.trim() ?? "";
  return {
    verifyEnabled: overrides.verifyEnabled ?? defaults.verifyByDefault,
    verifyProvider: overrides.verifyProvider?.trim() || defaults.verifyProvider,
    verifyModel: overrides.verifyModel?.trim() || defaults.verifyModel,
    verifyReasoning: parseReasoningLevel(
      overrides.verifyReasoning,
      DEFAULT_REASONING_LEVEL,
    ),
    verifyServiceTier: parseServiceTier(overrides.verifyServiceTier),
    autoContinue: overrides.autoContinue ?? defaults.autoContinue,
    progressUpdateMinutes:
      overrides.progressUpdateMinutes ?? defaults.progressUpdateMinutes,
    maxWorkers: overrides.maxWorkers ?? defaults.maxWorkers,
    maxOpenFindings: overrides.maxOpenFindings ?? defaults.maxOpenFindings,
    workerProvider,
    workerModel: overrides.workerModel?.trim() ?? "",
    workerReasoning: workerProvider
      ? parseReasoningLevel(overrides.workerReasoning)
      : "",
    workerServiceTier: workerProvider
      ? parseServiceTier(overrides.workerServiceTier)
      : null,
  };
}
