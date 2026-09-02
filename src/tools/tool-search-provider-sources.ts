import { createHash } from 'node:crypto';
import {
  mcpToolScopeAuthority,
  type McpToolScope,
} from '../runtime/mcp-tool-scope.js';
import {
  getOrCreateExternalMcpServers,
  resolveAuthorizedExternalMcpToolDefinition,
} from '../runtime/mcp-servers.js';
import {
  canonicalMcpToolIdentity,
  mcpServerAliasMatches,
  mcpToolAllowedByScope,
  stripMcpToolCarrier,
} from '../runtime/mcp-tool-authority.js';
import {
  searchComposioBrokerCandidates,
  type ComposioBrokerCandidate,
} from './composio-tools.js';
import { searchCapabilityOperations } from '../memory/capability-index.js';
import { requestedCapabilityEffectScope } from '../memory/capability-effect-scope.js';
import {
  aliasLabelFor,
  resolveAccountAlias,
} from '../memory/account-alias-store.js';
import {
  composioToolOperationVersion,
  composioToolSchemaObservedAt,
  getExactComposioToolsBySlugs,
  listUsableConnectedToolkits,
  selectToolkitConnection,
} from '../integrations/composio/client.js';
import {
  liveComposioOperationVersion,
  liveComposioOutputSchema,
  liveComposioSchemaFingerprint,
  rememberToolSchema,
} from './composio-schema-cache.js';
import { digestSchema, fingerprintSchema } from './tool-contract-store.js';
import {
  isRegisteredToolkitSlug,
  registeredToolkitOfSlug,
} from '../integrations/composio/toolkit-slug.js';
import { classifyComposioSlugEffect } from '../integrations/composio/slug-effect.js';
import {
  recallComposioAccountIdentity,
  recallComposioForSearch,
  type RememberedComposioMatch,
} from '../memory/tool-choice-store.js';
import {
  recordAdmissionCapabilityResolution,
  type CapabilityResolutionEntry,
} from '../runtime/harness/capability-resolution.js';
import { registerProofProvisionedCapabilities } from '../runtime/harness/proof-provisioned-catalog.js';
import { verifiedReadOriginIsCanonical } from '../runtime/read-path/verified-read-origin-authority.js';
import { listEvents } from '../runtime/harness/eventlog.js';
import {
  createProductionLiveReadAcquisitionRegistry,
  createProductionReviewedCliLiveReadAcquisitionAdapter,
  type ProductionLiveReadCarrierAdapterV1,
  type ProductionLiveReadNominationV1,
} from '../runtime/harness/production-live-read-acquisition-registry.js';
import { listReviewedCliReadDescriptors } from '../runtime/harness/reviewed-cli-read-config.js';
import { CLI_CATALOG, readConnectedClis } from '../integrations/cli-catalog/catalog.js';
import {
  AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE,
  issueAuthorizedLiveReadPlanningAuthority,
} from '../runtime/harness/live-read-planning-authority.js';
import {
  attachToolSearchSelectedAccountEvidence,
  CandidateSourceUnavailableError,
  TOOL_SEARCH_TOTAL_DEADLINE_MS,
} from './tool-search-tool.js';
import type {
  ToolSearchCandidateSource,
  ToolSearchBrokerCandidate,
  ToolSearchPlanningBlocker,
  ToolSearchPlanningDisclosureCandidate,
} from './tool-search-tool.js';

function boundedRank(index: number, count: number): number {
  return Math.max(0, 1 - (index / Math.max(1, count)));
}

/**
 * A connected catalog CLI with a reviewed read may replace that vendor's
 * Composio *reads* in discovery. The reviewed descriptor is read-only, so a
 * write must never be dropped, and a read is only demoted when the replacement
 * is actually provisioned (OPEN-THE-GATES Slice 5).
 */
export function composioToolkitOverlapsReviewedCliRead(toolkit: string): boolean {
  const needle = toolkit.trim().toLowerCase();
  if (!needle) return false;
  const connected = readConnectedClis();
  return CLI_CATALOG.some((entry) => (
    Boolean(entry.reviewedRead)
    && Boolean(connected[entry.id])
    && (
      entry.id.toLowerCase() === needle
      || entry.tags.some((tag) => tag.toLowerCase() === needle)
    )
  ));
}

export function reviewedCliReplacementIsReachable(toolkit: string): boolean {
  const needle = toolkit.trim().toLowerCase();
  if (!needle) return false;
  const entry = CLI_CATALOG.find((candidate) => (
    Boolean(candidate.reviewedRead)
    && (
      candidate.id.toLowerCase() === needle
      || candidate.tags.some((tag) => tag.toLowerCase() === needle)
    )
  ));
  const reviewed = entry?.reviewedRead;
  if (!reviewed) return false;
  return listReviewedCliReadDescriptors().some((descriptor) => (
    descriptor.descriptorId === reviewed.descriptorId
    || descriptor.operationId === reviewed.operationId
  ));
}

export type ComposioReviewedCliDiscoveryDisposition = 'keep' | 'demote';

export function composioDiscoveryDispositionAgainstReviewedCli(input: {
  toolkit: string;
  slug: string;
}): ComposioReviewedCliDiscoveryDisposition {
  if (!composioToolkitOverlapsReviewedCliRead(input.toolkit)) return 'keep';
  if (classifyComposioSlugEffect(input.slug) !== 'read') return 'keep';
  if (!reviewedCliReplacementIsReachable(input.toolkit)) return 'keep';
  return 'demote';
}

/** @deprecated Slice 5: suppression is effect-scoped. Prefer
 * `composioDiscoveryDispositionAgainstReviewedCli`. A toolkit-only call can
 * no longer drop writes. */
export function composioToolkitSuppressedByReviewedCliRead(
  toolkit: string,
  slug?: string,
): boolean {
  if (!slug) return false;
  return composioDiscoveryDispositionAgainstReviewedCli({ toolkit, slug }) === 'demote';
}

function composioDiscoveryScore(base: number, toolkit: string, slug: string): number {
  return composioDiscoveryDispositionAgainstReviewedCli({ toolkit, slug }) === 'demote'
    ? base - 0.75
    : base;
}

function createReviewedCliOnlyLiveReadRegistry(options: {
  adapterAllowed?: (
    adapter: Readonly<Pick<ProductionLiveReadCarrierAdapterV1, 'adapterId' | 'carrier'>>,
  ) => boolean;
  nominationAllowed?: (nomination: Readonly<ProductionLiveReadNominationV1>) => boolean;
}) {
  if (listReviewedCliReadDescriptors().length === 0) return null;
  return createProductionLiveReadAcquisitionRegistry({
    configuredAdapters: () => [createProductionReviewedCliLiveReadAcquisitionAdapter()],
    ...(options.adapterAllowed ? { adapterAllowed: options.adapterAllowed } : {}),
    ...(options.nominationAllowed ? { nominationAllowed: options.nominationAllowed } : {}),
  });
}

type BoundedAwaitOutcome<T> =
  | { kind: 'settled'; value: T }
  | { kind: 'failed'; error: unknown }
  | { kind: 'expired' };

/** A timeout/cancellation may stop awaiting provider I/O, but cannot assume
 * the provider promise itself stopped. Attach both settlement handlers before
 * racing so a late rejection is consumed, then make every authority-changing
 * continuation check the same guard. */
async function awaitBounded<T>(input: {
  start: () => Promise<T>;
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<BoundedAwaitOutcome<T>> {
  if (input.signal?.aborted) return { kind: 'expired' };
  if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) {
    return { kind: 'expired' };
  }
  let work: Promise<T>;
  try {
    work = input.start();
  } catch (error) {
    return { kind: 'failed', error };
  }
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish({ kind: 'expired' });
    const finish = (outcome: BoundedAwaitOutcome<T>) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    work.then(
      (value) => finish({ kind: 'settled', value }),
      (error) => finish({ kind: 'failed', error }),
    );
    input.signal?.addEventListener('abort', onAbort, { once: true });
    // Abort may have happened between the initial check and listener install.
    if (input.signal?.aborted) onAbort();
    if (!done && input.deadlineAt !== undefined) {
      timer = setTimeout(
        () => finish({ kind: 'expired' }),
        Math.max(0, input.deadlineAt - Date.now()),
      );
    }
  });
}

function discoveryStillActive(input: {
  signal?: AbortSignal;
  deadlineAt?: number;
}): boolean {
  return !input.signal?.aborted
    && (input.deadlineAt === undefined || Date.now() < input.deadlineAt);
}

/** One explicit registered Composio action is selection, not fuzzy intent.
 * Unknown namespaces and prose containing two action identities remain normal
 * fuzzy searches; neither can make token/list order choose authority. */
