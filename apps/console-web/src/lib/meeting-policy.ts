export interface MeetingPolicyModelOption {
  id: string;
  label: string;
  providerLabel: string;
  available: boolean;
  reason?: string;
}

export interface MeetingPolicyDefaultModel {
  modelId: string | null;
  label: string;
  available: boolean;
  reason?: string;
}

export interface MeetingPolicyDraft {
  before: { calendarPrepSuggestions: boolean };
  during: { modelId: string | null };
  after: { modelId: string | null };
}

export interface MeetingPolicy extends MeetingPolicyDraft {
  version: 1;
  revision: number;
  updatedAt: string | null;
  modelOptions: { live: MeetingPolicyModelOption[]; after: MeetingPolicyModelOption[] };
  defaults: { live: MeetingPolicyDefaultModel; after: MeetingPolicyDefaultModel };
  preparation?: {
    state: 'ready' | 'calendar_needed' | 'watch_off' | 'suggestions_off' | 'waiting_for_calendar' | 'unavailable';
    message: string;
  };
}

export interface MeetingPolicyEditor {
  saved: MeetingPolicy;
  draft: MeetingPolicyDraft;
}

export type MeetingPolicyStage = 'live' | 'after';
type Request = (path: string, options?: RequestInit) => Promise<unknown>;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function label(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
}

function modelId(value: unknown): value is string | null {
  return value === null || (label(value) && value === value.trim());
}

function reason(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= 1_000);
}

function option(value: unknown): value is MeetingPolicyModelOption {
  return record(value) && modelId(value.id) && value.id !== null && label(value.label)
    && label(value.providerLabel) && typeof value.available === 'boolean' && reason(value.reason);
}

function options(value: unknown): value is MeetingPolicyModelOption[] {
  return Array.isArray(value) && value.length <= 1_000 && value.every(option)
    && new Set(value.map((item) => item.id)).size === value.length;
}

function defaultModel(value: unknown): value is MeetingPolicyDefaultModel {
  return record(value) && modelId(value.modelId) && label(value.label)
    && typeof value.available === 'boolean' && reason(value.reason);
}

function validDraft(value: unknown): value is MeetingPolicyDraft {
  return record(value) && record(value.before) && typeof value.before.calendarPrepSuggestions === 'boolean'
    && record(value.during) && modelId(value.during.modelId) && record(value.after) && modelId(value.after.modelId);
}

function preparation(value: unknown): boolean {
  return value === undefined || (record(value) && typeof value.state === 'string'
    && ['ready', 'calendar_needed', 'watch_off', 'suggestions_off', 'waiting_for_calendar', 'unavailable'].includes(value.state)
    && label(value.message));
}

/** An unreadable profile must never turn into an editable set of defaults. */
export function meetingPolicyPayload(value: unknown): MeetingPolicy {
  if (!record(value) || value.ok === false || value.version !== 1 || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0 || !(value.updatedAt === null
      || (typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))))
    || !validDraft(value) || !record(value.modelOptions) || !options(value.modelOptions.live)
    || !options(value.modelOptions.after) || !record(value.defaults)
    || !defaultModel(value.defaults.live) || !defaultModel(value.defaults.after) || !preparation(value.preparation)) {
    throw new Error('Your saved meeting settings could not be read.');
  }
  return value as unknown as MeetingPolicy;
}

export function meetingPolicyDraft(policy: MeetingPolicyDraft): MeetingPolicyDraft {
  return {
    before: { calendarPrepSuggestions: policy.before.calendarPrepSuggestions },
    during: { modelId: policy.during.modelId },
    after: { modelId: policy.after.modelId },
  };
}

/** A conflict read advances the comparison/revision, but never overwrites the owner's unsaved choices. */
export function adoptMeetingPolicy(policy: MeetingPolicy, previous?: MeetingPolicyEditor | null, keepDraft = false): MeetingPolicyEditor {
  return { saved: policy, draft: meetingPolicyDraft(keepDraft && previous ? previous.draft : policy) };
}

export function meetingPolicyChanged(editor: MeetingPolicyEditor): boolean {
  return editor.draft.before.calendarPrepSuggestions !== editor.saved.before.calendarPrepSuggestions
    || editor.draft.during.modelId !== editor.saved.during.modelId || editor.draft.after.modelId !== editor.saved.after.modelId;
}

export function meetingPolicyPatch(editor: MeetingPolicyEditor): MeetingPolicyDraft & { expectedRevision: number } {
  if (!Number.isSafeInteger(editor.saved.revision) || editor.saved.revision < 0 || !validDraft(editor.draft)) {
    throw new Error('Read your saved meeting settings before saving changes.');
  }
  // Deliberately exclude catalog/default data and all capture/research permissions.
  return { expectedRevision: editor.saved.revision, ...meetingPolicyDraft(editor.draft) };
}

export function meetingPolicyModelChoices(policy: MeetingPolicy, stage: MeetingPolicyStage, selectedId: string | null): MeetingPolicyModelOption[] {
  const choices = policy.modelOptions[stage];
  if (selectedId === null || choices.some((choice) => choice.id === selectedId)) return choices;
  return [...choices, { id: selectedId, label: 'Previously selected model', providerLabel: 'Unavailable', available: false,
    reason: 'This model is no longer in your connected model choices. Choose another model when you are ready.' }];
}

export function selectedMeetingPolicyModel(policy: MeetingPolicy, stage: MeetingPolicyStage, selectedId: string | null): {
  label: string; available: boolean; reason?: string;
} {
  if (selectedId === null) return policy.defaults[stage];
  return meetingPolicyModelChoices(policy, stage, selectedId).find((choice) => choice.id === selectedId)!;
}

export function meetingPolicyRequestError(error: unknown, saving = false): string {
  const status = record(error) ? error.status : undefined;
  if (status === 401 || status === 403) return 'Reconnect to Clementine to read or change your meeting settings.';
  if (status === 503) return 'Your saved meeting settings are unavailable. Try reading them again before making changes.';
  if (status === 409) return 'These settings changed elsewhere. Your choices are kept. Review the current saved settings before saving again.';
  return saving
    ? 'Saving could not be confirmed. Your choices are kept. Read the saved settings before trying again.'
    : 'Your saved meeting settings could not be read. Try again.';
}

async function defaultRequest(path: string, init?: RequestInit): Promise<unknown> {
  const { api } = await import('./api');
  return api(path, init);
}

export async function getMeetingPolicy(signal?: AbortSignal, request: Request = defaultRequest): Promise<MeetingPolicy> {
  return meetingPolicyPayload(await request('/api/console/meetings/policy', { signal, cache: 'no-store' }));
}

export async function saveMeetingPolicy(editor: MeetingPolicyEditor, signal?: AbortSignal, request: Request = defaultRequest): Promise<MeetingPolicy> {
  const body = meetingPolicyPatch(editor);
  const saved = meetingPolicyPayload(await request('/api/console/meetings/policy', { method: 'PATCH', signal, body: JSON.stringify(body) }));
  if (saved.revision <= body.expectedRevision || meetingPolicyChanged({ saved, draft: body })) {
    throw new Error('The saved meeting choices could not be confirmed. Read the current settings again.');
  }
  return saved;
}
