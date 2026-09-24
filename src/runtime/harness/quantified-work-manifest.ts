import { isLiveApprovalAcknowledgement } from './accepted-source-kind.js';
import { detectMultiItemIntentFromConversation } from './multi-item-intent.js';
import {
  appendEvent,
  getSession,
  listEvents,
  type EventRow,
} from './eventlog.js';
import {
  resolveWorkItemId,
  summarizeWorkManifest,
  type WorkerManifestDescriptor,
} from './work-manifest.js';

const LARGE_CHAT_ITEM_COUNT = 8;

export interface QuantifiedWorkManifestGateInput {
  sessionId?: string;
  /** Exact accepted user event that owns this worker call. */
  sourceUserSeq?: number;
  items: string[];
  workManifest?: WorkerManifestDescriptor | null;
}

export interface QuantifiedWorkManifestGateDecision {
  ok: boolean;
  required: boolean;
  expectedCount?: number;
  error?: string;
  /** A fixed-contract refusal that a model may still arbitrate (chat only). */
  code?: 'fixed_contract_mismatch';
  /** Set when a model, not the detector, settled the item universe. */
  arbitrated?: { detectedCount: number; declaredCount: number; noul: number };
}

export type QuantifiedUniverseArbiter = (input: {
  sessionId: string;
  requestText: string;
  detectedCount: number;
  declaredItems: readonly string[];
}) => Promise<{ ok: true; noul: number } | { ok: false }>;

let quantifiedUniverseArbiterOverride: QuantifiedUniverseArbiter | null = null;

export function _setQuantifiedUniverseArbiterForTests(arbiter: QuantifiedUniverseArbiter | null): void {
  quantifiedUniverseArbiterOverride = arbiter;
}

const ARBITRATION_TIMEOUT_MS = 2_500;
const ARBITRATION_NOUL_MIN = 0.7;

/**
 * The detector reads counts out of the user's text with patterns. Live
 * 2026-09-24 (source 294452): "three separate cold prospect emails … a
 * competitor at 4.8 with 600 … 3.9 star rating with 40 reviews" was read as a
 * 40-item contract, and the brain's three-worker declaration was refused three
 * times until the task died. A number in the text is evidence, not the answer:
 * when a chat declaration disagrees with the detected count, a model reasons
 * about which one the user meant. Only its clear yes lifts the refusal;
 * unavailable or unsure keeps today's fail-closed behavior. Execution and
 * background sessions never arbitrate: their universe must be durable.
 */
async function arbitrateQuantifiedUniverse(input: {
  sessionId: string;
  requestText: string;
  detectedCount: number;
  declaredItems: readonly string[];
}): Promise<{ ok: true; noul: number } | { ok: false }> {
  if (quantifiedUniverseArbiterOverride) return quantifiedUniverseArbiterOverride(input);
  try {
    const { evaluateSystemOne } = await import('../jev/client.js');
    const result = await evaluateSystemOne({
      state: {
        request: input.requestText.replace(/\s+/g, ' ').trim().slice(0, 1_200),
        declaredItems: input.declaredItems.slice(0, 64),
        numberFoundInText: input.detectedCount,
      },
      questions: {
        complete: {
          type: 'noul',
          instructions: 'The user asked for work on some set of items. A pattern found the number numberFoundInText in the request text. Do the declaredItems name every item the user actually asked to be produced or processed, so that numberFoundInText refers to something else (a statistic, a rating, a count inside one item, or source material)?',
          criteria: {
            true: 'declaredItems is exactly the set of units the user asked for; the number in the text is not the count of those units.',
            false: 'The user asked for numberFoundInText units and declaredItems is a subset, a guess, or you are not sure.',
          },
        },
      },
      timeoutMs: ARBITRATION_TIMEOUT_MS,
      sessionId: input.sessionId,
      channel: 'jev-quantified-universe',
    });
    if (!result.ok) return { ok: false };
    const answer = result.answers.complete as { type: 'noul'; noul: number } | undefined;
    if (!answer || typeof answer.noul !== 'number') return { ok: false };
    return { ok: true, noul: answer.noul };
  } catch {
    return { ok: false };
  }
}

