/**
 * Learn, in the background, whether an external operation delivers anything,
 * from the operation's own definition (its description and input schema) and
 * never from its name.
 *
 * The structural risk classifier reads operation names. When a name looks
 * like a send, every call is carded as an irreversible send even when the
 * operation only opens or returns something (live 2026-09-25: opening a
 * direct conversation cost the owner a card, and the card that carried the
 * real message went unseen). This module asks two models about the exact
 * definition instead:
 *
 * 1. The fast classifier screens it with two yes/no probabilities. Only a
 *    confident "delivers nothing, deletes nothing" goes on.
 * 2. The owner's configured judge-role model confirms it with a structured
 *    verdict that echoes the exact definition digest.
 *
 * Only when both agree is a verdict written (learned-operation-delivery-store).
 * Disagreement, uncertainty, an unavailable model or an unreadable definition
 * writes nothing, and the conservative default stays. The risk loader then
 * applies the verdict only to the same current input schema, only in place of
 * a structural send, and only from the next accepted source on.
 *
 * Learning never runs on a turn's critical path: discovery schedules it for
 * the definitions it already holds and returns; this module bounds, dedupes
 * and retries it. The first encounter may still show a card.
 */
import { AsyncResource } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import pino from 'pino';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { peekTurnSemanticModelPort } from '../semantic-boundary/turn-semantic-port-registry.js';
import { OPERATION_DELIVERY_JUDGE_PURPOSE } from '../semantic-boundary/turn-semantic-model-port.js';
import { structuralExternalCapabilityRiskV1 } from './external-capability-risk.js';
import { canonicalExternalInputSchemaDigestV1 } from './external-capability-risk-loader.js';
import {
  forgetLearnedOperationDelivery,
  LEARNED_OPERATION_DELIVERY_CONFIRM_MIN,
  LEARNED_OPERATION_DELIVERY_SCREEN_MAX,
  LEARNED_OPERATION_DELIVERY_VERSION,
  learnedOperationDeliveryKey,
  learnedOperationDeliveryVerdict,
  normalizedLearnedOperationId,
  rememberLearnedOperationDelivery,
  type LearnedOperationDeliveryProviderKind,
} from './learned-operation-delivery-store.js';

const logger = pino({ name: 'learned-operation-delivery' });

export interface OperationDefinitionForDelivery {
  providerKind: LearnedOperationDeliveryProviderKind;
  operationId: string;
  /** The operation-only name the risk projector classifies. Defaults to the
   * operation id; a namespaced native tool passes its tool part. */
  semanticName?: string;
  description?: string | null;
  inputSchema?: unknown;
}

export type OperationDeliveryScreenResult =
  | { ok: true; model: string; deliveryProbability: number; irreversibleProbability: number }
  | { ok: false };

export type OperationDeliveryScreen = (input: {
  description: string;
  inputSchema: string;
  sessionId?: string;
}) => Promise<OperationDeliveryScreenResult>;

export type OperationDeliveryConfirmResult =
  | {
      ok: true;
      model: string;
      deliversToOthers: 'yes' | 'no' | 'uncertain';
      deletesOrIrreversible: 'yes' | 'no' | 'uncertain';
      confidence: number;
      definitionDigest: string;
    }
  | { ok: false };

export type OperationDeliveryConfirm = (input: {
  description: string;
  inputSchema: string;
  definitionDigest: string;
  sessionId?: string;
}) => Promise<OperationDeliveryConfirmResult>;

export type OperationDeliveryLearningOutcome =
  | 'learned'
  | 'already_learned'
  | 'not_send_shaped'
  | 'definition_unreadable'
  | 'screen_unavailable'
  | 'screen_not_confident'
  | 'confirm_unavailable'
  | 'confirm_disagreed'
  | 'confirm_not_confident'
  | 'confirm_mismatched'
  | 'superseded'
  | 'store_failed';

interface PreparedDefinition {
  key: string;
  providerKind: LearnedOperationDeliveryProviderKind;
  operationId: string;
  description: string;
  schemaText: string;
  definitionDigest: string;
  inputSchemaDigest: string;
}