function exactComposioOperationFromQuery(query: string): string | null {
  const operations = new Set<string>();
  const pattern = /(?:^|[^A-Za-z0-9_])([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)(?=$|[^A-Za-z0-9_])/g;
  for (const match of query.matchAll(pattern)) {
    const operation = String(match[1] ?? '').trim().toUpperCase();
    if (!operation) continue;
    const toolkit = registeredToolkitOfSlug(operation).trim().toLowerCase();
    const normalizedToolkit = toolkit.toUpperCase();
    if (
      !isRegisteredToolkitSlug(toolkit)
      || !operation.startsWith(`${normalizedToolkit}_`)
    ) continue;
    operations.add(operation);
  }
  return operations.size === 1 ? [...operations][0]! : null;
}

/** Fast-path memory must be evidence, not merely a plausible lexical hint.
 * The accepted query must explicitly name exactly one toolkit; only a
 * canonical verified read from that toolkit may compete. At least two intent
 * anchors and one uniquely best result are required. Counters and list order
 * never select authority: ties/weak/stale origins fall through to live fuzzy
 * discovery. */
function receiptBackedRememberedWinner(
  query: string,
  matches: readonly RememberedComposioMatch[],
): RememberedComposioMatch | null {
  const queryTokens = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const namedToolkits = new Set(matches
    .map((match) => registeredToolkitOfSlug(match.slug).trim().toLowerCase())
    .filter((toolkit) => isRegisteredToolkitSlug(toolkit) && queryTokens.has(toolkit)));
  if (namedToolkits.size !== 1) return null;
  const namedToolkit = [...namedToolkits][0]!;
  const eligible = matches
    .filter((match) => (
      registeredToolkitOfSlug(match.slug).trim().toLowerCase() === namedToolkit
      && match.matched.length >= 2
      && Boolean(match.verifiedReadOrigin)
      && verifiedReadOriginIsCanonical({
        origin: match.verifiedReadOrigin!,
        identifier: match.slug,
        ...(match.accountIdentity ? { accountIdentity: match.accountIdentity } : {}),
        ...(match.schemaFingerprint ? { schemaFingerprint: match.schemaFingerprint } : {}),
      })
    ))
    .sort((left, right) => (
      right.matched.length - left.matched.length
      || left.slug.localeCompare(right.slug)
    ));
  const winner = eligible[0];
  if (!winner) return null;
  const runnerUp = eligible[1];
  if (
    runnerUp
    && runnerUp.matched.length === winner.matched.length
  ) return null;
  return winner;
}

/** An explicit namespaced operation is selection, not fuzzy breadth. Resolve
 * at most one exact identity; prose containing two names remains an ordinary
 * search and cannot make list order choose authority. */
function exactExternalMcpOperationFromQuery(query: string): string | null {
  const identities = new Set<string>();
  const pattern = /(?:^|[^A-Za-z0-9._-])((?:mcp__)?[A-Za-z0-9._-]+?__[A-Za-z0-9._-]+)(?=$|[^A-Za-z0-9._-])/g;
  for (const match of query.matchAll(pattern)) {
    const identity = canonicalMcpToolIdentity(match[1] ?? '');
    if (identity) identities.add(identity);
  }
  return identities.size === 1 ? [...identities][0]! : null;
}

const ACCOUNT_EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function normalizedAccountEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/^smtp:/, '');
}

