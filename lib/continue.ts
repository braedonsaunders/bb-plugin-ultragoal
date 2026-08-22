export const NATIVE_GOAL_PROVIDERS = new Set(["codex"]);

export function usesNativeGoal(providerId: string): boolean {
  return NATIVE_GOAL_PROVIDERS.has(providerId);
}
