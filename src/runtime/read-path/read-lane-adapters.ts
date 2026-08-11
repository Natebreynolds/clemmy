/**
 * Production adapters for the accepted-turn warm-read resolver.
 *
 * The production factory first performs a local deterministic artifact match.
 * Ordinary messages therefore do not list accounts, load schemas, or approach
 * a provider. A possible warm hit then derives one canonical stable-account
 * scope and every actual Composio call crosses the governed gateway.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  listUsableConnectedToolkits,
  type ConnectedToolkit,
} from '../../integrations/composio/client.js';
import { registeredToolkitOfSlug } from '../../integrations/composio/toolkit-slug.js';
import { classifyComposioSlugEffect } from '../../integrations/composio/slug-effect.js';
import { detectJobReceipt } from '../../integrations/composio/async-job.js';
import {
  parseProcedureArtifactDocument,
  quarantineWarmProcedureArtifact,
  type DurableReceiptRecord,
} from '../../memory/procedure-receipts.js';
import type { ProcedureArtifact, ProcedureScope } from '../../memory/procedure-artifact.js';
import { listActiveArtifactRows } from '../../memory/procedure-store.js';
import { settlementCarriesVerifiedData } from '../../memory/verified-read-learning.js';
import { dispatchComposioTool } from '../../tools/composio-tools.js';
import {
  ensureLiveComposioSchemaFingerprint,
  liveComposioSchemaFingerprint,
  type LiveSchemaProviderRefresh,
  type LiveSchemaProviderRefreshObserver,
} from '../../tools/composio-schema-cache.js';
import { appendEvent, listEvents } from '../harness/eventlog.js';
import { currentAcceptedReadAuthority } from './accepted-read-authority.js';
import { eventLogReceiptResolver } from './event-log-read-receipts.js';
import {
  matchWarmCandidate,
  type AcceptedTurnReadPorts,
  type AcceptedTurnReadArtifactAuthority,
} from './read-lane-chat.js';
import type { BoundReadDispatch } from './read-envelope.js';
import {
  canonicalProcedureScope,
  isCanonicalProcedureScope,
  normalizeProcedureAccountIdentity,
} from './procedure-scope.js';
import { warmReadToolPolicyDigest } from './warm-read-policy.js';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

export const WARM_READ_PRESENTATION_MAX_CHARS = 4_000;

const WARM_READ_PRESENTATION_HEADER = "Here's what I found:";
const WARM_READ_PRESENTATION_OMISSION = '... (additional results omitted)';
const COMMON_EVIDENCE_KEYS = new Set(['data', 'result', 'results', 'items']);
type StoredWarmReadEvidenceEncoding = 'text-v1' | 'json-v1';

interface StoredWarmReadEvidence {
  summary: string;
  encoding: StoredWarmReadEvidenceEncoding;
}

function serializableSummary(value: unknown): StoredWarmReadEvidence | undefined {
  if (typeof value === 'string') return { summary: value, encoding: 'text-v1' };
  try {
    const summary = JSON.stringify(value);
    return typeof summary === 'string' ? { summary, encoding: 'json-v1' } : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isScalar(value: unknown): boolean {
  return value === null
    || value === undefined
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'bigint';
}

function successfulEnvelopeMetadata(key: string, value: unknown): boolean {
  switch (key.toLowerCase()) {
    case 'success':
    case 'successful':
    case 'ok':
      return value === true || value === 1 || /^(true|ok|success|successful)$/i.test(String(value));
    case 'status':
      return /^(ok|success|successful|complete|completed)$/i.test(String(value));
    case 'error':
      return value === null || value === undefined || value === '';
    default:
      return false;
  }
}

/** Remove only generic, positively-successful transport envelopes. Content
 * metadata such as totals and pagination remains visible instead of being
 * silently discarded. */