/** The models read the whole definition or nothing: a truncated schema could
 * hide the one field that delivers. */
const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_SCHEMA_CHARS = 12_000;
const SCREEN_TIMEOUT_MS = 8_000;
const CONFIRM_TIMEOUT_MS = 90_000;
const MAX_CONCURRENT = 2;
const MAX_QUEUED = 32;
const MAX_NEW_PER_CALL = 6;
/** A model's answer is not asked again for the same definition for a day;
 * an unavailable model is retried sooner. In memory only. */
const RETRY_AFTER_ANSWER_MS = 24 * 60 * 60_000;
const RETRY_AFTER_UNAVAILABLE_MS = 10 * 60_000;
const MAX_REMEMBERED = 500;

const NO_HINTS = Object.freeze({ readOnly: null, destructive: null, idempotent: null, openWorld: null });
const NO_SIGNALS = Object.freeze({ outboundDelivery: null, recipientsPresent: null, requestMethod: null });

const SCHEMA_SNAPSHOT_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 100_000,
  maxStringBytes: 1_048_576,
  maxTotalBytes: 2_097_152,
  omitUndefinedObjectMembers: true,
});

function sha256(...parts: string[]): string {
  const hash = createHash('sha256');
  parts.forEach((part, index) => {
    if (index > 0) hash.update('\0');
    hash.update(part, 'utf8');
  });
  return hash.digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The latest definition digest this process observed per operation. A
 * learning that finishes after a newer definition was seen is discarded. */
const latestObserved = new Map<string, string>();

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_REMEMBERED) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

type Preparation =
  | { status: 'prepared'; definition: PreparedDefinition }
  | { status: 'skipped'; outcome: OperationDeliveryLearningOutcome };

function prepareDefinition(definition: OperationDefinitionForDelivery): Preparation {
  const providerKind = definition.providerKind;
  const operationId = normalizedLearnedOperationId(providerKind, definition.operationId);
  const key = operationId ? learnedOperationDeliveryKey(providerKind, operationId) : null;
  if (!operationId || !key) return { status: 'skipped', outcome: 'definition_unreadable' };
  // Only the class the structural classifier cards as a send is worth a
  // model's reading: every other outcome is already ordinary, or is a delete,
  // admin or destructive floor a learned verdict may never lower.
  const structural = structuralExternalCapabilityRiskV1({
    semanticName: String(definition.semanticName ?? operationId).trim() || operationId,
    behaviorHints: NO_HINTS,
    callSignals: NO_SIGNALS,
  });
  if (structural.consequence !== 'send' || structural.destructive) {
    return { status: 'skipped', outcome: 'not_send_shaped' };
  }
  const description = String(definition.description ?? '').replace(/\s+/g, ' ').trim();
  if (!description || description.length > MAX_DESCRIPTION_CHARS) {
    return { status: 'skipped', outcome: 'definition_unreadable' };
  }
  if (!isRecord(definition.inputSchema)) return { status: 'skipped', outcome: 'definition_unreadable' };
  let schemaText: string;
  let inputSchemaDigest: string | null;
  try {
    const snapshot = JSON.parse(closedCanonicalJson(definition.inputSchema, SCHEMA_SNAPSHOT_LIMITS)) as unknown;
    schemaText = closedCanonicalJson(snapshot);
    inputSchemaDigest = canonicalExternalInputSchemaDigestV1(snapshot);
  } catch {
    return { status: 'skipped', outcome: 'definition_unreadable' };
  }
  if (!inputSchemaDigest || schemaText.length > MAX_SCHEMA_CHARS) {
    return { status: 'skipped', outcome: 'definition_unreadable' };
  }
  return {
    status: 'prepared',
    definition: {
      key,
      providerKind,
      operationId,
      description,
      schemaText,
      definitionDigest: sha256(description, schemaText),
      inputSchemaDigest,
    },
  };
}

