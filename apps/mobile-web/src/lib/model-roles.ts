import type { ModelRoleName, ModelSettings, ResolvedBrain, RoleModelGroup } from './api';

/**
 * Plain words for who handles each part of a request. The phone names a role
 * by what it does, never by a registry term, and every model name it shows
 * comes from the daemon catalog.
 */
export type ModelsRow = 'brain' | ModelRoleName;

export const ROLE_COPY: Record<ModelsRow, { title: string; explain: string; automatic: string }> = {
  brain: {
    title: 'Does the work',
    explain: 'Reads your request, plans it and uses your tools.',
    automatic: '',
  },
  writer: {
    title: 'Writes the final answer',
    explain: 'When a request gathers a lot of material, this model writes your reply from it. Short replies come from the model that does the work.',
    automatic: 'The model that does the work writes every reply.',
  },
  judge: {
    title: 'Checks the work',
    explain: 'Reviews finished work before Clem calls it done.',
    automatic: 'Clem picks a fast model from a different provider than the one writing.',
  },
  worker: {
    title: 'Helps in parallel',
    explain: 'Takes side tasks that run at the same time, like looking into several companies at once.',
    automatic: 'Clem picks, usually the model that does the work.',
  },
};

const PROVIDER_NAME: Record<string, string> = { codex: 'Codex', claude: 'Claude', byo: 'API key' };

/** A saved choice (from Settings on either device, or a chat rule), as
 *  opposed to Clem's automatic pick. */
export function isChosen(resolved?: Pick<ResolvedBrain, 'source'>): boolean {
  return resolved?.source === 'settings' || resolved?.source === 'chat-rule';
}

/** A model's name without its provider repeated in front ("Claude Opus" under
 *  Claude reads "Opus"). */
export function modelName(label: string, providerLabel: string): string {
  const prefix = `${providerLabel} `;
  return label.startsWith(prefix) && label.length > prefix.length ? label.slice(prefix.length) : label;
}

/** "Provider — Model", the same form the brain options use, for an exact id.
 *  An id missing from the catalog shows as itself. */
export function describeModel(modelId: string, groups: RoleModelGroup[] | undefined, provider?: string): string {
  for (const group of groups ?? []) {
    const model = group.models.find((candidate) => candidate.id === modelId);
    if (model) return `${group.label} — ${modelName(model.label, group.label)}`;
  }
  const name = provider ? PROVIDER_NAME[provider] : undefined;
  return name ? `${name} — ${modelId}` : modelId;
}

function catalogGroups(settings: ModelSettings): RoleModelGroup[] {
  const options = settings.roleOptions ?? {};
  return [...(options.writer ?? []), ...(options.judge ?? []), ...(options.worker ?? [])];
}

/** The brain as its picker names it. */
export function brainSummary(settings: ModelSettings): string {
  return settings.options.find((option) => option.value === settings.effectiveValue)?.label
    ?? describeModel(settings.brain.modelId, catalogGroups(settings), settings.brain.provider);
}

/** The model that will actually fill a role, and whether the owner chose it. */
export function roleSummary(role: ModelRoleName, settings: ModelSettings): string {
  const resolved = settings.roles?.[role];
  if (!resolved) return '';
  if (isChosen(resolved)) return describeModel(resolved.modelId, catalogGroups(settings), resolved.provider);
  if (resolved.modelId === settings.brain.modelId) return 'Same model that does the work';
  return `Automatic · ${describeModel(resolved.modelId, catalogGroups(settings), resolved.provider)}`;
}

/** A saved choice that is unavailable, and what runs instead. */
export function inactiveNote(resolved: ResolvedBrain | undefined, settings: ModelSettings): string | null {
  const saved = resolved?.inactiveBinding;
  if (!resolved || !saved || saved.modelId === resolved.modelId) return null;
  const groups = catalogGroups(settings);
  return `Your pick, ${describeModel(saved.modelId, groups, saved.provider)}, isn't available, so ${describeModel(resolved.modelId, groups, resolved.provider)} is used instead.`;
}

/** Warn only when the owner made a choice the checker's independence depends
 *  on: Clem's own pick already avoids the writer's family when it can. */
export function sameFamilyWarning(settings: ModelSettings): string | null {
  if (!settings.judgeReviewsOwnFamily) return null;
  if (!isChosen(settings.roles?.judge) && !isChosen(settings.roles?.writer)) return null;
  return 'The model checking the work comes from the same provider as the one writing it, so the check is less independent. Pick a checker from a different provider.';
}
