/**
 * Durable, per-operation effect verdicts from the operation's own definition:
 * what the provider declares about it (its read-only / destructive / update
 * hints), or, when the provider leaves that open, what a model read in its
 * description and input schema. The pure slug classifier consults this first
 * for every operation; the name is only a fallback until a definition has
 * been seen.
 *
 * Live 2026-09-24 (source 299433): a project board listing on a freshly
 * connected toolkit retrieves data, but
 * the slug has no read verb, so it classified as an external write, went
 * through the mutation consent gate, and a freshly connected app's first read
 * was refused. The curated documented-semantics table is exact provider
 * knowledge for a fixed set; this store is the learned complement for every
 * other noun-shaped operation, keyed the same way (provider-qualified slug).
 *
 * This module is filesystem-only on purpose: the classifier is imported by the
 * Composio client, so nothing here may import the harness, the registry or a
 * model client. A missing or unreadable store is the empty store.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';

export type LearnedComposioEffect = 'read' | 'write';

export interface LearnedComposioOperationEffect {
  effect: LearnedComposioEffect;
  /** Which authority decided it: the provider's own declaration, or a model
   * reading the definition where the provider left it open. */
  source: 'model' | 'provider';
  model: string;
  confidence: number;
  /** sha256 of the description + schema the verdict was made from. */
  definitionDigest: string;
  at: string;
}

interface StoreFile {
  version: 'v1';
  effects: Record<string, LearnedComposioOperationEffect>;
}

const STORE_FILE = path.join(BASE_DIR, 'state', 'composio-operation-effects.json');
const MAX_ENTRIES = 10_000;

let cache: { mtimeMs: number; file: StoreFile } | null = null;

function readStore(): StoreFile {
  try {
    if (!existsSync(STORE_FILE)) return { version: 'v1', effects: {} };
    const mtimeMs = statSync(STORE_FILE).mtimeMs;
    if (cache && cache.mtimeMs === mtimeMs) return cache.file;
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf8')) as Partial<StoreFile>;
    const file: StoreFile = parsed && typeof parsed.effects === 'object' && parsed.effects
      ? { version: 'v1', effects: parsed.effects as Record<string, LearnedComposioOperationEffect> }
      : { version: 'v1', effects: {} };
    cache = { mtimeMs, file };
    return file;
  } catch {
    return { version: 'v1', effects: {} };
  }
}

function writeStore(file: StoreFile): void {
  mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
  renameSync(tmp, STORE_FILE);
  cache = null;
}

/** The learned verdict for one provider-qualified slug, or null. */
export function learnedComposioOperationEffect(slug: string | null | undefined): LearnedComposioOperationEffect | null {
  const key = String(slug ?? '').trim().toUpperCase();
  if (!key) return null;
  return readStore().effects[key] ?? null;
}

export function rememberComposioOperationEffect(slug: string, verdict: LearnedComposioOperationEffect): void {
  const key = slug.trim().toUpperCase();
  if (!key) return;
  writeEffects({ ...readStore().effects, [key]: verdict });
}

/** The effect a provider's own hints declare, when they decide it: a
 * read-only operation reads; a destructive or updating one writes. An
 * operation that only creates (a record, a message, or a provider-side job
 * that gathers data) is left for a model to read; contradictory hints decide
 * nothing. */
export function providerDeclaredEffect(tags: readonly unknown[] | null | undefined): LearnedComposioEffect | null {
  const hints = new Set((tags ?? []).filter((tag): tag is string => typeof tag === 'string'));
  const readOnly = hints.has('readOnlyHint');
  const changes = hints.has('destructiveHint') || hints.has('updateHint');
  if (readOnly === changes) return null;
  return readOnly ? 'read' : 'write';
}

/** The identity of the definition a model verdict reads: its description and
 * input schema, bounded the way the model is shown them. Null when there is
 * no description to reason from. */
export function operationDefinitionDigest(description: unknown, inputSchema: unknown): string | null {
  const text = typeof description === 'string' ? description.replace(/\s+/g, ' ').trim().slice(0, 1_200) : '';
  if (!text) return null;
  let schemaText = '';
  try { schemaText = JSON.stringify(inputSchema ?? null).slice(0, 2_000); } catch { schemaText = ''; }
  return createHash('sha256').update(text).update('\0').update(schemaText).digest('hex');
}

function providerHintDigest(tags: readonly unknown[]): string {
  return createHash('sha256')
    .update(tags.filter((tag): tag is string => typeof tag === 'string' && tag.endsWith('Hint')).sort().join('\0'))
    .digest('hex');
}

/**
 * Bring stored verdicts in line with definitions that just arrived. A verdict
 * belongs to the exact definition it was made from: what the provider now
 * declares is recorded; a provider verdict whose declaration changed so it no
 * longer decides, or (from the provider itself) disappeared, is retired; a
 * model verdict whose description or schema changed is retired so the model
 * reads the new one. One write for the batch, and only when something
 * changed. `fromProvider` marks rows exactly as the provider returned them,
 * where an absent tag list means the provider declares nothing.
 */
export function rememberProviderDeclaredEffects(
  definitions: ReadonlyArray<{ slug?: unknown; tags?: unknown; description?: unknown; inputSchema?: unknown; inputParameters?: unknown }>,
  options: { fromProvider?: boolean } = {},
): void {
  const file = readStore();
  let effects: Record<string, LearnedComposioOperationEffect> | null = null;
  const at = new Date().toISOString();
  const current = (key: string) => (effects ?? file.effects)[key];
  const retire = (key: string) => { effects ??= { ...file.effects }; delete effects[key]; };
  for (const definition of definitions) {
    const key = typeof definition.slug === 'string' ? definition.slug.trim().toUpperCase() : '';
    if (!key) continue;
    const tags = Array.isArray(definition.tags) ? definition.tags : options.fromProvider ? [] : null;
    const effect = tags ? providerDeclaredEffect(tags) : null;
    const stored = current(key);
    if (tags && effect) {
      const definitionDigest = providerHintDigest(tags);
      if (stored?.source === 'provider' && stored.effect === effect && stored.definitionDigest === definitionDigest) continue;
      effects ??= { ...file.effects };
      effects[key] = { effect, source: 'provider', model: '', confidence: 1, definitionDigest, at };
      continue;
    }
    if (stored?.source === 'provider' && tags) { retire(key); continue; }
    if (stored?.source === 'model') {
      const digest = operationDefinitionDigest(definition.description, definition.inputSchema ?? definition.inputParameters);
      if (digest && digest !== stored.definitionDigest) retire(key);
    }
  }
  if (effects) writeEffects(effects);
}

function writeEffects(effects: Record<string, LearnedComposioOperationEffect>): void {
  const keys = Object.keys(effects);
  if (keys.length > MAX_ENTRIES) {
    for (const stale of keys.sort((a, b) => effects[a]!.at.localeCompare(effects[b]!.at)).slice(0, keys.length - MAX_ENTRIES)) delete effects[stale];
  }
  writeStore({ version: 'v1', effects });
}

export function _resetLearnedComposioOperationEffectsForTests(): void {
  cache = null;
  try { if (existsSync(STORE_FILE)) writeStore({ version: 'v1', effects: {} }); } catch { /* test hygiene only */ }
}
