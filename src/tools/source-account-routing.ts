/** Model-nominated account routing, checked against accepted source and live
 * identities. This supplies a route, never consent or execution authority. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getSession, listEvents } from '../runtime/harness/eventlog.js';
import { sameConversationAncestorSessionIds } from '../runtime/harness/accepted-source-session-branch.js';
import { peekTurnSemanticModelPort } from '../runtime/semantic-boundary/turn-semantic-port-registry.js';
import type { SourceAccountJudgeCall, SourceAccountJudgeResult } from '../runtime/semantic-boundary/turn-semantic-model-port.js';
import { readConsumedTaskContinuityPacket } from '../memory/task-continuity.js';
import { aliasLabelFor } from '../memory/account-alias-store.js';
import { selectToolkitConnection, type listUsableConnectedToolkits } from '../integrations/composio/client.js';

export const SourceAccountNominationSchema = z.object({
  toolkit: z.string().min(1).max(128),
  identity: z.string().min(1).max(320),
  source_quote: z.string().min(1).max(2_000),
}).strict();
export type SourceAccountNomination = z.infer<typeof SourceAccountNominationSchema>;

const RoutingEvidenceSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1),
  principalId: z.string().min(1),
  toolkit: z.string().min(1),
  identity: z.string().min(1),
  sourceSessionId: z.string().min(1),
  sourceUserSeq: z.number().int().positive(),
  sourceQuote: z.string().min(1).max(2_000),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  checkedForSourceUserSeq: z.number().int().positive(),
  checkedForSourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  judgeModelIdentity: z.string().min(1),
}).strict();
const DefaultRoutingEvidenceSchema = RoutingEvidenceSchema.extend({
  version: z.literal(2),
  selectionKind: z.literal('current_source_default'),
  sourceQuote: z.null(),
  connectionRevision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type ExplicitRoutingEvidence = z.infer<typeof RoutingEvidenceSchema>;
export type SourceAccountRoutingEvidence = ExplicitRoutingEvidence | z.infer<typeof DefaultRoutingEvidenceSchema>;
type Connections = Awaited<ReturnType<typeof listUsableConnectedToolkits>>;
type Connection = Connections[number];
export type SourceAccountRoutingResolution =
  | { kind: 'none' }
  | {
      kind: 'account_selection_required';
      choices: readonly string[];
      /** Why the nominated account was not bound. Surfaced to the model so
       *  the next hop is a precise question to the user, never a blind retry
       *  (live 2026-09-08: three identical refusals with no reason). */
      reason?: 'review_unavailable' | 'not_entailed' | 'quote_not_in_source';
    }
  | { kind: 'resolved'; connection: Connection; evidence: SourceAccountRoutingEvidence };

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const emailOf = (connection: Connection): string => String(connection.accountEmail ?? '')
  .trim().toLowerCase().replace(/^smtp:/, '');
const identityOf = (connection: Connection): string => emailOf(connection) || connection.connectionId;
function acceptedSource(sessionId: string, seq: number) {
  const event = listEvents(sessionId, { sinceSeq: seq - 1, types: ['user_input_received'], limit: 1 })[0];
  if (!event || event.seq !== seq || event.role !== 'user') return null;
  const display = typeof event.data.displayText === 'string' ? event.data.displayText : '';
  const text = display || (typeof event.data.text === 'string' ? event.data.text : '');
  return text.trim() ? { sessionId, seq, text, digest: digest(text) } : null;
}

/** Continuity must see corrections even when an intervening turn never ran a
 * tool. Refuse oversized/incomplete ranges instead of dropping older content
 * and presenting a stale account choice as the latest user intent. */
