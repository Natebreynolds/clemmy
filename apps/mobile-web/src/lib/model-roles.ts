import { MEMORY_ROLE_WORDS, memoryModelUnavailableText, memoryRoleAutomaticText } from '@clem/chat-engine';
import { clockText } from './memory-work';
import type { JudgeFallbackSelection, JudgeFallbackSetting, ModelRoleName, ModelSettings, ResolvedBrain, RoleModelGroup } from './api';

export function judgeFallbackValue(setting: JudgeFallbackSetting): string {
  return setting.mode === 'model' ? `model:${setting.modelId ?? ''}` : setting.mode;
}

export function judgeFallbackSelection(value: string): JudgeFallbackSelection {
  if (value === 'automatic' || value === 'off') return { mode: value };
  if (value.startsWith('model:') && value.slice(6)) return { mode: 'model', modelId: value.slice(6) };
  throw new Error('Choose a fallback judge from the list.');
}

export function judgeFallbackChoices(settings: ModelSettings): Array<{ id: string; label: string; available: boolean }> {
  const setting = settings.judgeFallback;
  const rows = (setting?.options ?? settings.roleOptions?.judge ?? []).flatMap((group) => group.models.map((model) => ({
    id: model.id,
    label: `${group.label} — ${modelName(model.label, group.label)}`,
    available: !(setting?.mode === 'model' && setting.modelId === model.id && setting.available === false),
  })));
  if (setting?.mode === 'model' && !rows.some((row) => row.id === (setting.modelId ?? ''))) {
    rows.push({ id: setting.modelId ?? '', label: setting.modelId || 'Saved model', available: false });
  }
  return rows;
}

/**
 * Plain words for who handles each part of a request, and who keeps your
 * memory in the background. The phone names a role by what it does, never by
 * a registry term, and every model name it shows comes from the daemon
 * catalog.
 */
export type ModelsRow = 'brain' | ModelRoleName;