function unwrapCommonEvidence(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 8 && isRecord(current); depth += 1) {
    const entries = Object.entries(current);
    const contentEntries = entries.filter(([key]) => COMMON_EVIDENCE_KEYS.has(key.toLowerCase()));
    if (contentEntries.length !== 1) break;
    const [contentKey, contentValue] = contentEntries[0]!;
    const metadata = entries.filter(([key]) => key !== contentKey);
    if (metadata.length > 0 && !metadata.every(([key, item]) => successfulEnvelopeMetadata(key, item))) break;
    current = contentValue;
  }
  return current;
}

function presentationLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) return 'Value';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function scalarText(value: unknown): string {
  if (value === null) return 'None';
  if (value === undefined) return 'Not provided';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value || '(empty)';
  return String(value);
}

const MARKDOWN_INLINE_SPECIALS = new Set(['\\', '`', '*', '_', '[', ']', '{', '}', '|']);

function escapeMarkdownInline(value: string): string {
  let escaped = '';
  for (const character of value) {
    if (MARKDOWN_INLINE_SPECIALS.has(character)) escaped += `\\${character}`;
    else if (character === '&') escaped += '&amp;';
    else if (character === '<') escaped += '&lt;';
    else if (character === '>') escaped += '&gt;';
    else escaped += character;
  }
  return escaped;
}

function inlineScalarText(value: unknown): string {
  return escapeMarkdownInline(scalarText(value));
}

function isMultilineString(value: unknown): value is string {
  return typeof value === 'string' && /[\r\n]/.test(value);
}

/** Indented code blocks preserve every content byte while keeping structured
 * provider text inert in Markdown. The prefix is presentation structure only. */
function renderMultilineTextBlock(value: string, depth: number): string {
  const prefix = `${'  '.repeat(depth)}    `;
  return `${prefix}${value.replace(/\r\n|\r|\n/g, (separator) => `${separator}${prefix}`)}`;
}

function tableCell(value: unknown): string {
  return inlineScalarText(value);
}