/**
 * Record that this exact definition is the current one for its operation. A
 * stored verdict for any other definition is removed now, before any model is
 * asked, so a changed definition never keeps the old verdict. Returns the
 * definition when it still needs learning, or the reason it does not.
 */
function observeDefinition(definition: OperationDefinitionForDelivery): Preparation {
  const preparation = prepareDefinition(definition);
  if (preparation.status !== 'prepared') return preparation;
  const prepared = preparation.definition;
  boundedSet(latestObserved, prepared.key, prepared.definitionDigest);
  const existing = learnedOperationDeliveryVerdict(prepared.providerKind, prepared.operationId);
  if (
    existing
    && existing.definitionDigest === prepared.definitionDigest
    && existing.inputSchemaDigest === prepared.inputSchemaDigest
  ) return { status: 'skipped', outcome: 'already_learned' };
  if (existing) forgetLearnedOperationDelivery(prepared.providerKind, prepared.operationId);
  return preparation;
}

async function boundedWait<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Stage one: the fast classifier. Two yes/no questions over the definition
 * only; the operation's name is deliberately not part of what it reads. */
async function screenWithJev(input: {
  description: string;
  inputSchema: string;
  sessionId?: string;
}): Promise<OperationDeliveryScreenResult> {
  const { evaluateSystemOne } = await import('../jev/client.js');
  const result = await evaluateSystemOne({
    state: { description: input.description, inputSchema: input.inputSchema },
    questions: {
      delivers: {
        type: 'noul',
        instructions: 'Judge only from this operation\'s description and input schema whether calling it, with any input its schema accepts, delivers content to or notifies any person, group or channel other than the account owner.',
        criteria: {
          true: 'It sends, posts, publishes, shares, forwards, replies to, invites or notifies someone other than the owner, or can with some accepted input, or the definition leaves that open.',
          false: 'It delivers nothing to anyone: it only opens, finds, looks up or returns something, such as an identifier, and nobody else is sent or told anything.',
        },
      },
      irreversible: {
        type: 'noul',
        instructions: 'Judge only from this operation\'s description and input schema whether calling it can delete anything, or change anything in a way that cannot be undone.',
        criteria: {
          true: 'It can delete, remove, overwrite or revoke something, or change it irreversibly, or the definition leaves that open.',
          false: 'It deletes nothing and changes nothing irreversibly.',
        },
      },
    },
    timeoutMs: SCREEN_TIMEOUT_MS,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    channel: 'jev-operation-delivery',
  });
  if (!result.ok) return { ok: false };
  const delivers = result.answers.delivers;
  const irreversible = result.answers.irreversible;
  if (delivers?.type !== 'noul' || irreversible?.type !== 'noul') return { ok: false };
  return {
    ok: true,
    model: result.model,
    deliveryProbability: delivers.noul,
    irreversibleProbability: irreversible.noul,
  };
}

/** Stage two: the owner's configured judge role, through the installed
 * semantic port. No port, no judge method, a failure or a timeout is no
 * confirmation. */
async function confirmWithJudge(input: {
  description: string;
  inputSchema: string;
  definitionDigest: string;
  sessionId?: string;
}): Promise<OperationDeliveryConfirmResult> {
  const port = peekTurnSemanticModelPort();
  if (!port?.judgeOperationDelivery) return { ok: false };
  const verdict = await boundedWait(port.judgeOperationDelivery({
    purpose: OPERATION_DELIVERY_JUDGE_PURPOSE,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    description: input.description,
    inputSchema: input.inputSchema,
    definitionDigest: input.definitionDigest,
  }), CONFIRM_TIMEOUT_MS);
  if (!verdict || typeof verdict.modelIdentity !== 'string' || !verdict.modelIdentity.trim()) {
    return { ok: false };
  }
  return {
    ok: true,
    model: verdict.modelIdentity.trim(),
    deliversToOthers: verdict.deliversToOthers,
    deletesOrIrreversible: verdict.deletesOrIrreversible,
    confidence: verdict.confidence,
    definitionDigest: verdict.definitionDigest,
  };
}