function accountSourceMentionIsNegated(text: string, start: number): boolean {
  // Stay inside the current clause. This lets "don't use A; use B" exclude A
  // without poisoning the later positive source selection of B.
  const prefix = text.slice(Math.max(0, start - 128), start);
  return /\b(?:do\s+not|don't|never|avoid|without|except(?:\s+for)?|other\s+than|instead\s+of|rather\s+than|not)\b[^.!?;]{0,80}$/i.test(prefix);
}

/** Source-looking words inside a quotation are content, not account-routing
 * authority. Apostrophes embedded in words ("don't", "James's") are not
 * quotation delimiters. */
function accountSourceMentionIsQuoted(text: string, start: number): boolean {
  let asciiDouble = false;
  let asciiSingle = false;
  let smartDouble = false;
  let smartSingle = false;
  let backtick = false;
  for (let index = 0; index < start; index += 1) {
    const char = text[index];
    if (char === '"') asciiDouble = !asciiDouble;
    else if (char === '`') backtick = !backtick;
    else if (char === '“') smartDouble = true;
    else if (char === '”') smartDouble = false;
    else if (char === '‘') smartSingle = true;
    else if (char === '’') smartSingle = false;
    else if (char === "'") {
      const previous = text[index - 1] ?? '';
      const next = text[index + 1] ?? '';
      if (!/[a-z0-9]/i.test(previous) || !/[a-z0-9]/i.test(next)) {
        asciiSingle = !asciiSingle;
      }
    }
  }
  return asciiDouble || asciiSingle || smartDouble || smartSingle || backtick;
}

/** "James said use my Work account" reports somebody else's words. It does
 * not grant the current request source authority, even though the embedded
 * sentence has otherwise-valid first-person grammar. */
function accountSourceMentionIsReported(text: string, start: number): boolean {
  const prefix = text.slice(Math.max(0, start - 160), start);
  return (
    /\b(?:says|said|writes|wrote|asks|asked|tells|told|quotes|quoted|repeats|repeated|reported)\b[^.!?;]{0,112}$/i.test(prefix)
    || /\b(?:subject|body|text|phrase|wording|words?)\b[^.!?;]{0,64}\b(?:say|says|said|read|reads|include|includes|contain|contains)\b[^.!?;]{0,48}$/i.test(prefix)
  );
}

function accountSourceMentionCannotSelect(text: string, start: number): boolean {
  return accountSourceMentionIsNegated(text, start)
    || accountSourceMentionIsQuoted(text, start)
    || accountSourceMentionIsReported(text, start);
}

/**
 * Exact connected addresses are closed-set identities, but their grammatical
 * role still matters. An attendee/recipient may itself be one of the user's
 * connected mailboxes (the live canary invited the personal mailbox from the
 * Scorpion mailbox), so mere occurrence can never select source authority.
 */
function connectedEmailsNamedAsSource(input: {
  text: string;
  choices: readonly string[];
}): Set<string> {
  const selected = new Set<string>();
  const choiceSet = new Set(input.choices);
  for (const match of input.text.matchAll(ACCOUNT_EMAIL_RE)) {
    const email = normalizedAccountEmail(match[0]);
    if (!choiceSet.has(email)) continue;
    const start = match.index ?? 0;
    if (accountSourceMentionCannotSelect(input.text, start)) continue;
    const end = start + match[0].length;
    const before = input.text.slice(Math.max(0, start - 128), start);
    const after = input.text.slice(end, Math.min(input.text.length, end + 96));
    const sourceBefore = (
      /\b(?:from|via|through)\s+(?:(?:my|the)\s+)?(?:(?:sending|source)\s+)?(?:email|mail|mailbox|account|calendar)\s*$/i.test(before)
      // Bare "from <address>" identifies source only for an outward action.
      // In "read a message from <address>", the address is the message's
      // sender and must not silently become the user's connected account.
      || /\b(?:send|schedule|create|write|post|publish|upload|share|invite|reply|respond)\b[^.!?;]{0,96}\b(?:from|via|through)\s*$/i.test(before)
      || /\b(?:using|use)\s+(?:(?:my|the)\s+)(?:(?:sending|source)\s+)?(?:email|mail|mailbox|account|calendar)?\s*$/i.test(before)
      || /\b(?:using|use)\s+(?:(?:sending|source)\s+)?(?:email|mail|mailbox|account|calendar)\s*$/i.test(before)
      || /\b(?:(?:my|the)\s+)?(?:sender|sending|source|email|mail|mailbox|account|calendar)(?:\s+(?:email|address|account))?(?:\s+to\s+use)?\s*(?:is|=|:)\s*$/i.test(before)
      // A read explicitly scoped to an address's Inbox/mailbox also names the
      // source account. Keep this narrower than generic "for <address>": the
      // latter commonly identifies an attendee, recipient, or record target.
      || /\b(?:read|search|list|show|find|get|inspect|check|open)\b[^.!?;]{0,96}\b(?:inbox|mailbox)(?:\s+(?:message|messages|email|emails|item|items))?\s+(?:for|of)\s*$/i.test(before)
    );
    const sourceAfter = /^\s+(?:is|as)\s+(?:(?:my|the)\s+)?(?:(?:sender|sending|source)\s+)?(?:email|mail|mailbox|account|calendar)\b/i.test(after);
    if (sourceBefore || sourceAfter) selected.add(email);
  }
  return selected;
}

type PlanningConnectionSelection =
  | {
      kind: 'resolved';
      connection: Awaited<ReturnType<typeof listUsableConnectedToolkits>>[number];
    }
  | { kind: 'account_selection_required'; choices: readonly string[] }
  | { kind: 'unavailable' };

/** Select an account only from current provider identity facts. Duplicate
 * re-auth connections for one mailbox collapse in selectToolkitConnection;
 * genuinely distinct mailboxes still require an explicit user choice. An
 * email in prose counts as that choice only when it exactly names one of the
 * currently connected identities, so a recipient address can never be
 * mistaken for the sending/reading account. When the current turn names no
 * account, unanimous exact-operation Tool Memory may nominate its stable
 * mailbox identity; that identity is re-resolved against this fresh provider
 * snapshot and cannot mint a ref when missing or ambiguous. */
/**
 * A later accepted source may not repeat the mailbox address. Live 2026-08-29
 * "That's the correct account" after the host named calendar@scorpion.example
 * still withheld OUTLOOK_CALENDAR_CREATE_EVENT as account_selection_required.
 * Only currently connected identities count, so a recipient address cannot
 * become the sending account.
 */
export function sessionEstablishedConnectedAccountEmail(input: {
  sessionId: string;
  sourceUserSeq: number;
  connectedEmails: ReadonlySet<string>;
}): string | undefined {
  if (input.connectedEmails.size === 0) return undefined;
  const selectedIn = (text: string): string | undefined => (
    connectedAccountExplicitlySelectedInCurrentText({
      text,
      choices: [...input.connectedEmails],
    })
  );
  try {
    const fromPriorUsers = new Set<string>();
    for (const event of listEvents(input.sessionId, { types: ['user_input_received'] })) {
      if (event.seq >= input.sourceUserSeq) continue;
      const display = typeof event.data.displayText === 'string' ? event.data.displayText.trim() : '';
      const text = typeof event.data.text === 'string' ? event.data.text.trim() : '';
      const acceptedText = display || text;
      const selected = selectedIn(acceptedText) ?? uniqueConnectedAccountFromSelectionReply({
        reply: acceptedText,
        choices: lastOfferedConnectedAccountChoices({
          sessionId: input.sessionId,
          sourceUserSeq: event.seq,
          connectedEmails: input.connectedEmails,
        }),
      });
      if (selected) fromPriorUsers.add(selected);
    }
    if (fromPriorUsers.size === 1) return [...fromPriorUsers][0];
    if (fromPriorUsers.size > 1) return undefined;
    const fromReplies = new Set<string>();
    for (const event of listEvents(input.sessionId, { types: ['conversation_completed'] })) {
      if (event.seq >= input.sourceUserSeq) continue;
      const presentation = event.data.presentation as { text?: unknown } | undefined;
      const reply = typeof event.data.reply === 'string' ? event.data.reply : '';
      const text = typeof presentation?.text === 'string' ? presentation.text : reply;
      const selected = selectedIn(text);
      if (selected) fromReplies.add(selected);
    }
    return fromReplies.size === 1 ? [...fromReplies][0] : undefined;
  } catch {
    return undefined;
  }
}

/** A reply to an offered mailbox list may name the address, or uniquely name
 * the domain ("My scorpion email please" vs breakthroughcoaching). Live
 * 2026-08-29 seq 98720 answered the host question that way; the next Outlook
 * search still withheld the write and re-asked. */
export function uniqueConnectedAccountFromSelectionReply(input: {
  reply: string;
  choices: readonly string[];
}): string | undefined {
  const text = input.reply.trim().toLowerCase();
  if (!text || input.choices.length < 2) return undefined;
  const tokens = text.split(/[^a-z0-9]+/).filter((token) => token.length >= 4);
  const hits: string[] = [];
  for (const choice of input.choices) {
    const email = normalizedAccountEmail(choice);
    if (!email.includes('@')) continue;
    if (text.includes(email)) {
      hits.push(email);
      continue;
    }
    const domainHead = email.split('@')[1]?.split('.')[0] ?? '';
    if (domainHead.length < 4) continue;
    if (
      text.includes(domainHead)
      || tokens.some((token) => domainHead === token || domainHead.startsWith(token) || token.startsWith(domainHead))
    ) hits.push(email);
  }
  return hits.length === 1 ? hits[0] : undefined;
}

/** Resolve an account named in the current request without treating a target's
 * organization or address as the caller's sending account. Exact addresses
 * and shorter domain aliases both require source-account grammar such as
 * "from <address>", "from my Acme email", or "using my Acme <service>";
 * recipient/attendee mentions grant no provider authority. */
export function connectedAccountExplicitlySelectedInCurrentText(input: {
  text: string;
  choices: readonly string[];
}): string | undefined {
  const text = input.text.trim().toLowerCase();
  if (!text) return undefined;
  const choices = [...new Set(
    input.choices
      .map((choice) => normalizedAccountEmail(choice))
      .filter((choice) => choice.includes('@')),
  )];
  if (choices.length === 0) return undefined;

  const aliases = new Set<string>();
  const aliasPatterns = [
    // "use/using my <account alias>" already establishes first-person source
    // selection. Do not enumerate the following provider, app, or resource
    // label: connected toolkits are open-ended, while the captured alias still
    // has to resolve uniquely against the current provider-owned email set.
    // Third-party possessives ("his", "their", "James's") cannot enter this
    // grammar. The live shape was "using my <account alias> <service>".
    /\b(?:use|using)\s+my\s+([a-z0-9-]{4,})\b/g,
    /\b(?:from|via|through)\s+(?:(?:my|the)\s+)?([a-z0-9-]{4,})\s+(?:email|mail|mailbox|account|calendar)\b/g,
  ];
  for (const pattern of aliasPatterns) {
    for (const match of text.matchAll(pattern)) {
      const alias = match[1]?.trim();
      if (alias && !accountSourceMentionCannotSelect(text, match.index ?? 0)) aliases.add(alias);
    }
  }
  if (aliases.size > 1) return undefined;
  const hits = new Set(connectedEmailsNamedAsSource({ text, choices }));
  for (const email of choices) {
    const domainHead = email.split('@')[1]?.split('.')[0] ?? '';
    if (domainHead.length < 4) continue;
    if ([...aliases].some((alias) => (
      alias === domainHead
      || domainHead.startsWith(alias)
      || alias.startsWith(domainHead)
    ))) hits.add(email);
  }
  return hits.size === 1 ? [...hits][0] : undefined;
}

const DURABLE_ALIAS_RESOURCE_WORDS = '(?:email|mail|mailbox|account|calendar|workspace|tenant|profile)';

/** Extract only clauses that grammatically nominate the caller's source. Bare
 * possessive mentions ("send to my Work account") and descriptive prose do
 * not enter durable alias resolution. */
function durableSourceAccountAliasLabelishes(text: string, toolkit: string): {
  labelishes: string[];
  ambiguous: boolean;
} {
  const normalizedText = text.trim().toLowerCase();
  if (!normalizedText) return { labelishes: [], ambiguous: false };
  const phrase = '([a-z0-9][a-z0-9-]*(?:\\s+[a-z0-9][a-z0-9-]*){0,7}?)';
  const terminator = `(?=\\s+${DURABLE_ALIAS_RESOURCE_WORDS}\\b|\\s+(?:and|or)\\s+(?:use|using|from|via|through)\\b|[,.;!?]|$)`;
  const patterns = [
    new RegExp(`\\b(?:use|using)\\s+my\\s+${phrase}${terminator}`, 'g'),
    new RegExp(`\\b(?:from|via|through)\\s+(?:my|the)\\s+${phrase}${terminator}`, 'g'),
  ];
  const labels = new Set<string>();
  let ambiguous = false;
  for (const pattern of patterns) {
    for (const match of normalizedText.matchAll(pattern)) {
      const start = match.index ?? 0;
      if (accountSourceMentionCannotSelect(normalizedText, start)) continue;
      const raw = match[1]?.trim();
      if (!raw) continue;
      const words = raw.match(/[a-z0-9][a-z0-9-]*/g) ?? [];
      // Two named accounts in one source phrase is genuine ambiguity, not an
      // invitation to choose the first label.
      if (words.some((word) => word === 'and' || word === 'or')) {
        ambiguous = true;
        continue;
      }
      const toolkitParts = toolkit.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const compactToolkit = toolkitParts.join('');
      let end = words.length;
      for (let index = 0; index < words.length; index += 1) {
        const compactWord = words[index]!.replace(/[^a-z0-9]+/g, '');
        const providerSequence = compactToolkit.length > 0
          && words.slice(index, index + toolkitParts.length)
            .map((word) => word.replace(/[^a-z0-9]+/g, ''))
            .join('') === compactToolkit;
        if (
          compactWord === compactToolkit
          || providerSequence
          || /^(?:email|mail|mailbox|account|calendar|workspace|tenant|profile|sending|source|connected|for|to|with|about|on|at|then|please)$/.test(words[index]!)
        ) {
          end = index;
          break;
        }
      }
      const labelish = words.slice(0, end).join(' ').trim();
      if (labelish) labels.add(labelish);
    }
  }
  return { labelishes: [...labels], ambiguous };
}

type DurableSourceAccountAliasSelection =
  | { kind: 'none' }
  | { kind: 'resolved_email'; email: string }
  | {
      kind: 'resolved_connection';
      connection: Awaited<ReturnType<typeof listUsableConnectedToolkits>>[number];
    }
  | { kind: 'unusable' };

/** Durable memory may nominate an identity, but the fresh, relevant provider
 * snapshot remains the authority. Email survives re-auth; a connection-id-only
 * alias is accepted only while that exact connection is still live. */
function durableSourceAccountAliasSelection(input: {
  text: string;
  toolkit: string;
  relevantLiveConnections: Awaited<ReturnType<typeof listUsableConnectedToolkits>>;
}): DurableSourceAccountAliasSelection {
  const extracted = durableSourceAccountAliasLabelishes(input.text, input.toolkit);
  if (extracted.ambiguous || extracted.labelishes.length > 1) return { kind: 'unusable' };
  if (extracted.labelishes.length === 0) return { kind: 'none' };
  const nominations = new Map<string, DurableSourceAccountAliasSelection>();
  let foundSavedAlias = false;
  for (const labelish of extracted.labelishes) {
    const saved = resolveAccountAlias(labelish, input.toolkit);
    if (!saved) continue;
    foundSavedAlias = true;
    const email = normalizedAccountEmail(saved.email);
    if (email.includes('@')) {
      const existsNow = input.relevantLiveConnections.some((connection) => (
        normalizedAccountEmail(connection.accountEmail) === email
      ));
      if (!existsNow) return { kind: 'unusable' };
      nominations.set(`email:${email}`, { kind: 'resolved_email', email });
      continue;
    }
    const connection = saved.connectionId
      ? input.relevantLiveConnections.find((candidate) => (
          candidate.connectionId === saved.connectionId
        ))
      : undefined;
    if (!connection) return { kind: 'unusable' };
    nominations.set(`connection:${connection.connectionId}`, {
      kind: 'resolved_connection',
      connection,
    });
  }
  // A non-empty, source-grammatical label that neither the fresh connected
  // identities nor durable alias memory recognize must not disappear into a
  // prior-session/default-account fallback.
  if (!foundSavedAlias) return { kind: 'unusable' };
  if (nominations.size !== 1) return { kind: 'unusable' };
  return [...nominations.values()][0]!;
}

export function lastOfferedConnectedAccountChoices(input: {
  sessionId: string;
  sourceUserSeq: number;
  connectedEmails: ReadonlySet<string>;
}): string[] {
  if (input.connectedEmails.size === 0) return [];
  try {
    const offered = listEvents(input.sessionId, { types: ['awaiting_user_input'] })
      .filter((event) => event.seq < input.sourceUserSeq)
      .sort((left, right) => right.seq - left.seq);
    for (const event of offered) {
      const options = event.data.options;
      if (!Array.isArray(options)) continue;
      const emails = [...new Set(
        options
          .filter((option): option is string => typeof option === 'string' && option.trim().length > 0)
          .map((option) => normalizedAccountEmail(option))
          .filter((email) => input.connectedEmails.has(email)),
      )];
      if (emails.length >= 2) return emails;
    }
  } catch {
    return [];
  }
  return [];
}

function normalizedOperationKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^(?:cap:(?:resolved|live):|composio:)+/, '')
    .replace(/:[^:]*@[^:]+$/, '')
    .replace(/[^a-z0-9]+/g, '');
}