function renderSimpleTable(values: unknown[]): string | undefined {
  if (values.length < 2 || !values.every(isRecord)) return undefined;
  const rows = values as Array<Record<string, unknown>>;
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  if (columns.length === 0 || columns.length > 6) return undefined;
  if (!rows.every((row) => columns.every((column) => !(column in row)
    || (isScalar(row[column]) && !isMultilineString(row[column]))))) {
    return undefined;
  }
  const header = `| ${columns.map((column) => tableCell(presentationLabel(column))).join(' | ')} |`;
  const separator = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((column) => tableCell(row[column])).join(' | ')} |`);
  return [header, separator, ...body].join('\n');
}

function renderNestedEvidence(value: unknown, depth = 0): string {
  const indent = '  '.repeat(depth);
  if (isMultilineString(value)) {
    return `${indent}- Text:\n\n${renderMultilineTextBlock(value, depth + 1)}`;
  }
  if (isScalar(value)) return `${indent}- ${inlineScalarText(value)}`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}- No results found.`;
    return value.map((item, index) => {
      if (isMultilineString(item)) {
        return `${indent}- Text:\n\n${renderMultilineTextBlock(item, depth + 1)}`;
      }
      if (isScalar(item)) return `${indent}- ${inlineScalarText(item)}`;
      return `${indent}- Result ${index + 1}:\n${renderNestedEvidence(item, depth + 1)}`;
    }).join('\n');
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${indent}- No details were returned.`;
    return entries.map(([key, item]) => {
      const label = escapeMarkdownInline(presentationLabel(key));
      if (isMultilineString(item)) {
        return `${indent}- ${label}:\n\n${renderMultilineTextBlock(item, depth + 1)}`;
      }
      if (isScalar(item)) return `${indent}- ${label}: ${inlineScalarText(item)}`;
      if (Array.isArray(item) && item.length === 0) return `${indent}- ${label}: No results found.`;
      if (isRecord(item) && Object.keys(item).length === 0) return `${indent}- ${label}: No details were returned.`;
      return `${indent}- ${label}:\n${renderNestedEvidence(item, depth + 1)}`;
    }).join('\n');
  }
  return `${indent}- ${inlineScalarText(String(value))}`;
}

function safeMarkdownCutIndex(text: string, requestedIndex: number): number {
  let cut = Math.max(0, Math.min(requestedIndex, text.length));

  // Never leave half of a UTF-16 surrogate pair at the public boundary.
  const priorCodeUnit = cut > 0 ? text.charCodeAt(cut - 1) : 0;
  const nextCodeUnit = cut < text.length ? text.charCodeAt(cut) : 0;
  if (priorCodeUnit >= 0xD800 && priorCodeUnit <= 0xDBFF
    && nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF) {
    cut -= 1;
  }

  // The only HTML entities this presenter emits. If the bound falls inside
  // one, omit the whole entity so its raw fragment never reaches the renderer.
  const lastAmpersand = text.lastIndexOf('&', cut - 1);
  if (lastAmpersand >= 0) {
    const fragment = text.slice(lastAmpersand, cut);
    if (['&amp;', '&lt;', '&gt;'].some((entity) => entity !== fragment && entity.startsWith(fragment))) {
      cut = lastAmpersand;
    }
  }

  // An odd trailing run is a half Markdown escape. Back up over its final
  // slash instead of allowing it to consume the omission marker/newline.
  let slashCount = 0;
  for (let index = cut - 1; index >= 0 && text[index] === '\\'; index -= 1) slashCount += 1;
  if (slashCount % 2 === 1) cut -= 1;
  return Math.max(0, cut);
}

function hasUnsafePresentationDepth(value: unknown, depth = 0, seen = new WeakSet<object>()): boolean {
  if (isScalar(value)) return false;
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  if (depth >= 6) return true;
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return children.some((child) => hasUnsafePresentationDepth(child, depth + 1, seen));
}

function boundReadableMarkdown(text: string): string {
  if (text.length <= WARM_READ_PRESENTATION_MAX_CHARS) return text;
  const suffix = `\n\n${WARM_READ_PRESENTATION_OMISSION}`;
  const available = WARM_READ_PRESENTATION_MAX_CHARS - suffix.length;
  const lastNewline = text.lastIndexOf('\n', Math.max(0, available - 1));
  const requestedCut = lastNewline > Math.floor(available / 2) ? lastNewline : available;
  const cut = safeMarkdownCutIndex(text, requestedCut);
  return `${text.slice(0, cut).trimEnd()}${suffix}`;
}

function renderPrettyFallback(value: unknown): string {
  let pretty: string;
  try {
    pretty = JSON.stringify(value, null, 2) ?? scalarText(value);
  } catch {
    pretty = 'The verified result could not be expanded into a simpler structure.';
  }
  // JSON.stringify always quotes string content, so provider text cannot
  // begin a line with this fence and prematurely close the block.
  const fence = '```';
  const complete = `${WARM_READ_PRESENTATION_HEADER}\n\n${fence}json\n${pretty}\n${fence}`;
  if (complete.length <= WARM_READ_PRESENTATION_MAX_CHARS) return complete;

  // A truncated JSON document must not masquerade as valid JSON. Keep the
  // fence balanced and label the bounded excerpt as text.
  const prefix = `${WARM_READ_PRESENTATION_HEADER}\n\n${fence}text\n`;
  const suffix = `\n${WARM_READ_PRESENTATION_OMISSION}\n${fence}`;
  const available = Math.max(0, WARM_READ_PRESENTATION_MAX_CHARS - prefix.length - suffix.length);
  const excerpt = pretty.slice(0, safeMarkdownCutIndex(pretty, available));
  return `${prefix}${excerpt.trimEnd()}${suffix}`;
}

/** Provider-neutral, zero-model presentation for verified warm evidence.
 * Already-natural strings (including strings inside generic success wrappers)
 * remain byte-for-byte unchanged. Structured evidence becomes bounded,
 * readable Markdown rather than a one-line provider JSON envelope. */