function probabilityAtMost(value: unknown, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
}

async function learnPrepared(
  prepared: PreparedDefinition,
  options: {
    screen?: OperationDeliveryScreen;
    confirm?: OperationDeliveryConfirm;
    sessionId?: string;
    now?: () => Date;
  },
): Promise<OperationDeliveryLearningOutcome> {
  const session = options.sessionId ? { sessionId: options.sessionId } : {};
  const screen = await boundedWait(
    (options.screen ?? screenWithJev)({
      description: prepared.description,
      inputSchema: prepared.schemaText,
      ...session,
    }),
    SCREEN_TIMEOUT_MS + 2_000,
  );
  if (!screen?.ok || typeof screen.model !== 'string' || !screen.model.trim()) return 'screen_unavailable';
  if (
    !probabilityAtMost(screen.deliveryProbability, LEARNED_OPERATION_DELIVERY_SCREEN_MAX)
    || !probabilityAtMost(screen.irreversibleProbability, LEARNED_OPERATION_DELIVERY_SCREEN_MAX)
  ) return 'screen_not_confident';

  const confirm = await boundedWait(
    (options.confirm ?? confirmWithJudge)({
      description: prepared.description,
      inputSchema: prepared.schemaText,
      definitionDigest: prepared.definitionDigest,
      ...session,
    }),
    CONFIRM_TIMEOUT_MS + 2_000,
  );
  if (!confirm?.ok || typeof confirm.model !== 'string' || !confirm.model.trim()) return 'confirm_unavailable';
  // Two readings by one model are one reading.
  if (confirm.model.trim() === screen.model.trim()) return 'confirm_unavailable';
  if (confirm.definitionDigest !== prepared.definitionDigest) return 'confirm_mismatched';
  if (confirm.deliversToOthers === 'yes' || confirm.deletesOrIrreversible === 'yes') return 'confirm_disagreed';
  if (
    confirm.deliversToOthers !== 'no'
    || confirm.deletesOrIrreversible !== 'no'
    || typeof confirm.confidence !== 'number'
    || !Number.isFinite(confirm.confidence)
    || confirm.confidence < LEARNED_OPERATION_DELIVERY_CONFIRM_MIN
    || confirm.confidence > 1
  ) return 'confirm_not_confident';

  // A newer definition observed while the models were reading wins.
  if (latestObserved.get(prepared.key) !== prepared.definitionDigest) return 'superseded';
  const stored = rememberLearnedOperationDelivery({
    version: LEARNED_OPERATION_DELIVERY_VERSION,
    providerKind: prepared.providerKind,
    operationId: prepared.operationId,
    verdict: 'delivers_nothing_non_destructive',
    definitionDigest: prepared.definitionDigest,
    inputSchemaDigest: prepared.inputSchemaDigest,
    screen: {
      model: screen.model.trim(),
      deliveryProbability: screen.deliveryProbability,
      irreversibleProbability: screen.irreversibleProbability,
    },
    confirm: {
      role: 'judge',
      model: confirm.model.trim(),
      deliversToOthers: 'no',
      deletesOrIrreversible: 'no',
      confidence: confirm.confidence,
    },
    learnedAt: (options.now?.() ?? new Date()).toISOString(),
  });
  return stored ? 'learned' : 'store_failed';
}

/**
 * Learn one operation's delivery verdict now. Discovery does not call this:
 * it schedules (scheduleOperationDeliveryLearning). Exposed for tests and for
 * callers that already run off the critical path.
 */
export async function learnOperationDelivery(
  definition: OperationDefinitionForDelivery,
  options: {
    screen?: OperationDeliveryScreen;
    confirm?: OperationDeliveryConfirm;
    sessionId?: string;
    now?: () => Date;
  } = {},
): Promise<OperationDeliveryLearningOutcome> {
  const preparation = observeDefinition(definition);
  if (preparation.status !== 'prepared') return preparation.outcome;
  try {
    return await learnPrepared(preparation.definition, options);
  } catch {
    return 'screen_unavailable';
  }
}

