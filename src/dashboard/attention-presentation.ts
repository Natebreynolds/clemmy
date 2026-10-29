/** Recoverable attention preferences. These never settle the work they hide. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import { withFileLockSyncStrict } from '../runtime/atomic-json.js';

export type AttentionKind = 'workflow' | 'conversation' | 'calendar' | 'notification';
export interface AttentionLifecycle {
  canDismiss: true;
  canDefer: true;
  effect: 'hide_only';
  dismissLabel: 'Dismiss';
  deferLabel: 'Tomorrow';
  generation: string;
  explanation: string;
}
export interface AttentionItem {
  key: string;
  kind: AttentionKind;
  title: string;
  detail: string;
  createdAt: string;
  notificationId?: string;
  sessionId?: string;
  runId?: string;
  workflow?: string;
  workflowSlug?: string;
  projectId?: string;
  lifecycle: AttentionLifecycle;
}
export type AttentionAction = 'dismiss' | 'defer' | 'restore';
export interface AttentionPreference {
  generation: string;
  action: AttentionAction;
  mutationToken: string;
  until?: string;
}
export type AttentionPreferences = Record<string, AttentionPreference>;
export type AttentionPresentationItem = AttentionItem & AttentionPreference & { action: 'dismiss' | 'defer' };
export type AttentionPresentationResult =
  | { ok: true; key: string; action: AttentionAction; generation: string; mutationToken: string; until?: string }
  | { ok: false; key: string; action: AttentionAction; error: string };

const FILE = path.join(BASE_DIR, 'state', 'attention-presentation.json');
const logger = pino({ name: 'clementine.attention-presentation' });
let warnedUnavailable = false;

/** Decisions and exact questions retain their own authority and preferences. */
export function isAttentionPresentationKey(key: string): boolean {
  return key.length <= 4096 && /^(flow|session|calendar|notification|heartbeat):\S[\s\S]*$/.test(key);
}
function validPreference(value: unknown): value is AttentionPreference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<AttentionPreference>;
  return typeof row.generation === 'string' && /^[a-f0-9]{64}$/.test(row.generation)
    && (row.action === 'dismiss' || row.action === 'defer' || row.action === 'restore')
    && typeof row.mutationToken === 'string' && row.mutationToken.length > 0
    && (row.until === undefined || typeof row.until === 'string' && Number.isFinite(Date.parse(row.until)))
    && (row.action !== 'defer' || row.until !== undefined);
}
export function readAttentionPreferences(requireValid = false): AttentionPreferences {
  try {
    const value: unknown = JSON.parse(readFileSync(FILE, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid attention preferences.');
    const stored = value as { version?: unknown; entries?: unknown };
    if (stored.version !== 1 || !stored.entries || typeof stored.entries !== 'object' || Array.isArray(stored.entries)
      || !Object.entries(stored.entries).every(([key, entry]) => isAttentionPresentationKey(key) && validPreference(entry))) {
      throw new Error('Invalid attention preferences.');
    }
    warnedUnavailable = false;
    return stored.entries as AttentionPreferences;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') { warnedUnavailable = false; return {}; }
    if (!warnedUnavailable) {
      logger.warn('Saved attention settings are unavailable; pending items remain visible and preference changes are disabled.');
      warnedUnavailable = true;
    }
    if (requireValid) throw new Error('Saved attention settings are unavailable. Pending items remain visible and no attention settings were changed.');
    return {};
  }
}
export function attentionItemHidden(item: Pick<AttentionItem, 'key' | 'lifecycle'>, preferences: AttentionPreferences, nowMs: number): boolean {
  const saved = preferences[item.key];
  return saved?.generation === item.lifecycle.generation
    && (saved.action === 'dismiss' || saved.action === 'defer' && Date.parse(saved.until ?? '') > nowMs);
}

/** A stable digest of server-owned facts, never a client-supplied generation. */
export function attentionGeneration(facts: unknown): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)])) : value;
  return createHash('sha256').update(JSON.stringify(canonical(facts))).digest('hex');
}
export function attentionLifecycle(generation: string): AttentionLifecycle {
  return { canDismiss: true, canDefer: true, effect: 'hide_only', dismissLabel: 'Dismiss', deferLabel: 'Tomorrow', generation,
    explanation: 'This only clears the item from your attention list. It does not answer, approve, cancel or change the work.' };
}
function writePreferences(entries: AttentionPreferences): void {
  const temporary = `${FILE}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify({ version: 1, entries }, null, 2), 'utf8'); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, FILE);
    if (process.platform !== 'win32') {
      const directory = openSync(path.dirname(FILE), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* The previous canonical bytes remain authoritative. */ }
    throw error;
  }
}

/** Resolve current raw asks under the preference lock: a cached render cannot
 * hide a newer run or let an old Undo replace a newer device's choice. */
export function mutateAttentionPreference(
  input: { key: string; action: AttentionAction; generation?: string; mutationToken?: string; nowMs?: number },
  resolveCurrent: () => readonly AttentionItem[],
): AttentionPresentationResult {
  const { key, action } = input;
  if (!isAttentionPresentationKey(key)) return { ok: false, key, action, error: 'This item uses its own decision or question controls.' };
  const nowMs = input.nowMs ?? Date.now();
  if (!input.generation || !/^[a-f0-9]{64}$/.test(input.generation)) {
    return { ok: false, key, action, error: 'Refresh this item before changing its attention setting.' };
  }
  mkdirSync(path.dirname(FILE), { recursive: true });
  return withFileLockSyncStrict(FILE, () => {
    const current = resolveCurrent();
    const item = current.find(row => row.key === key);
    if (!item) return { ok: false, key, action, error: 'This item no longer needs your attention.' };
    if (item.lifecycle.generation !== input.generation) {
      return { ok: false, key, action, error: 'This item has changed. Refresh before changing its attention setting.' };
    }
    const entries = readAttentionPreferences(true);
    const previous = entries[key];
    if (action === 'restore' && (!input.mutationToken || !previous
      || previous.generation !== input.generation || previous.mutationToken !== input.mutationToken)) {
      return { ok: false, key, action, error: 'The attention setting changed after this action. Refresh before changing it again.' };
    }
    const live = new Map(current.map(row => [row.key, row.lifecycle.generation]));
    for (const existing of Object.keys(entries)) if (live.get(existing) !== entries[existing].generation) delete entries[existing];
    const tomorrow = new Date(nowMs);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(8, 0, 0, 0);
    const until = action === 'defer' ? tomorrow.toISOString() : undefined;
    const mutationToken = action === 'restore' ? input.mutationToken! : randomUUID();
    entries[key] = { generation: input.generation!, action, mutationToken, ...(until ? { until } : {}) };
    writePreferences(entries);
    return { ok: true, key, action, generation: input.generation!, mutationToken, ...(until ? { until } : {}) };
  }, { timeoutMs: 0 });
}
