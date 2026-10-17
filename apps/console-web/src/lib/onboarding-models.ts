import type { ActiveBrain, SettingsSnapshot } from './settings';

export interface OnboardingBrainChoice {
  value: string;
  brain: ActiveBrain;
  modelId: string;
  label: string;
  available: boolean;
}

/** Only the server's exact model roster can supply setup choices. A saved key,
 * an auth badge, or a resolved role by itself does not make a runnable model. */
export function onboardingBrainChoices(settings: SettingsSnapshot | undefined): OnboardingBrainChoice[] {
  return (settings?.modelRoles?.brainOptions ?? []).flatMap((option) => {
    if (!option.modelId || !option.label || !['codex_oauth', 'claude_oauth', 'api_key'].includes(option.id)
      || option.value !== `${option.id}:${option.modelId}`) return [];
    return [{ value: option.value, brain: option.id, modelId: option.modelId,
      label: option.label, available: option.available === true }];
  });
}

/** Ready means one exact available choice agrees with the server's effective
 * route AND resolved brain. Never select the first connected account for them. */
export function selectedOnboardingBrain(settings: SettingsSnapshot | undefined): OnboardingBrainChoice | null {
  const roles = settings?.modelRoles;
  const value = roles?.effectiveBrainValue;
  const brain = roles?.effectiveBrain;
  if (!value || value !== value.trim() || !roles?.roles.brain.modelId
    || (brain !== 'codex_oauth' && brain !== 'claude_oauth' && brain !== 'api_key')) return null;
  // Count the raw matching rows before presentation filtering, just as the
  // native finisher does: a malformed duplicate cannot hide ambiguity.
  const matches = (roles.brainOptions ?? []).filter((option) => option.value === value);
  const option = matches.length === 1 ? matches[0] : undefined;
  if (option?.available !== true || option.id !== brain || !option.modelId || option.modelId !== option.modelId.trim()
    || value !== `${brain}:${option.modelId}` || option.modelId !== roles.roles.brain.modelId) return null;
  return { value, brain, modelId: option.modelId, label: option.label || option.modelId, available: true };
}

/** Refuse a stale or ambiguous draft before sending the canonical save. */
export function onboardingPrimarySelection(settings: SettingsSnapshot | undefined, value: string): {
  brain: ActiveBrain; modelId: string;
} | null {
  const matches = onboardingBrainChoices(settings).filter((choice) => choice.value === value);
  return matches.length === 1 && matches[0].available ? { brain: matches[0].brain, modelId: matches[0].modelId } : null;
}

/** The backup API takes model IDs, so an ID with more than one roster owner is
 * not a choice here. Keep saved unavailable IDs visible until explicitly edited. */
export function onboardingBackupChoices(settings: SettingsSnapshot | undefined): OnboardingBrainChoice[] {
  const choices = onboardingBrainChoices(settings).filter((choice) => choice.available);
  const primary = selectedOnboardingBrain(settings);
  return choices.filter((choice) => choice.modelId !== primary?.modelId
    && choices.filter((other) => other.modelId === choice.modelId).length === 1);
}

export function onboardingBackupSelection(settings: SettingsSnapshot | undefined, modelIds: readonly string[]): string[] | null {
  if (!settings?.modelRoles?.brainBackups || modelIds.length > 3 || new Set(modelIds).size !== modelIds.length) return null;
  const available = new Set(onboardingBackupChoices(settings).map((choice) => choice.modelId));
  return modelIds.every((id) => available.has(id)) ? [...modelIds] : null;
}
