/**
 * Durable, per-operation effect verdicts learned from the operation's own
 * definition (description and input schema), decided by a model once and then
 * consulted by the pure slug classifier for operations whose name carries no
 * verb at all.
 *
 * Live 2026-09-24 (source 299433): `MONDAY_BOARDS` retrieves board data, but
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
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';

export type LearnedComposioEffect = 'read' | 'write';

export interface LearnedComposioOperationEffect {
  effect: LearnedComposioEffect;
  /** Which authority decided it; only a model verdict is written today. */
  source: 'model';
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
const MAX_ENTRIES = 2_000;

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
  const file = readStore();
  const effects = { ...file.effects, [key]: verdict };
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
