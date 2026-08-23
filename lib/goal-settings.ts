export const DEFAULT_VERIFY_PROVIDER = "codex";
export const DEFAULT_VERIFY_MODEL = "gpt-5.6-sol";
export const DEFAULT_PROGRESS_UPDATE_MINUTES = 5;
// Evidence-backed slot count: coordination gains for LLM agent teams peak
// around 3-5 workers and industry tooling caps near 8 (docs/architecture-research.md).
export const DEFAULT_MAX_WORKERS = 5;

export interface GoalSettingOverrides {
  verifyEnabled: boolean | null;
  verifyProvider: string | null;
  verifyModel: string | null;
  autoContinue: boolean | null;
  progressUpdateMinutes: number | null;
  maxWorkers: number | null;
}

export interface ResolvedGoalSettings {
  verifyEnabled: boolean;
  verifyProvider: string;
  verifyModel: string;
  autoContinue: boolean;
  progressUpdateMinutes: number;
  maxWorkers: number;
}

export interface GoalSettingDefaults {
  verifyByDefault: boolean;
  verifyProvider: string;
  verifyModel: string;
  autoContinue: boolean;
  progressUpdateMinutes: number;
  maxWorkers: number;
}

export function resolveGoalSettings(
  overrides: GoalSettingOverrides,
  defaults: GoalSettingDefaults,
): ResolvedGoalSettings {
  return {
    verifyEnabled: overrides.verifyEnabled ?? defaults.verifyByDefault,
    verifyProvider: overrides.verifyProvider?.trim() || defaults.verifyProvider,
    verifyModel: overrides.verifyModel?.trim() || defaults.verifyModel,
    autoContinue: overrides.autoContinue ?? defaults.autoContinue,
    progressUpdateMinutes:
      overrides.progressUpdateMinutes ?? defaults.progressUpdateMinutes,
    maxWorkers: overrides.maxWorkers ?? defaults.maxWorkers,
  };
}
