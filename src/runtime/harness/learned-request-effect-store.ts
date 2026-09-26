/**
 * Learned request effects: what one REQUEST SHAPE of a generic provider tool
 * actually does.
 *
 * A generic request tool (an MCP server's `api_request`, `fetch`, `call`)
 * declares one definition for every endpoint it can reach, so nothing about
 * the tool itself can say whether a given call reads or writes. The effect
 * lives in the request: its method and its path. Live 2026-09-26: four
 * DataForSEO `POST /v3/serp/.../live/...` calls in a read-only SEO audit
 * settled as writes, so the turn drew a full write review, Jev could not
 * close it, and the ledger reserved four "writes" that changed nothing.
 *
 * This store remembers, per provider operation and request shape, that the
 * shape was found to read only. As with learned operation delivery, nothing
 * is recorded unless two models agree from the evidence: the request that was
 * made and what the provider returned. A verdict admits a read; it never
 * overrides a declared destructive hint or a sealed manifest.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';

export const LEARNED_REQUEST_EFFECT_VERSION = 1 as const;
/** The screen's probability that the request changed anything, at most. */
export const LEARNED_REQUEST_EFFECT_SCREEN_MAX = 0.1;
/** The judge's confidence that it changed nothing, at least. */
export const LEARNED_REQUEST_EFFECT_CONFIRM_MIN = 0.9;

export type LearnedRequestEffectProviderKind = 'native_mcp';

/** The part of a request that decides its effect: the protocol method and
 *  the path with identifiers replaced, so one verdict covers every call of
 *  the same endpoint. */
export interface RequestShape {
  method: string;
  pathTemplate: string;
}

export interface LearnedRequestEffectVerdictV1 {
  version: typeof LEARNED_REQUEST_EFFECT_VERSION;
  providerKind: LearnedRequestEffectProviderKind;
  operationId: string;
  shape: RequestShape;
  verdict: 'reads_only';
  /** Digest of the evidence both models read: shape, request and response. */
  evidenceDigest: string;
  screen: { model: string; changeProbability: number };
  confirm: { role: 'judge'; model: string; changesProvider: 'no'; confidence: number };
  learnedAt: string;
}

interface StoreFile {
  version: 'v1';
  verdicts: Record<string, unknown>;
}

const STORE_FILE = path.join(BASE_DIR, 'state', 'request-effect-verdicts.json');
const MAX_ENTRIES = 4_000;
const MAX_IDENTITY_CHARS = 2_048;
const MAX_MODEL_CHARS = 200;
const MAX_METHOD_CHARS = 16;
const MAX_PATH_CHARS = 512;
const SHA256 = /^[a-f0-9]{64}$/;
const PROVIDER_KINDS = new Set<LearnedRequestEffectProviderKind>(['native_mcp']);

let cache: { mtimeMs: number; file: StoreFile } | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && value === value.trim();
}

function probability(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/** HTTP methods, the protocol's own vocabulary. The shape records the method
 *  as given; it does not decide the effect. A GET that creates and a POST
 *  that reads are both real, and only the evidence settles them. */
const HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']);

function decoded(args: unknown): unknown {
  if (typeof args !== 'string') return args;
  try { return JSON.parse(args) as unknown; } catch { return undefined; }
}

const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\d[A-Za-z0-9_-]{6,})$/i;

/** One path with its identifiers replaced, so every call of an endpoint
 *  shares a shape. A full URL keeps its host: two hosts are two APIs. */
