import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BASE_DIR } from '../../config.js';
import { withFileLockSyncStrict } from '../../runtime/atomic-json.js';
import { connectedTaskBrainOptions, connectedBrainModelCapability, connectedModelGroupsForRole, validateRoleModelBinding } from '../../runtime/harness/model-role-options.js';
import { labelForModelId } from '../../runtime/harness/model-discovery.js';
import { resolveRoleModel, modelProviderLive, unavailableSavedBrain } from '../../runtime/harness/model-roles.js';
import type { ModelProviderClass } from '../../runtime/harness/model-wire-registry.js';

const modelId = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:/-]+$/);
const fields = {
  before: z.object({ calendarPrepSuggestions: z.boolean() }).strict(),
  during: z.object({ modelId: modelId.nullable() }).strict(),
  after: z.object({ modelId: modelId.nullable() }).strict(),
};
export const MeetingAssistantPolicySchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime().nullable(), ...fields }).strict();
export type MeetingAssistantPolicy = z.infer<typeof MeetingAssistantPolicySchema>;
export const MeetingAssistantPolicyUpdateSchema = z.object({ expectedRevision: z.number().int().nonnegative(), ...fields }).strict();
export type MeetingAssistantPolicyUpdate = z.infer<typeof MeetingAssistantPolicyUpdateSchema>;
export const MeetingModelPinSchema = z.object({ version: z.literal(1), modelId, provider: z.enum(['codex', 'claude', 'byo']),
  role: z.enum(['quick', 'brain']), profileRevision: z.number().int().nonnegative(), selection: z.enum(['inherited', 'explicit']),
  fallback: z.literal('none') }).strict();
export type MeetingModelPin = Readonly<z.infer<typeof MeetingModelPinSchema>>;
export interface MeetingModelOption { id: string; label: string; providerLabel: string; available: boolean; reason?: string }
export interface MeetingModelDefault { modelId: string; label: string; available: boolean; reason?: string }
export interface MeetingAssistantPolicySnapshot extends MeetingAssistantPolicy {
  modelOptions: { live: MeetingModelOption[]; after: MeetingModelOption[] };
  defaults: { live: MeetingModelDefault; after: MeetingModelDefault };
}
export class MeetingAssistantPolicyError extends Error {
  constructor(readonly code: 'unavailable' | 'conflict' | 'invalid' | 'model_unavailable', message: string) {
    super(message); this.name = 'MeetingAssistantPolicyError';
  }
}
const defaults = (): MeetingAssistantPolicy => ({ version: 1, revision: 0, updatedAt: null,
  before: { calendarPrepSuggestions: false }, during: { modelId: null }, after: { modelId: null } });
type Role = 'quick' | 'brain';
interface PolicyRouting {
  choices(role: Role): MeetingModelOption[];
  resolve(role: Role): { modelId: string; provider: ModelProviderClass; inactiveBinding?: unknown };
  validate(role: Role, id: string): { ok: true; provider: ModelProviderClass } | { ok: false; reason: string };
  live(id: string, provider: ModelProviderClass): boolean;
  label(id: string): string;
}
const routing: PolicyRouting = {
  choices: role => role === 'brain'
    ? connectedTaskBrainOptions().flatMap(option => {
      if (!option.modelId || !option.available) return [];
      const available = option.available;
      return [{ id: option.modelId, label: option.label, providerLabel: option.id === 'api_key' ? 'Connected provider' : option.id === 'claude_oauth' ? 'Claude' : 'Codex',
        available, ...(!available ? { reason: 'Connect this model in Settings to use it.' } : {}) }];
    })
    : connectedModelGroupsForRole(role).flatMap(group => group.models.map(model => ({
      id: model.id, label: model.label, providerLabel: group.label, available: true,
    }))),
  resolve: role => {
    const resolved = resolveRoleModel(role);
    const unavailable = unavailableSavedBrain();
    if (unavailable && (role === 'brain' || resolved.source === 'default')) return { ...unavailable, inactiveBinding: true };
    return resolved;
  },
  validate: (role, id) => {
    if (role !== 'brain') return validateRoleModelBinding(role, id);
    // The global role-binding API intentionally excludes brain: its selector
    // changes auth mode. A meeting task instead pins one connected brain
    // choice without writing that global switch.
    return connectedBrainModelCapability(id);
  },
  live: modelProviderLive, label: labelForModelId,
};

/** Defaults are non-authorizing. A missing file is a new profile; a damaged file
 * is unavailable, never permission to silently replace the owner's choices. */