function acceptedRequestText(sessionId: string, sourceUserSeq: number): string {
  const current = listEvents(sessionId, {
    sinceSeq: sourceUserSeq - 1,
    types: ['user_input_received'],
  }).find((event) => event.seq === sourceUserSeq);
  return current ? eventText(current) : '';
}

/**
 * The gate every fan-out call goes through: the synchronous contract check,
 * then, for a chat refusal whose only ground is a detected count that the
 * declaration disagrees with, a model decides which count the user meant.
 */
export async function evaluateQuantifiedWorkManifestGateWithArbitration(
  input: QuantifiedWorkManifestGateInput,
): Promise<QuantifiedWorkManifestGateDecision> {
  const decision = evaluateQuantifiedWorkManifestGate(input);
  if (decision.ok || decision.code !== 'fixed_contract_mismatch') return decision;
  const sessionId = input.sessionId?.trim() ?? '';
  const sourceUserSeq = input.sourceUserSeq;
  if (!sessionId || !Number.isSafeInteger(sourceUserSeq) || (sourceUserSeq ?? 0) <= 0) return decision;
  const detectedCount = decision.expectedCount;
  const declaredItems = [...new Set(input.items.map((item) => item.trim()).filter(Boolean))];
  if (!detectedCount || declaredItems.length === 0 || declaredItems.length === detectedCount) return decision;
  let session: ReturnType<typeof getSession>;
  try { session = getSession(sessionId); } catch { return decision; }
  if (!session || session.kind !== 'chat') return decision;
  const requestText = acceptedRequestText(sessionId, sourceUserSeq as number);
  if (!requestText) return decision;
  const verdict = await arbitrateQuantifiedUniverse({ sessionId, requestText, detectedCount, declaredItems });
  const accepted = verdict.ok && verdict.noul >= ARBITRATION_NOUL_MIN;
  try {
    appendEvent({
      sessionId,
      turn: 0,
      role: 'system',
      type: 'guardrail_tripped',
      data: {
        kind: 'quantified_universe_arbitrated',
        sourceUserSeq,
        detectedCount,
        declaredCount: declaredItems.length,
        declaredItems: declaredItems.slice(0, 64),
        arbiter: verdict.ok ? { noul: verdict.noul } : { unavailable: true },
        accepted,
      },
    });
  } catch { /* the record never blocks the decision */ }
  if (!accepted) {
    return {
      ...decision,
      error: `${decision.error ?? ''} A model was asked whether the declared ${declaredItems.length} items are the whole request and ${verdict.ok ? 'did not confirm it' : 'was unavailable'}; if the user's text names a different set of items than the number suggests, declare that set exactly and say why.`.trim(),
    };
  }
  return {
    ok: true,
    required: true,
    expectedCount: declaredItems.length,
    arbitrated: { detectedCount, declaredCount: declaredItems.length, noul: verdict.ok ? verdict.noul : 0 },
  };
}

interface QuantifiedWorkContract {
  expectedCount: number;
  source: 'policy' | 'conversation';
}

function eventText(event: EventRow): string {
  const data = event.data as {
    text?: unknown;
    decision?: { reply?: unknown; summary?: unknown };
  };
  if (typeof data?.text === 'string') return data.text.trim();
  if (typeof data?.decision?.reply === 'string') return data.decision.reply.trim();
  if (typeof data?.decision?.summary === 'string') return data.decision.summary.trim();
  return '';
}

function validExpectedCount(value: unknown): number | null {
  const count = typeof value === 'number' ? value : Number.NaN;
  return Number.isSafeInteger(count) && count >= 3 ? count : null;
}

/**
 * Resolve only the current request's explicit item contract.
 *
 * The main loop's fanout_policy_decision is preferred because it is the
 * already-computed structural signal, but it must name the same accepted user
 * row as this tool call. The Claude SDK lane does not always emit that event,
 * so the same pure detector is used over the exact input and only the
 * immediately preceding assistant proposal as a parity fallback.
 */