export function presentWarmReadEvidence(value: unknown): string {
  const evidence = unwrapCommonEvidence(value);
  if (typeof evidence === 'string') return evidence;
  if (hasUnsafePresentationDepth(evidence)) return renderPrettyFallback(evidence);

  let body: string;
  if (Array.isArray(evidence)) {
    if (evidence.length === 0) body = 'No results found.';
    else body = renderSimpleTable(evidence)
      ?? (evidence.length === 1 && isRecord(evidence[0])
        ? renderNestedEvidence(evidence[0])
        : renderNestedEvidence(evidence));
  } else if (isRecord(evidence)) {
    body = Object.keys(evidence).length === 0 ? 'No details were returned.' : renderNestedEvidence(evidence);
  } else {
    body = scalarText(evidence);
  }
  return boundReadableMarkdown(`${WARM_READ_PRESENTATION_HEADER}\n\n${body}`);
}

export { eventLogReceiptResolver } from './event-log-read-receipts.js';

type GovernedDispatch = typeof dispatchComposioTool;

/**
 * Build ports for one already-accepted source. Callers supply derived
 * identity/catalog truth; the adapter rechecks all of it at the gateway's
 * immediate provider boundary.
 */
export function buildProductionReadPorts(input: {
  sessionId: string;
  sourceUserSeq: number;
  sourceTurn: number;
  attemptId: string;
  runId?: string | null;
  userInput: string;
  scope: ProcedureScope;
  authorizedArtifact: AcceptedTurnReadArtifactAuthority;
  /** Exact live connection ids observed for this stable account/toolkit before
   * activation. The gateway may choose one of these, never a default route. */
  connectedAccountIds: ReadonlySet<string>;
  liveSchemaFingerprint(identifier: string): string | undefined;
  accountConnected(): boolean;
  cancellationRequested?(): boolean | Promise<boolean>;
  warmPolicyDigest?: string;
  dispatchTool?: GovernedDispatch;
  clock?: () => number;
}): AcceptedTurnReadPorts {
  const receipts = eventLogReceiptResolver(input.sessionId);
  const expectedAcceptedSource = `${input.sessionId}:${input.sourceUserSeq}`;
  const dispatchTool = input.dispatchTool ?? dispatchComposioTool;
  return {
    scope: () => input.scope,
    authorizedArtifact: () => input.authorizedArtifact,
    liveSchemaFingerprint: input.liveSchemaFingerprint,
    accountConnected: input.accountConnected,
    receipts,
    async dispatch(bound: BoundReadDispatch) {
      const authorized = input.authorizedArtifact;
      if (bound.identifier !== authorized.identifier
        || bound.provider !== authorized.provider
        || bound.operation !== authorized.operation
        || bound.schemaFingerprint !== authorized.schemaFingerprint
        || bound.tenant !== authorized.scope.tenant
        || bound.workspace !== authorized.scope.workspace
        || bound.accountIdentity !== authorized.scope.accountIdentity
        || authorized.kind !== 'composio') {
        return { error: 'bound dispatch differs from the production-authorized artifact', transient: false };
      }
      if (classifyComposioSlugEffect(bound.identifier) !== 'read') {
        return { error: 'live taxonomy no longer classifies the procedure as a read', transient: false };
      }
      if (await input.cancellationRequested?.()) {
        return { error: 'accepted warm-read attempt was cancelled', transient: false };
      }
      if (bound.acceptedSource !== expectedAcceptedSource
        || bound.accountIdentity !== input.scope.accountIdentity
        || bound.tenant !== input.scope.tenant
        || bound.workspace !== input.scope.workspace
        || bound.effectClass !== 'read') {
        return { error: 'bound warm-read identity does not match the accepted source scope', transient: false };
      }
      if (input.liveSchemaFingerprint(bound.identifier) !== bound.schemaFingerprint) {
        return { error: 'live schema authority changed before governed dispatch', transient: false };
      }

      let crossedAuthorizedBoundary = false;
      const canonicalCallId = `warmread_${randomUUID()}`;
      let calledEvent: ReturnType<typeof appendEvent> | undefined;
      let lifecycleClosed = false;
      const closeLifecycle = (ok: boolean, details: Record<string, unknown>): void => {
        if (!calledEvent || lifecycleClosed) return;
        lifecycleClosed = true;
        appendEvent({
          sessionId: input.sessionId,
          turn: input.sourceTurn,
          role: 'system',
          type: 'tool_returned',
          parentEventId: calledEvent.id,
          data: {
            sourceUserSeq: input.sourceUserSeq,
            attemptId: input.attemptId,
            acceptedSource: expectedAcceptedSource,
            tool: 'composio_execute_tool',
            effectiveTool: bound.identifier,
            toolSlug: bound.identifier,
            callId: canonicalCallId,
            canonicalCallId,
            accounting: 'top_level',
            effect: 'read',
            warmRead: true,
            warmReadPolicyDigest: input.warmPolicyDigest,
            ok,
            ...details,
          },
        });
      };
      try {
        calledEvent = appendEvent({
          sessionId: input.sessionId,
          turn: input.sourceTurn,
          role: 'system',
          type: 'tool_called',
          data: {
            sourceUserSeq: input.sourceUserSeq,
            attemptId: input.attemptId,
            acceptedSource: expectedAcceptedSource,
            tool: 'composio_execute_tool',
            effectiveTool: bound.identifier,
            toolSlug: bound.identifier,
            callId: canonicalCallId,
            canonicalCallId,
            accounting: 'top_level',
            effect: 'read',
            warmRead: true,
            warmReadPolicyDigest: input.warmPolicyDigest,
            accountIdentity: bound.accountIdentity,
            // Runtime-owned identity only. Historical argument values do not
            // become a second learning/replay channel through telemetry.
            arguments: { tool_slug: bound.identifier },
          },
        });
        const outcome = await dispatchTool(bound.identifier, bound.args, {
          sessionId: input.sessionId,
          userInput: input.userInput,
          preferredIdentity: bound.accountIdentity,
          strictPreferredIdentity: true,
          dispatchBoundary: async (context, providerDispatch) => {
            const authority = currentAcceptedReadAuthority(
              input.sessionId,
              input.sourceUserSeq,
              input.runId ?? undefined,
              input.userInput,
            );
            if (!authority || authority.attempt.attemptId !== input.attemptId) {
              throw new Error('accepted source no longer owns the current active attempt');
            }
            if (await input.cancellationRequested?.()) {
              throw new Error('accepted warm-read attempt was cancelled');
            }
            if (classifyComposioSlugEffect(bound.identifier) !== 'read') {
              throw new Error('live taxonomy no longer classifies the procedure as a read');
            }
            let resolvedIdentity = '';
            try { resolvedIdentity = normalizeProcedureAccountIdentity(context.identity); } catch { /* refused below */ }
            if (context.toolSlug !== bound.identifier
              || !context.connectionId
              || !input.connectedAccountIds.has(context.connectionId)
              || resolvedIdentity !== bound.accountIdentity) {
              throw new Error('gateway resolved a different stable account identity');
            }
            if (context.schemaFingerprint !== bound.schemaFingerprint
              || input.liveSchemaFingerprint(bound.identifier) !== bound.schemaFingerprint) {
              throw new Error('live schema authority changed at the provider boundary');
            }
            crossedAuthorizedBoundary = true;
            return providerDispatch();
          },
        });
        if (!outcome.ok) {
          closeLifecycle(false, {
            error: `governed gateway declined: ${outcome.reason}`,
            providerDispatched: crossedAuthorizedBoundary,
          });
          return {
            error: `governed gateway declined: ${outcome.reason}`,
            transient: false,
            ...(crossedAuthorizedBoundary ? { providerDispatched: true } : {}),
          };
        }
        if (!crossedAuthorizedBoundary) {
          closeLifecycle(false, { error: 'governed gateway did not cross the accepted-source boundary', providerDispatched: false });
          return { error: 'governed gateway did not cross the accepted-source boundary', transient: false };
        }
        // Deterministic cold/warm presentation-parity failures are properties
        // of this exact artifact, not source-owned evidence. Classify and
        // quarantine before the post-I/O authority check so Stop/supersession
        // cannot leave a known paid-loop artifact active for a fresh source.
        let resolvedIdentity = '';
        try { resolvedIdentity = normalizeProcedureAccountIdentity(outcome.identity); } catch { /* parity failure below */ }
        const returnedAsyncJob = Boolean(detectJobReceipt(bound.identifier, outcome.result));
        const returnedVerifiedData = settlementCarriesVerifiedData(outcome.result);
        const evidenceSummary = returnedVerifiedData && !returnedAsyncJob
          ? serializableSummary(outcome.result)
          : undefined;
        const parityFailure = resolvedIdentity !== bound.accountIdentity
          ? 'provider result is not bound to the admitted stable account'
          : returnedAsyncJob
            ? 'provider result is an async job handle, not settled read evidence'
            : !returnedVerifiedData
              ? 'provider result is not settled read evidence'
              : evidenceSummary === undefined
                ? 'provider result cannot be recorded as durable read evidence'
                : evidenceSummary.summary.length > WARM_READ_PRESENTATION_MAX_CHARS
                  ? 'provider result exceeds the bounded durable warm-read evidence limit'
                  : undefined;
        const parityArtifactQuarantined = Boolean(parityFailure) && quarantineWarmProcedureArtifact(
          authorized.artifactId,
          `warm execution parity failure: ${parityFailure}`,
        );
        // Provider I/O may outlive its admitting attempt. Never convert a
        // result into receipt/credit after Stop or supersession; report a
        // SPENT read so the bridge also knows not to re-run a brain/provider.
        const postDispatchAuthority = currentAcceptedReadAuthority(
          input.sessionId,
          input.sourceUserSeq,
          input.runId ?? undefined,
          input.userInput,
        );
        if (!postDispatchAuthority
          || postDispatchAuthority.attempt.attemptId !== input.attemptId
          || await input.cancellationRequested?.()) {
          closeLifecycle(false, {
            error: 'accepted source lost authority while the provider read was in flight',
            providerDispatched: true,
            ...(parityFailure ? { artifactQuarantined: parityArtifactQuarantined } : {}),
          });
          return {
            error: 'accepted source lost authority while the provider read was in flight',
            transient: false,
            providerDispatched: true,
          };
        }
        if (parityFailure) {
          closeLifecycle(false, {
            error: parityFailure,
            providerDispatched: true,
            artifactQuarantined: parityArtifactQuarantined,
          });
          return {
            error: parityFailure,
            transient: false,
            providerDispatched: true,
          };
        }
        const { summary, encoding } = evidenceSummary!;
        const record: DurableReceiptRecord = {
          receiptId: `readrcpt_${randomUUID()}`,
          at: new Date().toISOString(),
          provider: bound.provider,
          operation: bound.operation,
          effectClass: 'read',
          identifier: bound.identifier,
          schemaFingerprint: bound.schemaFingerprint,
          scope: {
            tenant: bound.tenant,
            workspace: bound.workspace,
            accountIdentity: bound.accountIdentity,
          },
          dispatchOutcome: 'succeeded',
          readEvidenceRef: `evt:${sha256(summary).slice(0, 24)}`,
        };
        appendEvent({
          sessionId: input.sessionId,
          turn: input.sourceTurn,
          role: 'system',
          type: 'read_receipt',
          data: {
            record,
            sourceUserSeq: input.sourceUserSeq,
            attemptId: input.attemptId,
            // Bounded evidence summary; the receipt carries the digest/ref.
            evidenceSummary: summary,
            evidenceEncoding: encoding,
          },
        });
        closeLifecycle(true, { receiptId: record.receiptId, providerDispatched: true });
        return { receiptId: record.receiptId };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try { closeLifecycle(false, { error: message.slice(0, 400), providerDispatched: crossedAuthorizedBoundary }); } catch { /* receipt failure stays fail closed */ }
        return {
          error: message,
          transient: false,
          ...(crossedAuthorizedBoundary ? { providerDispatched: true } : {}),
        };
      }
    },
    async present(evidence: DurableReceiptRecord) {
      try {
        for (const event of listEvents(input.sessionId)) {
          if (event.type !== 'read_receipt') continue;
          const data = event.data as {
            record?: DurableReceiptRecord;
            evidenceSummary?: string;
            evidenceEncoding?: StoredWarmReadEvidenceEncoding;
          } | undefined;
          if (data?.record?.receiptId === evidence.receiptId && data.evidenceSummary) {
            if (data.evidenceEncoding === 'json-v1') {
              return { draft: presentWarmReadEvidence(JSON.parse(data.evidenceSummary) as unknown) };
            }
            if (data.evidenceEncoding === 'text-v1') {
              // Never reinterpret a natural JSON-looking string.
              return { draft: data.evidenceSummary };
            }
            if (data.evidenceEncoding === undefined) {
              // Receipts written before typed encodings treated their bounded
              // summary as the final draft, even when it looked like JSON.
              return { draft: data.evidenceSummary };
            }
            throw new Error('verified receipt has no typed evidence encoding');
          }
        }
      } catch { /* fall through to the typed failure below */ }
      throw new Error('verified receipt has no stored evidence summary');
    },
    clock: input.clock,
  };
}

