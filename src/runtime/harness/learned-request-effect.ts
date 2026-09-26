/**
 * Learning what a generic request actually did.
 *
 * A provider tool whose effect the host cannot classify is treated as a write
 * before it runs, and that is right: the arguments are the model's own text,
 * and a gate cannot lower itself on them. After the call returns, the picture
 * is different. The request that was made and the provider's answer are
 * evidence, and two models can read them: Jev screens, the configured judge
 * confirms, and only their agreement that the request changed nothing is
 * remembered, for that request shape. The next call of the same shape is a
 * read from the start: no write reservation, an ordinary review, and Jev may
 * close the turn.
 *
 * Nothing here waits on the turn. Learning is queued off the settlement,
 * bounded, deduplicated per shape, and never retried sooner than its last
 * outcome allows. No Jev key or no judge port means nothing is learned and
 * nothing changes.
 */
import { AsyncResource } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import pino from 'pino';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { peekTurnSemanticModelPort } from '../semantic-boundary/turn-semantic-port-registry.js';
import { REQUEST_EFFECT_JUDGE_PURPOSE } from '../semantic-boundary/turn-semantic-model-port.js';
import { digestToolOutput } from './tool-output-digest.js';
import {
  LEARNED_REQUEST_EFFECT_CONFIRM_MIN,
  LEARNED_REQUEST_EFFECT_SCREEN_MAX,
  LEARNED_REQUEST_EFFECT_VERSION,
  learnedRequestEffectKey,
  learnedRequestEffectVerdict,
  rememberLearnedRequestEffect,
  requestShapeOf,
  type LearnedRequestEffectProviderKind,
  type RequestShape,
} from './learned-request-effect-store.js';

export { requestPathTemplate, requestShapeOf } from './learned-request-effect-store.js';

const logger = pino({ name: 'learned-request-effect' });

const MAX_REQUEST_CHARS = 2_000;
const MAX_RESPONSE_CHARS = 3_000;
const SCREEN_TIMEOUT_MS = 8_000;
const CONFIRM_TIMEOUT_MS = 90_000;
const MAX_CONCURRENT = 2;
const MAX_QUEUED = 32;
const RETRY_AFTER_ANSWER_MS = 24 * 60 * 60_000;
/** The screen alone said no; the judge never looked. Ask again sooner. */
const RETRY_AFTER_SCREEN_MS = 2 * 60 * 60_000;
const RETRY_AFTER_UNAVAILABLE_MS = 10 * 60_000;
const MAX_REMEMBERED = 500;

export interface SettledRequestForEffect {
  providerKind: LearnedRequestEffectProviderKind;
  /** The operation the host classified: `server__tool` for a native tool. */
  operationId: string;
  args: unknown;
  /** The provider's answer, as the model would see it. */
  result: unknown;
  sessionId?: string;
}

export type RequestEffectScreenResult =
  | { ok: true; model: string; changeProbability: number }
  | { ok: false };

export type RequestEffectScreen = (input: {
  evidence: RequestEffectEvidence;
  sessionId?: string;
}) => Promise<RequestEffectScreenResult>;

export type RequestEffectConfirmResult =
  | { ok: true; model: string; changesProvider: 'yes' | 'no' | 'uncertain'; confidence: number; evidenceDigest: string }
  | { ok: false };

export type RequestEffectConfirm = (input: {
  evidence: RequestEffectEvidence;
  evidenceDigest: string;
  sessionId?: string;
}) => Promise<RequestEffectConfirmResult>;

export type RequestEffectLearningOutcome =
  | 'learned'
  | 'already_learned'
  | 'no_shape'
  | 'no_evidence'
  | 'screen_unavailable'
  | 'screen_not_confident'
  | 'confirm_unavailable'
  | 'confirm_disagreed'
  | 'confirm_not_confident'
  | 'confirm_mismatched'
  | 'store_failed';

/** What both models read. The operation's name is not part of it: a request
 *  is judged from what it asked and what came back, never from spelling. */