export const ROLE_COPY: Record<ModelsRow, {
  title: string;
  explain: string;
  automatic: string;
  /** What a saved pick changes, when it is not the next message. */
  saved?: string;
}> = {
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
  // The words are the desktop's too (@clem/chat-engine), so the two can never
  // name this role differently. Its automatic line depends on whose model it
  // borrows today, which only the daemon knows: see roleAutomaticText.
  memory: {
    title: MEMORY_ROLE_WORDS.title,
    explain: MEMORY_ROLE_WORDS.explain,
    automatic: MEMORY_ROLE_WORDS.automaticNone,
    saved: 'Saved. The next memory job uses it.',
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
 *  The brain options name models of a provider that is not connected too; an
 *  id missing from both shows as itself. */
export function describeModel(
  modelId: string,
  groups: RoleModelGroup[] | undefined,
  provider?: string,
  brainOptions: ModelSettings['options'] = [],
): string {
  for (const group of groups ?? []) {
    const model = group.models.find((candidate) => candidate.id === modelId);
    if (model) return `${group.label} — ${modelName(model.label, group.label)}`;
  }
  const named = brainOptions.find((option) => option.modelId === modelId);
  if (named) return named.label;
  const name = provider ? PROVIDER_NAME[provider] : undefined;
  return name ? `${name} — ${modelId}` : modelId;
}

function catalogGroups(settings: ModelSettings): RoleModelGroup[] {
  const options = settings.roleOptions ?? {};
  return [...(options.writer ?? []), ...(options.judge ?? []), ...(options.worker ?? []), ...(options.memory ?? [])];
}

function describe(modelId: string, provider: string | undefined, settings: ModelSettings): string {
  return describeModel(modelId, catalogGroups(settings), provider, settings.options);
}

/** "Provider — Model" for any model id the daemon reports (a memory job's
 *  served model, say), named from the same catalog as the Models card. Before
 *  the catalog loads, or for an id it does not know, the id shows as itself. */
export function modelLabel(modelId: string, settings: ModelSettings | null | undefined): string {
  return settings ? describe(modelId, undefined, settings) : modelId;
}

/** The note under "Automatic" in a role's picker. Keeps your memory borrows
 *  another role's model, and the daemon says whose. */
export function roleAutomaticText(role: ModelRoleName, resolved?: Partial<Pick<ResolvedBrain, 'follows' | 'modelId'>>): string {
  return role === 'memory' ? memoryRoleAutomaticText(resolved?.follows ?? null, resolved?.modelId || null) : ROLE_COPY[role].automatic;
}

/** The brain as its picker names it. */
export function brainSummary(settings: ModelSettings): string {
  return settings.options.find((option) => option.value === settings.effectiveValue)?.label
    ?? describe(settings.brain.modelId, settings.brain.provider, settings);
}

/** The model that will actually fill a role, and whether the owner chose it. */
export function roleSummary(role: ModelRoleName, settings: ModelSettings): string {
  const resolved = settings.roles?.[role];
  if (!resolved) return '';
  // No model at all (Keeps your memory, when nothing it may use is reachable):
  // say so rather than print an empty name.
  if (!resolved.modelId) {
    const saved = resolved.inactiveBinding;
    if (saved?.modelId) return `${describe(saved.modelId, saved.provider, settings)} · not available right now`;
    return isChosen(resolved) ? 'No model available right now' : 'Automatic · no model available right now';
  }
  if (isChosen(resolved)) return describe(resolved.modelId, resolved.provider, settings);
  // Whose model Keeps your memory borrows is the daemon's to say (roleNote);
  // an id that happens to match the brain's says nothing about it.
  if (role !== 'memory' && resolved.modelId === settings.brain.modelId) return 'Same model that does the work';
  return `Automatic · ${describe(resolved.modelId, resolved.provider, settings)}`;
}

/** The line under a role's summary in Settings › Models: for Keeps your
 *  memory on Automatic, whose model it borrows today, as the daemon resolved
 *  it (the same words the picker and the desktop use). */
export function roleNote(role: ModelRoleName, settings: ModelSettings): string | null {
  const resolved = settings.roles?.[role];
  if (role !== 'memory' || !resolved?.modelId || isChosen(resolved) || !resolved.follows) return null;
  return memoryRoleAutomaticText(resolved.follows, resolved.modelId);
}

/** A saved choice that is unavailable, and what runs instead. When nothing
 *  runs in its place (Keeps your memory never substitutes a pick), the work
 *  waits for it, and the note says that instead of naming a stand-in. For
 *  Keeps your memory it also says why its model cannot serve at all. */
export function inactiveNote(resolved: ResolvedBrain | undefined, settings: ModelSettings, role?: ModelRoleName): string | null {
  const saved = resolved?.inactiveBinding;
  // Keeps your memory with no saved pick in the way (Automatic with nothing
  // that can serve, or a pick out of quota or backing off): the daemon's
  // reason, in the Mac's words.
  if (role === 'memory' && resolved?.unavailable && !saved) {
    const name = resolved.modelId ? describe(resolved.modelId, resolved.provider, settings) : null;
    return memoryModelUnavailableText(resolved.unavailable, name, { clock: (iso) => clockText(iso, Date.now()) });
  }
  if (!resolved || !saved) return null;
  const pick = describe(saved.modelId, saved.provider, settings);
  const nothingRuns = !resolved.modelId || (role === 'memory' && saved.modelId === resolved.modelId);
  if (!nothingRuns && saved.modelId === resolved.modelId) return null;
  if (nothingRuns) {
    return role === 'memory'
      ? `Your pick, ${pick}, isn't available, so learning waits until it is back. Nothing is lost.`
      : `Your pick, ${pick}, isn't available, and nothing runs in its place until it is back.`;
  }
  return `Your pick, ${pick}, isn't available, so ${describe(resolved.modelId, resolved.provider, settings)} is used instead.`;
}

/** Warn only when the owner made a choice the checker's independence depends
 *  on: Clem's own pick already avoids the writer's family when it can. */
export function sameFamilyWarning(settings: ModelSettings): string | null {
  if (!settings.judgeReviewsOwnFamily) return null;
  if (!isChosen(settings.roles?.judge) && !isChosen(settings.roles?.writer)) return null;
  return 'The model checking the work comes from the same provider as the one writing it, so the check is less independent. Pick a checker from a different provider.';
}
