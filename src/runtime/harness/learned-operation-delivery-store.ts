/**
 * Durable delivery verdicts for external operations, learned from each
 * operation's own definition (its description and input schema) and confirmed
 * by two independent models. The external-capability risk loader consults
 * them; nothing else grants them meaning.
 *
 * An operation that only opens a conversation returns an id and delivers
 * nothing. Carded as an irreversible send because of a word in its name, it
 * asks the owner to approve a step with no content, and the card that carries
 * the real message can go unseen.
 *
 * Exactly one verdict is ever written: both models agree the exact definition
 * delivers nothing to anyone other than the owner and can neither delete nor
 * irreversibly change anything. Absence is the conservative default. A record
 * binds the exact definition the models read: the loader applies it only to
 * the same current input schema, and a newly observed definition removes it
 * before anything is asked again.
 *
 * Filesystem-only on purpose: the risk loader imports this module, so nothing
 * here may import a model client or the harness. A missing, unreadable or
 * malformed store is the empty store.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';

export const LEARNED_OPERATION_DELIVERY_VERSION = 1 as const;
/** Stage one may pass a definition on only at or below this probability of
 * delivery, and of deletion or irreversible change. */
export const LEARNED_OPERATION_DELIVERY_SCREEN_MAX = 0.1;
/** Stage two must be at least this confident in both of its answers. */
export const LEARNED_OPERATION_DELIVERY_CONFIRM_MIN = 0.9;

export type LearnedOperationDeliveryProviderKind = 'composio' | 'native_mcp';

export interface LearnedOperationDeliveryVerdictV1 {
  version: typeof LEARNED_OPERATION_DELIVERY_VERSION;
  providerKind: LearnedOperationDeliveryProviderKind;
  /** Normalized with learnedOperationDeliveryKey's rule. */
  operationId: string;
  verdict: 'delivers_nothing_non_destructive';
  /** sha256 of the exact description and input-schema text both models read. */
  definitionDigest: string;
  /** Full canonical digest of that same input schema, comparable to the risk
   * loader's own digest of the current definition. */
  inputSchemaDigest: string;
  /** Exact account/manifest/schema/argument scope; absent means the whole operation. */
  callBindingDigest?: string;
  /** Stage one: the fast classifier's probabilities for the two questions. */
  screen: {
    model: string;
    deliveryProbability: number;
    irreversibleProbability: number;
  };
  /** Stage two: the owner's configured judge-role model. */
  confirm: {
    role: 'judge';
    model: string;
    deliversToOthers: 'no';
    deletesOrIrreversible: 'no';
    confidence: number;
    explanation?: string;
  };
  learnedAt: string;
}

interface StoreFile {
  version: 'v1';
  verdicts: Record<string, unknown>;
}

const STORE_FILE = path.join(BASE_DIR, 'state', 'operation-delivery-verdicts.json');
const MAX_ENTRIES = 2_000;
const MAX_IDENTITY_CHARS = 2_048;
const MAX_MODEL_CHARS = 200;
const SHA256 = /^[a-f0-9]{64}$/;
const PROVIDER_KINDS = new Set<LearnedOperationDeliveryProviderKind>(['composio', 'native_mcp']);

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

/** The normalized operation identity for one provider. A provider whose
 * operation ids are case-insensitive is compared upper-cased; every other
 * provider keeps its exact id. */
export function normalizedLearnedOperationId(
  providerKind: LearnedOperationDeliveryProviderKind,
  operationId: string,
): string | null {
  const trimmed = String(operationId ?? '').trim();
  if (!trimmed || trimmed.length > MAX_IDENTITY_CHARS) return null;
  return providerKind === 'composio' ? trimmed.toUpperCase() : trimmed;
}

export function learnedOperationDeliveryKey(
  providerKind: string,
  operationId: string,
): string | null {
  if (!PROVIDER_KINDS.has(providerKind as LearnedOperationDeliveryProviderKind)) return null;
  const normalized = normalizedLearnedOperationId(
    providerKind as LearnedOperationDeliveryProviderKind,
    operationId,
  );
  return normalized ? `${providerKind}:${normalized}` : null;
}

/** Strict closed-shape parse. Thresholds and model independence are checked
 * again here, so a hand-edited or partially written row can never lower risk. */