export interface RequestEffectEvidence {
  method: string;
  pathTemplate: string;
  request: string;
  response: string;
}

interface PreparedRequest {
  key: string;
  providerKind: LearnedRequestEffectProviderKind;
  operationId: string;
  shape: RequestShape;
  evidence: RequestEffectEvidence;
  evidenceDigest: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function decoded(args: unknown): unknown {
  if (typeof args !== 'string') return args;
  try { return JSON.parse(args) as unknown; } catch { return undefined; }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function requestText(args: unknown): string {
  const record = decoded(args);
  try {
    return closedCanonicalJson(record ?? null).slice(0, MAX_REQUEST_CHARS);
  } catch {
    return String(record ?? '').slice(0, MAX_REQUEST_CHARS);
  }
}

function responseText(result: unknown): string {
  const text = typeof result === 'string'
    ? result
    : result === undefined
      ? ''
      : (() => { try { return JSON.stringify(result); } catch { return String(result); } })();
  const trimmed = text.trim();
  if (!trimmed) return '';
  try {
    return digestToolOutput(trimmed, { maxChars: MAX_RESPONSE_CHARS }).slice(0, MAX_RESPONSE_CHARS);
  } catch {
    return trimmed.slice(0, MAX_RESPONSE_CHARS);
  }
}

type Preparation =
  | { status: 'prepared'; request: PreparedRequest }
  | { status: 'skipped'; outcome: RequestEffectLearningOutcome };

function prepare(input: SettledRequestForEffect): Preparation {
  const shape = requestShapeOf(input.args);
  if (!shape) return { status: 'skipped', outcome: 'no_shape' };
  const key = learnedRequestEffectKey(input.providerKind, input.operationId, shape);
  if (!key) return { status: 'skipped', outcome: 'no_shape' };
  if (learnedRequestEffectVerdict(input.providerKind, input.operationId, shape)) {
    return { status: 'skipped', outcome: 'already_learned' };
  }
  const response = responseText(input.result);
  if (!response) return { status: 'skipped', outcome: 'no_evidence' };
  const evidence: RequestEffectEvidence = {
    method: shape.method,
    pathTemplate: shape.pathTemplate,
    request: requestText(input.args),
    response,
  };
  return {
    status: 'prepared',
    request: {
      key,
      providerKind: input.providerKind,
      operationId: input.operationId.trim(),
      shape,
      evidence,
      evidenceDigest: sha256(closedCanonicalJson(evidence)),
    },
  };
}

async function boundedWait<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); timer.unref?.(); }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Stage one: Jev reads the request and the provider's answer. */
async function screenWithJev(input: {
  evidence: RequestEffectEvidence;
  sessionId?: string;
}): Promise<RequestEffectScreenResult> {
  const { evaluateSystemOne } = await import('../jev/client.js');
  const result = await evaluateSystemOne({
    state: input.evidence,
    questions: {
      changes: {
        type: 'noul',
        instructions: 'Judge only from this request (its method, path, and body) and the provider\'s response whether the request changed anything on the provider\'s side.',
        criteria: {
          true: 'It created, updated, deleted, sent, published, scheduled, started or queued something, or spent an allowance beyond the price of answering this request, or the response leaves that open.',
          false: 'It only looked something up and returned it. Nothing on the provider is different afterwards, apart from the provider charging for the answer itself.',
        },
      },
    },
    timeoutMs: SCREEN_TIMEOUT_MS,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    channel: 'jev-request-effect',
  });
  if (!result.ok) return { ok: false };
  const changes = result.answers.changes;
  if (changes?.type !== 'noul') return { ok: false };
  return { ok: true, model: result.model, changeProbability: changes.noul };
}

/** Stage two: the owner's configured judge role, through the installed
 * semantic port. No port, no judge method, a failure or a timeout is no
 * confirmation. */
