/**
 * Decide, once, whether a Composio operation only reads, from the operation's
 * own definition. The provider's declared hints decide when they can (a
 * read-only operation reads; a destructive or updating one writes). Where
 * they leave it open, as for an operation that only "creates" (a record, a
 * message, or a provider-side job that gathers data), a model reads the
 * description and input schema. The verdict is persisted
 * (learned-operation-effect-store.ts) and the slug classifier consults it
 * before the name. An unsure or absent verdict leaves the conservative write
 * default in place.
 */
import { createHash } from 'node:crypto';
import { captureTurnLearningScope, readTurnLearningPolicyForScope, type TurnLearningScope } from '../../memory/turn-learning-policy.js';
import { composioSlugVerbEvidence } from './slug-effect.js';
import {
  learnedComposioOperationEffect,
  providerDeclaredEffect,
  rememberComposioOperationEffect,
  rememberProviderDeclaredEffects,
} from './learned-operation-effect-store.js';

export interface OperationDefinitionForEffect {
  slug: string;
  description?: string | null;
  inputSchema?: unknown;
  /** The provider's tags for this definition, effect hints included. */
  tags?: readonly string[];
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

async function evaluateWithJev(input: { slug: string; description: string; schemaText: string; sessionId?: string }, scope: TurnLearningScope) {
  const { evaluateSystemOne } = await import('../../runtime/jev/client.js');
  if (readTurnLearningPolicyForScope(scope).status !== 'allowed') return { ok: false as const };
  const result = await evaluateSystemOne({
    state: { operation: input.slug, description: input.description, inputSchema: input.schemaText },
    questions: {
      readOnly: {
        type: 'noul',
        instructions: 'Judge from the description and input schema whether calling this operation only gathers or computes information and returns it.',
        criteria: {
          true: 'It only retrieves, lists, searches or computes information and returns it, including a provider-side search, scrape, crawl or research job whose only product is data returned to the caller. It creates, changes, archives, moves or deletes none of the user\'s records, files, settings or content, and sends or posts nothing to anyone.',
          false: 'It can create, change, archive, move or delete the user\'s records, files, settings or content, or send or post anything to anyone, or the description leaves that open.',
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
  options: { sessionId?: string; sourceUserSeq?: number; evaluate?: OperationEffectEvaluate; deadlineAt?: number } = {},
): Promise<string[]> {
  // What the provider declares is a fact about the operation, not something
  // learned from this turn: record it whatever the turn's learning policy.
  rememberProviderDeclaredEffects(definitions);
  const scope = captureTurnLearningScope(options);
  if (readTurnLearningPolicyForScope(scope).status !== 'allowed') return [];
  const sessionId = options.sessionId;
  const evaluate: OperationEffectEvaluate = options.evaluate ?? ((input) => evaluateWithJev(input, scope));
  const learned: string[] = [];
  const seen = new Set<string>();
  for (const definition of definitions) {
    const slug = String(definition.slug ?? '').trim().toUpperCase();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) break;
    // The provider decided it: nothing for a model to read. When its hints
    // are known but leave the effect open, the model reads whatever the name
    // says; without hints, only a name with no verb at all is asked.
    if (learnedComposioOperationEffect(slug)?.source === 'provider') continue;
    const hinted = Array.isArray(definition.tags) && definition.tags.length > 0;
    if (hinted ? providerDeclaredEffect(definition.tags) !== null : composioSlugVerbEvidence(slug) !== 'unknown') continue;
    const description = String(definition.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 1_200);
    if (!description) continue;
    let schemaText = '';
    try { schemaText = JSON.stringify(definition.inputSchema ?? null).slice(0, 2_000); } catch { schemaText = ''; }
    const digest = definitionDigest(description, schemaText);
    const existing = learnedComposioOperationEffect(slug);
    if (existing && existing.definitionDigest === digest) continue;
    try {
      if (readTurnLearningPolicyForScope(scope).status !== 'allowed') break;
      const verdict = await evaluate({ slug, description, schemaText, ...(sessionId ? { sessionId } : {}) });
      if (!verdict.ok) continue;
      const effect = verdict.readOnly >= READ_MIN ? 'read' : verdict.readOnly <= WRITE_MAX ? 'write' : null;
      if (!effect) continue;
      if (readTurnLearningPolicyForScope(scope).status !== 'allowed') break;
      rememberComposioOperationEffect(slug, {
        effect, source: 'model', model: verdict.model, confidence: verdict.readOnly,
        definitionDigest: digest, at: new Date().toISOString(),
      });
      learned.push(slug);
    } catch { /* an unavailable model leaves the write default */ }
  }
  return learned;
}