/** A plan citation may be the live slug, a minted cap:resolved ref, or that
 * ref with a mailbox suffix. None of those spellings is a different write. */
export function citationMatchesDisclosedOperation(citation: string, operation: string): boolean {
  const cited = citation.trim();
  const name = operation.trim();
  if (!cited || !name) return false;
  const citedKey = normalizedOperationKey(cited);
  const nameKey = normalizedOperationKey(name);
  return citedKey.length > 0 && citedKey === nameKey;
}

export function accountSelectionForCitedWrite(input: {
  citedRefs: readonly string[];
  blockers: ReadonlyArray<{ name: string; choices: readonly string[] }>;
}): { name: string; choices: readonly string[] } | null {
  const cited = input.citedRefs.map((ref) => ref.trim()).filter(Boolean);
  if (cited.length === 0 || input.blockers.length === 0) return null;
  const matches = input.blockers.filter((blocker) => (
    cited.some((ref) => citationMatchesDisclosedOperation(ref, blocker.name))
    && blocker.choices.length > 0
  ));
  if (matches.length === 0) return null;
  const uniqueChoices = new Set(
    matches.map((blocker) => [...blocker.choices].map((choice) => choice.trim().toLowerCase()).sort().join('\0')),
  );
  if (uniqueChoices.size !== 1) return null;
  return { name: matches[0]!.name, choices: [...matches[0]!.choices] };
}

export function accountSelectionBlockersFromSearchResult(
  result: unknown,
): Array<{ name: string; choices: string[] }> {
  return parseToolSearchAccountBlockers(result);
}

/** One unique connected-account choice set across this-turn search blockers.
 * That is a user question, not a plan. Live 2026-08-29 invite: first search
 * returned Outlook creates with two mailboxes, then the model looped
 * plan_task instead of asking. */
export function uniqueConnectedAccountQuestion(
  blockers: ReadonlyArray<{ name: string; choices: readonly string[] }>,
): { choices: readonly string[] } | null {
  const eligible = blockers.filter((blocker) => blocker.choices.length >= 2);
  if (eligible.length === 0) return null;
  const keys = new Set(
    eligible.map((blocker) => (
      [...blocker.choices].map((choice) => choice.trim().toLowerCase()).sort().join('\0')
    )),
  );
  if (keys.size !== 1) return null;
  return { choices: eligible[0]!.choices };
}

function parseToolSearchAccountBlockers(result: unknown): Array<{ name: string; choices: string[] }> {
  let payload: unknown = result;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return [];
    }
  }
  const rows = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as { results?: unknown }).results
    : null;
  if (!Array.isArray(rows)) return [];
  const blockers: Array<{ name: string; choices: string[] }> = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const record = row as {
      name?: unknown;
      planningRefStatus?: unknown;
      accountChoices?: unknown;
    };
    if (typeof record.name !== 'string' || !record.name.trim()) continue;
    if (record.planningRefStatus !== 'account_selection_required') continue;
    if (!Array.isArray(record.accountChoices)) continue;
    const choices = [...new Set(
      record.accountChoices
        .filter((choice): choice is string => typeof choice === 'string' && choice.trim().length > 0)
        .map((choice) => choice.trim()),
    )];
    if (choices.length === 0) continue;
    blockers.push({ name: record.name.trim(), choices });
  }
  return blockers;
}

/** This-turn tool_search rows that found the write but still need the user
 * to name one connected account. That is an input question, not a missing
 * capability — live 2026-08-29 invite: OUTLOOK_CALENDAR_CREATE_EVENT was
 * returned with two mailboxes, then plan_task called it undisclosed and
 * offered greenhouse/airtable. */
export function thisTurnSearchAccountSelectionBlockers(input: {
  sessionId: string;
  sourceUserSeq: number;
}): Array<{ name: string; choices: readonly string[] }> {
  const byName = new Map<string, string[]>();
  try {
    for (const event of listEvents(input.sessionId, { types: ['tool_returned'] })) {
      if (event.data.sourceUserSeq !== input.sourceUserSeq) continue;
      if (event.data.tool !== 'tool_search') continue;
      for (const blocker of parseToolSearchAccountBlockers(event.data.result)) {
        byName.set(blocker.name, blocker.choices);
      }
    }
  } catch {
    return [];
  }
  return [...byName.entries()].map(([name, choices]) => ({ name, choices }));
}

export function planningConnectionForOperation(
  operation: string,
  acceptedText: string,
  connections: Awaited<ReturnType<typeof listUsableConnectedToolkits>>,
  sessionContext?: { sessionId: string; sourceUserSeq: number },
): PlanningConnectionSelection {
  const toolkit = registeredToolkitOfSlug(operation).trim().toLowerCase();
  const relevantLiveConnections = connections.filter((connection) => (
    connection.slug.trim().toLowerCase() === toolkit
    && /active|enabled|initiat/i.test(connection.status ?? '')
  ));
  const acceptedTokens = new Set(acceptedText.match(/[A-Za-z0-9_-]+/g) ?? []);
  const namedConnectionIds = relevantLiveConnections
    .filter((connection) => acceptedTokens.has(connection.connectionId));
  if (namedConnectionIds.length === 1) {
    return { kind: 'resolved', connection: namedConnectionIds[0]! };
  }
  const connectedEmails = new Set(
    relevantLiveConnections
      .map((connection) => normalizedAccountEmail(connection.accountEmail))
      .filter((email) => email.includes('@')),
  );
  const currentSelectionHint = connectedAccountExplicitlySelectedInCurrentText({
    text: acceptedText,
    choices: [...connectedEmails],
  });
  const durableAliasSelection = currentSelectionHint
    ? { kind: 'none' } as const
    : durableSourceAccountAliasSelection({
        text: acceptedText,
        toolkit,
        relevantLiveConnections,
      });
  if (durableAliasSelection.kind === 'resolved_connection') {
    return { kind: 'resolved', connection: durableAliasSelection.connection };
  }
  if (durableAliasSelection.kind === 'unusable') {
    const choices = [...new Set(relevantLiveConnections.map((connection) => (
      normalizedAccountEmail(connection.accountEmail) || connection.connectionId
    )))];
    return choices.length > 0
      ? { kind: 'account_selection_required', choices }
      : { kind: 'unavailable' };
  }
  const selectionReplyHint = sessionContext
    ? uniqueConnectedAccountFromSelectionReply({
        reply: acceptedText,
        choices: lastOfferedConnectedAccountChoices({
          sessionId: sessionContext.sessionId,
          sourceUserSeq: sessionContext.sourceUserSeq,
          connectedEmails,
        }),
      })
    : undefined;
  const sessionIdentityHint = sessionContext
    ? sessionEstablishedConnectedAccountEmail({
        sessionId: sessionContext.sessionId,
        sourceUserSeq: sessionContext.sourceUserSeq,
        connectedEmails,
      })
    : undefined;
  const identityHint = currentSelectionHint
    ?? (durableAliasSelection.kind === 'resolved_email'
      ? durableAliasSelection.email
      : undefined)
    ?? selectionReplyHint
    ?? sessionIdentityHint
    ?? recallComposioAccountIdentity(operation);
  const outcome = selectToolkitConnection(operation, connections, identityHint);
  if (outcome.kind === 'ambiguous' || outcome.kind === 'identity-absent') {
    return {
      kind: 'account_selection_required',
      choices: [...new Set(outcome.candidates.map((candidate) => (
        normalizedAccountEmail(candidate.email) || candidate.connectionId
      )))],
    };
  }
  if (outcome.kind !== 'resolved') return { kind: 'unavailable' };
  const connection = connections.find((candidate) => candidate.connectionId === outcome.connectionId);
  return connection ? { kind: 'resolved', connection } : { kind: 'unavailable' };
}

