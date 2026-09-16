/** Model-nominated account routing, checked against accepted source and live
 * identities. This supplies a route, never consent or execution authority. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getSession, listEvents } from '../runtime/harness/eventlog.js';
import { sameConversationAncestorSessionIds } from '../runtime/harness/accepted-source-session-branch.js';
import { adoptedSteerNotesForSource, objectiveWithAdoptedSteering } from '../runtime/harness/steer-notes.js';
import { peekTurnSemanticModelPort } from '../runtime/semantic-boundary/turn-semantic-port-registry.js';
import type { SourceAccountJudgeCall, SourceAccountJudgeResult } from '../runtime/semantic-boundary/turn-semantic-model-port.js';
import { readConsumedTaskContinuityPacket } from '../memory/task-continuity.js';
import { aliasLabelFor, listAccountAliases, resolveAccountAlias, rememberAccountAlias } from '../memory/account-alias-store.js';
import { selectToolkitConnection, type listUsableConnectedToolkits } from '../integrations/composio/client.js';
import { structuralDestinationPosture } from '../runtime/harness/external-capability-risk.js';
import pino from 'pino';

const logger = pino({ name: 'source-account-routing' });

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
      /** Human label per choice (account label, alias, or email) so the model
       *  and the host's own question can say "Scorpion (brett@…)" instead of
       *  an opaque connection id. */
      labels?: Readonly<Record<string, string>>;
      /** Why the nominated account was not bound. Surfaced to the model so
       *  the next hop is a precise question to the user, never a blind retry
       *  (live 2026-09-08: three identical refusals with no reason). */
      reason?: 'review_unavailable' | 'not_entailed' | 'quote_not_in_source';
    }
  | { kind: 'resolved'; connection: Connection; evidence: SourceAccountRoutingEvidence };

/** The alias label under which an answered "which account?" for a READ is
 *  remembered, so the same question is never asked twice for that toolkit. */
export const READ_DEFAULT_ACCOUNT_LABEL = 'default read account';
/** The alias label under which an answered "which account should send?" for a
 *  WRITE is remembered. Unlike the read default it never routes by itself:
 *  the account judge reviews the current wording against it (2026-09-14:
 *  the owner answered "Scorpion" for invites three times in four days). */
export const SEND_DEFAULT_ACCOUNT_LABEL = 'default send account';
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const emailOf = (connection: Connection): string => String(connection.accountEmail ?? '')
  .trim().toLowerCase().replace(/^smtp:/, '');