export function requestPathTemplate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2_048) return null;
  let host = '';
  let pathname = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      host = url.host.toLowerCase();
      pathname = url.pathname;
    } catch {
      return null;
    }
  } else if (!trimmed.startsWith('/')) {
    return null;
  }
  const withoutQuery = pathname.split(/[?#]/)[0] ?? '';
  const segments = withoutQuery.split('/').filter(Boolean)
    .map((segment) => (ID_SEGMENT.test(segment) ? '{id}' : segment.toLowerCase()));
  const template = `${host}/${segments.join('/')}`;
  return template.length <= 512 ? template : null;
}

/**
 * The request shape of a call's arguments: the HTTP method the arguments
 * select and the path or URL they address. Read from the top level of the
 * arguments only. Without both, the call has no learnable shape.
 */
export function requestShapeOf(args: unknown): RequestShape | null {
  const record = decoded(args);
  if (!isRecord(record)) return null;
  let method: string | null = null;
  let pathTemplate: string | null = null;
  for (const value of Object.values(record)) {
    if (typeof value !== 'string') continue;
    const upper = value.trim().toUpperCase();
    if (method === null && HTTP_METHODS.has(upper)) { method = upper; continue; }
    if (pathTemplate === null) {
      const template = requestPathTemplate(value);
      if (template) pathTemplate = template;
    }
  }
  return method && pathTemplate ? { method, pathTemplate } : null;
}

export function normalizedLearnedRequestOperationId(operationId: string): string | null {
  const trimmed = String(operationId ?? '').trim();
  if (!trimmed || trimmed.length > MAX_IDENTITY_CHARS) return null;
  return trimmed;
}

export function isRequestShape(value: unknown): value is RequestShape {
  return isRecord(value)
    && hasExactKeys(value, ['method', 'pathTemplate'])
    && boundedText(value.method, MAX_METHOD_CHARS)
    && value.method === value.method.toUpperCase()
    && boundedText(value.pathTemplate, MAX_PATH_CHARS);
}

export function learnedRequestEffectKey(
  providerKind: string,
  operationId: string,
  shape: RequestShape,
): string | null {
  if (!PROVIDER_KINDS.has(providerKind as LearnedRequestEffectProviderKind)) return null;
  if (!isRequestShape(shape)) return null;
  const normalized = normalizedLearnedRequestOperationId(operationId);
  return normalized ? `${providerKind}:${normalized}#${shape.method} ${shape.pathTemplate}` : null;
}

export function parseLearnedRequestEffectVerdictV1(value: unknown): LearnedRequestEffectVerdictV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'version', 'providerKind', 'operationId', 'shape', 'verdict', 'evidenceDigest', 'screen', 'confirm', 'learnedAt',
  ])) return null;
  if (value.version !== LEARNED_REQUEST_EFFECT_VERSION) return null;
  if (
    typeof value.providerKind !== 'string'
    || !PROVIDER_KINDS.has(value.providerKind as LearnedRequestEffectProviderKind)
  ) return null;
  const providerKind = value.providerKind as LearnedRequestEffectProviderKind;
  if (
    !boundedText(value.operationId, MAX_IDENTITY_CHARS)
    || normalizedLearnedRequestOperationId(value.operationId) !== value.operationId
  ) return null;
  if (!isRequestShape(value.shape)) return null;
  if (value.verdict !== 'reads_only') return null;
  if (typeof value.evidenceDigest !== 'string' || !SHA256.test(value.evidenceDigest)) return null;
  const screen = value.screen;
  if (
    !isRecord(screen)
    || !hasExactKeys(screen, ['model', 'changeProbability'])
    || !boundedText(screen.model, MAX_MODEL_CHARS)
    || !probability(screen.changeProbability, 0, LEARNED_REQUEST_EFFECT_SCREEN_MAX)
  ) return null;
  const confirm = value.confirm;
  if (
    !isRecord(confirm)
    || !hasExactKeys(confirm, ['role', 'model', 'changesProvider', 'confidence'])
    || confirm.role !== 'judge'
    || !boundedText(confirm.model, MAX_MODEL_CHARS)
    || confirm.changesProvider !== 'no'
    || !probability(confirm.confidence, LEARNED_REQUEST_EFFECT_CONFIRM_MIN, 1)
  ) return null;
  // Two readings by one model are one reading.
  if (confirm.model === screen.model) return null;
  if (typeof value.learnedAt !== 'string') return null;
  const learnedAtMs = Date.parse(value.learnedAt);
  if (!Number.isFinite(learnedAtMs) || new Date(learnedAtMs).toISOString() !== value.learnedAt) return null;
  return {
    version: LEARNED_REQUEST_EFFECT_VERSION,
    providerKind,
    operationId: value.operationId,
    shape: { method: value.shape.method, pathTemplate: value.shape.pathTemplate },
    verdict: 'reads_only',
    evidenceDigest: value.evidenceDigest,
    screen: { model: screen.model, changeProbability: screen.changeProbability },
    confirm: { role: 'judge', model: confirm.model, changesProvider: 'no', confidence: confirm.confidence },
    learnedAt: value.learnedAt,
  };
}