async function confirmWithJudge(input: {
  evidence: RequestEffectEvidence;
  evidenceDigest: string;
  sessionId?: string;
}): Promise<RequestEffectConfirmResult> {
  const port = peekTurnSemanticModelPort();
  if (!port?.judgeRequestEffect) return { ok: false };
  const verdict = await boundedWait(port.judgeRequestEffect({
    purpose: REQUEST_EFFECT_JUDGE_PURPOSE,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...input.evidence,
    evidenceDigest: input.evidenceDigest,
  }), CONFIRM_TIMEOUT_MS);
  if (!verdict || typeof verdict.modelIdentity !== 'string' || !verdict.modelIdentity.trim()) {
    return { ok: false };
  }
  return {
    ok: true,
    model: verdict.modelIdentity.trim(),
    changesProvider: verdict.changesProvider,
    confidence: verdict.confidence,
    evidenceDigest: verdict.evidenceDigest,
  };
}

function probabilityAtMost(value: unknown, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
}

async function learnPrepared(
  prepared: PreparedRequest,
  options: {
    screen?: RequestEffectScreen;
    confirm?: RequestEffectConfirm;
    sessionId?: string;
    now?: () => Date;
  },
): Promise<RequestEffectLearningOutcome> {
  const session = options.sessionId ? { sessionId: options.sessionId } : {};
  const screen = await boundedWait(
    (options.screen ?? screenWithJev)({ evidence: prepared.evidence, ...session }),
    SCREEN_TIMEOUT_MS + 2_000,
  );
  if (!screen?.ok || typeof screen.model !== 'string' || !screen.model.trim()) return 'screen_unavailable';
  if (!probabilityAtMost(screen.changeProbability, LEARNED_REQUEST_EFFECT_SCREEN_MAX)) {
    logger.info({ operationId: prepared.operationId, shape: prepared.shape, screen: screen.model,
      changeProbability: screen.changeProbability, bar: LEARNED_REQUEST_EFFECT_SCREEN_MAX },
      'request effect screen saw a possible change; the judge was not asked');
    return 'screen_not_confident';
  }

  const confirm = await boundedWait(
    (options.confirm ?? confirmWithJudge)({
      evidence: prepared.evidence,
      evidenceDigest: prepared.evidenceDigest,
      ...session,
    }),
    CONFIRM_TIMEOUT_MS + 2_000,
  );
  if (!confirm?.ok || typeof confirm.model !== 'string' || !confirm.model.trim()) return 'confirm_unavailable';
  // Two readings by one model are one reading.
  if (confirm.model.trim() === screen.model.trim()) return 'confirm_unavailable';
  const judged = { operationId: prepared.operationId, shape: prepared.shape, screen: screen.model,
    changeProbability: screen.changeProbability, judge: confirm.model,
    changesProvider: confirm.changesProvider, confidence: confirm.confidence };
  if (confirm.evidenceDigest !== prepared.evidenceDigest) {
    logger.info(judged, 'request effect judge answered about different evidence');
    return 'confirm_mismatched';
  }
  if (confirm.changesProvider === 'yes') {
    logger.info(judged, 'request effect judge found a change; the shape stays a write');
    return 'confirm_disagreed';
  }
  if (
    confirm.changesProvider !== 'no'
    || typeof confirm.confidence !== 'number'
    || !Number.isFinite(confirm.confidence)
    || confirm.confidence < LEARNED_REQUEST_EFFECT_CONFIRM_MIN
    || confirm.confidence > 1
  ) {
    logger.info(judged, 'request effect judge was not confident; the shape stays a write');
    return 'confirm_not_confident';
  }

  const stored = rememberLearnedRequestEffect({
    version: LEARNED_REQUEST_EFFECT_VERSION,
    providerKind: prepared.providerKind,
    operationId: prepared.operationId,
    shape: prepared.shape,
    verdict: 'reads_only',
    evidenceDigest: prepared.evidenceDigest,
    screen: { model: screen.model.trim(), changeProbability: screen.changeProbability },
    confirm: { role: 'judge', model: confirm.model.trim(), changesProvider: 'no', confidence: confirm.confidence },
    learnedAt: (options.now?.() ?? new Date()).toISOString(),
  });
  return stored ? 'learned' : 'store_failed';
}