function interveningSources(input: {
  sessionId: string; principalId: string; originSeq: number; currentSeq: number;
}): Array<{ sourceUserSeq: number; acceptedText: string }> | null {
  if (input.originSeq === input.currentSeq) return [];
  const maxSources = 32;
  const sessions = [input.sessionId, ...sameConversationAncestorSessionIds(input)];
  const events = sessions.flatMap(sessionId => listEvents(sessionId, {
    types: ['user_input_received'], sinceSeq: input.originSeq, limit: maxSources + 1,
  })).filter(event => event.seq < input.currentSeq).sort((a, b) => a.seq - b.seq);
  if (events.length > maxSources) return null;
  const sources: Array<{ sourceUserSeq: number; acceptedText: string }> = [];
  let chars = 0;
  for (const event of events) {
    const source = acceptedSource(event.sessionId, event.seq);
    if (!source || event.data.synthetic === true) return null;
    chars += source.text.length;
    if (chars > 24_000) return null;
    sources.push({ sourceUserSeq: source.seq, acceptedText: source.text });
  }
  return sources;
}

/** A bounded cache shares a judgment across the search's many operation rows.
 * Replacing the semantic port (including in tests) cannot reuse old verdicts. */
const judgments = new WeakMap<object, Map<string, Promise<SourceAccountJudgeResult>>>();
async function judge(call: SourceAccountJudgeCall, connectionRevision: string): Promise<SourceAccountJudgeResult | null> {
  const port = peekTurnSemanticModelPort();
  if (!port?.judgeAccountSelection) return null;
  let cache = judgments.get(port);
  if (!cache) { cache = new Map(); judgments.set(port, cache); }
  const key = digest(JSON.stringify({ call, connectionRevision }));
  let pending = cache.get(key);
  if (!pending) {
    pending = port.judgeAccountSelection(call);
    cache.set(key, pending);
    if (cache.size > 256) cache.delete(cache.keys().next().value!);
  }
  try { return await pending; } catch { return null; }
}

/** Reads only routing evidence the host persisted in its existing resolution
 * ledger. No assistant prose, provider text, other session, or guessed alias
 * can become an established account selection. */
function newestEstablishedRoute(input: {
  sessionId: string; sourceUserSeq: number; principalId: string; toolkit: string;
}): ExplicitRoutingEvidence | 'conflict' | null {
  const sessions = [input.sessionId, ...sameConversationAncestorSessionIds(input)];
  const events = sessions.flatMap(sessionId => listEvents(sessionId,
    { types: ['capability_resolution'], limit: 128, desc: true })).sort((a, b) => a.seq - b.seq);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.data.authoritativeForTask !== true || !Array.isArray(event.data.entries)) continue;
    const eventSource = event.data.sourceUserSeq;
    if (typeof eventSource !== 'number' || eventSource > input.sourceUserSeq) continue;
    const found = new Map<string, ExplicitRoutingEvidence>();
    let checkedDefault = false;
    for (const entry of event.data.entries) {
      if (!entry || typeof entry !== 'object') continue;
      const parsed = z.union([RoutingEvidenceSchema, DefaultRoutingEvidenceSchema]).safeParse(entry.sourceAccountRouting);
      if (!parsed.success) continue;
      const route = parsed.data;
      if (route.sessionId !== event.sessionId || !sessions.includes(route.sourceSessionId) || route.principalId !== input.principalId
        || route.toolkit !== input.toolkit || route.checkedForSourceUserSeq !== eventSource
        || route.sourceUserSeq > route.checkedForSourceUserSeq) continue;
      const origin = acceptedSource(route.sourceSessionId, route.sourceUserSeq);
      const checked = acceptedSource(route.sessionId, route.checkedForSourceUserSeq);
      if (!origin || !checked || origin.digest !== route.sourceDigest
        || checked.digest !== route.checkedForSourceDigest) continue;
      if (route.version === 2) {
        // A checked default is a boundary, not a selected-account fact. Never
        // scan past newer default work to resurrect an older explicit route.
        if (route.sourceSessionId !== route.sessionId || route.sourceUserSeq !== eventSource
          || route.sourceDigest !== route.checkedForSourceDigest) continue;
        checkedDefault = true;
      } else if (origin.text.includes(route.sourceQuote)) found.set(route.identity, route);
    }
    // Conflicting identities at the newest checked source never fall through
    // to an older convenient account.
    if (checkedDefault) return found.size > 0 ? 'conflict' : null;
    if (found.size > 0) return found.size === 1 ? [...found.values()][0]! : 'conflict';
  }
  return null;
}