interface ProductionReadAdapterDependencies {
  listConnections: () => Promise<ConnectedToolkit[]>;
  dispatchTool: GovernedDispatch;
  liveFingerprint: (identifier: string) => string | undefined;
  ensureLiveFingerprint: (
    identifier: string,
    observer?: LiveSchemaProviderRefreshObserver,
  ) => Promise<string | undefined>;
}

const DEFAULT_DEPENDENCIES: ProductionReadAdapterDependencies = {
  listConnections: () => listUsableConnectedToolkits(),
  dispatchTool: dispatchComposioTool,
  liveFingerprint: liveComposioSchemaFingerprint,
  ensureLiveFingerprint: ensureLiveComposioSchemaFingerprint,
};

let productionDependencies = DEFAULT_DEPENDENCIES;

/** Focused test seam below the bridge; production still uses the real factory. */
export function _setProductionReadAdapterDependenciesForTests(
  dependencies: Partial<ProductionReadAdapterDependencies> | null,
): void {
  productionDependencies = dependencies ? { ...DEFAULT_DEPENDENCIES, ...dependencies } : DEFAULT_DEPENDENCIES;
}

function matchingComposioArtifacts(message: string): ProcedureArtifact[] {
  return listActiveArtifactRows()
    .map((document) => parseProcedureArtifactDocument(document))
    .filter((parsed): parsed is Extract<typeof parsed, { ok: true }> => parsed.ok)
    .map((parsed) => parsed.artifact)
    .filter((artifact) => artifact.effectClass === 'read'
      && artifact.kind === 'composio'
      && Boolean(artifact.scope.accountIdentity)
      && isCanonicalProcedureScope(artifact.scope)
      && Boolean(matchWarmCandidate(message, [artifact])));
}

