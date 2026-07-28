import { detectMultiItemIntentFromConversation } from './multi-item-intent.js';
import {
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
    event.type === 'user_input_received' && event.seq > sourceUserSeq
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