export function parseLearnedOperationDeliveryVerdictV1(
  value: unknown,
): LearnedOperationDeliveryVerdictV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'version', 'providerKind', 'operationId', 'verdict', 'definitionDigest',
    'inputSchemaDigest', 'screen', 'confirm', 'learnedAt',
    ...(Object.hasOwn(value, 'callBindingDigest') ? ['callBindingDigest'] : []),
  ])) return null;
  if (value.version !== LEARNED_OPERATION_DELIVERY_VERSION) return null;
  if (
    typeof value.providerKind !== 'string'
    || !PROVIDER_KINDS.has(value.providerKind as LearnedOperationDeliveryProviderKind)
  ) return null;
  const providerKind = value.providerKind as LearnedOperationDeliveryProviderKind;
  if (
    !boundedText(value.operationId, MAX_IDENTITY_CHARS)
    || normalizedLearnedOperationId(providerKind, value.operationId) !== value.operationId
  ) return null;
  if (value.verdict !== 'delivers_nothing_non_destructive') return null;
  if (
    typeof value.definitionDigest !== 'string' || !SHA256.test(value.definitionDigest)
    || typeof value.inputSchemaDigest !== 'string' || !SHA256.test(value.inputSchemaDigest)
  ) return null;
  if (value.callBindingDigest !== undefined && (typeof value.callBindingDigest !== 'string' || !SHA256.test(value.callBindingDigest))) return null;
  const screen = value.screen;
  if (
    !isRecord(screen)
    || !hasExactKeys(screen, ['model', 'deliveryProbability', 'irreversibleProbability'])
    || !boundedText(screen.model, MAX_MODEL_CHARS)
    || !probability(screen.deliveryProbability, 0, LEARNED_OPERATION_DELIVERY_SCREEN_MAX)
    || !probability(screen.irreversibleProbability, 0, LEARNED_OPERATION_DELIVERY_SCREEN_MAX)
  ) return null;
  const confirm = value.confirm;
  if (
    !isRecord(confirm)
    || !hasExactKeys(confirm, ['role', 'model', 'deliversToOthers', 'deletesOrIrreversible', 'confidence', ...(Object.hasOwn(confirm, 'explanation') ? ['explanation'] : [])])
    || (confirm.explanation !== undefined && !boundedText(confirm.explanation, 600))
    || confirm.role !== 'judge'
    || !boundedText(confirm.model, MAX_MODEL_CHARS)
    || confirm.deliversToOthers !== 'no'
    || confirm.deletesOrIrreversible !== 'no'
    || !probability(confirm.confidence, LEARNED_OPERATION_DELIVERY_CONFIRM_MIN, 1)
  ) return null;
  // Two readings by one model are one reading.
  if (confirm.model === screen.model) return null;
  if (typeof value.learnedAt !== 'string') return null;
  const learnedAtMs = Date.parse(value.learnedAt);
  if (!Number.isFinite(learnedAtMs) || new Date(learnedAtMs).toISOString() !== value.learnedAt) return null;
  return {
    version: LEARNED_OPERATION_DELIVERY_VERSION,
    providerKind,
    operationId: value.operationId,
    verdict: 'delivers_nothing_non_destructive',
    definitionDigest: value.definitionDigest,
    inputSchemaDigest: value.inputSchemaDigest,
    ...(value.callBindingDigest ? { callBindingDigest: value.callBindingDigest as string } : {}),
    screen: {
      model: screen.model,
      deliveryProbability: screen.deliveryProbability,
      irreversibleProbability: screen.irreversibleProbability,
    },
    confirm: {
      role: 'judge',
      model: confirm.model,
      deliversToOthers: 'no',
      deletesOrIrreversible: 'no',
      confidence: confirm.confidence,
      ...(confirm.explanation ? { explanation: confirm.explanation as string } : {}),
    },
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

/** The current learned verdict for one exact provider operation, or null. */
export function learnedOperationDeliveryVerdict(
  providerKind: string,
  operationId: string,
  callBindingDigest?: string,
): LearnedOperationDeliveryVerdictV1 | null {
  const base = learnedOperationDeliveryKey(providerKind, operationId);
  const key = base && callBindingDigest ? `${base}:${callBindingDigest}` : base;
  if (!key) return null;
  const verdict = parseLearnedOperationDeliveryVerdictV1(readStore().verdicts[key]);
  return verdict && learnedOperationDeliveryKey(verdict.providerKind, verdict.operationId) === base
    && verdict.callBindingDigest === callBindingDigest
    ? verdict
    : null;
}

export function rememberLearnedOperationDelivery(value: LearnedOperationDeliveryVerdictV1): boolean {
  const verdict = parseLearnedOperationDeliveryVerdictV1(value);
  const base = verdict ? learnedOperationDeliveryKey(verdict.providerKind, verdict.operationId) : null;
  const key = base && verdict?.callBindingDigest ? `${base}:${verdict.callBindingDigest}` : base;
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

/** Remove the verdict for one operation. Returns true when one was removed. */
export function forgetLearnedOperationDelivery(providerKind: string, operationId: string): boolean {
  const key = learnedOperationDeliveryKey(providerKind, operationId);
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

export function _resetLearnedOperationDeliveryForTests(): void {
  cache = null;
  try { if (existsSync(STORE_FILE)) writeStore({ version: 'v1', verdicts: {} }); } catch { /* test hygiene only */ }
}