function consumedAccountClarification(
  sessionId: string,
  sourceUserSeq: number,
  answer: string,
): NonNullable<SourceAccountJudgeCall['clarification']> | null {
  try {
    const consumed = readConsumedTaskContinuityPacket({ sessionId, consumingSourceUserSeq: sourceUserSeq });
    if (consumed.status !== 'consumed' || consumed.packet.pause.kind !== 'clarification') return null;
    const options = consumed.packet.pause.options.filter((option) => typeof option === 'string' && option.trim());
    if (options.length < 2) return null;
    const resolution = consumed.resolution as { disposition?: string; selectedOption?: string; activeTaskInput?: string };
    return {
      question: consumed.packet.pause.question,
      options,
      answer: resolution.activeTaskInput?.trim() || answer,
      selectedOption: resolution.disposition === 'selected' && resolution.selectedOption ? resolution.selectedOption : null,
    };
  } catch {
    return null;
  }
}

export async function resolveSourceAccountRouting(input: {
  sessionId: string;
  sourceUserSeq: number;
  toolkit: string;
  operation: string;
  connections: Connections;
  nomination?: SourceAccountNomination | null;
}): Promise<SourceAccountRoutingResolution> {
  const toolkit = input.toolkit.trim().toLowerCase();
  const relevant = input.connections.filter((connection) => connection.slug.trim().toLowerCase() === toolkit
    && /^(?:active|enabled|initiated)$/i.test(connection.status ?? ''));
  const choices = [...new Set(relevant.map(identityOf))];
  const blocked = (
    reason?: 'not_entailed' | 'quote_not_in_source',
  ): SourceAccountRoutingResolution => ({ kind: 'account_selection_required', choices, ...(reason ? { reason } : {}) });
  const source = acceptedSource(input.sessionId, input.sourceUserSeq);
  const session = getSession(input.sessionId);
  if (!source || !session) return blocked();
  const principalId = session.userId || session.id;
  const supplied = input.nomination && input.nomination.toolkit.trim().toLowerCase() === toolkit
    ? SourceAccountNominationSchema.safeParse(input.nomination)
    : null;
  if (supplied && !supplied.success) return blocked();
  const nomination = supplied?.success ? supplied.data : null;
  const latest = newestEstablishedRoute({ ...input, principalId, toolkit });
  if (!nomination && latest === 'conflict') return blocked();
  let established = !nomination && latest !== 'conflict' ? latest : null;
  const defaultMode = !nomination && !established;
  if (defaultMode && choices.length !== 1) return blocked();
  const proposedIdentity = nomination?.identity.trim() ?? established?.identity ?? choices[0]!;
  const exact = relevant.filter((connection) => connection.connectionId === proposedIdentity
    || emailOf(connection) === proposedIdentity.toLowerCase());
  if (exact.length === 0) return blocked();
  const identity = identityOf(exact[0]!);
  // Duplicate re-auths are one stable identity; the normal provider selector
  // chooses its current transport. Distinct identities remain ambiguous.
  if (new Set(exact.map(identityOf)).size !== 1) return blocked();
  const selected = selectToolkitConnection(input.operation, exact, identity);
  if (selected.kind !== 'resolved') return blocked();
  const connection = relevant.find((candidate) => candidate.connectionId === selected.connectionId);
  if (!connection) return blocked();
  // A current quote can refer back to work without repeating its account. A
  // same-identity nomination must not hide the host's checked earlier choice.
  // This does not repair invented quotes or borrow a different account's route.
  if (nomination && source.text.includes(nomination.source_quote)
    && latest !== 'conflict' && latest?.identity === identity) established = latest;
  const sourceQuote = established?.sourceQuote ?? nomination?.source_quote ?? null;
  const origin = defaultMode ? source : established
    ? acceptedSource(established.sourceSessionId, established.sourceUserSeq) : (() => {
    if (source.text.includes(sourceQuote!)) return source;
    // A model may cite earlier accepted user wording after a retry/branch.
    // Only validated conversation ancestry is eligible; the judge below must
    // independently establish both that selection and current continuity.
    const sessions = [input.sessionId, ...sameConversationAncestorSessionIds({ sessionId: input.sessionId, principalId })];
    const candidates = sessions.flatMap(sessionId => listEvents(sessionId,
      { types: ['user_input_received'], limit: 64, desc: true }))
      .filter(event => event.seq < input.sourceUserSeq && event.role === 'user')
      .sort((a, b) => b.seq - a.seq);
    for (const event of candidates) {
      const prior = acceptedSource(event.sessionId, event.seq);
      if (prior?.text.includes(sourceQuote!)) return prior;
    }
    return null;
  })();
  if (!origin || (sourceQuote !== null && !origin.text.includes(sourceQuote))) return blocked(sourceQuote !== null ? 'quote_not_in_source' : undefined);
  if (established?.checkedForSourceUserSeq === input.sourceUserSeq
    && established.checkedForSourceDigest === source.digest) {
    return { kind: 'resolved', connection, evidence: established };
  }
  const interveningAcceptedSources = interveningSources({
    sessionId: input.sessionId, principalId, originSeq: defaultMode ? 0 : origin.seq, currentSeq: source.seq,
  });
  if (!interveningAcceptedSources) return blocked();
  const mode = defaultMode ? 'current_source_default' : 'explicit_selection';
  const connectionRevision = digest(JSON.stringify(relevant.map((candidate) => ({
    id: candidate.connectionId, identity: identityOf(candidate), status: candidate.status,
  })).sort((a, b) => a.id.localeCompare(b.id))));
  const subject = {
    mode, connectionRevision,
    sessionId: input.sessionId, principalId, sourceUserSeq: input.sourceUserSeq,
    sourceDigest: source.digest, toolkit, identity, sourceQuote,
    nominatedSourceQuote: nomination?.source_quote ?? null,
    sourceSessionId: origin.sessionId, originSourceUserSeq: origin.seq,
    establishedSourceDigest: origin.digest,
    interveningAcceptedSources,
  };
  const proposalDigest = digest(JSON.stringify(subject));
  // The user may be answering the host's OWN account question. When this
  // source consumed a clarification whose options carry the connected
  // identities, the judge sees the question, its labeled options and the
  // answer — "the Scorpion one" or "my default" then entails an identity the
  // bare answer never names. Routing evidence only; the judge still decides.
  const clarification = consumedAccountClarification(input.sessionId, input.sourceUserSeq, source.text);
  const result = await judge({
    purpose: 'turn_semantics_account_selection',
    ...(clarification ? { clarification } : {}),
    mode,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedText: source.text,
    sourceQuote: nomination?.source_quote ?? sourceQuote,
    toolkit,
    accountIdentity: identity,
    accountLabel: aliasLabelFor(toolkit, emailOf(connection) || undefined, connection.connectionId)
      ?? connection.accountLabel ?? connection.alias ?? null,
    establishedSource: origin.seq !== input.sourceUserSeq
      ? { acceptedText: origin.text, sourceQuote: sourceQuote!, previouslyChecked: established !== null } : null,
    interveningAcceptedSources,
    proposalDigest,
  }, connectionRevision);
  if (!result) return { kind: 'account_selection_required', choices, reason: 'review_unavailable' };
  if (result.verdict !== (defaultMode ? 'default_compatible' : 'entailed')
    || result.proposalDigest !== proposalDigest || !result.modelIdentity.trim()) return blocked('not_entailed');
  if (defaultMode) return { kind: 'resolved', connection, evidence: {
    version: 2, selectionKind: 'current_source_default', sessionId: input.sessionId, principalId, toolkit, identity,
    sourceSessionId: input.sessionId, sourceUserSeq: source.seq, sourceQuote: null, sourceDigest: source.digest,
    checkedForSourceUserSeq: source.seq, checkedForSourceDigest: source.digest,
    connectionRevision, judgeModelIdentity: result.modelIdentity,
  } };
  return { kind: 'resolved', connection, evidence: {
    version: 1, sessionId: input.sessionId, principalId, toolkit, identity,
    sourceSessionId: origin.sessionId, sourceUserSeq: origin.seq,
    sourceQuote: sourceQuote!, sourceDigest: origin.digest,
    checkedForSourceUserSeq: input.sourceUserSeq,
    checkedForSourceDigest: source.digest,
    judgeModelIdentity: result.modelIdentity,
  } };
}