function currentQuantifiedWorkContract(
  sessionId: string,
  sourceUserSeq: number,
): QuantifiedWorkContract | null {
  const currentInput = listEvents(sessionId, {
    sinceSeq: sourceUserSeq - 1,
    types: ['user_input_received'],
  }).find((event) => event.seq === sourceUserSeq);
  if (!currentInput) return null;

  const currentPolicy = listEvents(sessionId, {
    sinceSeq: sourceUserSeq,
    types: ['fanout_policy_decision'],
  })
    .filter((event) => (
      (event.data as { sourceUserSeq?: unknown }).sourceUserSeq === sourceUserSeq
    ))
    .at(-1);
  if (currentPolicy) {
    const data = currentPolicy.data as { detected?: unknown; itemCount?: unknown };
    const count = data.detected === true ? validExpectedCount(data.itemCount) : null;
    if (count !== null) return { expectedCount: count, source: 'policy' };
  }

  const currentText = eventText(currentInput);
  if (!currentText) return null;
  const priorAssistant = listEvents(sessionId, {
    types: ['conversation_step'],
  })
    .filter((event) => event.seq < sourceUserSeq)
    .at(-1);
  const priorProposal = priorAssistant ? eventText(priorAssistant) : '';
  const detected = detectMultiItemIntentFromConversation(
    currentText,
    priorProposal ? [priorProposal] : [],
  );
  return detected.isMultiItem
    ? { expectedCount: detected.itemCount, source: 'conversation' }
    : null;
}

function aliasTarget(
  descriptor: WorkerManifestDescriptor,
  item: string,
): string {
  const aliases = descriptor.aliases;
  if (Array.isArray(aliases)) {
    const wanted = item.trim().toLowerCase();
    const match = aliases.find((entry) => entry.alias.trim().toLowerCase() === wanted);
    return match?.itemId?.trim() || item;
  }
  if (aliases && typeof aliases === 'object') {
    const exact = aliases[item];
    if (typeof exact === 'string' && exact.trim()) return exact.trim();
    const wanted = item.trim().toLowerCase();
    for (const [label, itemId] of Object.entries(aliases)) {
      if (
        label.trim().toLowerCase() === wanted
        && typeof itemId === 'string'
        && itemId.trim()
      ) {
        return itemId.trim();
      }
    }
  }
  return item;
}

function fixedContractError(expectedCount: number, detail: string): QuantifiedWorkManifestGateDecision {
  return {
    ok: false,
    required: true,
    expectedCount,
    code: 'fixed_contract_mismatch',
    error: (
      `This clearly quantified task has a fixed ${expectedCount}-item contract, but ${detail}. `
      + `Retry run_worker with the full ${expectedCount}-item \`items\` array and a workManifest `
      + 'that declares the canonical item universe. Workers were NOT started.'
    ),
  };
}

function manifestTouchedByRequest(
  sessionId: string,
  manifestId: string,
  sourceUserSeq: number,
): boolean {
  const events = listEvents(sessionId, {
    sinceSeq: sourceUserSeq,
    types: ['user_input_received', 'work_manifest_declared'],
  });
  const nextUserSeq = events.find((event) => (
    event.type === 'user_input_received' && !isLiveApprovalAcknowledgement(event) && event.seq > sourceUserSeq
  ))?.seq;
  return events.some((event) => {
    if (event.type !== 'work_manifest_declared') return false;
    const data = event.data as { manifestId?: unknown; sourceUserSeq?: unknown };
    if (data.manifestId !== manifestId) return false;
    if (Number.isSafeInteger(data.sourceUserSeq)) {
      return data.sourceUserSeq === sourceUserSeq;
    }
    // Historical manifests had no request owner. Preserve their ordered
    // behavior only while this request is still the newest user boundary;
    // once another user row exists, a legacy declaration cannot be assigned
    // safely to either overlapping request.
    return nextUserSeq === undefined || event.seq < nextUserSeq;
  });
}

/**
 * Fail closed only at the fan-out boundary, and only for work where a durable
 * universe materially matters: execution/background sessions or large
 * (N>=8) chat batches. Ordinary chat and small conversational batches take the
 * byte-identical fast path.
 */
