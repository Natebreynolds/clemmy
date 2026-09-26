/**
 * worker-model-offer — "keep this model for this kind of work?"
 *
 * When the owner named a model for one part of a request and a helper ran on
 * it, the chat offers once to save that as a rule. Nothing is saved until the
 * owner taps Save; "Just this once" closes the offer. A saved rule is the same
 * binding Settings → Models writes, so it shows there and can be changed there.
 *
 * One offer per conversation for each kind of work and model: the id is
 * derived from both, so a later turn that makes the same choice does not ask
 * again.
 */
import { createHash } from 'node:crypto';
import { appendEvent, listEvents } from './eventlog.js';
import type { WorkerModelOffer } from './worker-model-route.js';

export type WorkerModelOfferAction = 'save' | 'dismiss';

/** The kind of work as an id component: case and spacing never make a second
 *  offer. The saved rule itself is slugified by the settings owner. This module
 *  sits on the public projection path, so it stays free of the memory stores. */
function intentKey(intent: string): string {
  return intent.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function workerModelOfferId(sessionId: string, offer: Pick<WorkerModelOffer, 'intent' | 'modelId'>): string {
  const digest = createHash('sha256')
    .update(`${sessionId}\u0000${intentKey(offer.intent)}\u0000${offer.modelId}`)
    .digest('hex')
    .slice(0, 16);
  return `wmo-${digest}`;
}

interface StoredOffer extends WorkerModelOffer {
  offerId: string;
  sourceUserSeq?: number;
}

function storedOffer(sessionId: string, offerId: string): StoredOffer | null {
  for (const event of listEvents(sessionId, { types: ['worker_model_offer'] })) {
    const data = event.data as Partial<StoredOffer>;
    if (data.offerId === offerId && typeof data.intent === 'string' && typeof data.modelId === 'string') {
      return {
        offerId,
        intent: data.intent,
        modelId: data.modelId,
        modelName: typeof data.modelName === 'string' ? data.modelName : data.modelId,
        ...(typeof data.sourceUserSeq === 'number' ? { sourceUserSeq: data.sourceUserSeq } : {}),
      };
    }
  }
  return null;
}

/** The owner's answer to an offer, or null while it is still open. */
export function workerModelOfferResolution(sessionId: string, offerId: string): WorkerModelOfferAction | null {
  return offerResolved(sessionId, offerId);
}

function offerResolved(sessionId: string, offerId: string): WorkerModelOfferAction | null {
  for (const event of listEvents(sessionId, { types: ['worker_model_offer_resolved'] })) {
    const data = event.data as { offerId?: unknown; action?: unknown };
    if (data.offerId === offerId && (data.action === 'save' || data.action === 'dismiss')) return data.action;
  }
  return null;
}

/** Record the offer once for this conversation. Best-effort: an offer that
 *  cannot be recorded is simply not shown. */
export function recordWorkerModelOffer(input: {
  sessionId: string;
  sourceUserSeq?: number | null;
  offer: WorkerModelOffer;
}): string | null {
  const sessionId = input.sessionId.trim();
  if (!sessionId || !intentKey(input.offer.intent) || !input.offer.modelId.trim()) return null;
  const offerId = workerModelOfferId(sessionId, input.offer);
  try {
    if (storedOffer(sessionId, offerId)) return offerId;
    appendEvent({
      sessionId,
      turn: 0,
      role: 'system',
      type: 'worker_model_offer',
      data: {
        offerId,
        intent: input.offer.intent.trim().slice(0, 120),
        modelId: input.offer.modelId.trim(),
        modelName: input.offer.modelName.trim().slice(0, 80) || input.offer.modelId.trim(),
        ...(typeof input.sourceUserSeq === 'number' ? { sourceUserSeq: input.sourceUserSeq } : {}),
      },
    });
    return offerId;
  } catch {
    return null;
  }
}

export type ResolveWorkerModelOfferResult =
  | { ok: true; action: WorkerModelOfferAction; alreadyResolved: boolean }
  | { ok: false; code: 'NOT_FOUND' | 'SAVE_FAILED'; message: string };

type SaveRule = (rule: { intent: string; modelId: string }) => Promise<void>;

async function productionSaveRule(rule: { intent: string; modelId: string }): Promise<void> {
  const { persistModelRoleSetting } = await import('./model-role-settings.js');
  persistModelRoleSetting({ role: 'worker', modelId: rule.modelId, whenIntent: rule.intent, source: 'chat-rule' });
  // Apply on the next turn without a restart, like every other settings door.
  const { resetHarnessRuntimeConfig } = await import('./codex-client.js');
  const { resetClaudeModelCache } = await import('./claude-model.js');
  const { resetByoModelCache } = await import('./byo-model.js');
  const { clearAutonomyAgentCache } = await import('../../agents/autonomy-v2.js');
  resetHarnessRuntimeConfig();
  resetClaudeModelCache();
  resetByoModelCache();
  clearAutonomyAgentCache();
}

let saveRule: SaveRule = productionSaveRule;

/** Test seam: replace the settings write. */
export function _setWorkerModelOfferSaveForTests(fn: SaveRule | null): void {
  saveRule = fn ?? productionSaveRule;
}

/** The owner answered an offer. Save writes the rule through the one settings
 *  owner; either answer closes the offer for this conversation. */
export async function resolveWorkerModelOffer(input: {
  sessionId: string;
  offerId: string;
  action: WorkerModelOfferAction;
}): Promise<ResolveWorkerModelOfferResult> {
  const sessionId = input.sessionId.trim();
  const offer = sessionId ? storedOffer(sessionId, input.offerId) : null;
  if (!offer) return { ok: false, code: 'NOT_FOUND', message: 'That offer is not in this conversation.' };
  const prior = offerResolved(sessionId, offer.offerId);
  if (prior) return { ok: true, action: prior, alreadyResolved: true };
  if (input.action === 'save') {
    try {
      await saveRule({ intent: offer.intent, modelId: offer.modelId });
    } catch (error) {
      return { ok: false, code: 'SAVE_FAILED', message: error instanceof Error ? error.message : String(error) };
    }
  }
  appendEvent({
    sessionId,
    turn: 0,
    role: 'system',
    type: 'worker_model_offer_resolved',
    data: { offerId: offer.offerId, action: input.action },
  });
  return { ok: true, action: input.action, alreadyResolved: false };
}