function readStore(): StoreFile {
  try {
    if (!existsSync(STORE_FILE)) return { version: 'v1', verdicts: {} };
    const mtimeMs = statSync(STORE_FILE).mtimeMs;
    if (cache && cache.mtimeMs === mtimeMs) return cache.file;
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf8')) as Partial<StoreFile>;
    const file: StoreFile = parsed && parsed.version === 'v1' && isRecord(parsed.verdicts)
      ? { version: 'v1', verdicts: parsed.verdicts }
      : { version: 'v1', verdicts: {} };
    cache = { mtimeMs, file };
    return file;
  } catch {
    return { version: 'v1', verdicts: {} };
  }
}

function writeStore(file: StoreFile): void {
  mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
  renameSync(tmp, STORE_FILE);
  cache = null;
}

/** The learned verdict for this exact operation and request shape, or null. */
export function learnedRequestEffectVerdict(
  providerKind: string,
  operationId: string,
  shape: RequestShape | null | undefined,
): LearnedRequestEffectVerdictV1 | null {
  if (!shape) return null;
  const key = learnedRequestEffectKey(providerKind, operationId, shape);
  if (!key) return null;
  const verdict = parseLearnedRequestEffectVerdictV1(readStore().verdicts[key]);
  return verdict && learnedRequestEffectKey(verdict.providerKind, verdict.operationId, verdict.shape) === key
    ? verdict
    : null;
}

export function rememberLearnedRequestEffect(value: LearnedRequestEffectVerdictV1): boolean {
  const verdict = parseLearnedRequestEffectVerdictV1(value);
  const key = verdict ? learnedRequestEffectKey(verdict.providerKind, verdict.operationId, verdict.shape) : null;
  if (!verdict || !key) return false;
  try {
    const verdicts: Record<string, unknown> = { ...readStore().verdicts, [key]: verdict };
    const keys = Object.keys(verdicts);
    if (keys.length > MAX_ENTRIES) {
      const learnedAt = (entry: unknown): string => (
        isRecord(entry) && typeof entry.learnedAt === 'string' ? entry.learnedAt : ''
      );
      const oldest = keys
        .sort((left, right) => learnedAt(verdicts[left]).localeCompare(learnedAt(verdicts[right])))
        .slice(0, keys.length - MAX_ENTRIES);
      for (const stale of oldest) delete verdicts[stale];
    }
    writeStore({ version: 'v1', verdicts });
    return true;
  } catch {
    return false;
  }
}

export function forgetLearnedRequestEffect(
  providerKind: string,
  operationId: string,
  shape: RequestShape,
): boolean {
  const key = learnedRequestEffectKey(providerKind, operationId, shape);
  if (!key) return false;
  try {
    const file = readStore();
    if (!Object.hasOwn(file.verdicts, key)) return false;
    const verdicts = { ...file.verdicts };
    delete verdicts[key];
    writeStore({ version: 'v1', verdicts });
    return true;
  } catch {
    return false;
  }
}

export function _resetLearnedRequestEffectsForTests(): void {
  cache = null;
  try { if (existsSync(STORE_FILE)) writeStore({ version: 'v1', verdicts: {} }); } catch { /* test hygiene only */ }
}