const identityOf = (connection: Connection): string => emailOf(connection) || connection.connectionId;
const toolkit = (connection: Connection): string => String(connection.slug ?? '').trim().toLowerCase();
export function accountChoiceLabels(connections: readonly Connection[]): Readonly<Record<string, string>> {
  const labels: Record<string, string> = {};
  for (const connection of connections) {
    const identity = identityOf(connection);
    // A label the user gave this account (the alias store) beats the
    // provider's own; the provider's beats the email; the id is last.
    // A CHOICE MUST BE ANSWERABLE. Precedence: the name Clem already
    // remembered for this account, then the name the user gave the connection
    // at the provider, then the provider's own label, then the email, then
    // the provider's stable human handle. The raw connection id is LAST, and
    // only when nothing else exists — live 2026-09-09 a user was asked to pick
    // between three ca_******** ids for their own mailboxes, answered "the
    // work one" in plain English, and was asked the same question again.
    // First NON-EMPTY wins: `??` would stop at an empty-string email and fall
    // straight to the id, which is exactly the unanswerable question.
    const label = aliasLabelFor(toolkit(connection), emailOf(connection) || undefined, connection.connectionId)
      ?? [
        connection.accountLabel,
        connection.alias,
        emailOf(connection),
        connection.accountName,
        connection.wordId,
      ].map((value) => String(value ?? '').trim()).find(Boolean)
      ?? connection.connectionId;
    if (!labels[identity]) labels[identity] = label;
  }
  return Object.freeze(labels);
}
function acceptedSource(sessionId: string, seq: number) {
  const event = listEvents(sessionId, { sinceSeq: seq - 1, types: ['user_input_received'], limit: 1 })[0];
  if (!event || event.seq !== seq || event.role !== 'user') return null;
  const display = typeof event.data.displayText === 'string' ? event.data.displayText : '';
  const original = display || (typeof event.data.text === 'string' ? event.data.text : '');
  if (!original.trim()) return null;
  // Account routing must see the same delivered owner corrections as the
  // running brain. Binding the digest to those notes also invalidates a cached
  // route when the owner changes the selection. Queued notes and notes from a
  // different accepted source are excluded by the shared adoption contract.
  const text = objectiveWithAdoptedSteering(original, adoptedSteerNotesForSource({ sessionId, sourceUserSeq: seq }));
  return { sessionId, seq, text, digest: digest(text) };
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
  if (!port?.judgeAccountSelection) {
    logger.warn({ toolkit: call.toolkit, purpose: call.purpose, portInstalled: Boolean(port) },
      'account-routing review has no semantic model port for this turn; the selection is reported review_unavailable');
    return null;
  }
  let cache = judgments.get(port);
  if (!cache) { cache = new Map(); judgments.set(port, cache); }
  const key = digest(JSON.stringify({ call, connectionRevision }));
  let pending = cache.get(key);
  if (!pending) {
    pending = port.judgeAccountSelection(call);
    cache.set(key, pending);
    if (cache.size > 256) cache.delete(cache.keys().next().value!);
  }
  try {
    return await pending;
  } catch (error) {
    // A failed review must not be remembered as the answer: the next identical
    // selection re-runs the judge instead of replaying the rejection (live
    // 2026-09-08: "retry the identical account_selection once" could never
    // succeed because the rejected promise sat in this cache). And SAY WHY —
    // a silent null became four "review_unavailable" refusals and a dead turn.
    cache.delete(key);
    logger.warn({
      err: error,
      toolkit: call.toolkit,
      accountIdentity: call.accountIdentity,
      purpose: call.purpose,
    }, 'account-routing review failed — the judge model call threw; the selection is reported review_unavailable');
    return null;
  }
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
    const defaultIdentities = new Set<string>();
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
        defaultIdentities.add(route.identity);
      } else if (origin.text.includes(route.sourceQuote)) found.set(route.identity, route);
    }
    // Conflicting identities at the newest checked source never fall through
    // to an older convenient account. A checked default and an explicit route
    // that name the SAME account are one selection, not a conflict: a read
    // routed on the owner's words and a write reviewed against the remembered
    // default both land in the same mailbox (live 2026-09-15 23:14, a Drafts
    // read beside a draft create at one source made the next write ask).
    if (checkedDefault) {
      const others = [...found.keys()].filter(identity => !defaultIdentities.has(identity));
      if (others.length > 0 || defaultIdentities.size > 1) return 'conflict';
      return null;
    }
    if (found.size > 0) return found.size === 1 ? [...found.values()][0]! : 'conflict';
  }
  return null;
}

/** True when this accepted source consumed a continuity packet — the user was
 *  answering a question (the host's labeled one, or the model's own ask).
 *  Live 2026-09-08: the model asked "which mailbox?" itself; the answer routed
 *  the read but was not remembered because only the host's packet kind was. */
function sourceAnsweredAQuestion(sessionId: string, sourceUserSeq: number): boolean {
  try {
    const consumed = readConsumedTaskContinuityPacket({ sessionId, consumingSourceUserSeq: sourceUserSeq });
    return consumed.status === 'consumed';
  } catch {
    return false;
  }
}

/** The semantic port records a chosen option as `opt-N` (1-based). The judge
 * reads options by wording, so hand it the label the user actually chose.
 * Live 2026-09-14: "opt-2" hid "Send Adam an invite from my Scorpion calendar"
 * from the account judge, which then could not entail the Scorpion account. */
