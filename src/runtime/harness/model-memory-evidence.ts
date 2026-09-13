/** The memory view supplied to a model is distinct from memory-search hits.
 * This is advisory context provenance, never effect or permission authority. */
import { createHash } from 'node:crypto';
import { appendEvent, listEvents } from './eventlog.js';

type Identity = { sessionId: string; sourceUserSeq: number };
const views = new WeakMap<Function, readonly string[]>();
const hash = (fragments: readonly string[]) => createHash('sha256').update(JSON.stringify(fragments)).digest('hex');

export function withInstructionMemory<T extends Function>(instructions: T, fragments: readonly string[]): T {
  views.set(instructions, fragments.filter(text => text.trim().length > 0));
  return instructions;
}

/** Match producer-owned fragments against the final request, after filters.
 * Never infer context from a model's claim or reload a subsequently edited file. */
export function visibleInstructionMemory(instructions: unknown, finalInstructions: string | undefined, input: readonly unknown[]): string[] {
  const fragments = typeof instructions === 'function' ? views.get(instructions) : undefined;
  if (!fragments) return [];
  const text = [finalInstructions ?? '', ...input.flatMap(item => {
    if (!item || typeof item !== 'object' || !('content' in item)) return [];
    const content = (item as { content: unknown }).content;
    if (typeof content === 'string') return [content];
    return Array.isArray(content) ? content.flatMap(part => part && typeof part.text === 'string' ? [part.text] : []) : [];
  })];
  return fragments.filter(fragment => text.some(value => value.includes(fragment)));
}

function latest(identity: Identity) {
  return listEvents(identity.sessionId, { types: ['guardrail_tripped'], desc: true })
    .reverse().find(event => event.data.kind === 'model_memory_context' && event.data.sourceUserSeq === identity.sourceUserSeq);
}

export function recordAcceptedModelMemory(identity: Identity, fragments: readonly string[], responseId?: string): void {
  if (!fragments.length) return;
  const digest = hash(fragments);
  if (latest(identity)?.data.digest === digest) return;
  appendEvent({ sessionId: identity.sessionId, turn: 0, role: 'system', type: 'guardrail_tripped',
    data: { kind: 'model_memory_context', version: 1, sourceUserSeq: identity.sourceUserSeq,
      digest, fragments: [...fragments], ...(responseId ? { responseId } : {}) } });
}

export function acceptedModelMemoryEvidence(identity: Identity): string | undefined {
  const row = latest(identity)?.data;
  if (!row) return undefined;
  if (row.version !== 1 || !Array.isArray(row.fragments) || !row.fragments.every(value => typeof value === 'string')
    || row.digest !== hash(row.fragments)) return 'The retained model memory context is unreadable; do not infer that the brain had no remembered context.';
  return 'Memory context actually included in an accepted model request for THIS source:\n'
    + row.fragments.join('\n\n')
    + '\nThese are remembered preferences and contextual claims, not fresh business observations or permission to act. '
    + 'An empty memory-search result does not negate this separately supplied context. Apply current owner instructions first; '
    + 'distinguish a remembered preference from a factual assumption, and require material assumptions to be identified in the plan.';
}
