/**
 * Decide, once, whether a noun-shaped Composio operation only reads, from the
 * operation's own description and input schema, with a model. The verdict is
 * persisted (learned-operation-effect-store.ts) and consulted by the pure slug
 * classifier from then on. Only a confident read verdict changes behavior; an
 * unsure or absent verdict leaves the conservative write default in place.
 */
import { createHash } from 'node:crypto';
import { composioSlugVerbEvidence } from './slug-effect.js';
import { learnedComposioOperationEffect, rememberComposioOperationEffect } from './learned-operation-effect-store.js';

export interface OperationDefinitionForEffect {
  slug: string;
  description?: string | null;
  inputSchema?: unknown;
}

export type OperationEffectEvaluate = (input: {
  slug: string;
  description: string;
  schemaText: string;
  sessionId?: string;
}) => Promise<{ ok: true; readOnly: number; model: string } | { ok: false }>;

const READ_MIN = 0.9;
const WRITE_MAX = 0.15;
const TIMEOUT_MS = 2_500;

async function evaluateWithJev(input: { slug: string; description: string; schemaText: string; sessionId?: string }) {
  const { evaluateSystemOne } = await import('../../runtime/jev/client.js');
  const result = await evaluateSystemOne({
    state: { operation: input.slug, description: input.description, inputSchema: input.schemaText },
    questions: {
      readOnly: {
        type: 'noul',
        instructions: 'Judge from the description and input schema whether calling this operation only retrieves data from the provider.',
        criteria: {
          true: 'It only reads or lists or searches existing data; it creates, updates, deletes, sends, posts, archives, moves or triggers nothing.',
          false: 'It can change provider state or send anything, or the description leaves that open.',
        },
      },
    },
    timeoutMs: TIMEOUT_MS,
    sessionId: input.sessionId,
    channel: 'jev-operation-effect',
  });
  if (!result.ok) return { ok: false as const };
  const answer = result.answers.readOnly as { type: 'noul'; noul: number } | undefined;
  if (!answer || typeof answer.noul !== 'number') return { ok: false as const };
  return { ok: true as const, readOnly: answer.noul, model: result.model };
}

function definitionDigest(description: string, schemaText: string): string {
  return createHash('sha256').update(description).update('\0').update(schemaText).digest('hex');
}

/**
 * Learn the effect of every noun-shaped operation in `definitions` that has no
 * verdict yet. Bounded per operation; failures leave no record. Returns the
 * slugs whose verdict was written this call.
 */
export async function learnComposioOperationEffects(
  definitions: readonly OperationDefinitionForEffect[],
  options: { sessionId?: string; evaluate?: OperationEffectEvaluate; deadlineAt?: number } = {},
): Promise<string[]> {
  const evaluate = options.evaluate ?? evaluateWithJev;
  const learned: string[] = [];
  const seen = new Set<string>();
  for (const definition of definitions) {
    const slug = String(definition.slug ?? '').trim().toUpperCase();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) break;
    if (composioSlugVerbEvidence(slug) !== 'unknown') continue;
    const description = String(definition.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 1_200);
    if (!description) continue;
    let schemaText = '';
    try { schemaText = JSON.stringify(definition.inputSchema ?? null).slice(0, 2_000); } catch { schemaText = ''; }
    const digest = definitionDigest(description, schemaText);
    const existing = learnedComposioOperationEffect(slug);
    if (existing && existing.definitionDigest === digest) continue;
    try {
      const verdict = await evaluate({ slug, description, schemaText, ...(options.sessionId ? { sessionId: options.sessionId } : {}) });
      if (!verdict.ok) continue;
      const effect = verdict.readOnly >= READ_MIN ? 'read' : verdict.readOnly <= WRITE_MAX ? 'write' : null;
      if (!effect) continue;
      rememberComposioOperationEffect(slug, {
        effect, source: 'model', model: verdict.model, confidence: verdict.readOnly,
        definitionDigest: digest, at: new Date().toISOString(),
      });
      learned.push(slug);
    } catch { /* an unavailable model leaves the write default */ }
  }
  return learned;
}