export function clarificationSelectedOptionLabel(
  selectedOption: string | null | undefined,
  options: readonly string[],
): string | null {
  const raw = typeof selectedOption === 'string' ? selectedOption.trim() : '';
  if (!raw) return null;
  if (options.includes(raw)) return raw;
  const ordinal = /^opt-(\d{1,3})$/.exec(raw);
  if (ordinal) {
    const label = options[Number(ordinal[1]) - 1];
    return typeof label === 'string' && label.trim() ? label : null;
  }
  return raw;
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
      selectedOption: resolution.disposition === 'selected'
        ? clarificationSelectedOptionLabel(resolution.selectedOption, options)
        : null,
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
  /** The operation's effect class. A READ never waits on the cross-family
   *  judge: a nominated or established identity routes directly, and only a
   *  write keeps the source-versus-recipient review. */
  effect?: 'read' | 'write';
}): Promise<SourceAccountRoutingResolution> {
  const toolkit = input.toolkit.trim().toLowerCase();
  let relevant = input.connections.filter((connection) => connection.slug.trim().toLowerCase() === toolkit
    && /^(?:active|enabled|initiated)$/i.test(connection.status ?? ''));
  // LEARN WHO THESE ACCOUNTS ARE BEFORE ASKING WHICH ONE.
  //
  // The provider's connection listing often carries no email at all, so a
  // choice between several accounts was posed as raw connection ids — which
  // nobody can answer about their own mailboxes (live 2026-09-09: the user
  // replied "my work mailbox, the scorpion.co one" and was asked the same
  // question again). The one-time identity probe already existed but only ran
  // on the direct Composio execution path, and it is skipped for a PREPARED
  // execution — which is the path a planned write takes, so a planned write
  // could never learn the identities it was about to ask about.
  //
  // Probe here too: bounded to the unidentified candidates, attempted once per
  // connection and cached durably, and entirely failure-tolerant — if the
  // probe cannot run we simply ask with whatever label we already have.
  if (relevant.length > 1 && relevant.some((connection) => !emailOf(connection))) {
    try {
      const [{ enrichToolkitIdentities }, { cachedIdentityEmail }] = await Promise.all([
        import('./composio-tools.js'),
        import('../integrations/composio/identity-cache.js'),
      ]);
      if (await enrichToolkitIdentities(toolkit, [...relevant] as never) > 0) {
        relevant = relevant.map((connection) => (emailOf(connection)
          ? connection
          : { ...connection, accountEmail: cachedIdentityEmail(connection.connectionId) ?? connection.accountEmail }));
      }
    } catch {
      // An unreachable provider must never turn a choice into a failed turn.
    }
  }
  const choices = [...new Set(relevant.map(identityOf))];
  const blocked = (
    reason?: 'not_entailed' | 'quote_not_in_source',
  ): SourceAccountRoutingResolution => ({
    kind: 'account_selection_required',
    choices,
    // EVERY blocked path carries labels, not just the review-unavailable one
    // below: an option list is only answerable if it says who each account is.
    labels: accountChoiceLabels(relevant),
    ...(reason ? { reason } : {}),
  });
  const source = acceptedSource(input.sessionId, input.sourceUserSeq);
  const session = getSession(input.sessionId);
  if (!source || !session) return blocked();
  const principalId = session.userId || session.id;
  const supplied = input.nomination && input.nomination.toolkit.trim().toLowerCase() === toolkit
    ? SourceAccountNominationSchema.safeParse(input.nomination)
    : null;
  if (supplied && !supplied.success) return blocked();
  // A MODEL-SUPPLIED IDENTITY IS A HINT, NOT EVIDENCE.
  //
  // Provenance is the whole distinction. A durable alias, the owner's own
  // words, a reply to an offered choice, and Tool Memory are all things the
  // OWNER established. `account_selection.identity` invented by the model
  // in-turn is none of them — and when it names no live connected identity for
  // this toolkit, it is a guess about the owner's connections that the owner
  // never made. Promoting it into a blocked selection converts "the model
  // guessed wrong" into "the account this action expects is gone", which is a
  // false claim about what is connected AND an unanswerable question when
  // there was no choice to make in the first place.
  //
  // Live 2026-09-11: googledocs had exactly ONE active connection
  // (`ca_P57D3YdQqviX`) carrying no email identity at all, so no email could
  // ever have matched it. The model nominated an address it had invented,
  // quoting only the pasted document URL, and the owner's own document went
  // unread behind an account question with a single opaque option.
  //
  // So: discard the guess and resolve exactly as if none had been offered —
  // one connected account resolves, several still ask. This loosens NOTHING.
  // The entailment check below is untouched and still refuses to bind an
  // account the accepted wording does not name; a nomination that MATCHES a
  // live identity still earns its full review. Discarding only ever lands on
  // the same route a null nomination would have taken.
  // Two things have to be true before a nomination is discarded, and the
  // second is what keeps a REMOVED account honest. An account the owner named
  // that has since been disconnected is still the owner's choice: falling back
  // to whatever else is connected would operate as a different identity than
  // the one they asked for, which is the whole mistake this guard prevents.
  // So a nomination is discarded ONLY when it names nothing live AND the
  // owner's own words never named it either — model invention with no
  // counterpart in the conversation and none among the connections.
  const nominatedIdentity = supplied?.success ? supplied.data.identity.trim() : '';
  const nominationNamesALiveIdentity = supplied?.success
    && relevant.some((connection) => connection.connectionId === nominatedIdentity
      || emailOf(connection) === nominatedIdentity.toLowerCase());
  const ownersWordsNameTheIdentity = supplied?.success
    && nominatedIdentity.length > 0
    && (source.text.toLowerCase().includes(nominatedIdentity.toLowerCase())
      || supplied.data.source_quote.toLowerCase().includes(nominatedIdentity.toLowerCase()));
  let nomination = supplied?.success
    && (nominationNamesALiveIdentity || ownersWordsNameTheIdentity)
    ? supplied.data
    : null;
  // THE REMEMBERED DEFAULT FOR A WRITE: the send default the owner answered
  // with, or — when none was ever asked — the read default. A draft, an
  // event, a note lands in the store the owner reads from; only the judge's
  // review of the current wording, never the host, binds it.
  const matchRemembered = (label: string): Connection | null => {
    const remembered = resolveAccountAlias(label, toolkit);
    return remembered ? relevant.find((connection) => (
      (remembered.connectionId && connection.connectionId === remembered.connectionId)
      || (remembered.email && emailOf(connection) === remembered.email.toLowerCase())
    )) ?? null : null;
  };
  const rememberedSendDefault = input.effect !== 'read' && choices.length !== 1
    ? matchRemembered(SEND_DEFAULT_ACCOUNT_LABEL)
    : null;
  const rememberedForWrite = input.effect !== 'read' && choices.length !== 1
    ? rememberedSendDefault ?? matchRemembered(READ_DEFAULT_ACCOUNT_LABEL)
    : null;
  const nominatesSendDefault = Boolean(nomination && rememberedSendDefault && (
    rememberedSendDefault.connectionId === nomination.identity.trim()
    || emailOf(rememberedSendDefault) === nomination.identity.trim().toLowerCase()
  ));
  // A nomination that merely repeats the remembered default is the owner's
  // established choice, not a new explicit selection: review it as the
  // default (the judge sees the remembered preference) instead of demanding
  // that the current wording name the account.
  if (nomination && rememberedForWrite && (
    rememberedForWrite.connectionId === nomination.identity.trim()
    || emailOf(rememberedForWrite) === nomination.identity.trim().toLowerCase()
  )) nomination = null;
  const latest = newestEstablishedRoute({ ...input, principalId, toolkit });
  if (!nomination && latest === 'conflict') return blocked();
  let established = !nomination && latest !== 'conflict' ? latest : null;
  const connectionRevision = digest(JSON.stringify(relevant.map((candidate) => ({
    id: candidate.connectionId, identity: identityOf(candidate), status: candidate.status,
  })).sort((a, b) => a.id.localeCompare(b.id))));
  // THE OWNER'S OWN ANSWER, ECHOED. The send default is the account the owner
  // named when the host asked "which account should send?". A nomination that
  // repeats it is agreement with that standing answer, not a selection the
  // current wording must justify, so the host resolves it — unless the wording
  // names a different connected account of this toolkit by its address or its
  // recorded alias label (recorded data, never a reading of the prose); then
  // the judge reviews the wording exactly as before. The write itself still
  // meets its own gate; this binds only which mailbox it is addressed to.
  if (nominatesSendDefault && rememberedSendDefault
    && !namesAnotherConnectedAccount(source.text, relevant, rememberedSendDefault, toolkit)) {
    return { kind: 'resolved', connection: rememberedSendDefault, evidence: {
      version: 2, selectionKind: 'current_source_default', sessionId: input.sessionId, principalId, toolkit,
      identity: identityOf(rememberedSendDefault),
      sourceSessionId: input.sessionId, sourceUserSeq: source.seq, sourceQuote: null, sourceDigest: source.digest,
      checkedForSourceUserSeq: source.seq, checkedForSourceDigest: source.digest,
      connectionRevision, judgeModelIdentity: 'host:send_default_nominated',
    } };
  }
  const defaultMode = !nomination && !established;
  let rememberedSend: Connection | null = null;
  if (defaultMode && choices.length !== 1) {
    // NOTHING WAS LEARNED was the gap: after the host's own "which account?"
    // she asked again next conversation. For a READ, the answer the user gave
    // once is this toolkit's remembered default; use it and say so.
    if (input.effect === 'read') {
      const remembered = resolveAccountAlias(READ_DEFAULT_ACCOUNT_LABEL, toolkit);
      const match = remembered ? relevant.find((connection) => (
        (remembered.connectionId && connection.connectionId === remembered.connectionId)
        || (remembered.email && emailOf(connection) === remembered.email.toLowerCase())
      )) : undefined;
      if (match) {
        return { kind: 'resolved', connection: match, evidence: {
          version: 2, selectionKind: 'current_source_default', sessionId: input.sessionId, principalId, toolkit,
          identity: identityOf(match),
          sourceSessionId: input.sessionId, sourceUserSeq: source.seq, sourceQuote: null, sourceDigest: source.digest,
          checkedForSourceUserSeq: source.seq, checkedForSourceDigest: source.digest,
          connectionRevision, judgeModelIdentity: 'host:read_default',
        } };
      }
    }
    // A WRITE with a remembered send default is not asked again either — but
    // it is not bound by the host: the judge below reviews the current
    // wording against the remembered preference and can still refuse.
    if (input.effect !== 'read') {
      rememberedSend = matchRemembered(SEND_DEFAULT_ACCOUNT_LABEL);
      // A write that CHANGES AN EXISTING record (update/delete — the
      // operation's own posture, never the request's wording) has no account
      // preference to ask about: the record lives where it is read from, so
      // the toolkit's remembered read account is where it is changed. A wrong
      // guess is a provider "not found", never a misdirected send. Live
      // 2026-09-15: an event edit was disclosed account_selection_required with
      // the read default on file, and the model asked about wording instead.
      if (!rememberedSend && structuralDestinationPosture(input.operation) === 'named_existing') {
        const readDefault = resolveAccountAlias(READ_DEFAULT_ACCOUNT_LABEL, toolkit);
        const match = readDefault ? relevant.find((connection) => (
          (readDefault.connectionId && connection.connectionId === readDefault.connectionId)
          || (readDefault.email && emailOf(connection) === readDefault.email.toLowerCase())
        )) : undefined;
        if (match) {
          return { kind: 'resolved', connection: match, evidence: {
            version: 2, selectionKind: 'current_source_default', sessionId: input.sessionId, principalId, toolkit,
            identity: identityOf(match),
            sourceSessionId: input.sessionId, sourceUserSeq: source.seq, sourceQuote: null, sourceDigest: source.digest,
            checkedForSourceUserSeq: source.seq, checkedForSourceDigest: source.digest,
            connectionRevision, judgeModelIdentity: 'host:read_default_named_existing',
          } };
        }
      }
    }
    // No send default was ever answered: the read default is where the
    // owner's own store lives. Reviewed by the judge below like a send
    // default; a wording that names another account still conflicts.
    if (!rememberedSend) rememberedSend = rememberedForWrite;
    if (!rememberedSend) return blocked();
  }
  const proposedIdentity = nomination?.identity.trim() ?? established?.identity
    ?? (rememberedSend ? identityOf(rememberedSend) : choices[0]!);
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
  const subject = {
    mode, connectionRevision,
    sessionId: input.sessionId, principalId, sourceUserSeq: input.sourceUserSeq,
    sourceDigest: source.digest, toolkit, identity, sourceQuote,
    nominatedSourceQuote: nomination?.source_quote ?? null,
    sourceSessionId: origin.sessionId, originSourceUserSeq: origin.seq,
    establishedSourceDigest: origin.digest,
    interveningAcceptedSources,
  };
  // With one live connected identity there is no account choice to review.
  // The accepted source and current connection revision still bind the read;
  // writes continue through the existing account-review path below.
  if (input.effect === 'read' && defaultMode) {
    return { kind: 'resolved', connection, evidence: {
      version: 2, selectionKind: 'current_source_default', sessionId: input.sessionId, principalId, toolkit, identity,
      sourceSessionId: input.sessionId, sourceUserSeq: source.seq, sourceQuote: null, sourceDigest: source.digest,
      checkedForSourceUserSeq: source.seq, checkedForSourceDigest: source.digest,
      connectionRevision, judgeModelIdentity: 'host:read_single_account',
    } };
  }
  // READS DO NOT WAIT ON THE JUDGE. Reading the wrong calendar is visible and
  // correctable; sending from the wrong identity is not. Live 2026-09-08: a
  // one-call calendar read died because the judge role (a separate model with
  // its own sign-in) failed four times. For a read, a nomination that names an
  // exact connected identity — or the conversation's established route — is
  // the route. The result discloses the account so the user can correct it.
  if (input.effect === 'read' && !defaultMode && origin) {
    if (sourceAnsweredAQuestion(input.sessionId, input.sourceUserSeq)) {
      // The user just answered "which account?" — remember it for reads.
      try {
        rememberAccountAlias({ toolkit, label: READ_DEFAULT_ACCOUNT_LABEL, email: emailOf(connection) || undefined, connectionId: connection.connectionId });
      } catch { /* memory is a convenience, never a gate */ }
    }
    return { kind: 'resolved', connection, evidence: {
      version: 1, sessionId: input.sessionId, principalId, toolkit, identity,
      sourceSessionId: origin.sessionId, sourceUserSeq: origin.seq,
      sourceQuote: sourceQuote ?? '', sourceDigest: origin.digest,
      checkedForSourceUserSeq: input.sourceUserSeq,
      checkedForSourceDigest: source.digest,
      judgeModelIdentity: 'host:read_route',
    } };
  }
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
    ...(rememberedSend
      ? { rememberedDefault: { identity, label: aliasLabelFor(toolkit, emailOf(rememberedSend) || undefined, rememberedSend.connectionId) ?? null } }
      : {}),
    mode,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedText: source.text,
    sourceQuote: nomination?.source_quote ?? sourceQuote,
    toolkit,
    accountIdentity: identity,
    accountLabel: aliasLabelFor(toolkit, emailOf(connection) || undefined, connection.connectionId)
      ?? [connection.accountLabel, connection.alias, connection.accountName, connection.wordId]
        .map((value) => String(value ?? '').trim()).find(Boolean)
      ?? null,
    establishedSource: origin.seq !== input.sourceUserSeq
      ? { acceptedText: origin.text, sourceQuote: sourceQuote!, previouslyChecked: established !== null } : null,
    interveningAcceptedSources,
    proposalDigest,
  }, connectionRevision);
  if (!result) return { kind: 'account_selection_required', choices, labels: accountChoiceLabels(relevant), reason: 'review_unavailable' };
  if (result.verdict !== (defaultMode ? 'default_compatible' : 'entailed')
    || result.proposalDigest !== proposalDigest || !result.modelIdentity.trim()) return blocked('not_entailed');
  if (defaultMode) return { kind: 'resolved', connection, evidence: {
    version: 2, selectionKind: 'current_source_default', sessionId: input.sessionId, principalId, toolkit, identity,
    sourceSessionId: input.sessionId, sourceUserSeq: source.seq, sourceQuote: null, sourceDigest: source.digest,
    checkedForSourceUserSeq: source.seq, checkedForSourceDigest: source.digest,
    connectionRevision, judgeModelIdentity: result.modelIdentity,
  } };
  if (sourceAnsweredAQuestion(input.sessionId, input.sourceUserSeq)) {
    // The user just answered "which account should send?" and the judge
    // entailed it. Remember the preference; the judge still reviews next time.
    try {
      rememberAccountAlias({ toolkit, label: SEND_DEFAULT_ACCOUNT_LABEL, email: emailOf(connection) || undefined, connectionId: connection.connectionId });
    } catch { /* memory is a convenience, never a gate */ }
  }
  return { kind: 'resolved', connection, evidence: {
    version: 1, sessionId: input.sessionId, principalId, toolkit, identity,
    sourceSessionId: origin.sessionId, sourceUserSeq: origin.seq,
    sourceQuote: sourceQuote!, sourceDigest: origin.digest,
    checkedForSourceUserSeq: input.sourceUserSeq,
    checkedForSourceDigest: source.digest,
    judgeModelIdentity: result.modelIdentity,
  } };
}

/** True when the accepted wording names a connected account of this toolkit
 *  other than `chosen`: by its address, or by an alias label the owner recorded
 *  for it. Reserved default labels are not names. Recorded identifiers only. */
function namesAnotherConnectedAccount(
  text: string,
  connections: readonly Connection[],
  chosen: Connection,
  toolkit: string,
): boolean {
  const haystack = text.toLowerCase();
  const chosenIdentity = identityOf(chosen);
  const reserved = new Set([SEND_DEFAULT_ACCOUNT_LABEL, READ_DEFAULT_ACCOUNT_LABEL].map((label) => label.toLowerCase()));
  const aliases = listAccountAliases(toolkit);
  for (const connection of connections) {
    if (identityOf(connection) === chosenIdentity) continue;
    const email = emailOf(connection);
    if (email && haystack.includes(email.toLowerCase())) return true;
    const labels = aliases
      .filter((alias) => (alias.connectionId && alias.connectionId === connection.connectionId)
        || (alias.email && email && alias.email.toLowerCase() === email.toLowerCase()))
      .map((alias) => alias.label.trim().toLowerCase())
      .filter((label) => label.length >= 3 && !reserved.has(label));
    if (labels.some((label) => haystack.includes(label))) return true;
  }
  return false;
}
