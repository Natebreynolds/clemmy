/** Read one reply's retained records. Never expand a missing identity into a
 * session-wide or time-based lookup. These are records, not inferred reasons. */
import { humanToolLabel, modelDisplayName, type TaskHandlingDetails } from '@clem/chat-engine';
import { api } from './api';
import { memoryFactHref, memoryFactId } from './memory-fact-links';
import { validMemoryWork } from './task-memory-status';

export type { TaskHandlingDetails } from '@clem/chat-engine';
export type TaskModelRecord = TaskHandlingDetails['models'][number];
export type TaskToolRecord = TaskHandlingDetails['tools'][number];

export function taskDetailsPath(sessionId: string, sourceUserSeq: number): string {
  if (!sessionId.trim() || !Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0) {
    throw new Error('This reply does not have an exact request identity.');
  }
  return `/api/console/sessions/${encodeURIComponent(sessionId)}/handling?sourceUserSeq=${sourceUserSeq}`;
}

type DetailsRequest = (path: string, options?: RequestInit) => Promise<unknown>;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const optionalText = (value: unknown): boolean => value === undefined || text(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const oneOf = (value: unknown, choices: readonly string[]): boolean => text(value) && choices.includes(value);
function usageTotals(value: unknown): boolean {
  return record(value) && ['calls', 'failedCalls', 'uncertifiedCalls', 'unknownCostCalls', 'promptTokens',
    'cachedReadTokens', 'uncachedWorkTokens', 'outputTokens', 'reportedTotalTokens', 'modelMs'].every((key) => count(value[key]));
}
function memoryRef(value: unknown): boolean {
  return record(value) && text(value.type) && text(value.id);
}

/** A successful HTTP read can still be malformed. Reject it here instead of
 * letting a missing array or a non-string label take down the chat renderer. */
function validDetails(value: unknown): value is TaskHandlingDetails {
  if (!record(value) || value.version !== 1 || !text(value.sessionId) || !count(value.sourceUserSeq)
    || !text(value.acceptedAt) || !text(value.observedAt) || !strings(value.attemptIds)
    || !strings(value.limitations) || !record(value.limits)) return false;
  const limits = value.limits;
  if (!['toolsTruncated', 'modelsTruncated', 'memoryTruncated'].every((key) => typeof limits[key] === 'boolean')) return false;
  if (!Array.isArray(value.tools) || !value.tools.every((row) => record(row) && text(row.callId) && count(row.eventSeq)
    && text(row.name) && optionalText(row.attemptId) && text(row.startedAt) && optionalText(row.finishedAt) && optionalText(row.effect)
    && oneOf(row.status, ['started', 'returned', 'failed', 'reused'])
    && oneOf(row.dispatchEvidence, ['physical', 'lifecycle', 'reused'])
    && (row.physicalDispatches === undefined || count(row.physicalDispatches))
    && (row.selection === undefined || (record(row.selection) && oneOf(row.selection.kind, ['owner_preference', 'prepared_approach'])
      && optionalText(row.selection.text) && optionalText(row.selection.strategyId)
      && (row.selection.factId === undefined || count(row.selection.factId)))))) return false;
  if (!Array.isArray(value.models) || !value.models.every((row) => record(row) && text(row.callId) && text(row.role)
    && text(row.provider) && text(row.resolvedModel) && typeof row.responseCompleted === 'boolean'
    && ['requestedModel', 'servedModel', 'servedProvider', 'providerReportedModel', 'attemptId', 'fallbackToModel'].every((key) => optionalText(row[key]))
    && oneOf(row.status, ['started', 'success', 'failed', 'fallback', 'cancelled'])
    && (row.durationMs === undefined || count(row.durationMs)))) return false;
  if (value.usage !== null && (!record(value.usage) || value.usage.scope !== 'accepted_source' || !text(value.usage.meteringStartedAt)
    || typeof value.usage.sourcePredatesMetering !== 'boolean' || !usageTotals(value.usage.totals)
    || !record(value.usage.byRole) || !Object.values(value.usage.byRole).every(usageTotals))) return false;
  const memory = value.memory;
  if (!record(memory) || (memory.consolidation !== undefined && !validMemoryWork(memory.consolidation))
    || !Array.isArray(memory.recall) || !memory.recall.every((run) => record(run) && text(run.id)
    && text(run.surface) && text(run.createdAt) && Array.isArray(run.refs) && run.refs.every((ref: unknown) => memoryRef(ref)
      && record(ref) && optionalText(ref.text) && oneOf(ref.outcome, ['offered', 'used', 'not_useful'])))) return false;
  const provided = memory.provided;
  if (provided !== null && (!record(provided) || !text(provided.recordedAt) || !count(provided.sourceUserSeq)
    || !Array.isArray(provided.manifest) || !provided.manifest.every((section) => record(section) && text(section.section)
      && oneOf(section.tier, ['core', 'relevant', 'now']) && count(section.tokens) && count(section.bytes)
      && Array.isArray(section.refs) && section.refs.every(memoryRef)))) return false;
  return true;
}
export async function getTaskDetails(
  sessionId: string,
  sourceUserSeq: number,
  signal?: AbortSignal,
  request: DetailsRequest = (path, options) => api<unknown>(path, options),
): Promise<TaskHandlingDetails> {
  const result = await request(taskDetailsPath(sessionId, sourceUserSeq), { signal });
  if (!record(result) || result.version !== 1 || result.sessionId !== sessionId || result.sourceUserSeq !== sourceUserSeq) {
    throw new Error('These details do not belong to this reply.');
  }
  if (!validDetails(result)) throw new Error('This reply’s details could not be read.');
  return result;
}

export function recordedCount(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value).toLocaleString() : 'Not recorded';
}