/**
 * Learn one settled request's effect now. Settlement does not call this: it
 * schedules (scheduleRequestEffectLearning). Exposed for tests and for
 * callers already off the critical path.
 */
export async function learnRequestEffect(
  input: SettledRequestForEffect,
  options: {
    screen?: RequestEffectScreen;
    confirm?: RequestEffectConfirm;
    sessionId?: string;
    now?: () => Date;
  } = {},
): Promise<RequestEffectLearningOutcome> {
  const preparation = prepare(input);
  if (preparation.status !== 'prepared') return preparation.outcome;
  try {
    return await learnPrepared(preparation.request, options);
  } catch {
    return 'screen_unavailable';
  }
}

// ─── Background scheduling ─────────────────────────────────────────────────

interface QueuedRequest {
  prepared: PreparedRequest;
  /** Runs in the async context of the settlement that observed the call, so
   * its model usage is attributed there and nowhere else. */
  run: () => Promise<RequestEffectLearningOutcome>;
}

const queue: QueuedRequest[] = [];
const pending = new Set<string>();
const retryAfter = new Map<string, number>();
let running = 0;
let pumpScheduled = false;
let idleWaiters: Array<() => void> = [];

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value);
  if (map.size > MAX_REMEMBERED) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function noteOutcome(prepared: PreparedRequest, outcome: RequestEffectLearningOutcome): void {
  const unavailable = outcome === 'screen_unavailable'
    || outcome === 'confirm_unavailable'
    || outcome === 'store_failed';
  const screened = outcome === 'screen_not_confident';
  const answered = outcome === 'confirm_disagreed'
    || outcome === 'confirm_not_confident'
    || outcome === 'confirm_mismatched';
  if (unavailable || screened || answered) {
    boundedSet(retryAfter, prepared.key,
      Date.now() + (unavailable ? RETRY_AFTER_UNAVAILABLE_MS : screened ? RETRY_AFTER_SCREEN_MS : RETRY_AFTER_ANSWER_MS));
  }
  const log = outcome === 'learned' ? logger.info.bind(logger) : logger.debug.bind(logger);
  log({ operationId: prepared.operationId, providerKind: prepared.providerKind, shape: prepared.shape, outcome },
    'request effect learning finished');
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
      .catch((): RequestEffectLearningOutcome => 'screen_unavailable')
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
 * Schedule learning for one settled request and return at once. Bounded (a
 * short queue, two at a time), deduplicated per shape, and never retried
 * sooner than its previous outcome allows. True when scheduled.
 */
export function scheduleRequestEffectLearning(
  input: SettledRequestForEffect,
  options: { sessionId?: string } = {},
): boolean {
  try {
    const preparation = prepare(input);
    if (preparation.status !== 'prepared') return false;
    if (queue.length >= MAX_QUEUED) return false;
    const prepared = preparation.request;
    if (pending.has(prepared.key)) return false;
    const retryAt = retryAfter.get(prepared.key);
    if (retryAt !== undefined && retryAt > Date.now()) return false;
    pending.add(prepared.key);
    const learnOptions = options.sessionId ? { sessionId: options.sessionId } : {};
    queue.push({ prepared, run: AsyncResource.bind(() => learnPrepared(prepared, learnOptions)) });
    if (!pumpScheduled) {
      pumpScheduled = true;
      setImmediate(pump);
    }
    return true;
  } catch {
    // Settlement never waits on, or fails for, learning.
    return false;
  }
}

/** Test seam: resolves once nothing is queued or running. */
export function _drainRequestEffectLearningForTests(): Promise<void> {
  return new Promise((resolve) => {
    idleWaiters.push(resolve);
    settleIdle();
  });
}

export function _resetRequestEffectLearningForTests(): void {
  queue.length = 0;
  pending.clear();
  retryAfter.clear();
}