/**
 * Deposit identity/schema facts for only the provider candidates the visible
 * tool_search result actually returned. Writes remain staging-only until
 * plan_task. Exact proven reads also materialize a current callable entry so
 * an ordinary foreground read does not need to manufacture a graph merely to
 * look at its source; every crossing still reopens the same live definition.
 */
export async function stageDisclosedPlanningProviderCandidates(input: {
  sessionId: string;
  sourceUserSeq: number;
  candidates: readonly ToolSearchPlanningDisclosureCandidate[];
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<{ blockers: Readonly<Record<string, ToolSearchPlanningBlocker>> }> {
  const empty = () => ({ blockers: Object.freeze({}) });
  const guard = { signal: input.signal, deadlineAt: input.deadlineAt };
  if (!discoveryStillActive(guard)) return empty();
  const composioCandidates = input.candidates.filter((candidate) => (
    candidate.sourceKind === 'authorized_composio'
    && candidate.carrier === 'work_call'
    && candidate.name.trim()
    && candidate.schema
    && typeof candidate.schema === 'object'
    && !Array.isArray(candidate.schema)
  ));
  // Per-source disclosure isolates providers. Do not make an exact MCP or
  // reviewed-local ref wait on an unrelated connected-account snapshot.
  if (composioCandidates.length === 0) {
    return empty();
  }
  const accepted = listEvents(input.sessionId, {
    sinceSeq: input.sourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  }).find((event) => event.seq === input.sourceUserSeq);
  const display = typeof accepted?.data.displayText === 'string' ? accepted.data.displayText.trim() : '';
  const eventText = typeof accepted?.data.text === 'string' ? accepted.data.text.trim() : '';
  const acceptedText = display || eventText;
  if (!acceptedText || !discoveryStillActive(guard)) return empty();
  const connectionOutcome = await awaitBounded({
    start: () => listUsableConnectedToolkits({ requireFresh: true }),
    ...guard,
  });
  if (connectionOutcome.kind !== 'settled' || !discoveryStillActive(guard)) return empty();
  const connections = connectionOutcome.value;
  const entries = new Map<string, CapabilityResolutionEntry>();
  const blockers: Record<string, ToolSearchPlanningBlocker> = {};
  // A task may resolve source and destination in separate foreground searches.
  // Keep the newest accepted-task resolution cumulative so the existing
  // proof publisher can materialize the model-selected subset at plan time.
  for (const event of listEvents(input.sessionId, { types: ['capability_resolution'] })) {
    if (!discoveryStillActive(guard)) return empty();
    if (event.data.sourceUserSeq !== input.sourceUserSeq || event.data.authoritativeForTask === false) continue;
    const prior = Array.isArray(event.data.entries)
      ? event.data.entries as CapabilityResolutionEntry[]
      : [];
    for (const entry of prior) {
      if (
        entry.kind !== 'composio'
        || entry.status !== 'proven'
        || entry.connection === 'missing'
        || !entry.identifier?.trim()
      ) continue;
      entries.set(`composio:${entry.identifier.trim().toLowerCase()}`, { ...entry });
    }
  }
  for (const candidate of composioCandidates.slice(0, 20)) {
    if (!discoveryStillActive(guard)) return empty();
    const slug = candidate.name.trim();
    const selection = planningConnectionForOperation(slug, acceptedText, connections, {
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
    });
    // Account ambiguity is an input question, never a reason to mint a
    // provider-default manifest behind the model's back. Duplicate re-auths
    // for the same mailbox are one identity, not false ambiguity.
    if (selection.kind === 'account_selection_required') {
      blockers[slug] = Object.freeze({
        code: 'account_selection_required',
        choices: Object.freeze([...selection.choices]),
      });
      continue;
    }
    if (selection.kind !== 'resolved') continue;
    const selectedToolkit = registeredToolkitOfSlug(slug).trim().toLowerCase();
    const selectedEmail = normalizedAccountEmail(selection.connection.accountEmail);
    attachToolSearchSelectedAccountEvidence(candidate, {
      toolkit: selectedToolkit,
      ...(selectedEmail.includes('@') ? { email: selectedEmail } : {}),
      label: aliasLabelFor(
        selectedToolkit,
        selectedEmail || undefined,
        selection.connection.connectionId,
      ) ?? selection.connection.accountLabel ?? selection.connection.alias,
      connectionId: selection.connection.connectionId,
    });
    const effectClass = classifyComposioSlugEffect(slug) === 'read' ? 'read' : 'write';
    entries.set(`composio:${slug.toLowerCase()}`, {
      intent: 'foreground tool_search disclosed this exact live operation',
      kind: 'composio',
      identifier: slug,
      status: 'proven',
      connection: 'active',
      accountIdentity: selection.connection.connectionId,
      effectClass,
    });
  }
  if (entries.size > 0) {
    if (!discoveryStillActive(guard)) return empty();
    recordAdmissionCapabilityResolution({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedInput: acceptedText,
      entries: [...entries.values()],
    });
  }
  const provenReads = composioCandidates.filter((candidate) => {
    const proof = entries.get(`composio:${candidate.name.trim().toLowerCase()}`);
    return proof?.effectClass === 'read';
  });
  if (provenReads.length > 0 && discoveryStillActive(guard)) {
    await registerProofProvisionedCapabilities(
      { sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq },
      {
        allowedIdentifiers: provenReads.map((candidate) => candidate.name.trim()),
        expectedSchemaDigests: provenReads.map((candidate) => ({
          identifier: candidate.name.trim(),
          schemaDigest: digestSchema(candidate.schema as Record<string, unknown>),
        })),
        publicationGuard: () => discoveryStillActive(guard),
      },
    );
  }
  if (!discoveryStillActive(guard)) return empty();
  return { blockers: Object.freeze({ ...blockers }) };
}
/**
 * Bind provider adapters to the already-resolved turn scope. The returned
 * sources are lazy: constructing a fresh action does no connector I/O; only an
 * actual unresolved-role tool_search pays discovery latency. Both adapters
 * return capability context, never execution authority.
 */
/** Nominations are bounded hard: this is a hint budget, not a scan. */
const INDEX_NOMINATION_LIMIT = 6;
/** One aggregate budget for every exact lookup a single search may trigger. */
const INDEX_NOMINATION_DEADLINE_MS = 4_000;
/** Return just before the broker-owned abort so completed partial progress is
 * observed by the caller rather than discarded at the same timer boundary. */
const PROVIDER_SOURCE_RETURN_MARGIN_MS = 100;

function exactDiscoveryDeadline(sourceDeadlineAt?: number): number {
  const ownDeadline = Date.now() + INDEX_NOMINATION_DEADLINE_MS;
  return sourceDeadlineAt === undefined
    ? ownDeadline
    : Math.min(ownDeadline, sourceDeadlineAt - PROVIDER_SOURCE_RETURN_MARGIN_MS);
}

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Reach an exact capability the provider's fuzzy search cannot find.
 *
 * Measured live 2026-08-26 against the real account: "what's on my calendar
 * tomorrow" returned thirteen Composio candidates and NOT ONE read — only
 * create/cancel/update. `OUTLOOK_GET_CALENDAR_VIEW` was never returned at any
 * ranking or phrasing, while the local capability index returned it at rank one
 * with effect=read. For that capability, nomination is not an optimisation; it
 * is the only path that reaches it. Clem then asked which calendar despite
 * holding a hard constraint naming the exact connection, and on the Salesforce
 * turn restated a five-month-old figure as "I can confirm".
 *
 * The index is ADVISORY and stays that way. It contributes exactly one thing —
 * an exact slug worth asking the provider about. Schema, membership, and every
 * downstream proof come from the live exact lookup below; a nomination that
 * cannot be proven live simply does not exist. Plan admission still revalidates
 * the selected definition afterwards, unchanged.
 */
export type ExactMaterializationRequest = {
  slug: string;
  toolkit: string;
};

/** Materialize one bounded exact provider batch. This function alone may warm
 * schema authority for the exact-discovery paths below, and only while its
 * caller's absolute deadline/cancellation guard is still live. */
async function materializeExactProviderBatch(input: {
  requests: readonly ExactMaterializationRequest[];
  signal?: AbortSignal;
  deadlineAt: number;
}): Promise<ComposioBrokerCandidate[]> {
  if (input.requests.length === 0 || !discoveryStillActive(input)) return [];
  const slugs = input.requests.map((request) => request.slug);
  const toolkitBySlug = new Map(input.requests.map((request) => [request.slug, request.toolkit]));
  const batchOutcome = await awaitBounded({
    start: () => getExactComposioToolsBySlugs(slugs),
    signal: input.signal,
    deadlineAt: input.deadlineAt,
  });
  if (batchOutcome.kind !== 'settled' || !discoveryStillActive(input)) return [];
  const batch = batchOutcome.value;
  if (batch.size === 0) return [];

  const materialized: ComposioBrokerCandidate[] = [];
  for (const slug of slugs) {
    if (!discoveryStillActive(input)) return [];
    const tool = batch.get(slug);
    if (!tool) continue;
    // Provider-owned exact slug/toolkit/schema/version/output/timestamp are all
    // mandatory. Neither a named token nor an advisory index row vouches for
    // any part of the returned definition.
    const returnedSlug = String(tool.slug ?? '').trim().toUpperCase();
    const returnedToolkit = tool.toolkitSlug?.trim().toLowerCase() ?? '';
    const expectedToolkit = toolkitBySlug.get(slug) ?? '';
    if (returnedSlug !== slug || !returnedToolkit || returnedToolkit !== expectedToolkit) continue;
    if (!isSchemaRecord(tool.inputParameters)) continue;
    const operationVersion = composioToolOperationVersion(tool);
    const observedAt = composioToolSchemaObservedAt(tool);
    const outputWasObserved = Object.prototype.hasOwnProperty.call(tool, 'outputParameters')
      && tool.outputParameters !== undefined;
    const outputSchema = tool.outputParameters === null
      ? null
      : isSchemaRecord(tool.outputParameters)
        ? tool.outputParameters
        : undefined;
    if (
      !operationVersion
      || !Number.isFinite(observedAt)
      || observedAt! < 0
      || observedAt! > Date.now()
      || !outputWasObserved
      || outputSchema === undefined
      || !discoveryStillActive(input)
    ) continue;

    // The same provider observation is deposited once; a response that settles
    // after timeout/abort is consumed by awaitBounded but can never reach here.
    rememberToolSchema(
      returnedSlug,
      tool.inputParameters,
      observedAt,
      operationVersion,
      outputSchema,
    );
    const cachedOutput = liveComposioOutputSchema(returnedSlug);
    const sameOutput = outputSchema === null
      ? cachedOutput === null
      : isSchemaRecord(cachedOutput)
        && digestSchema(cachedOutput) === digestSchema(outputSchema);
    if (
      liveComposioSchemaFingerprint(returnedSlug) !== fingerprintSchema(tool.inputParameters)
      || liveComposioOperationVersion(returnedSlug) !== operationVersion
      || !sameOutput
      || !discoveryStillActive(input)
    ) continue;
    materialized.push({
      toolkit: returnedToolkit,
      slug: returnedSlug,
      name: tool.name ?? returnedSlug,
      ...(tool.description ? { description: tool.description } : {}),
      score: 0,
      inputParameters: tool.inputParameters,
    });
  }
  return discoveryStillActive(input) ? materialized : [];
}

async function freshConnectionsWithin(input: {
  signal?: AbortSignal;
  deadlineAt: number;
}): Promise<Awaited<ReturnType<typeof listUsableConnectedToolkits>> | null> {
  const outcome = await awaitBounded({
    start: () => listUsableConnectedToolkits({ requireFresh: true }),
    signal: input.signal,
    deadlineAt: input.deadlineAt,
  });
  return outcome.kind === 'settled' && discoveryStillActive(input)
    ? outcome.value
    : null;
}

export type ExactWorkflowProviderProvisionResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | 'accepted_source_missing_or_changed'
        | 'invalid_exact_operation'
        | 'exact_definition_unavailable'
        | 'fresh_connections_unavailable'
        | 'account_selection_required'
        | 'connection_unavailable'
        | 'proof_publication_expired'
        | 'proof_provisioning_refused';
      identifier: string;
      detail?: string;
      choices?: readonly string[];
    };

export interface ExactWorkflowProviderProvisionDependencies {
  materializeExact?: (input: {
    requests: readonly ExactMaterializationRequest[];
    signal?: AbortSignal;
    deadlineAt: number;
  }) => Promise<ComposioBrokerCandidate[]>;
  freshConnections?: (input: {
    signal?: AbortSignal;
    deadlineAt: number;
  }) => Promise<Awaited<ReturnType<typeof listUsableConnectedToolkits>> | null>;
  recordResolution?: typeof recordAdmissionCapabilityResolution;
  registerProof?: typeof registerProofProvisionedCapabilities;
}

function normalizedAcceptedSourceText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Pre-model supply for exact Composio operations authored by an immutable
 * workflow step but absent from the durable manifest store.
 *
 * This is deliberately not a fuzzy/tool_search invocation. The caller has
 * already reduced the immutable source to an exact, registered operation set;
 * this helper performs one bounded exact provider lookup, binds one current
 * account per operation, records that proof against the already-persisted
 * source, and publishes only that exact set through the ordinary selected-
 * definition revalidation path. Both reads and writes are metadata-provisioned
 * here; all normal graph/effect/physical-dispatch gates remain downstream.
 */
export async function provisionExactWorkflowProviderOperations(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedInput: string;
  operationIds: readonly string[];
  signal?: AbortSignal;
  deadlineAt?: number;
}, dependencies: ExactWorkflowProviderProvisionDependencies = {}): Promise<ExactWorkflowProviderProvisionResult> {
  const accepted = listEvents(input.sessionId, {
    sinceSeq: input.sourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  }).find((event) => event.seq === input.sourceUserSeq);
  const acceptedText = normalizedAcceptedSourceText(
    typeof accepted?.data.displayText === 'string' && accepted.data.displayText.trim()
      ? accepted.data.displayText
      : accepted?.data.text,
  );
  if (
    !acceptedText
    || acceptedText !== normalizedAcceptedSourceText(input.acceptedInput)
  ) {
    return {
      ok: false,
      code: 'accepted_source_missing_or_changed',
      identifier: input.operationIds[0]?.trim().toUpperCase() || 'unknown',
    };
  }

  const operationIds = [...new Set(input.operationIds.map((value) => value.trim().toUpperCase()))]
    .filter(Boolean)
    .sort();
  if (operationIds.length === 0 || operationIds.length > 32) {
    return {
      ok: false,
      code: 'invalid_exact_operation',
      identifier: operationIds[32] ?? operationIds[0] ?? 'unknown',
    };
  }
  const requests: ExactMaterializationRequest[] = [];
  for (const operation of operationIds) {
    const toolkit = registeredToolkitOfSlug(operation).trim().toLowerCase();
    if (
      !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}$/.test(operation)
      || !isRegisteredToolkitSlug(toolkit)
      || !operation.startsWith(`${toolkit.toUpperCase()}_`)
    ) {
      return { ok: false, code: 'invalid_exact_operation', identifier: operation };
    }
    requests.push({ slug: operation, toolkit });
  }

  // One aggregate deadline covers definition lookup, account refresh, proof,
  // and publication. A late provider promise is consumed by awaitBounded, and
  // publicationGuard prevents it from mutating authority after expiry.
  const ownDeadlineAt = Date.now() + TOOL_SEARCH_TOTAL_DEADLINE_MS;
  const deadlineAt = input.deadlineAt === undefined
    ? ownDeadlineAt
    : Math.min(ownDeadlineAt, input.deadlineAt);
  const guard = { signal: input.signal, deadlineAt };
  if (!discoveryStillActive(guard)) {
    return {
      ok: false,
      code: 'proof_publication_expired',
      identifier: operationIds[0]!,
    };
  }

  const [materialized, connections] = await Promise.all([
    (dependencies.materializeExact ?? materializeExactProviderBatch)({ requests, ...guard }),
    (dependencies.freshConnections ?? freshConnectionsWithin)(guard),
  ]);
  if (!discoveryStillActive(guard)) {
    return {
      ok: false,
      code: 'proof_publication_expired',
      identifier: operationIds[0]!,
    };
  }
  const materializedBySlug = new Map(materialized.map((candidate) => [
    candidate.slug.trim().toUpperCase(),
    candidate,
  ]));
  for (const operation of operationIds) {
    if (!materializedBySlug.has(operation)) {
      return { ok: false, code: 'exact_definition_unavailable', identifier: operation };
    }
  }
  if (!connections) {
    return {
      ok: false,
      code: 'fresh_connections_unavailable',
      identifier: operationIds[0]!,
    };
  }

  const entries: CapabilityResolutionEntry[] = [];
  for (const operation of operationIds) {
    const selection = planningConnectionForOperation(
      operation,
      input.acceptedInput,
      connections,
      { sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq },
    );
    if (selection.kind === 'account_selection_required') {
      return {
        ok: false,
        code: 'account_selection_required',
        identifier: operation,
        choices: Object.freeze([...selection.choices]),
      };
    }
    if (selection.kind !== 'resolved') {
      return { ok: false, code: 'connection_unavailable', identifier: operation };
    }
    entries.push({
      intent: 'immutable workflow source names this exact operation',
      kind: 'composio',
      identifier: operation,
      status: 'proven',
      connection: 'active',
      accountIdentity: selection.connection.connectionId,
      effectClass: classifyComposioSlugEffect(operation) === 'read' ? 'read' : 'write',
    });
  }

  (dependencies.recordResolution ?? recordAdmissionCapabilityResolution)({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedInput: input.acceptedInput,
    entries,
  });
  const expectedSchemaDigests = operationIds.map((identifier) => ({
    identifier,
    schemaDigest: digestSchema(
      materializedBySlug.get(identifier)!.inputParameters as Record<string, unknown>,
    ),
  }));
  const publication = await awaitBounded({
    start: () => (dependencies.registerProof ?? registerProofProvisionedCapabilities)(
      { sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq },
      {
        allowedIdentifiers: operationIds,
        expectedSchemaDigests,
        publicationGuard: () => discoveryStillActive(guard),
      },
    ),
    ...guard,
  });
  if (publication.kind === 'failed') {
    return {
      ok: false,
      code: 'proof_provisioning_refused',
      identifier: operationIds[0]!,
      detail: publication.error instanceof Error
        ? publication.error.message
        : String(publication.error),
    };
  }
  if (publication.kind !== 'settled' || !discoveryStillActive(guard)) {
    return {
      ok: false,
      code: 'proof_publication_expired',
      identifier: operationIds[0]!,
    };
  }
  if (publication.value.refusal) {
    return {
      ok: false,
      code: 'proof_provisioning_refused',
      identifier: publication.value.refusal.identifier,
      detail: publication.value.refusal.code,
    };
  }
  // "ok" means every requested operation is now a registered catalog entry.
  // Live 2026-09-01: an empty registration with no refusal reported ok, the
  // host re-ran its exact check against the same empty catalog, and the turn
  // ended as a no-progress internal error with a log line saying ok: true.
  const registeredOperations = new Set(publication.value.registered.map((capabilityId) => (
    capabilityId.replace(/^cap:resolved:/u, '').split(':definition:')[0]?.toUpperCase() ?? ''
  )));
  const unregistered = operationIds.find((operation) => !registeredOperations.has(operation));
  if (unregistered) {
    return {
      ok: false,
      code: 'proof_provisioning_refused',
      identifier: unregistered,
      detail: 'not_registered',
    };
  }
  return { ok: true };
}