export function evaluateQuantifiedWorkManifestGate(
  input: QuantifiedWorkManifestGateInput,
): QuantifiedWorkManifestGateDecision {
  const sessionId = input.sessionId?.trim();
  if (!sessionId) return { ok: true, required: false };
  const sourceUserSeq = input.sourceUserSeq;
  if (!Number.isSafeInteger(sourceUserSeq) || (sourceUserSeq ?? 0) <= 0) {
    // Legacy/internal callers without an accepted request boundary retain the
    // old behavior. Production foreground lanes always supply this identity.
    return { ok: true, required: false };
  }
  try {
    const session = getSession(sessionId);
    if (!session) {
      return {
        ok: false,
        required: true,
        error: 'The current request session could not be verified. Workers were NOT started.',
      };
    }
    const contract = currentQuantifiedWorkContract(sessionId, sourceUserSeq as number);
    if (!contract) return { ok: true, required: false };
    const required = session.kind === 'execution'
      || contract.expectedCount >= LARGE_CHAT_ITEM_COUNT;
    if (!required) return { ok: true, required: false };

    const expectedCount = contract.expectedCount;
    if (expectedCount > 256) {
      return {
        ok: false,
        required: true,
        expectedCount,
        error: (
          `This task declares ${expectedCount} canonical items, but run_worker supports at most 256 in one structurally complete batch. `
          + 'Use or author a durable workflow with forEach for the full universe. '
          + 'Workers were NOT started; do not run or report a partial subset as complete.'
        ),
      };
    }
    const descriptor = input.workManifest;
    if (!descriptor) {
      return fixedContractError(expectedCount, 'the call omitted workManifest');
    }

    const manifestId = descriptor.id?.trim();
    const existing = manifestId ? summarizeWorkManifest(sessionId, manifestId) : null;
    if (!existing) {
      if (input.items.length !== expectedCount) {
        return fixedContractError(
          expectedCount,
          `the declaration call supplied only ${input.items.length}/${expectedCount} canonical items`,
        );
      }
      return { ok: true, required: true, expectedCount };
    }

    const touchedThisRequest = manifestTouchedByRequest(
      sessionId,
      existing.manifestId,
      sourceUserSeq as number,
    );
    // The first manifest-bearing call owned by a new user request must cover
    // that request's exact N-item delta. After that full declaration/reconcile,
    // later phases may operate on slices of the already-fixed universe.
    if (!touchedThisRequest && input.items.length !== expectedCount) {
      return fixedContractError(
        expectedCount,
        `the first call for this request supplied only ${input.items.length}/${expectedCount} items`,
      );
    }

    const undeclared = input.items.filter((item) => (
      resolveWorkItemId(sessionId, existing.manifestId, aliasTarget(descriptor, item)) === null
    ));
    if (descriptor.mode === 'extend') {
      if (undeclared.length > 0 && touchedThisRequest) {
        return fixedContractError(
          expectedCount,
          `the call tried to add another ${undeclared.length} undeclared item${undeclared.length === 1 ? '' : 's'} after this request's exact scope delta was already bound`,
        );
      }
      if (!touchedThisRequest) {
        const missingPhase = !existing.phases.some((phase) => phase.id === descriptor.phase);
        const phaseOnlyExtension = missingPhase && undeclared.length === 0;
        const exactItemExtension = undeclared.length === expectedCount;
        if (!phaseOnlyExtension && !exactItemExtension) {
          return fixedContractError(
            expectedCount,
            (
              `mode="extend" represented only ${undeclared.length}/${expectedCount} requested additions as new canonical items. `
              + 'Use undeclared ids for an item-scope extension, or an undeclared phase with existing ids for a phase-only extension'
            ),
          );
        }
      }
      return { ok: true, required: true, expectedCount };
    }
    if (undeclared.length > 0) {
      return fixedContractError(
        expectedCount,
        `${undeclared.length} requested item${undeclared.length === 1 ? '' : 's'} are outside workManifest "${existing.manifestId}"`,
      );
    }

    return { ok: true, required: true, expectedCount };
  } catch (error) {
    return {
      ok: false,
      required: true,
      error: (
        'The current request work contract could not be verified, so workers were NOT started. '
        + `Retry after the local execution ledger is available (${error instanceof Error ? error.message : 'unknown state error'}).`
      ),
    };
  }
}