/** Call durations can overlap. Never label their sum as the task's time. */
export function recordedDuration(ms: number | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

const ROLE_WORDS: Record<string, string> = {
  brain: 'Did the work', worker: 'Helped in parallel', judge: 'Review call',
  writer: 'Wrote the reply', memory: 'Memory work', quick: 'Quick check',
};
export function taskModelRole(role: string): string {
  return Object.hasOwn(ROLE_WORDS, role) ? ROLE_WORDS[role]! : plainRecordName(role);
}

export function plainRecordName(value: string): string {
  const words = value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Not recorded';
}

/** A resolved route is not proof of which model answered. */
export function taskModelIdentity(row: TaskModelRecord): { name: string; confirmed: boolean; note: string } {
  const actual = row.responseCompleted ? row.providerReportedModel?.trim() || row.servedModel?.trim() : '';
  return {
    name: modelDisplayName(actual || row.resolvedModel) || 'Model not recorded',
    confirmed: Boolean(actual),
    note: actual ? 'Response model recorded' : 'Route recorded; response model not confirmed',
  };
}

export function taskModelProvider(row: TaskModelRecord): { label: string; note: string | null } {
  const served = row.responseCompleted ? row.servedProvider?.trim() : '';
  const requested = row.provider.trim();
  return {
    label: served ? plainRecordName(served) : requested ? `Requested provider: ${plainRecordName(requested)}` : 'Provider not recorded',
    note: served && requested && served !== requested ? `Requested provider: ${plainRecordName(requested)}`
      : !served && row.responseCompleted ? 'Response provider not recorded' : null,
  };
}

export function taskModelStatus(row: TaskModelRecord): string {
  switch (row.status) {
    case 'success': return row.responseCompleted ? 'Response completed' : 'Completion not recorded';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
    case 'fallback': return 'Switched to a backup';
    case 'started': return 'Completion not recorded';
  }
}

export function taskToolName(row: TaskToolRecord): string {
  return humanToolLabel(row.name) || 'Tool not recorded';
}

export function taskToolStatus(row: TaskToolRecord): string {
  switch (row.status) {
    case 'returned': return 'Result returned';
    case 'failed': return 'Failed';
    case 'reused': return 'Reused a saved result';
    case 'started': return 'Result not recorded';
  }
}

export function taskToolEvidence(row: TaskToolRecord): string {
  if (row.dispatchEvidence === 'physical') return 'Dispatch recorded';
  if (row.dispatchEvidence === 'reused') return 'Saved result; no new dispatch';
  return 'Call recorded; dispatch not confirmed';
}

/** Only the engine's exact selection receipt can explain a tool choice. */
export function taskToolReason(row: TaskToolRecord): string | null {
  const selection = row.selection;
  if (!selection) return null;
  if (selection.kind === 'owner_preference') {
    return selection.text?.trim() ? `Saved preference recorded for this approach: ${selection.text.trim()}` : 'Saved preference recorded for this approach';
  }
  return 'Prepared tool choice recorded';
}

const MEMORY_SECTION_WORDS: Record<string, string> = {
  autonomy: 'Your approval preferences', userpreferences: 'Your preferences',
  standingpolicies: 'Your standing instructions', standinginstructions: 'Your standing instructions',
  identity: 'How Clem works with you', corepersonality: 'Clem’s communication style',
  longtermmemory: 'Long-term memory', skilldiscovery: 'Available skills',
  memoryprimer: 'Relevant memories', factprimer: 'Relevant memories',
  relevanttothisrequest: 'Relevant memories', persistentfacts: 'Saved facts',
  provenrunstrategies: 'Recorded tool approaches', rememberedtoolchoices: 'Learned tool approaches',
  memorypointer: 'Memory lookup guidance', delegatedwork: 'Delegated work',
  sessionpointers: 'Conversation context', rightnow: 'Current work',
};
export function taskMemorySections(detail: TaskHandlingDetails): string[] {
  const sections = detail.memory.provided?.manifest ?? [];
  return [...new Set(sections.flatMap((entry) => {
    const key = entry.section.toLowerCase().replace(/[^a-z]/g, '');
    if (key === 'header') return [];
    return [Object.hasOwn(MEMORY_SECTION_WORDS, key) ? MEMORY_SECTION_WORDS[key]! : 'Other saved context'];
  }))];
}

/** Manifest references say what was made available, not what influenced an
 * answer. Policy refs point at the same exact saved-fact detail as fact refs. */
export function taskProvidedMemoryLinks(detail: TaskHandlingDetails): Array<{ id: number; href: string }> {
  const links = new Map<number, string>();
  for (const section of detail.memory.provided?.manifest ?? []) {
    for (const ref of section.refs) {
      if (ref.type !== 'fact' && ref.type !== 'policy') continue;
      const id = memoryFactId(ref.id);
      const href = memoryFactHref(id);
      if (id && href && !links.has(id)) links.set(id, href);
      if (links.size >= 12) return [...links].map(([id, href]) => ({ id, href }));
    }
  }
  return [...links].map(([id, href]) => ({ id, href }));
}

export function taskUsageNotes(detail: TaskHandlingDetails): string[] {
  const usage = detail.usage;
  if (!usage) return ['Usage was not recorded for this request.'];
  const notes = ['These are recorded calls for this request. Linked tasks may have their own usage.'];
  if (usage.sourcePredatesMetering) notes.push('This request began before usage recording, so the figures are incomplete.');
  if (usage.totals.uncertifiedCalls > 0) notes.push('Some calls do not have complete usage records.');
  if (usage.totals.unknownCostCalls > 0) notes.push('Cost is unknown for some calls.');
  notes.push('These figures are not a provider bill or the task’s elapsed time.');
  return notes;
}