export function createMeetingAssistantPolicyStore(file: string, modelRouting: PolicyRouting = routing) {
  function read(): MeetingAssistantPolicy {
    try {
      if (statSync(file).size > 32_768) throw new Error('oversized');
      return MeetingAssistantPolicySchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults();
      throw new MeetingAssistantPolicyError('unavailable', 'Meeting preferences could not be read. Your saved choices have been kept.');
    }
  }
  function write(input: unknown): MeetingAssistantPolicy {
    const parsed = MeetingAssistantPolicyUpdateSchema.safeParse(input);
    if (!parsed.success) throw new MeetingAssistantPolicyError('invalid', 'Choose the meeting preferences to save.');
    mkdirSync(path.dirname(file), { recursive: true });
    return withFileLockSyncStrict(file, () => {
      const current = read(); const update = parsed.data;
      if (current.revision !== update.expectedRevision) throw new MeetingAssistantPolicyError('conflict', 'Meeting preferences changed elsewhere. Review the latest choices before saving.');
      for (const [key, role] of [['during', 'quick'], ['after', 'brain']] as const) {
        const selection = update[key].modelId;
        // An unchanged disconnected choice can be retained while another field
        // is edited. It remains unavailable at dispatch, never a fallback.
        if (selection && selection !== current[key].modelId) {
          const validation = modelRouting.validate(role, selection);
          if (!validation.ok || !modelRouting.live(selection, validation.provider)) {
            throw new MeetingAssistantPolicyError('model_unavailable', 'That meeting model is not connected. Choose another model or inherit your current setting.');
          }
        }
      }
      const next = MeetingAssistantPolicySchema.parse({ version: 1, revision: current.revision + 1,
        updatedAt: new Date().toISOString(), before: update.before, during: update.during, after: update.after });
      const temporary = `${file}.${randomUUID()}.tmp`;
      let descriptor: number | undefined;
      try {
        descriptor = openSync(temporary, 'wx', 0o600);
        writeFileSync(descriptor, `${JSON.stringify(next)}\n`); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
        renameSync(temporary, file);
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        try { unlinkSync(temporary); } catch { /* renamed or no file was created */ }
      }
      return next;
    }, { timeoutMs: 0 });
  }
  function resolve(meetingId: string, phase: 'live' | 'after'): MeetingModelPin {
    if (!meetingId.trim()) throw new MeetingAssistantPolicyError('invalid', 'A meeting is required.');
    const policy = read(); const role = phase === 'live' ? 'quick' : 'brain';
    const selection = (phase === 'live' ? policy.during : policy.after).modelId;
    const resolved = selection ? modelRouting.validate(role, selection) : modelRouting.resolve(role);
    if (('ok' in resolved && !resolved.ok) || ('inactiveBinding' in resolved && resolved.inactiveBinding)) {
      throw new MeetingAssistantPolicyError('model_unavailable', 'The selected meeting model is unavailable. Reconnect it or choose a model in meeting preferences.');
    }
    const id = selection ?? ('modelId' in resolved ? resolved.modelId : '');
    const provider = 'provider' in resolved ? resolved.provider : undefined;
    if (!id || !provider || !modelRouting.live(id, provider)) throw new MeetingAssistantPolicyError('model_unavailable', 'The selected meeting model is not connected. Your recording is unaffected.');
    return Object.freeze(MeetingModelPinSchema.parse({ version: 1, modelId: id, provider, role,
      profileRevision: policy.revision, selection: selection ? 'explicit' : 'inherited', fallback: 'none' }));
  }
  function snapshot(): MeetingAssistantPolicySnapshot {
    const policy = read();
    function choices(role: Role, selected: string | null): MeetingModelOption[] {
      const seen = new Set<string>();
      const options = modelRouting.choices(role).filter(choice => !seen.has(choice.id) && Boolean(seen.add(choice.id)))
        .map(choice => ({ ...choice, available: choice.available }));
      if (selected && !options.some(option => option.id === selected)) options.push({ id: selected,
        label: modelRouting.label(selected), providerLabel: 'Saved choice', available: false, reason: 'Reconnect this model or choose another.' });
      return options;
    }
    function defaultModel(role: Role): MeetingModelDefault {
      const result = modelRouting.resolve(role);
      const available = !result.inactiveBinding && modelRouting.live(result.modelId, result.provider);
      return { modelId: result.modelId, label: modelRouting.label(result.modelId), available,
        ...(!available ? { reason: 'Connect a model in Settings to use this choice.' } : {}) };
    }
    return { ...policy, modelOptions: { live: choices('quick', policy.during.modelId), after: choices('brain', policy.after.modelId) },
      defaults: { live: defaultModel('quick'), after: defaultModel('brain') } };
  }
  return { read, write, resolve, snapshot };
}

const store = createMeetingAssistantPolicyStore(path.join(BASE_DIR, 'state', 'meeting-capture', 'assistant-policy.json'));
export const loadMeetingAssistantPolicy = store.read;
export const saveMeetingAssistantPolicy = store.write;
export const resolveMeetingModelPin = store.resolve;
export const meetingAssistantPolicySnapshot = store.snapshot;