/** Warm execution requires positive connected truth. Substring checks admit
 * `INACTIVE`; in-progress initiation is useful to the interactive reconnect
 * UI but is not autonomous dispatch authority. */
function warmConnectionStatusIsUsable(status: unknown): boolean {
  return /^(active|enabled)$/i.test(String(status ?? '').trim());
}

/**
 * Async production factory used by the bridge without injection. It performs
 * only local artifact matching for unrelated messages. Provider connection
 * truth is consulted solely for an unambiguous, canonical warm candidate.
 */
export async function buildProductionReadPortsForAcceptedTurn(input: {
  sessionId: string;
  sourceUserSeq: number;
  sourceTurn: number;
  attemptId: string;
  runId?: string | null;
  message: string;
  allowedToolNames?: readonly string[];
  excludedToolNames?: readonly string[];
  cancellationRequested?(): boolean | Promise<boolean>;
}): Promise<AcceptedTurnReadPorts | null> {
  try {
    const matches = matchingComposioArtifacts(input.message);
    if (matches.length !== 1) return null;

    const candidate = matches[0]!;
    if (input.excludedToolNames?.some((name) =>
      name === 'composio_execute_tool' || name === candidate.identifier)) return null;
    if (input.allowedToolNames
      && !input.allowedToolNames.includes('composio_execute_tool')) return null;

    const accountIdentities = new Set(matches.map((artifact) => artifact.scope.accountIdentity));
    if (accountIdentities.size !== 1) return null;
    const accountIdentity = [...accountIdentities][0]!;
    const scope = canonicalProcedureScope(accountIdentity);

    // Unknown or drifted catalog authority is a local decline. On restart, one
    // exact-slug metadata refresh may restore the still-governed authority;
    // require it to populate the boundary-visible accessor rather than trusting
    // an uncorroborated return value from the refresh operation itself.
    let liveFingerprint = productionDependencies.liveFingerprint(candidate.identifier);
    if (!liveFingerprint) {
      await productionDependencies.ensureLiveFingerprint(candidate.identifier, (refresh: LiveSchemaProviderRefresh) => {
        const outcome = refresh.outcome === 'refreshed'
          ? refresh.fingerprint === candidate.schemaFingerprint ? 'matched' : 'mismatched'
          : refresh.outcome;
        appendEvent({
          sessionId: input.sessionId,
          turn: input.sourceTurn,
          role: 'system',
          type: 'warm_schema_metadata_refresh',
          data: {
            sourceUserSeq: input.sourceUserSeq,
            attemptId: input.attemptId,
            artifactId: candidate.artifactId,
            durationMs: Math.max(0, Math.round(refresh.durationMs)),
            outcome,
          },
        });
      });
      liveFingerprint = productionDependencies.liveFingerprint(candidate.identifier);
    }
    if (liveFingerprint !== candidate.schemaFingerprint) {
      return null;
    }
    if (classifyComposioSlugEffect(candidate.identifier) !== 'read') return null;
    if (await input.cancellationRequested?.()) return null;
    const candidateToolkit = registeredToolkitOfSlug(candidate.identifier);

    // Account truth is consulted only after exact schema authority. Ordinary
    // chat returned above without any network work; a restart miss may have
    // performed one exact-slug metadata lookup before this point.
    const connections = await productionDependencies.listConnections();
    if (await input.cancellationRequested?.()) return null;
    const matchingConnections = connections.filter((connection) => {
      if (!warmConnectionStatusIsUsable(connection.status)) return false;
      const connectionToolkit = connection.slug.trim().toLowerCase().replace(/[-\s]+/g, '_');
      if (connectionToolkit !== candidateToolkit) return false;
      try {
        return normalizeProcedureAccountIdentity(connection.accountEmail) === accountIdentity;
      } catch {
        return false;
      }
    });
    const connected = matchingConnections.length > 0;
    if (!connected) return null;

    return buildProductionReadPorts({
      ...input,
      userInput: input.message,
      scope,
      authorizedArtifact: {
        artifactId: candidate.artifactId,
        kind: candidate.kind,
        identifier: candidate.identifier,
        provider: candidate.provider,
        operation: candidate.operation,
        schemaFingerprint: candidate.schemaFingerprint,
        scope: { ...candidate.scope },
      },
      connectedAccountIds: new Set(matchingConnections.map((connection) => connection.connectionId)),
      accountConnected: () => connected,
      liveSchemaFingerprint: productionDependencies.liveFingerprint,
      dispatchTool: productionDependencies.dispatchTool,
      warmPolicyDigest: warmReadToolPolicyDigest(input),
    });
  } catch {
    return null;
  }
}