// ─── Background scheduling ─────────────────────────────────────────────────

interface QueuedDefinition {
  prepared: PreparedDefinition;
  /** Runs in the async context of the discovery that observed the
   * definition, so its model usage is attributed there and nowhere else. */
  run: () => Promise<OperationDeliveryLearningOutcome>;
}

const queue: QueuedDefinition[] = [];
const pending = new Set<string>();
const retryAfter = new Map<string, number>();
let running = 0;
let pumpScheduled = false;
let idleWaiters: Array<() => void> = [];

function retryKey(prepared: PreparedDefinition): string {
  return `${prepared.key}\0${prepared.definitionDigest}`;
}

function noteOutcome(prepared: PreparedDefinition, outcome: OperationDeliveryLearningOutcome): void {
  const unavailable = outcome === 'screen_unavailable'
    || outcome === 'confirm_unavailable'
    || outcome === 'store_failed';
  const answered = outcome === 'screen_not_confident'
    || outcome === 'confirm_disagreed'
    || outcome === 'confirm_not_confident'
    || outcome === 'confirm_mismatched';
  if (unavailable || answered) {
    boundedSet(retryAfter, retryKey(prepared),
      Date.now() + (unavailable ? RETRY_AFTER_UNAVAILABLE_MS : RETRY_AFTER_ANSWER_MS));
  }
  const log = outcome === 'learned' ? logger.info.bind(logger) : logger.debug.bind(logger);
  log({ operationId: prepared.operationId, providerKind: prepared.providerKind, outcome },
    'operation delivery learning finished');
}

function settleIdle(): void {
  if (running > 0 || queue.length > 0 || pumpScheduled) return;
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const resolve of waiters) resolve();
}

function pump(): void {
  pumpScheduled = false;
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const next = queue.shift()!;
    running += 1;
    void Promise.resolve()
      .then(next.run)
      .catch((): OperationDeliveryLearningOutcome => 'screen_unavailable')
      .then((outcome) => noteOutcome(next.prepared, outcome))
      .catch(() => { /* diagnostics only */ })
      .finally(() => {
        running -= 1;
        pending.delete(next.prepared.key);
        pump();
        settleIdle();
      });
  }
  settleIdle();
}

/**
 * Schedule learning for definitions discovery already holds, and return at
 * once. Bounded (a few new operations per call, a short queue, two at a
 * time), deduplicated per operation, and never retried sooner than its
 * previous outcome allows. Returns how many were scheduled.
 */
export function scheduleOperationDeliveryLearning(
  definitions: readonly OperationDefinitionForDelivery[],
  options: { sessionId?: string } = {},
): number {
  let scheduled = 0;
  for (const definition of definitions) {
    if (scheduled >= MAX_NEW_PER_CALL || queue.length >= MAX_QUEUED) break;
    try {
      const preparation = observeDefinition(definition);
      if (preparation.status !== 'prepared') continue;
      const prepared = preparation.definition;
      if (pending.has(prepared.key)) continue;
      const retryAt = retryAfter.get(retryKey(prepared));
      if (retryAt !== undefined && retryAt > Date.now()) continue;
      pending.add(prepared.key);
      const learnOptions = options.sessionId ? { sessionId: options.sessionId } : {};
      queue.push({
        prepared,
        run: AsyncResource.bind(() => learnPrepared(prepared, learnOptions)),
      });
      scheduled += 1;
    } catch {
      // Discovery never waits on, or fails for, learning.
    }
  }
  if (scheduled > 0 && !pumpScheduled) {
    pumpScheduled = true;
    setImmediate(pump);
  }
  return scheduled;
}

/** Test seam: resolves once nothing is queued or running. */
export function _drainOperationDeliveryLearningForTests(): Promise<void> {
  return new Promise((resolve) => {
    idleWaiters.push(resolve);
    settleIdle();
  });
}

export function _resetOperationDeliveryLearningForTests(): void {
  queue.length = 0;
  pending.clear();
  retryAfter.clear();
  latestObserved.clear();
}