async function materializeNamedComposioOperation(input: {
  operation: string;
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<ComposioBrokerCandidate[]> {
  const deadlineAt = exactDiscoveryDeadline(input.deadlineAt);
  const guard = { signal: input.signal, deadlineAt };
  const toolkit = registeredToolkitOfSlug(input.operation).trim().toLowerCase();
  return materializeExactProviderBatch({
    requests: [{ slug: input.operation, toolkit }],
    ...guard,
  });
}

async function materializeRememberedComposioOperations(input: {
  matches: readonly { slug: string }[];
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<ComposioBrokerCandidate[]> {
  const deadlineAt = exactDiscoveryDeadline(input.deadlineAt);
  const guard = { signal: input.signal, deadlineAt };
  const seen = new Set<string>();
  const requests: ExactMaterializationRequest[] = [];
  for (const match of input.matches.slice(0, INDEX_NOMINATION_LIMIT)) {
    const slug = match.slug.trim().toUpperCase();
    const toolkit = registeredToolkitOfSlug(slug).trim().toLowerCase();
    if (
      !slug
      || seen.has(slug)
      || !isRegisteredToolkitSlug(toolkit)
      || !slug.startsWith(`${toolkit.toUpperCase()}_`)
    ) continue;
    seen.add(slug);
    requests.push({ slug, toolkit });
  }
  return materializeExactProviderBatch({ requests, ...guard });
}

async function materializeIndexNominations(input: {
  query: string;
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<ComposioBrokerCandidate[]> {
  // This is an absolute budget for the whole nomination, including the fresh
  // current-account snapshot. Starting it after that I/O made the nominal 4s
  // bound additive and allowed already-late rows to warm schema authority.
  const deadlineAt = exactDiscoveryDeadline(input.deadlineAt);
  const guard = { signal: input.signal, deadlineAt };
  if (!discoveryStillActive(guard)) return [];
  const indexed = searchCapabilityOperations(input.query, {
    limit: INDEX_NOMINATION_LIMIT * 3,
    carrierKind: 'composio',
  });
  if (indexed.length === 0 || !discoveryStillActive(guard)) return [];
  const usable = await freshConnectionsWithin(guard);
  if (!usable || usable.length === 0 || !discoveryStillActive(guard)) return [];

  const requests: ExactMaterializationRequest[] = [];
  const requested = new Set<string>();
  for (const hit of indexed) {
    if (!discoveryStillActive(guard)) return [];
    const slug = hit.identifier.trim().toUpperCase();
    if (!slug || requested.has(slug)) continue;
    const slugToolkit = registeredToolkitOfSlug(slug).trim().toLowerCase();
    const indexedCarrier = String(hit.carrier ?? '').trim().toLowerCase();
    if (
      !slugToolkit
      || !isRegisteredToolkitSlug(slugToolkit)
      || !indexedCarrier
      || slugToolkit !== indexedCarrier
    ) continue;
    // Advisory nominations still require one resolved current account before
    // paying for exact lookup. Genuine ambiguity is surfaced later only when
    // the user explicitly selected the exact operation above.
    const selection = planningConnectionForOperation(slug, input.query, usable);
    if (selection.kind !== 'resolved') continue;
    requests.push({ slug, toolkit: slugToolkit });
    requested.add(slug);
    if (requests.length >= INDEX_NOMINATION_LIMIT) break;
  }
  return materializeExactProviderBatch({ requests, ...guard });
}

/** MCP scope is an authority boundary for MCP adapters only. A reviewed CLI
 * or future non-MCP live carrier must not disappear merely because the turn
 * denied or narrowly scoped connected MCP servers. */
function liveReadAdapterAllowedByMcpScope(
  scope: McpToolScope,
  adapter: Readonly<Pick<ProductionLiveReadCarrierAdapterV1, 'carrier'>>,
): boolean {
  if (adapter.carrier.kind !== 'mcp') return true;
  const server = adapter.carrier.name.trim();
  if (!server) return false;
  if ((scope.deniedServerSlugs ?? []).some((denied) => (
    mcpServerAliasMatches(server, denied)
  ))) return false;
  const authority = mcpToolScopeAuthority(scope);
  if (authority === 'none') return false;
  if (authority === 'catalog') return true;
  if (authority === 'server_set') {
    return (scope.allowedServerSlugs ?? []).some((allowed) => (
      mcpServerAliasMatches(server, allowed)
    ));
  }
  // Exact leases retain the configured namespace itself; generic alias
  // normalization is deliberately not authority-equal at this edge.
  const normalizedServer = server.toLowerCase();
  return (scope.allowedToolNames ?? []).some((name) => {
    const identity = canonicalMcpToolIdentity(name);
    return identity?.slice(0, identity.indexOf('__')) === normalizedServer;
  });
}

function liveReadNominationAllowedByMcpScope(
  scope: McpToolScope,
  nomination: Readonly<ProductionLiveReadNominationV1>,
): boolean {
  return nomination.carrier.kind !== 'mcp'
    || mcpToolAllowedByScope(nomination.identity.reference.identifier, scope);
}

export function buildAuthorizedToolSearchCandidateSources(
  scope: McpToolScope,
  planningIdentity?: { sessionId: string; sourceUserSeq: number },
): readonly ToolSearchCandidateSource[] {
  const externalMcp: ToolSearchCandidateSource = {
    kind: 'authorized_external_mcp',
    async search({ query, limit, signal }) {
      if (signal?.aborted) return [];
      const exactOperation = exactExternalMcpOperationFromQuery(query);
      if (exactOperation) {
        const exact = await resolveAuthorizedExternalMcpToolDefinition(exactOperation, scope);
        if (signal?.aborted) return [];
        if (exact) {
          return [{
            name: stripMcpToolCarrier(exact.name),
            summary: typeof exact.description === 'string'
              ? exact.description
              : `Connected external capability ${stripMcpToolCarrier(exact.name)}`,
            ...(exact.inputSchema !== undefined ? { schema: exact.inputSchema } : {}),
            carrier: 'work_call',
            score: 1,
          }];
        }
      }
      const server = getOrCreateExternalMcpServers({ ...scope, queryText: query });
      const tools = await server.listTools();
      if (signal?.aborted) return [];
      return tools.slice(0, limit).map((tool, index): ToolSearchBrokerCandidate => ({
        name: stripMcpToolCarrier(tool.name),
        summary: typeof tool.description === 'string'
          ? tool.description
          : `Connected external capability ${stripMcpToolCarrier(tool.name)}`,
        ...(tool.inputSchema !== undefined ? { schema: tool.inputSchema } : {}),
        carrier: 'work_call',
        score: boundedRank(index, Math.min(limit, tools.length)),
      }));
    },
  };

  /** Planning callers use one provider-neutral acquisition registry for both
   * native MCP and reviewed CLI reads. This replaces (rather than accompanies)
   * the legacy MCP source, so a single tool_search never lists the same MCP
   * server twice. The returned token is only a nomination; disclosure reopens
   * every fact from current host authority. */
  const liveReadRegistrySource: ToolSearchCandidateSource | null = planningIdentity
    ? (() => {
        const registry = createProductionLiveReadAcquisitionRegistry({
          adapterAllowed: (adapter) => liveReadAdapterAllowedByMcpScope(scope, adapter),
          nominationAllowed: (nomination) => liveReadNominationAllowedByMcpScope(scope, nomination),
        });
        return {
          kind: AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE,
          async search({ query, signal, deadlineAt }) {
            const guard = { signal, deadlineAt };
            if (!discoveryStillActive(guard)) return [];
            const queryDigest = createHash('sha256')
              .update(`${planningIdentity.sessionId}\0${planningIdentity.sourceUserSeq}\0${query}`, 'utf8')
              .digest('hex');
            const issue = (materialized: Parameters<typeof issueAuthorizedLiveReadPlanningAuthority>[0]['materialized']) => {
              const issued = issueAuthorizedLiveReadPlanningAuthority({
                identity: planningIdentity,
                materialized,
                publicationGuard: () => discoveryStillActive(guard),
              });
              if (!issued || !discoveryStillActive(guard)) return [];
              return [{
                name: issued.name,
                summary: `Current attested read capability ${issued.name}`,
                schema: issued.schema,
                carrier: 'work_call' as const,
                score: 1,
                planningAuthority: issued.authority,
              }];
            };
            // Exact-one across every MCP server plus CLI hides a unique
            // reviewed CLI when an unrelated carrier is slow, missing, or
            // unavailable. Cite the CLI first; it is local closed data.
            const cliOnly = createReviewedCliOnlyLiveReadRegistry({
              adapterAllowed: (adapter) => liveReadAdapterAllowedByMcpScope(scope, adapter),
              nominationAllowed: (nomination) => liveReadNominationAllowedByMcpScope(scope, nomination),
            });
            if (cliOnly) {
              const cliAcquired = await cliOnly.acquire({
                requirementId: `foreground-read-cli:${queryDigest}`,
                objective: query,
                effect: 'read',
              }, guard);
              if (!discoveryStillActive(guard)) return [];
              if (cliAcquired.status !== 'blocked') return issue(cliAcquired);
            }
            const acquired = await registry.acquire({
              requirementId: `foreground-read:${queryDigest}`,
              objective: query,
              effect: 'read',
            }, guard);
            if (!discoveryStillActive(guard)) return [];
            if (acquired.status === 'blocked') {
              if (
                acquired.reason === 'carrier_unavailable'
                || acquired.reason === 'live_unavailable'
              ) {
                throw new CandidateSourceUnavailableError('search_failed', acquired.detail);
              }
              if (acquired.reason === 'publication_expired') {
                throw new CandidateSourceUnavailableError(
                  'timed_out',
                  'the live-read acquisition deadline expired before authority could be published',
                );
              }
              return [];
            }
            return issue(acquired);
          },
        } satisfies ToolSearchCandidateSource;
      })()
    : null;

  const composio: ToolSearchCandidateSource = {
    kind: 'authorized_composio',
    async search({ query, signal, deadlineAt }) {
      if (signal?.aborted) return [];
      const exactOperation = exactComposioOperationFromQuery(query);
      if (exactOperation) {
        const exactToolkit = registeredToolkitOfSlug(exactOperation).trim().toLowerCase();
        const connectionDeadlineAt = exactDiscoveryDeadline(deadlineAt);
        const currentConnections = await freshConnectionsWithin({
          signal,
          deadlineAt: connectionDeadlineAt,
        });
        if (signal?.aborted) return [];
        if (
          currentConnections
          && !currentConnections.some((connection) => (
            connection.slug.trim().toLowerCase() === exactToolkit
            && /active|enabled|initiat/i.test(connection.status ?? '')
          ))
        ) {
          throw new CandidateSourceUnavailableError(
            'no_connections',
            `No current ${exactToolkit} connection can authorize ${exactOperation}.`,
            {
              kind: 'exact_capability_connection',
              toolkit: exactToolkit,
              capability: exactOperation,
              capabilityRef: `cap:resolved:${exactOperation.toLowerCase()}`,
            },
          );
        }
        const exact = await materializeNamedComposioOperation({
          operation: exactOperation,
          signal,
          deadlineAt,
        });
        if (signal?.aborted) return [];
        return exact.map((candidate): ToolSearchBrokerCandidate => ({
          name: candidate.slug,
          summary: candidate.description?.trim()
            || `${candidate.name} (${candidate.toolkit})`,
          schema: candidate.inputParameters,
          carrier: 'work_call',
          score: composioDiscoveryScore(1, registeredToolkitOfSlug(candidate.slug), candidate.slug),
          invocation: {
            name: 'composio_execute_tool',
            fixedArgs: { tool_slug: candidate.slug },
            payloadField: 'arguments',
          },
          guidance: `Build the action arguments from this exact live schema. Invoke work_call with inner name composio_execute_tool; set tool_slug to ${candidate.slug} and serialize the action arguments into the arguments field.`,
        }));
      }
      // A strict confident Tool Memory hit gets one exact provider
      // revalidation and no fuzzy request. Account resolution intentionally
      // remains in stageDisclosedPlanningProviderCandidates, the sole boundary
      // that can mint a planning ref or report an account-choice blocker.
      const remembered = recallComposioForSearch(query, { limit: INDEX_NOMINATION_LIMIT });
      const rememberedWinner = receiptBackedRememberedWinner(query, remembered);
      const requestEffectScope = requestedCapabilityEffectScope(query);
      if (
        rememberedWinner
        && requestEffectScope !== 'write'
        && requestEffectScope !== 'mixed'
      ) {
        const exact = await materializeRememberedComposioOperations({
          matches: [rememberedWinner],
          signal,
          deadlineAt,
        });
        if (signal?.aborted) return [];
        if (exact.length > 0) {
          return exact.map((candidate, index): ToolSearchBrokerCandidate => ({
            name: candidate.slug,
            summary: candidate.description?.trim()
              || `${candidate.name} (${candidate.toolkit})`,
            schema: candidate.inputParameters,
            carrier: 'work_call',
            score: composioDiscoveryScore(
              boundedRank(index, exact.length),
              registeredToolkitOfSlug(candidate.slug),
              candidate.slug,
            ),
            invocation: {
              name: 'composio_execute_tool',
              fixedArgs: { tool_slug: candidate.slug },
              payloadField: 'arguments',
            },
            guidance: `Build the action arguments from this exact live schema. Invoke work_call with inner name composio_execute_tool; set tool_slug to ${candidate.slug} and serialize the action arguments into the arguments field.`,
          }));
        }
      }
      // Memory/index rows are ranking hints, never completeness or liveness
      // proof. Every admitted unresolved role gets exactly one bounded live
      // filtered search; only identifiers present in that response may be
      // returned or acquire a planning ref.
      const indexed = searchCapabilityOperations(query, {
        // Rank hints cover the same bounded provider window even when the
        // caller asks for the default eight-row first page.
        limit: 20,
        carrierKind: 'composio',
      });
      const indexScore = new Map(indexed.map((hit) => [
        hit.identifier.trim().toLowerCase(),
        hit.score,
      ]));
      // Fuzzy membership and exact advisory nomination are independent live
      // reads. Start them together so their budgets overlap instead of stacking
      // (the live Inbox canary spent the whole host window in this sequence).
      const [fuzzyOutcome, nominated, rememberedRead] = await Promise.all([
        awaitBounded({
          start: () => searchComposioBrokerCandidates(query, 20),
          signal,
          ...(deadlineAt !== undefined
            ? { deadlineAt: deadlineAt - PROVIDER_SOURCE_RETURN_MARGIN_MS }
            : {}),
        }),
        materializeIndexNominations({ query, signal, deadlineAt }),
        // A canonical read receipt may nominate the read phase of mixed work,
        // but it cannot replace bounded live discovery of the requested write.
        // Live calendar failure 2026-08-29: returning only the remembered
        // availability read hid OUTLOOK_CALENDAR_CREATE_EVENT before freeze.
        rememberedWinner && (requestEffectScope === 'write' || requestEffectScope === 'mixed')
          ? materializeRememberedComposioOperations({
              matches: [rememberedWinner],
              signal,
              deadlineAt,
            })
          : Promise.resolve([] as ComposioBrokerCandidate[]),
      ]);
      if (signal?.aborted) return [];
      const candidates = fuzzyOutcome.kind === 'settled' ? fuzzyOutcome.value : [];
      if (fuzzyOutcome.kind === 'failed' && nominated.length === 0) {
        throw fuzzyOutcome.error;
      }
      // Provider fuzzy rows win duplicate identity/order; nomination adds only
      // exact reach for rows fuzzy omitted.
      const seen = new Set<string>();
      const merged = [...candidates, ...rememberedRead, ...nominated].filter((candidate) => {
        const slug = candidate.slug.trim().toUpperCase();
        if (!slug || seen.has(slug)) return false;
        seen.add(slug);
        return true;
      });
      if (signal?.aborted) return [];
      return merged
        .map((candidate, index): ToolSearchBrokerCandidate => ({
          name: candidate.slug,
          summary: candidate.description?.trim()
            || `${candidate.name} (${candidate.toolkit})`,
          schema: candidate.inputParameters,
          carrier: 'work_call',
          // The provider result owns membership. Memory can only nudge the
          // ordering of those exact live rows, never add a missing row.
          score: composioDiscoveryScore(
            boundedRank(index, candidates.length)
              + Math.min(0.05, Math.max(0, indexScore.get(candidate.slug.toLowerCase()) ?? 0) * 0.05),
            registeredToolkitOfSlug(candidate.slug),
            candidate.slug,
          ),
          invocation: {
            name: 'composio_execute_tool',
            fixedArgs: { tool_slug: candidate.slug },
            payloadField: 'arguments',
          },
          guidance: `Build the action arguments from this exact live schema. Invoke work_call with inner name composio_execute_tool; set tool_slug to ${candidate.slug} and serialize the action arguments into the arguments field.`,
        }))
        .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.name.localeCompare(right.name))
        // Keep the broker's full bounded snapshot. tool_search owns visible
        // page size/cursors; truncating here made provider rank nine impossible
        // to recover without another physical discovery epoch.
        .slice(0, 20);
    },
  };

  // A planning surface must never mount both native-MCP discovery paths. The
  // metadata-only legacy source remains solely for callers that do not own a
  // primary planning identity yet.
  return [liveReadRegistrySource ?? externalMcp, composio];
}
