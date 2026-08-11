import { createHash } from 'node:crypto';
import { formatComposioCliDefaultReadAccountRoute } from '../../integrations/composio/account-route.js';
import { registeredToolkitOfSlug } from '../../integrations/composio/toolkit-slug.js';
import { currentAcceptedReadAuthority } from '../read-path/accepted-read-authority.js';
import {
  listEvents,
  resolveToolOutputsForAuthority,
  type EventRow,
} from './eventlog.js';
import { extractCompleteJsonObjects, extractJsonCandidate } from './json-repair.js';
import { isDirectionSeekingQuestion, isPromiseShapedReply } from './objective-judge.js';
import {
  classifySettledDirectComposioRead,
  formatSettledReadSuccessAdvisory,
} from './settled-read-repeat.js';
import { projectCanonicalTopLevelToolEvents } from './tool-effect.js';
import {
  completionEvidenceToolName,
  isControlOnlyTool,
  isToolSurfaceProbeTool,
  objectiveRequiresFreshExternalWrite,
  objectiveRequiresMutatingEvidence,
  singleSuccessfulCollectionReadCompletesObjective,
  singleSuccessfulCollectionReadHasNoHardMultiplicity,
  toolOutputLooksSuccessful,
} from './tool-evidence.js';
import { assertPublicPresentationText } from './turn-outcome.js';
import { matchesBlockedText } from './verify-delivered.js';
import {
  authoritativePresentationLineMask,
  parseAuthoritativeMarkdownTables,
  parseCollectionCountHeading,
  parseCollectionStatusSummary,
  parseReadNavigationHeading,
  parseScopedProviderSnapshotBlocks,
  presentationRequiresSemanticJudge,
} from './presentation-authority.js';
import {
  parseReadHistoryClaims,
  validateReadHistoryClaims,
  type ReadHistorySnapshot,
} from './read-history-claims.js';
import { resolveLatestTrustedPriorVerifiedRead } from './verified-read-history.js';

export interface ExactVerifiedReadCompletionCertificate {
  version: 1;
  kind: 'single_collection_read' | 'read_discovery_scaffold';
  sourceUserSeq: number;
  attemptId: string;
  callId: string;
  toolName: string;
  outputDigest: string;
  objectiveDigest: string;
  presentationDigest: string;
}

export interface ExactVerifiedReadCompletionInput {
  sessionId: string;
  sourceUserSeq: number | undefined;
  turn: number;
  runAttemptId: string | undefined;
  acceptedUserInput: string;
  objective: string;
  reply: string;
  openApprovalCard: boolean;
}

interface ExactReadOccurrence {
  call: EventRow;
  returned: EventRow;
  callId: string;
  outerTool: string;
  effectiveTool: string;
  args: unknown;
  output: string;
}

const PENDING_COLLECTION_KEYS = new Set([
  'continuation_token',
  'continuationtoken',
  'end_cursor',
  'endcursor',
  'has_more',
  'hasmore',
  'has_next',
  'hasnext',
  'has_next_page',
  'hasnextpage',
  'next_cursor',
  'nextcursor',
  'next_link',
  'nextlink',
  'next_page',
  'nextpage',
  'next_page_token',
  'nextpagetoken',
  'next_url',
  'nexturl',
  'odata_next_link',
  'odatanextlink',
  'partial',
  'partial_page',
  'partialpage',
  'truncated',
]);
const PAGINATION_CONTAINER_KEYS = new Set([
  'links',
  'page_info',
  'pageinfo',
  'pagination',
  'paging',
]);
const PAGE_TOTAL_KEYS = new Set([
  'page_count',
  'pagecount',
  'pages',
  'total_pages',
  'totalpages',
]);
const OUTPUT_FAILURE_LINE_RE =
  /(?:^|[\r\n])\s*(?:[\u26a0\ufe0f]+\s*)?(?:(?:ERROR|FAILED|FAILURE|NOT CONNECTED)\b|HTTP\s+[45]\d{2}\b|(?:Authentication required|Forbidden|Permission denied|Provider unavailable|Rate limit(?:ed| exceeded)?|Request timed out|Unauthorized)\b|\[provider-dispatch:[^\]]*(?:fail|error|denied|reject)[^\]]*\]|An error occurred while running the tool\b|Tool call (?:refused|blocked) by harness\b|MCP error\b)/i;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function eventData(event: EventRow): Record<string, unknown> {
  return event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : {};
}

function eventText(event: EventRow, key: string): string {
  const value = eventData(event)[key];
  return typeof value === 'string' ? value.trim() : '';
}

function eventSourceUserSeq(event: EventRow): number | null {
  const value = eventData(event).sourceUserSeq;
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function toolCallInput(call: EventRow): unknown {
  const data = eventData(call);
  const raw = data.args ?? data.arguments;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw) as unknown; } catch { return undefined; }
}

function effectiveToolName(call: EventRow): string {
  const durable = eventText(call, 'effectiveTool');
  if (durable) return durable;
  return completionEvidenceToolName(eventText(call, 'tool'), toolCallInput(call));
}

function readExplicitlyUsesNoConnectedAccount(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const record = args as Record<string, unknown>;
  for (const key of ['connected_account_id', 'connectedAccountId']) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    return record[key] === null;
  }
  return false;
}

function parseLeadingRecord(
  output: string,
  expectedToolName: string,
  options: { allowReadRoutingRemainder?: boolean } = {},
): Record<string, unknown> | null {
  const candidate = extractJsonCandidate(output);
  if (!candidate) return null;
  const candidateAt = output.lastIndexOf(candidate);
  if (candidateAt < 0) return null;
  const before = output.slice(0, candidateAt).trim();
  const after = output.slice(candidateAt + candidate.length).trim();
  // Every locally generated rail is appended after the formatted provider
  // envelope. The same bytes before JSON are provider prose, not a harness
  // route, even when they imitate an exact rail.
  if (before) return null;
  const remainder = after;
  const exactSettledReadLine = formatSettledReadSuccessAdvisory(expectedToolName);
  const routeToolkit = registeredToolkitOfSlug(expectedToolName);
  const exactAccountRouteLine = /^[a-z0-9][a-z0-9_-]*$/.test(routeToolkit)
    ? formatComposioCliDefaultReadAccountRoute(routeToolkit)
    : null;
  const allowedRemainders = options.allowReadRoutingRemainder
    ? new Set([
        exactSettledReadLine,
        ...(exactAccountRouteLine
          ? [
              exactAccountRouteLine,
              `${exactAccountRouteLine}\n\n${exactSettledReadLine}`,
            ]
          : []),
      ])
    : new Set<string>();
  // This certificate owns one JSON provider envelope. The sole non-JSON bytes
  // it may project away are exact harness-generated read-routing notes bound to
  // the effective tool: the authoritative CLI account route, the later settled
  // read advisory, or those two lines in their only generated order. Warnings,
  // provider prose, write routes, altered/duplicated rails, and second values
  // remain ambiguous and therefore retain the ordinary semantic judge.
  if (remainder && !allowedRemainders.has(remainder)) return null;
  if (OUTPUT_FAILURE_LINE_RE.test(remainder)
    || extractCompleteJsonObjects(remainder, 1).length > 0
    || extractJsonCandidate(remainder) !== null) return null;
  try {
    const value = JSON.parse(candidate) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const populatedError = (error: unknown): boolean => (
      error === true
      || (typeof error === 'string' && error.trim().length > 0)
      || (Array.isArray(error) && error.length > 0)
      || (Boolean(error) && typeof error === 'object' && !Array.isArray(error)
        && Object.keys(error as Record<string, unknown>).length > 0)
    );
    // `successful:true` cannot erase a sibling GraphQL/provider error. The
    // generic tool classifier permits a few advisory-error envelopes; this
    // exact-completion seam deliberately does not.
    if (populatedError(record.error) || populatedError(record.errors)) return null;
    return record;
  } catch {
    return null;
  }
}

function normalizedKeyWords(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

const COLLECTION_KEYS = new Set([
  'contacts',
  'documents',
  'events',
  'files',
  'items',
  'messages',
  'records',
  'results',
  'rows',
  'tasks',
]);

// Only an explicitly total-valued field can close a generic collection. A
// bare `count` is commonly page-local (`count: 1, pageSize: 1`) and therefore
// cannot prove that the provider returned the whole collection.
const TOTAL_COUNT_KEYS = new Set(['total', 'total count']);
const COLLECTION_COUNT_KEYS = new Set(['count', ...TOTAL_COUNT_KEYS]);

interface ExactCollectionShape {
  container: Record<string, unknown>;
  collectionKey: string;
  rows: unknown[];
}

function collectionEnvelopeContainsFailure(
  value: unknown,
  rows: ReadonlySet<unknown>,
  depth = 0,
  inResponseEnvelope = false,
): boolean {
  if (depth > 10 || value == null || rows.has(value)) return false;
  if (Array.isArray(value)) return value.some((child) => collectionEnvelopeContainsFailure(child, rows, depth + 1, inResponseEnvelope));
  if (typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(([rawKey, child]) => {
    const key = normalizedKeyWords(rawKey).replace(/\s+/g, '_');
    if ((key === 'error' || key === 'errors' || key === 'http_error')) {
      if (child === true
        || (typeof child === 'string' && child.trim().length > 0)
        || (Array.isArray(child) && child.length > 0)
        || (Boolean(child) && typeof child === 'object' && !Array.isArray(child)
          && Object.keys(child as Record<string, unknown>).length > 0)) return true;
    }
    if ((key === 'success' || key === 'successful' || key === 'ok')
      && (child === false || child === 0 || (typeof child === 'string' && /^(?:false|no|0)$/i.test(child.trim())))) return true;
    if (key === 'failed'
      && (child === true || child === 1 || (typeof child === 'string' && /^(?:true|yes|1)$/i.test(child.trim())))) return true;
    if (key === 'is_error'
      && (child === true || child === 1 || (typeof child === 'string' && /^(?:true|yes|1)$/i.test(child.trim())))) return true;
    if (key === 'status'
      && typeof child === 'string'
      && /^(?:error|failed|failure|not[_ -]?connected|rejected|unauthori[sz]ed)$/i.test(child.trim())) return true;
    const numeric = typeof child === 'number'
      ? child
      : typeof child === 'string' && /^\s*\d{3}\s*$/.test(child)
        ? Number(child)
        : Number.NaN;
    if (Number.isFinite(numeric)
      && numeric >= 400
      && numeric <= 599
      && (/^(?:http_)?status(?:_code|code)?$/.test(key) || (inResponseEnvelope && key === 'code'))) return true;
    const childResponseEnvelope = inResponseEnvelope
      || /(?:^|_)(?:error|http|provider|response|upstream)(?:_|$)/.test(key);
    return collectionEnvelopeContainsFailure(child, rows, depth + 1, childResponseEnvelope);
  });
}

interface SnapshotField {
  aliases: string[];
  key: string;
  scope: 'metadata' | 'row';
  value: string;
}

function scalarText(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const rendered = String(value).trim();
  return rendered ? rendered : null;
}

function exactCollectionShape(record: Record<string, unknown>): ExactCollectionShape | null {
  const candidates: ExactCollectionShape[] = [];
  const nestedData = record.data;
  const containers = [
    record,
    ...(nestedData && typeof nestedData === 'object' && !Array.isArray(nestedData)
      ? [nestedData as Record<string, unknown>]
      : []),
  ];
  if (Array.isArray(nestedData)) {
    candidates.push({ container: record, collectionKey: 'data', rows: nestedData });
  }
  for (const container of containers) {
    for (const [rawKey, value] of Object.entries(container)) {
      const key = normalizedKeyWords(rawKey);
      if (COLLECTION_KEYS.has(key) && Array.isArray(value)) {
        candidates.push({ container, collectionKey: key, rows: value });
      }
    }
  }
  if (candidates.length !== 1) return null;
  const shape = candidates[0]!;
  // V1 is intentionally the exact proof-backed seam: an empty result or one
  // current row. Multi-row completeness needs a separate row-by-row contract.
  if (shape.rows.length > 1) return null;

  const countContainers = [...new Set([record, shape.container])];
  const declaredAggregates = countContainers.flatMap((container) => (
    Object.entries(container)
      .filter(([rawKey]) => COLLECTION_COUNT_KEYS.has(normalizedKeyWords(rawKey)))
      .map(([rawKey, value]) => ({ key: normalizedKeyWords(rawKey), value }))
  ));
  const declaredTotals = declaredAggregates
    .filter(({ key }) => TOTAL_COUNT_KEYS.has(key));
  // Absence of a cursor is not proof that a provider did not silently apply a
  // default page size. V1 therefore requires an unambiguous total == rows;
  // providers that expose only page-local counts retain the ordinary judge.
  // Any adjacent count must agree too; contradictory aggregate metadata is
  // never resolved in favor of the field that would make the receipt pass.
  if (declaredTotals.length === 0) return null;
  if (declaredAggregates.some(({ value }) => (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || value !== shape.rows.length
  ))) return null;
  return shape;
}

function stripPresentationMarkup(value: string): string {
  return value
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/^\s*[-*+]\s+/, '')
    .trim();
}

function normalizedPresentationLabel(value: string): string {
  return normalizedKeyWords(stripPresentationMarkup(value))
    .replace(/^(?:current|final|latest)\s+/, '')
    .trim();
}

function normalizedPresentedValue(value: string): string {
  return stripPresentationMarkup(value)
    .replace(/^(["'])([\s\S]*)\1$/, '$2')
    .replace(/[.!]$/, '')
    .trim()
    .toLowerCase();
}

function normalizedStructuredValue(rawLabel: string, rawValue: string): string {
  const label = normalizedPresentationLabel(rawLabel);
  const value = normalizedPresentedValue(rawValue);
  if (!/^(?:revision|state|status)$/.test(label)) return value;
  return /^([a-z0-9_-]+)\s+\((?:up\s+from|was|from|previously)\s+[a-z0-9_-]+\)$/i.exec(value)?.[1]
    ?? value;
}

function addAssertion(assertions: Map<string, string[]>, rawLabel: string, rawValue: string): void {
  const label = normalizedPresentationLabel(rawLabel);
  const value = normalizedStructuredValue(rawLabel, rawValue);
  if (!label || !value) return;
  const bucket = assertions.get(label) ?? [];
  if (!bucket.includes(value)) bucket.push(value);
  assertions.set(label, bucket);
}

function markdownCells(line: string): string[] | null {
  if (!/^\s*\|.*\|\s*$/.test(line)) return null;
  return line.trim().slice(1, -1).split('|').map((cell) => cell.trim());
}

function dividerRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

interface InlineCurrentMetadataPair {
  sourceMarker: string;
  revision: string;
  lineIndex: number;
  scope: string | null;
}

/** Accept a compact but still explicit current-snapshot binding used by live
 * providers: `(source marker VALUE, revision N)`. Both labels and values must
 * share one parenthetical, and the surrounding line must frame a present read;
 * quoted, prior, reported, or historical snapshots remain judge-owned. */
function inlineCurrentMetadataPairs(text: string): InlineCurrentMetadataPair[] {
  const pairs: InlineCurrentMetadataPair[] = [];
  const pairPattern = /\(\s*source\s+marker\s*(?:(?:is|remains|equals)\s+|[:=]\s*)?([A-Za-z0-9][A-Za-z0-9_.:/-]*)\s*,\s*(?:now\s+at\s+|current\s+)?revision\s*(?:(?:is|remains|equals)\s+|[:=]\s*)?(\d+)\s*\)/gi;
  const authority = authoritativePresentationLineMask(text);
  for (const [lineIndex, rawLine] of text.split(/\r?\n/).entries()) {
    if (!authority[lineIndex]) continue;
    const line = rawLine.replace(/\*\*/g, '').replace(/`/g, '');
    const matches = [...line.matchAll(pairPattern)];
    if (matches.length !== 1) continue;
    for (const match of matches) {
      const prefix = line.slice(0, match.index ?? 0);
      const suffix = line.slice((match.index ?? 0) + match[0].length);
      const heading = prefix.trim().replace(/^#{1,6}\s*/, '');
      const hereHeading = /^here\s+(?:are|is)\s+the\s+(?:current|latest)\s+(?:items?|records?|rows?|tasks?)(?:\s+(?:in|from|for|on)\s+the\s+([A-Za-z0-9_-]+(?:\s+[A-Za-z0-9_-]+){0,8}\s+(?:queue|feed|list|snapshot)))?$/i.exec(heading);
      const freshHeading = /^fresh\s+read\s+of\s+the\s+([A-Za-z0-9_-]+(?:\s+[A-Za-z0-9_-]+){0,8}\s+(?:queue|feed|list|snapshot))$/i.exec(heading);
      if (!hereHeading && !freshHeading) continue;
      if (/^\s*(?:>\s*)?["“'‘]/u.test(prefix) || /["“'‘]\s*$/u.test(prefix)) continue;
      if (!/^\s*:\s*$/.test(suffix)) continue;
      pairs.push({
        sourceMarker: match[1]!,
        revision: match[2]!,
        lineIndex,
        scope: normalizedKeyWords(hereHeading?.[1] ?? freshHeading?.[1] ?? '') || null,
      });
    }
  }
  return pairs;
}

/** The compact metadata pair is authoritative only for the exact one-row
 * item table it introduces. This prevents a current-looking heading in one
 * section from lending source/revision authority to a table in another. */
function inlineCurrentMetadataPairOwnsItemTable(
  text: string,
  pair: InlineCurrentMetadataPair,
): boolean {
  const lines = text.split(/\r?\n/);
  const authority = authoritativePresentationLineMask(text);
  let headerIndex = pair.lineIndex + 1;
  while (headerIndex < lines.length && !lines[headerIndex]!.trim()) headerIndex += 1;
  const headers = headerIndex < lines.length ? markdownCells(lines[headerIndex]!) : null;
  const divider = headerIndex + 1 < lines.length ? markdownCells(lines[headerIndex + 1]!) : null;
  const row = headerIndex + 2 < lines.length ? markdownCells(lines[headerIndex + 2]!) : null;
  if (!authority[pair.lineIndex]
    || !authority[headerIndex]
    || !authority[headerIndex + 1]
    || !authority[headerIndex + 2]
    || !headers || !divider || !row
    || headers.length !== 3
    || divider.length !== 3
    || row.length !== 3
    || !dividerRow(divider)) return false;
  const normalizedHeaders = headers.map(normalizedPresentationLabel);
  if (!(
    (normalizedHeaders[0] === 'item id' || normalizedHeaders[0] === 'item')
    && normalizedHeaders[1] === 'title'
    && (normalizedHeaders[2] === 'status' || normalizedHeaders[2] === 'state')
  )) return false;
  const following = headerIndex + 3 < lines.length
    ? markdownCells(lines[headerIndex + 3]!)
    : null;
  return !following;
}

/** Parse only explicit field bindings: label/value bullets and Markdown table
 * snapshots. Narrative remains byte-preserved, but it cannot lend an unrelated
 * number, historical status, or substring to a requested current field. */
function structuredReplyAssertions(
  reply: string,
  fields: readonly SnapshotField[],
  shape: ExactCollectionShape,
): {
  assertions: Map<string, string[]>;
  labelLines: Array<{ index: number; label: string }>;
  tableLines: Set<number>;
  horizontalRows: Array<{ headers: string[]; values: string[] }>;
  narrativeLineOverrides: Map<number, string>;
  valid: boolean;
} {
  const assertions = new Map<string, string[]>();
  const labelLines: Array<{ index: number; label: string }> = [];
  const parsedTables = parseAuthoritativeMarkdownTables(reply);
  const tableLines = parsedTables.lineIndexes;
  const horizontalRows: Array<{ headers: string[]; values: string[] }> = [];
  const narrativeLineOverrides = new Map<number, string>();
  let valid = parsedTables.valid;
  const lines = reply.split(/\r?\n/);
  const authority = authoritativePresentationLineMask(reply);
  const claimedFieldIndexes = new Set<number>();
  const fieldForLabel = (rawLabel: string): { field: SnapshotField; index: number } | null => {
    const label = normalizedPresentationLabel(rawLabel);
    const matches = fields
      .map((field, index) => ({ field, index }))
      .filter(({ field }) => field.aliases.includes(label));
    return matches.length === 1 ? matches[0]! : null;
  };
  const claimField = (rawLabel: string, rawValue: string): number | null => {
    const resolved = fieldForLabel(rawLabel);
    if (!resolved || claimedFieldIndexes.has(resolved.index)) return null;
    const value = normalizedStructuredValue(rawLabel, rawValue);
    if (!value || value !== normalizedPresentedValue(resolved.field.value)) return null;
    addAssertion(assertions, rawLabel, rawValue);
    claimedFieldIndexes.add(resolved.index);
    return resolved.index;
  };
  const scoped = parseScopedProviderSnapshotBlocks(reply);
  const scopedLines = new Set(scoped.blocks.flatMap((block) => [
    block.headingLineIndex,
    block.itemLineIndex,
    block.sourceLineIndex,
  ]));
  for (const block of scoped.blocks) {
    if (claimField('source marker', block.sourceMarker) === null
      || claimField('revision', block.revision) === null
      || claimField('item id', block.itemId) === null
      || claimField('title', block.title) === null
      || claimField('status', block.status) === null) valid = false;
    narrativeLineOverrides.set(block.headingLineIndex, '');
    narrativeLineOverrides.set(block.itemLineIndex, '');
    narrativeLineOverrides.set(block.sourceLineIndex, block.narrativeSuffix ?? '');
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!authority[index] || scopedLines.has(index)) continue;
    if (markdownCells(line)) continue;
    const plain = stripPresentationMarkup(line);
    const match = /^(.{1,60}?):\s*(\S[\s\S]*)$/.exec(plain);
    if (match) {
      addAssertion(assertions, match[1]!, match[2]!);
      const label = normalizedPresentationLabel(match[1]!);
      if (fieldForLabel(match[1]!)) {
        // Replace the provisional assertion with one exact, uniquely-owned
        // provider field. Unknown heading-like prose remains narrative.
        assertions.delete(label);
        if (claimField(match[1]!, match[2]!) === null) valid = false;
        labelLines.push({ index, label });
      }
    }
  }

  for (const pair of inlineCurrentMetadataPairs(reply)) {
    if (claimField('source marker', pair.sourceMarker) === null
      || claimField('revision', pair.revision) === null) valid = false;
  }

  const tableKinds: Array<{
    kind: 'vertical' | 'horizontal';
    fieldIndexes: number[];
    headerLineIndex: number;
    endLineIndex: number;
  }> = [];
  if (parsedTables.tables.length > 2) valid = false;
  for (const table of parsedTables.tables) {
    const normalizedHeaders = table.headers.map(normalizedPresentationLabel);
    const fieldIndexes: number[] = [];
    if (normalizedHeaders.length === 2
      && normalizedHeaders[0] === 'field'
      && normalizedHeaders[1] === 'value') {
      const localFields = new Set<number>();
      for (const row of table.rows) {
        if (row.length !== 2) {
          valid = false;
          continue;
        }
        const resolved = fieldForLabel(row[0]!);
        const fieldIndex = claimField(row[0]!, row[1]!);
        if (!resolved || fieldIndex === null || localFields.has(resolved.index)) {
          valid = false;
          continue;
        }
        localFields.add(resolved.index);
        fieldIndexes.push(resolved.index);
      }
      tableKinds.push({
        kind: 'vertical',
        fieldIndexes,
        headerLineIndex: table.headerLineIndex,
        endLineIndex: table.endLineIndex,
      });
    } else {
      if (table.rows.length !== 1 || new Set(normalizedHeaders).size !== normalizedHeaders.length) {
        valid = false;
      }
      const row = table.rows[0] ?? [];
      for (let cell = 0; cell < normalizedHeaders.length; cell += 1) {
        const resolved = fieldForLabel(table.headers[cell]!);
        const fieldIndex = claimField(table.headers[cell]!, row[cell] ?? '');
        if (!resolved || fieldIndex === null || fieldIndexes.includes(resolved.index)) {
          valid = false;
          continue;
        }
        fieldIndexes.push(resolved.index);
      }
      horizontalRows.push({ headers: normalizedHeaders, values: row });
      tableKinds.push({
        kind: 'horizontal',
        fieldIndexes,
        headerLineIndex: table.headerLineIndex,
        endLineIndex: table.endLineIndex,
      });
    }
  }
  if (tableKinds.length === 2) {
    const [first, second] = tableKinds;
    const firstScopes = new Set(first!.fieldIndexes.map((index) => fields[index]!.scope));
    const secondScopes = new Set(second!.fieldIndexes.map((index) => fields[index]!.scope));
    const bridgeIndexes = lines
      .map((line, index) => ({ index, line }))
      .slice(first!.endLineIndex + 1, second!.headerLineIndex)
      .filter(({ line }) => line.trim())
      .map(({ index }) => index);
    const bridge = bridgeIndexes.length === 1 && authority[bridgeIndexes[0]!]
      ? parseCollectionCountHeading(lines[bridgeIndexes[0]!]!)
      : null;
    const bridgeIsOwned = bridgeIndexes.length === 0
      || (bridgeIndexes.length === 1 && bridge?.count === shape.rows.length);
    if (first!.kind !== 'vertical'
      || second!.kind !== 'horizontal'
      || [...firstScopes].some((scope) => scope !== 'metadata')
      || [...secondScopes].some((scope) => scope !== 'row')
      || !bridgeIsOwned) {
      valid = false;
    } else if (bridgeIndexes.length === 1) {
      // This exact count-bound line is part of the two-table snapshot, not
      // free-standing narrative. Consume it only after both table scopes and
      // the provider row count agree.
      tableLines.add(bridgeIndexes[0]!);
    }
  }
  return {
    assertions,
    labelLines,
    tableLines,
    horizontalRows,
    narrativeLineOverrides,
    valid,
  };
}

function singularCollectionName(collectionKey: string): string {
  if (collectionKey === 'data' || collectionKey === 'results') return 'item';
  return collectionKey.endsWith('ies')
    ? `${collectionKey.slice(0, -3)}y`
    : collectionKey.endsWith('s')
      ? collectionKey.slice(0, -1)
      : collectionKey;
}

/** A row identity must name the row itself, not merely end in `id`.
 * `workspaceId`, `accountId`, and similar foreign keys are attributes of the
 * row and cannot prove that two snapshots describe the same item. */
function stableRowIdentifierKey(rawKey: string, collectionKey: string): boolean {
  const key = normalizedKeyWords(rawKey);
  return new Set([
    'id',
    'identifier',
    'item id',
    'record id',
    'row id',
    'task id',
    `${singularCollectionName(collectionKey)} id`,
  ]).has(key);
}

function fieldAliases(rawKey: string, scope: SnapshotField['scope'], collectionKey: string): string[] {
  const key = normalizedKeyWords(rawKey);
  const aliases = new Set([key]);
  if (scope === 'row' && stableRowIdentifierKey(key, collectionKey)) {
    aliases.add('id');
    aliases.add('identifier');
    aliases.add(`${singularCollectionName(collectionKey)} id`);
  }
  if (scope === 'row' && /(?:^|\s)(?:status|state)$/.test(key)) {
    // A one-row business snapshot commonly describes the same terminal
    // property as either status or state. Treat both labels as assertions so
    // `Status: open` cannot coexist with `Current state: closed`.
    aliases.add('status');
    aliases.add('state');
  }
  return [...aliases];
}

function snapshotFields(record: Record<string, unknown>, shape: ExactCollectionShape): SnapshotField[] {
  const fields: SnapshotField[] = [];
  const metadataContainers = [...new Set([record, shape.container])];
  for (const container of metadataContainers) {
    for (const [rawKey, value] of Object.entries(container)) {
      const key = normalizedKeyWords(rawKey);
      if (COLLECTION_COUNT_KEYS.has(key) || COLLECTION_KEYS.has(key) || key === 'data') continue;
      const rendered = scalarText(value);
      if (!rendered) continue;
      fields.push({ aliases: fieldAliases(rawKey, 'metadata', shape.collectionKey), key, scope: 'metadata', value: rendered });
    }
  }
  const row = shape.rows[0];
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    for (const [rawKey, value] of Object.entries(row as Record<string, unknown>)) {
      const rendered = scalarText(value);
      if (!rendered) continue;
      fields.push({
        aliases: fieldAliases(rawKey, 'row', shape.collectionKey),
        key: normalizedKeyWords(rawKey),
        scope: 'row',
        value: rendered,
      });
    }
  }
  return fields;
}

function exactSnapshotField(
  fields: readonly SnapshotField[],
  scope: SnapshotField['scope'],
  alias: string,
): string | null {
  const matches = fields.filter((field) => field.scope === scope && field.aliases.includes(alias));
  return matches.length === 1 ? matches[0]!.value : null;
}

function readAccountIdentity(args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'implicit';
  const record = args as Record<string, unknown>;
  for (const key of ['connected_account_id', 'connectedAccountId']) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = record[key];
    if (value === null) return 'none';
    if (typeof value === 'string' && value.trim() === value && value.length > 0) {
      return `id:${value}`;
    }
    return null;
  }
  return 'implicit';
}

/** Canonicalize the complete JSON provider snapshot for historical equality.
 * Key order is irrelevant; array order and every provider fact remain
 * load-bearing. Status/state casing follows the typed transition semantics. */
function canonicalReadSnapshotValue(value: unknown, key = '', depth = 0): unknown {
  if (depth > 32) throw new Error('provider snapshot is too deeply nested');
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((child) => canonicalReadSnapshotValue(child, key, depth + 1));
  }
  if (!value || typeof value !== 'object') throw new Error('provider snapshot is not JSON data');
  const output: Record<string, unknown> = {};
  for (const childKey of Object.keys(value as Record<string, unknown>).sort()) {
    output[childKey] = canonicalReadSnapshotValue(
      (value as Record<string, unknown>)[childKey],
      childKey,
      depth + 1,
    );
  }
  return output;
}

function readSnapshotContentDigest(record: Record<string, unknown>): string | null {
  try {
    return digest(JSON.stringify(canonicalReadSnapshotValue(record)));
  } catch {
    return null;
  }
}

function readViewDigest(args: unknown): string | null {
  try {
    return digest(JSON.stringify(canonicalReadSnapshotValue(args)));
  } catch {
    return null;
  }
}

/** Project only the facts needed to validate conversational history. The
 * digest keeps provider/tool/account/source identity internal; none of these
 * values are used as substitute presentation evidence. */
function readHistorySnapshot(
  record: Record<string, unknown>,
  shape: ExactCollectionShape,
  effectiveTool: string,
  args: unknown,
): ReadHistorySnapshot | null {
  const fields = snapshotFields(record, shape);
  const sourceMarker = exactSnapshotField(fields, 'metadata', 'source marker');
  const revisionText = exactSnapshotField(fields, 'metadata', 'revision');
  if (!sourceMarker || !revisionText || !/^\d+$/.test(revisionText)) return null;
  const revision = Number(revisionText);
  if (!Number.isSafeInteger(revision) || revision < 0) return null;
  const accountIdentity = readAccountIdentity(args);
  if (accountIdentity === null) return null;
  // An implicit/default account route is not durable source identity: its
  // provider default can change between turns while the same raw args remain.
  // Until the physical lifecycle carries the gateway-proven stable account,
  // history is limited to an explicit pinned selector or the isolated
  // positively account-free proof provider.
  if ((accountIdentity === 'implicit' || accountIdentity === 'none')
    && !effectiveTool.startsWith('PROOF_')) return null;
  const viewDigest = readViewDigest(args);
  if (!viewDigest) return null;
  const contentDigest = readSnapshotContentDigest(record);
  if (!contentDigest) return null;
  const rows: ReadHistorySnapshot['rows'] = [];
  if (shape.rows.length === 1) {
    const stableIds = fields.filter((field) => field.scope === 'row'
      && stableRowIdentifierKey(field.key, shape.collectionKey));
    const id = stableIds.length === 1 ? stableIds[0]!.value : null;
    const title = exactSnapshotField(fields, 'row', 'title');
    const status = fields.find(fieldIsRowStatus)?.value ?? null;
    if (!id || !title || !status) return null;
    rows.push({ id, title, status });
  }
  return {
    sourceKey: digest(JSON.stringify([
      effectiveTool,
      accountIdentity,
      viewDigest,
      sourceMarker,
      shape.collectionKey,
    ])),
    contentDigest,
    revision,
    count: shape.rows.length,
    rows,
  };
}

interface AffirmativePresentationContract {
  fields: string[];
  line: string;
}

function affirmativePresentationContract(objective: string): AffirmativePresentationContract | null {
  // The receipt is an optimization, not a natural-language parser. Accept one
  // line-anchored affirmative field contract and let every descriptive,
  // negated, embedded, or compound phrasing keep the normal judge. The mixed
  // conversation proof has one exact cold-read variant where the same line
  // first excludes alternate discovery surfaces; own that complete, anchored
  // prohibition before parsing the otherwise-identical return contract.
  const directives = objective.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:(?:kindly|please)\s+)?(?:return(?!\s+to\b)|report|present|include)\s+([^.!?;]+)[.!?]?\s*$/i.exec(line)
      ?? /^\s*do\s+not\s+use\s+(?:any\s+)?other\s+discovery,\s*code\s+mode,\s*shell,\s*workspace(?:\s+tool)?,\s*or\s+memory\.\s*(?:return(?!\s+to\b)|report|present|include)\s+([^.!?;]+)[.!?]?\s*$/i.exec(line);
    return match ? [{ clause: match[1]!, line }] : [];
  });
  if (directives.length !== 1) return null;
  if (/\b(?:(?:do\s+not|don't|dont|never)\s+(?:return|report|present|include)|(?:omit|exclude)\b|only\s+(?:return|report|present|include)|without\s+(?:returning|reporting|presenting|including))\b/i.test(objective)) return null;
  const fields: string[] = [];
  const clause = directives[0]!.clause.replace(/\s+and\s+/gi, ',');
  for (const part of clause.split(',')) {
    const field = normalizedKeyWords(part)
      .replace(/^(?:the|a|an|current)\s+/, '')
      .trim();
    if (field && !fields.includes(field)) fields.push(field);
  }
  return { fields, line: directives[0]!.line };
}

function requestedPresentationFields(objective: string): string[] {
  return affirmativePresentationContract(objective)?.fields ?? [];
}

const EMPTY_COLLECTION_CLAIM_RES = [
  /\b(?:no|zero)\s+(?:current\s+)?(?:items?|records?|results?|rows?|tasks?|events?|contacts?|messages?|documents?|files?)(?:\s+(?:was|were|is|are)\s+(?:found|matched|returned))?\b/gi,
  /\b(?:items?|records?|results?|rows?|tasks?|events?|contacts?|messages?|documents?|files?)\s*[:=-]\s*(?:none|empty|0)\b/gi,
  /\b(?:none|nothing)\s+(?:was\s+|were\s+)?(?:found|matched|returned)\b/gi,
];

function emptyCollectionClaimIsDisputed(reply: string, start: number, end: number): boolean {
  const before = reply.slice(Math.max(0, start - 100), start);
  const after = reply.slice(end, Math.min(reply.length, end + 100));
  // A quoted or discussed proposition is not itself asserted by the reply.
  // Keep this local to the exact occurrence so a later disputed phrase cannot
  // cancel an independent affirmative empty-result sentence elsewhere.
  return /^\s*[”’"']?\s*(?:is|was|would\s+be|seems?|appears?)\s+(?:false|incorrect|wrong|untrue|not\s+true)\b/i.test(after)
    || /\b(?:false|incorrect|wrong|untrue)\s+(?:claim|statement|assertion|report)?\s*(?:that\s+)?[“‘"']?\s*$/i.test(before)
    || /\b(?:deny|denies|denied|dispute|disputes|disputed|reject|rejects|rejected)\s+(?:the\s+)?(?:claim|statement|assertion|report)?\s*(?:that\s+)?[“‘"']?\s*$/i.test(before)
    || /\b(?:not|never)\s+(?:true\s+that\s+)?[^.!?\n]{0,24}$/i.test(before);
}

function emptyCollectionClaimIsAffirmativeCurrent(reply: string, start: number, end: number): boolean {
  if (emptyCollectionClaimIsDisputed(reply, start, end)) return false;
  const prior = reply.slice(0, start);
  const following = reply.slice(end);
  const priorBoundary = Math.max(
    prior.lastIndexOf('\n'),
    prior.lastIndexOf('.'),
    prior.lastIndexOf('!'),
    prior.lastIndexOf('?'),
    prior.lastIndexOf(';'),
  );
  const nextOffsets = ['\n', '.', '!', '?', ';']
    .map((delimiter) => following.indexOf(delimiter))
    .filter((offset) => offset >= 0);
  const nextBoundary = nextOffsets.length > 0 ? Math.min(...nextOffsets) : following.length;
  const before = prior.slice(priorBoundary + 1);
  const after = following.slice(0, nextBoundary);

  // Quoting or attributing the proposition does not assert it. Likewise,
  // conditional, historical, modal, or uncertainty framing is not a current
  // result even when the literal words "no current items" are present.
  if (/[“"‘']\s*$/u.test(before) || /^\s*[”"’']/u.test(after)) return false;
  const directPrefix = before.replace(/[*_`]/g, '').trim();
  const directCurrentAssertion = directPrefix.length === 0
    || /^(?:(?:fresh|current|latest)\s+(?:read|result|snapshot)\s*[:—-]|(?:the\s+)?(?:provider|source|feed|queue|result|snapshot)\s+(?:returned|contains?|has|shows?|lists?)|(?:i|we)\s+(?:found|received|retrieved|saw)|there\s+(?:are|were))$/i.test(directPrefix);
  // Positive certification is intentionally grammatical rather than an
  // open-ended modality blacklist. Any other prefix keeps the ordinary judge,
  // including "there may be" and "it is possible that".
  if (!directCurrentAssertion || after.trim().length > 0) return false;
  if (/\b(?:according\s+to|allegedly|apparently|claimed?|claims?|could|earlier|historically|if|last\s+(?:time|run|result)|may|maybe|might|not\s+sure|perhaps|possible|possibly|previously|reported?|reports?|said|says|seems?|suggested?|suggests?|supposing|unclear|unless|whether|would)\b[^.!?\n;]*$/i.test(before)) return false;
  if (/\b(?:can(?:not|'t)|could(?:\s+not|n't)?|did\s+not|does\s+not|unable\s+to)\s+(?:confirm|establish|know|verify)\b[^.!?\n;]*$/i.test(before)) return false;
  if (/^\s*(?:,\s*)?(?:according\s+to|allegedly|apparently|could|if|may|maybe|might|perhaps|possibly|reportedly|seems?|unless|whether|would|were\s+(?:allegedly|apparently|possibly|reportedly))\b/i.test(after)) return false;
  return true;
}

function replyClaimsEmptyCollection(reply: string): boolean {
  const narrative = reply.replace(/[*_`]/g, '');
  for (const pattern of EMPTY_COLLECTION_CLAIM_RES) {
    for (const match of narrative.matchAll(pattern)) {
      const start = match.index ?? -1;
      if (start < 0) continue;
      if (emptyCollectionClaimIsAffirmativeCurrent(
        narrative,
        start,
        start + match[0].length,
      )) return true;
    }
  }
  return false;
}

function settledZeroCollection(record: Record<string, unknown>): boolean {
  const candidates = [record, record.data]
    .filter((value): value is Record<string, unknown> => Boolean(value)
      && typeof value === 'object'
      && !Array.isArray(value));
  return candidates.some((value) => (
    Object.entries(value).some(([key, child]) => /^(?:count|total|total_count)$/i.test(key) && child === 0)
    || Object.entries(value).some(([key, child]) => /^(?:data|items|records|results|rows)$/i.test(key)
      && Array.isArray(child)
      && child.length === 0)
  ));
}

function explicitCurrentFieldClaims(reply: string, aliases: readonly string[]): string[] {
  const claims: string[] = [];
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const patterns = [
      new RegExp(`\\b(?:current|final|latest)\\s+${escaped}\\s*(?:is|remains|equals|=|:)\\s*([^.!?\\n;,]+)`, 'gi'),
      new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])\\s*(?:is|remains|equals|=|:)\\s*([^.!?\\n;,]+)`, 'gi'),
    ];
    for (const pattern of patterns) {
      for (const match of reply.matchAll(pattern)) {
        const value = normalizedPresentedValue(match[1] ?? '');
        if (value) claims.push(value);
      }
    }
  }
  return [...new Set(claims)];
}

function explicitNarrativeFieldClaims(reply: string, aliases: readonly string[]): string[] {
  const claims: string[] = [];
  // Strip presentation delimiters without deleting underscores that are part
  // of exact provider values such as `PROOF_RELEASE_QUEUE:LOCAL_ONLY`.
  const narrative = reply.replace(/\*\*/g, '').replace(/`/g, '');
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const pattern = new RegExp(
      `(?<![A-Za-z0-9_-])(?:(?:the|this|that)\\s+)?(?:current\\s+)?${escaped}(?![A-Za-z0-9_-])\\s+(?:is|remains|equals)\\s+([^.!?\\n;,]+)`,
      'gi',
    );
    for (const match of narrative.matchAll(pattern)) {
      const value = normalizedPresentedValue(match[1] ?? '');
      if (value) claims.push(value);
    }
  }
  return [...new Set(claims)];
}

function explicitPossessiveFieldClaims(
  reply: string,
  aliases: readonly string[],
  rowIdentifiers: readonly string[],
): string[] {
  const subjects = [...new Set(['item', 'record', 'row', 'task', ...rowIdentifiers])]
    .map((subject) => subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const claims: string[] = [];
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const pattern = new RegExp(
      `(?<![A-Za-z0-9_-])(?:its|(?:(?:the|this|that)\\s+)?(?:${subjects})[’']s)\\s+(?:current\\s+)?${escaped}(?![A-Za-z0-9_-])\\s*(?:is|remains|equals|=|:)\\s*([^.!?\\n;,]+)`,
      'gi',
    );
    for (const match of reply.replace(/\*\*/g, '').replace(/`/g, '').matchAll(pattern)) {
      const value = normalizedPresentedValue(match[1] ?? '');
      if (value) claims.push(value);
    }
  }
  return [...new Set(claims)];
}

function shapeRowIdentifiers(shape: ExactCollectionShape): string[] {
  const row = shape.rows[0] && typeof shape.rows[0] === 'object' && !Array.isArray(shape.rows[0])
    ? shape.rows[0] as Record<string, unknown>
    : null;
  return row
    ? Object.entries(row)
      .filter(([key]) => stableRowIdentifierKey(key, shape.collectionKey))
      .map(([, value]) => scalarText(value))
      .filter((value): value is string => Boolean(value))
    : [];
}

function explicitRowStatusNarrativeClaims(reply: string, shape: ExactCollectionShape): string[] {
  const rowIdentifiers = shapeRowIdentifiers(shape);
  const subjects = [...new Set([
    'item',
    'record',
    'row',
    'task',
    singularCollectionName(shape.collectionKey),
    ...rowIdentifiers,
  ])]
    .map((subject) => subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const exactSubject = `(?<![A-Za-z0-9_-])(?:${subjects})(?![A-Za-z0-9_-])`;
  const patterns = [
    new RegExp(
      `(?<![A-Za-z0-9_-])(?:(?:the|this|that)\\s+)?${exactSubject}\\s+(?:is|remains)\\s+(?:(?:currently|now)\\s+)?([^.!?\\n]{1,80})(?=[.!?]|$)`,
      'gi',
    ),
    new RegExp(
      `(?<![A-Za-z0-9_-])(?:(?:the|this|that)\\s+)?${exactSubject}[’']s\\s+(?:current\\s+)?(?:status|state)\\s*(?:is|remains|[:=])\\s*([^.!?\\n]{1,80})(?=[.!?]|$)`,
      'gi',
    ),
    /\bits\s+(?:current\s+)?(?:status|state)\s*(?:is|remains|[:=])\s*([^.!?\n]{1,80})(?=[.!?]|$)/gi,
    /\b(?:current|final|latest)\s+(?:status|state)\s*[:=]\s*([^.!?\n]{1,80})(?=[.!?]|$)/gi,
  ];
  const claims: string[] = [];
  const narrative = reply
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\bisn[’']t\b/gi, 'is not');
  for (const pattern of patterns) {
    for (const match of narrative.matchAll(pattern)) {
      const value = normalizedPresentedValue(match[1] ?? '');
      if (value) claims.push(value);
    }
  }
  return [...new Set(claims)];
}

function fieldIsRowStatus(field: Pick<SnapshotField, 'key' | 'scope'>): boolean {
  return field.scope === 'row' && /(?:^|\s)(?:status|state)$/.test(field.key);
}

function wholeSegmentExplicitFieldClaim(
  segment: string,
  fields: readonly SnapshotField[],
  shape: ExactCollectionShape,
): boolean {
  const prefix = '(?:(?:actually|however|in fact|for clarity),\\s*|but(?:,\\s*|\\s+))?';
  for (const field of fields) {
    for (const alias of field.aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      const direct = new RegExp(
        `^${prefix}(?:(?:the|this|that)\\s+)?(?:current|final|latest)?\\s*${escaped}(?![A-Za-z0-9_-])\\s*(?:is|remains|equals|=|:)\\s*([^.!?\\n;,]+)[.!]?$`,
        'i',
      );
      const possessive = new RegExp(
        `^${prefix}(?:its|(?:(?:the|this|that)\\s+)?(?:item|record|row|task|${shapeRowIdentifiers(shape)
          .map((identifier) => identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|')})[’']s)\\s+(?:current\\s+)?${escaped}(?![A-Za-z0-9_-])\\s*(?:is|remains|equals|=|:)\\s*([^.!?\\n;,]+)[.!]?$`,
        'i',
      );
      if (direct.test(segment) || possessive.test(segment)) return true;
    }
  }
  const rowSubjects = [...new Set([
    'item',
    'record',
    'row',
    'task',
    singularCollectionName(shape.collectionKey),
    ...shapeRowIdentifiers(shape),
  ])].map((subject) => subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(
    `^${prefix}(?:(?:the|this|that)\\s+)?(?:${rowSubjects})\\s+(?:is|remains)\\s+(?:(?:currently|now)\\s+)?([^.!?\\n;,]+)[.!]?$`,
    'i',
  ).test(segment)
    || new RegExp(
      `^${prefix}(?:(?:the|this|that)\\s+)?(?:${rowSubjects})\\s+(?:is\\s+)?titled\\s+([^.!?\\n;,]+)[.!]?$`,
      'i',
    ).test(segment);
}

function neutralReadNarrativeSegment(
  segment: string,
  shape: ExactCollectionShape,
  expectedTool: string,
  ownerScope: string,
  noAccountSelected: boolean,
  objective: string,
): boolean {
  const count = shape.rows.length;
  const totalWithNoun = /^(?:[-*+]\s+)?total\s*:\s*(\d+)\s+(?:items?|records?|rows?|tasks?)[.!]?$/i.exec(segment);
  const totalLabel = /^(?:[-*+]\s+)?total\s+(?:items?|records?|rows?|tasks?)\s*:\s*(\d+)[.!]?$/i.exec(segment);
  if (totalWithNoun || totalLabel) {
    return Number(totalWithNoun?.[1] ?? totalLabel?.[1]) === count;
  }
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactTool = escape(expectedTool);
  const exactScope = escape(ownerScope).replace(/\s+/g, '\\s+');
  const toolkit = normalizedKeyWords(registeredToolkitOfSlug(expectedTool) ?? expectedTool.split('_')[0] ?? '');
  const providerDescriptorMatches = (value: string): boolean => {
    const descriptor = normalizedKeyWords(value);
    return Boolean(toolkit) && new RegExp(`^(?:(?:local|connected|authenticated)\\s+)?${escape(toolkit).replace(/\s+/g, '\\s+')}$`, 'i').test(descriptor);
  };
  if (new RegExp(`^results?\\s+from\\s+${exactTool}\\s*:$`, 'i').test(segment)) return true;
  const freshProvider = /^read\s+fetched\s+fresh\s+via\s+the\s+authenticated\s+composio\s+cli[’']s\s+([A-Za-z0-9 _-]{1,80})\s+provider\s*\(\s*no\s+account\s+selected\s*\)[.!]?$/i.exec(segment);
  if (freshProvider) return noAccountSelected && providerDescriptorMatches(freshProvider[1] ?? '');
  const retrievedProvider = /^retrieved\s+via\s+([A-Za-z0-9][A-Za-z0-9_.:/-]*)\s+on\s+the\s+([A-Za-z0-9 _-]{1,80})\s+provider\s*;\s*no\s+connected\s+account\s+was\s+selected[.!]?$/i.exec(segment);
  if (retrievedProvider) {
    return noAccountSelected
      && retrievedProvider[1]?.toLowerCase() === expectedTool.toLowerCase()
      && providerDescriptorMatches(retrievedProvider[2] ?? '');
  }
  const scopedHeading = new RegExp(
    `^here(?:'|’)s\\s+the\\s+(?:current\\s+)?${exactScope}(?:\\s+result)?(?:\\s*\\(\\s*(\\d+)\\s+items?\\s*\\))?\\s*:$`,
    'i',
  ).exec(segment);
  if (scopedHeading) return scopedHeading[1] === undefined || Number(scopedHeading[1]) === count;
  const navigationHeading = parseReadNavigationHeading(segment, ownerScope);
  if (navigationHeading) {
    const objectiveOwnsContinuity = /\bsame\s+connected\s+source\b/i.test(objective)
      || objective.split(/\r?\n/).some((line) => isFreshReadReuseLine(line));
    if (navigationHeading.sameSource && !objectiveOwnsContinuity) return false;
    if (navigationHeading.changedState
      && !objective.split(/\r?\n/).some((line) => isFreshReadReuseLine(line))) return false;
    return true;
  }
  if (new RegExp(`^${exactScope}\\s*[—–-]\\s*current\\s+items\\s*:$`, 'i').test(segment)) return true;
  if (/^pulled\s+fresh\s+from\s+the\s+same\s+connected\s+source\s+via\s+the\s+proven\s+capability[.!]?$/i.test(segment)) {
    return /\bsame\s+connected\s+source\b/i.test(objective)
      && /\bcapability\s+already\s+proved\b/i.test(objective);
  }
  if (/^fresh\s+read\s+complete\s*[—–-]\s*the\s+provider\s+state\s+updated\s*:\s*$/i.test(segment)) {
    return FRESH_READ_REUSE_LINE_RES.some((pattern) => pattern.test(
      objective.split(/\r?\n/).find((line) => pattern.test(line)) ?? '',
    ));
  }
  if (new RegExp(`^refreshed\\s+(?:the\\s+)?${exactScope}\\s*:$`, 'i').test(segment)) return true;
  if (new RegExp(`^refreshed\\s+(?:the\\s+)?${exactScope}\\s*[—–-]\\s*it\\s+changed\\s+since\\s+last\\s+check\\s*:$`, 'i').test(segment)) return true;
  if (ownerScope === 'proof release queue' && /^here\s+is\s+the\s+current\s+release\s+queue\s*:$/i.test(segment)) return true;
  if (ownerScope === 'proof release queue' && /^fresh\s+read\s*[—–-]\s*the\s+queue\s+changed\s+after\s+restart\s*:$/i.test(segment)) return true;
  if (/^queue\s+refreshed\s*[—–-]\s*unchanged\s+from\s+the\s+last\s+pull\s*:$/i.test(segment)) return true;
  if (/^queue\s+refreshed\s*[—–-]\s*there(?:'|’)s\s+been\s+a\s+change\s+since\s+the\s+last\s+pull\s*:$/i.test(segment)) return true;
  if (/^refreshed\s*[—–-]\s*(?:the\s+)?queue\s+is\s+unchanged\s*:$/i.test(segment)) return true;
  if (/^no\s+changes\s+since\s+last\s+check[.!]?$/i.test(segment)) return true;
  if (/^unchanged\s+from\s+before[.!]?$/i.test(segment)) return true;
  if (/^no\s+account\s+was\s+selected[.!]?$/i.test(segment)) return noAccountSelected;
  if (/^unchanged\s+since\s+(?:the\s+)?(?:last|previous)\s+read[.!]?$/i.test(segment)) return true;
  if (/^that(?:'|’)s\s+the\s+only\s+current\s+(?:item|record|row|task)[.!]?$/i.test(segment)) return count === 1;
  if (/^(?:no|zero)\s+current\s+(?:items?|records?|rows?|tasks?)\s+(?:was|were)\s+returned[.!]?$/i.test(segment)) return count === 0;
  return false;
}

function narrativeSnapshotClaimsMatch(
  narrative: string,
  fields: readonly SnapshotField[],
  shape: ExactCollectionShape,
  expectedTool: string,
  ownerScope: string,
  noAccountSelected: boolean,
  objective: string,
): boolean {
  const rowIdentifiers = shapeRowIdentifiers(shape);
  const expectedForAlias = (alias: string): string | null => {
    const matches = fields.filter((field) => field.aliases.includes(alias));
    return matches.length === 1 ? normalizedPresentedValue(matches[0]!.value) : null;
  };
  const statusExpected = fields.find(fieldIsRowStatus);
  const revisionExpected = fields.find((field) => field.aliases.includes('revision'));
  const statusValue = statusExpected ? normalizedPresentedValue(statusExpected.value) : null;
  const revisionValue = revisionExpected ? normalizedPresentedValue(revisionExpected.value) : null;
  const fieldAliases = [...new Set(fields.flatMap((field) => field.aliases))];
  const fieldToken = fieldAliases.length > 0
    ? new RegExp(`(?<![A-Za-z0-9_-])(?:${fieldAliases
      .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
      .join('|')})(?![A-Za-z0-9_-])`, 'i')
    : /$^/;

  const segments = narrative
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  for (const segment of segments) {
    const plain = segment
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .replace(/\bisn[’']t\b/gi, 'is not');
    let parsedAssertions = 0;
    let wholeSegmentOwned = false;

    const collectionSummary = parseCollectionStatusSummary(plain);
    if (collectionSummary) {
      parsedAssertions += 1;
      wholeSegmentOwned = true;
      const objectiveOwnsContinuity = /\bsame\s+connected\s+source\b/i.test(objective)
        || objective.split(/\r?\n/).some((line) => isFreshReadReuseLine(line));
      if ((collectionSummary.continuity && !objectiveOwnsContinuity)
        || collectionSummary.count !== shape.rows.length
        || (collectionSummary.status !== null
          && (!statusValue
            || normalizedPresentedValue(collectionSummary.status) !== statusValue))
        || (collectionSummary.revision !== null
          && (!revisionValue
            || normalizedPresentedValue(String(collectionSummary.revision)) !== revisionValue))) return false;
    }

    const inlinePairs = inlineCurrentMetadataPairs(plain);
    for (const pair of inlinePairs) {
      parsedAssertions += 2;
      wholeSegmentOwned = true;
      if (pair.sourceMarker.toLowerCase() !== expectedForAlias('source marker')
        || pair.revision !== expectedForAlias('revision')) return false;
    }

    const oneItemSummary = /^(?:still\s+)?(?:one|1)\s+([A-Za-z0-9_-]+)\s+(?:item|record|row|task)(?:\s+in\s+(?:the\s+)?(?:queue|feed|list|snapshot))?,\s+at\s+revision\s+(\d+)[.!]?$/i.exec(plain);
    if (oneItemSummary) {
      parsedAssertions += 2;
      wholeSegmentOwned = true;
      if (!statusValue
        || !revisionValue
        || normalizedPresentedValue(oneItemSummary[1] ?? '') !== statusValue
        || normalizedPresentedValue(oneItemSummary[2] ?? '') !== revisionValue) return false;
    }

    const compactOneItemSummary = /^(?:still\s+)?(?:one|1)\s+([A-Za-z0-9_-]+)\s+(?:item|record|row|task)\s+in\s+(?:the\s+)?(?:queue|feed|list|snapshot)[.!]?$/i.exec(plain);
    if (compactOneItemSummary) {
      parsedAssertions += 1;
      wholeSegmentOwned = true;
      if (shape.rows.length !== 1
        || !statusValue
        || normalizedPresentedValue(compactOneItemSummary[1] ?? '') !== statusValue) return false;
    }

    const unchangedFromPull = /^unchanged\s+from\s+(?:the\s+)?(?:last|previous)\s+(?:pull|read|check)\s*[—–-]\s*still\s+(one|zero|\d+)\s+(?:items?|records?|rows?|tasks?)(?:\s+total)?,\s*revision\s+(\d+)[.!]?$/i.exec(plain);
    if (unchangedFromPull) {
      parsedAssertions += 3;
      wholeSegmentOwned = true;
      const count = /^(?:one)$/i.test(unchangedFromPull[1] ?? '')
        ? 1
        : /^(?:zero)$/i.test(unchangedFromPull[1] ?? '')
          ? 0
          : Number(unchangedFromPull[1]);
      if (count !== shape.rows.length
        || !revisionValue
        || normalizedPresentedValue(unchangedFromPull[2] ?? '') !== revisionValue) return false;
    }

    // This comparison is compatible context, not positive snapshot evidence:
    // the exact current pair/table already carries that authority and the
    // downstream output-grounding gate still owns the historical claim.
    const unchangedSnapshotSummary = /^still\s+(?:one|1)\s+(?:item|record|row|task),\s+unchanged\s+since\s+(?:the\s+)?(?:last|previous)\s+read\s*[—–-]\s*same\s+source\s+and\s+revision(?:\s+via\s+the\s+[A-Za-z0-9 _-]{1,80}\s+provider)?[.!]?$/i.test(plain);
    if (unchangedSnapshotSummary) {
      parsedAssertions += 1;
      wholeSegmentOwned = true;
    }

    const compatibleStateRefreshHeading = /^(?:provider\s+)?state\s+has\s+(?:advanced|changed)\s*[—–-]\s*here(?:'|’)s\s+the\s+(?:current|fresh|latest|refreshed)\s+(?:queue|result|snapshot)\s*:$/i.test(plain);
    if (compatibleStateRefreshHeading) {
      parsedAssertions += 1;
      wholeSegmentOwned = true;
    }

    const rowOnlyStatusTransition = /^(?:the\s+)?(?:only\s+)?(?:item|record|row|task)\s+(?:moved|changed|flipped)\s+from\s+([A-Za-z0-9_-]+)\s*(?:→|->|to)\s*([A-Za-z0-9_-]+)(?:\s+since\s+(?:the\s+)?(?:last|previous)\s+read)?[.!]?$/i.exec(plain);
    if (rowOnlyStatusTransition) {
      parsedAssertions += 1;
      wholeSegmentOwned = true;
      if (!statusValue
        || normalizedPresentedValue(rowOnlyStatusTransition[2] ?? '') !== statusValue) return false;
    }

    const itemThenRevisionSentence = /^(?:the\s+)?(?:single\s+|only\s+)?(?:item|record|row|task)\s+(?:moved|changed|flipped)\s+from\s+([A-Za-z0-9_-]+)\s*(?:→|->|to)\s*([A-Za-z0-9_-]+),\s*and\s+the\s+revision\s+(?:bumped|advanced|changed|moved)\s+(?:from\s+)?(\d+)\s*(?:→|->|to)\s*(?:revision\s+)?(\d+)[.!]?$/i.exec(plain);
    if (itemThenRevisionSentence) {
      parsedAssertions += 2;
      wholeSegmentOwned = true;
      if (!statusValue
        || !revisionValue
        || normalizedPresentedValue(itemThenRevisionSentence[2] ?? '') !== statusValue
        || normalizedPresentedValue(itemThenRevisionSentence[4] ?? '') !== revisionValue) return false;
    }

    const statusThenRevision = /^still\s+(?:one|1)\s+(?:item|record|row|task),\s+but\s+its\s+(?:current\s+)?(?:status|state)\s+(?:moved|changed|flipped)\s+from\s+([A-Za-z0-9_-]+)\s*(?:→|->|to)\s*([A-Za-z0-9_-]+)\s+and\s+the\s+revision\s+(?:advanced|changed|moved)\s+from\s+(?:revision\s+)?(\d+)\s*(?:→|->|to)\s*(?:revision\s+)?(\d+)\s*[—–-]\s*the\s+provider\s+state\s+changed\s+since\s+(?:the\s+)?(?:last|previous)\s+read[.!]?$/i.exec(plain);
    const stateStatusThenRevision = /^the\s+state\s+changed\s+since\s+(?:the\s+)?(?:last|previous)\s+read\s*:\s*the\s+(?:item|record|row|task)\s+(?:moved|changed|flipped)\s+from\s+([A-Za-z0-9_-]+)\s*(?:→|->|to)\s*([A-Za-z0-9_-]+)\s*\(\s*revision\s+(\d+)\s*(?:→|->|to)\s*(?:revision\s+)?(\d+)\s*\)[.!]?$/i.exec(plain);
    const revisionThenStatus = /^the\s+(?:queue|feed|list|snapshot)\s+(?:advanced|changed|moved)\s+from\s+revision\s+(\d+)\s+to\s+revision\s+(\d+),\s+and\s+the\s+(?:(?:single\s+)?item[’']s\s+)?(?:status|state)\s+(?:moved|changed|flipped)\s+from\s+([A-Za-z0-9_-]+)\s+to\s+([A-Za-z0-9_-]+)[.!]?$/i.exec(plain);
    const revisionThenItem = /^the\s+(?:queue|feed|list|snapshot)\s+(?:advanced|changed|moved)\s+from\s+revision\s+(\d+)\s*(?:→|->|to)\s*(\d+),\s+and\s+the\s+(?:single|only|one)\s+(?:item|record|row|task)\s+(?:moved|changed|flipped)\s+from\s+([A-Za-z0-9_-]+)\s*(?:→|->|to)\s*([A-Za-z0-9_-]+)[.!]?$/i.exec(plain);
    const itemThenRevisionAnnotation = /^the\s+(?:single\s+|only\s+)?(?:item|record|row|task)\s+(?:moved|changed|flipped)\s+from\s+([A-Za-z0-9_-]+)\s*(?:→|->|to)\s*([A-Za-z0-9_-]+)(?:\s+since\s+(?:the\s+)?(?:last|previous)\s+read)?\s*\(\s*revision\s+(?:bumped|advanced|changed|moved)\s+(\d+)\s*(?:→|->|to)\s*(\d+)\s*\)[.!]?$/i.exec(plain);
    const claudeStatusThenRevision = /^it(?:'|’)s\s+advanced\s+since\s+last\s+check\s*[—–-]\s*(?:status|state)\s+(?:moved|changed|flipped)\s+from\s+([A-Za-z0-9_-]+)\s+to\s+([A-Za-z0-9_-]+),\s+and\s+the\s+revision\s+(?:bumped|advanced|changed|moved)\s+to\s+(\d+)[.!]?$/i.exec(plain);
    if (statusThenRevision || stateStatusThenRevision || revisionThenStatus || revisionThenItem || itemThenRevisionAnnotation || claudeStatusThenRevision) {
      parsedAssertions += 2;
      wholeSegmentOwned = true;
      const currentStatus = statusThenRevision?.[2]
        ?? stateStatusThenRevision?.[2]
        ?? revisionThenStatus?.[4]
        ?? revisionThenItem?.[4]
        ?? itemThenRevisionAnnotation?.[2]
        ?? claudeStatusThenRevision?.[2]
        ?? '';
      const currentRevision = statusThenRevision?.[4]
        ?? stateStatusThenRevision?.[4]
        ?? revisionThenStatus?.[2]
        ?? revisionThenItem?.[2]
        ?? itemThenRevisionAnnotation?.[4]
        ?? claudeStatusThenRevision?.[3]
        ?? '';
      if (!statusValue
        || !revisionValue
        || normalizedPresentedValue(currentStatus) !== statusValue
        || normalizedPresentedValue(currentRevision) !== revisionValue) return false;
    }

    const currentRevisionTarget = /^fresh\s+read\s*[—–-]\s*the\s+(?:queue|feed|list|snapshot)\s+(?:advanced|changed|moved)\s+to\s+revision\s+(\d+)\s*:$/i.exec(plain);
    if (currentRevisionTarget) {
      parsedAssertions += 1;
      wholeSegmentOwned = true;
      if (!revisionValue
        || normalizedPresentedValue(currentRevisionTarget[1] ?? '') !== revisionValue) return false;
    }

    const revisionStateChangeHeading = /^fresh\s+read\s*[—–-]\s*(?:the\s+)?(queue|feed|list|snapshot)\s+state\s+has\s+changed\s*\(\s*revision\s+(?:bumped|advanced|changed|moved)\s+(?:from\s+)?(\d+)\s*(?:→|->|to)\s*(?:revision\s+)?(\d+)\s*\)\s*:$/i.exec(plain);
    if (revisionStateChangeHeading) {
      parsedAssertions += 2;
      wholeSegmentOwned = true;
      const ownerNoun = ownerScope.trim().split(/\s+/).at(-1)?.toLowerCase() ?? '';
      if (revisionStateChangeHeading[1]?.toLowerCase() !== ownerNoun
        || !revisionValue
        || normalizedPresentedValue(revisionStateChangeHeading[3] ?? '') !== revisionValue) return false;
    }

    const stateChangedStatus = /^state\s+changed\s+since\s+(?:the\s+)?(?:last|previous)\s+read\s*[—–-]\s*the\s+(?:item|record|row|task)\s+is\s+now\s+([A-Za-z0-9_-]+)[.!]?$/i.exec(plain);
    if (stateChangedStatus) {
      parsedAssertions += 1;
      wholeSegmentOwned = true;
      if (!statusValue
        || normalizedPresentedValue(stateChangedStatus[1] ?? '') !== statusValue) return false;
    }

    const pronounStatus = /^(?:(?:actually|correction)\s*[:,]\s*)?(?:it|this|that)\s+(?:is|remains)\s+(?:(?:currently|now)\s+)?([A-Za-z0-9_-]+)[.!]?$/i.exec(plain);
    if (pronounStatus) {
      parsedAssertions += 1;
      wholeSegmentOwned = true;
      if (!statusValue
        || normalizedPresentedValue(pronounStatus[1] ?? '') !== statusValue) return false;
    }

    for (const field of fields) {
      const claims = [
        ...explicitCurrentFieldClaims(plain, field.aliases),
        ...explicitNarrativeFieldClaims(plain, field.aliases),
        ...explicitPossessiveFieldClaims(plain, field.aliases, rowIdentifiers),
        ...(fieldIsRowStatus(field) ? explicitRowStatusNarrativeClaims(plain, shape) : []),
      ];
      const expected = normalizedPresentedValue(field.value);
      parsedAssertions += claims.length;
      if (claims.some((claim) => claim !== expected)) return false;
    }

    if (wholeSegmentExplicitFieldClaim(plain, fields, shape)) wholeSegmentOwned = true;

    const fieldBearingPresentAssertion = fieldToken.test(plain)
      && /\b(?:at\s+revision|current|currently|now|equals|has|is|lists?|remains|shows?|still)\b|[:=]/i.test(plain);
    const rowBearingPresentAssertion = rowIdentifiers.some((identifier) => (
      new RegExp(`(?<![A-Za-z0-9_-])${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'i').test(plain)
    )) && /\b(?:is|remains|title|status|state)\b/i.test(plain);
    const transitionBearingAssertion = /\b(?:item|record|row|task|status|state|revision|queue|feed|list|snapshot)\b[^.!?\n]{0,180}\b(?:advanced|changed|flipped|moved)\b|\b(?:advanced|changed|flipped|moved)\b[^.!?\n]{0,180}\b(?:item|record|row|task|status|state|revision|queue|feed|list|snapshot)\b/i.test(plain);
    const neutralSegment = parsedAssertions === 0 && neutralReadNarrativeSegment(
      plain,
      shape,
      expectedTool,
      ownerScope,
      noAccountSelected,
      objective,
    );
    if ((fieldBearingPresentAssertion || rowBearingPresentAssertion || transitionBearingAssertion)
      && parsedAssertions === 0
      && !neutralSegment) return false;
    if (parsedAssertions > 0 && !wholeSegmentOwned) return false;
    if (parsedAssertions === 0 && !neutralSegment) return false;
  }
  return true;
}

/**
 * Exact one-row presentation floor. Every explicitly requested field is bound
 * to its own label/table cell, and every assertion for that label must equal
 * the current provider value. Narrative is never treated as positive evidence,
 * but simple present-tense field/status assertions are checked for conflicts;
 * historical conversational context may remain around the exact snapshot.
 */
function replyCoversNamedReadFields(
  objective: string,
  reply: string,
  record: Record<string, unknown>,
  shape: ExactCollectionShape,
  expectedTool: string,
  noAccountSelected: boolean,
): boolean {
  const requested = requestedPresentationFields(objective);
  if (requested.length < 3) return false;
  const contract = plainRetrievalAndPresentationContract(objective);
  const ownerScope = contract
    ? objectiveRetrievalOwnerScope(objective, contract)
    : null;
  if (!ownerScope) return false;
  if (presentationRequiresSemanticJudge(reply)) return false;
  const scopedSnapshot = parseScopedProviderSnapshotBlocks(reply);
  if (!scopedSnapshot.valid
    || scopedSnapshot.blocks.length > 1
    || (scopedSnapshot.claimed && scopedSnapshot.blocks.length !== 1)
    || scopedSnapshot.blocks.some((block) => (
      !positiveRetrievalClauseOwnsScope(objective, block.scope)
      || (block.narrativeSuffixStatus !== null
        && normalizedPresentedValue(block.narrativeSuffixStatus)
          !== normalizedPresentedValue(block.status))
    ))) return false;
  const inlineMetadata = inlineCurrentMetadataPairs(reply);
  if (inlineMetadata.length > 1
    || (inlineMetadata.length === 1
      && (!inlineCurrentMetadataPairOwnsItemTable(reply, inlineMetadata[0]!)
        || (inlineMetadata[0]!.scope !== null
          && !positiveRetrievalClauseOwnsScope(objective, inlineMetadata[0]!.scope!))))) return false;
  const fields = snapshotFields(record, shape);
  const structured = structuredReplyAssertions(reply, fields, shape);
  if (!structured.valid) return false;
  const assertions = structured.assertions;
  const rowFieldAliases = new Set(fields
    .filter((field) => field.scope === 'row')
    .flatMap((field) => field.aliases));
  const structuredDataRows = structured.horizontalRows.filter((row) => (
    row.headers.some((header) => rowFieldAliases.has(header))
  ));
  if (structuredDataRows.length > 1) return false;
  const acceptedLabels = new Set(fields.flatMap((field) => field.aliases));
  const consumedLines = new Set(structured.tableLines);
  for (const binding of structured.labelLines) {
    if (acceptedLabels.has(binding.label)) consumedLines.add(binding.index);
  }
  const narrative = reply.split(/\r?\n/)
    .map((line, index) => structured.narrativeLineOverrides.has(index)
      ? structured.narrativeLineOverrides.get(index)!
      : consumedLines.has(index) ? '' : line)
    .join('\n');
  const requestedSnapshotFields: SnapshotField[] = [];
  let metadataBindings = 0;
  let rowIdentityBindings = 0;

  for (const requestedField of requested) {
    const matchingFields = fields.filter((candidate) => candidate.aliases.includes(requestedField));
    if (matchingFields.length === 0) {
      // With an explicitly empty collection, row fields have no values to
      // present. The empty-result sentence below is their exact substitute,
      // but it cannot coexist with invented structured row assertions.
      if (shape.rows.length === 0) {
        const absentAliases = new Set([requestedField]);
        if (/(?:^|\s)id$/.test(requestedField) || requestedField === 'identifier') {
          absentAliases.add('id');
          absentAliases.add('identifier');
          absentAliases.add(`${singularCollectionName(shape.collectionKey)} id`);
        }
        if ([...absentAliases].some((alias) => (assertions.get(alias)?.length ?? 0) > 0)
          || explicitCurrentFieldClaims(narrative, [...absentAliases]).length > 0
          || explicitNarrativeFieldClaims(narrative, [...absentAliases]).length > 0
          || (/^(?:status|state)$/.test(requestedField)
            && explicitRowStatusNarrativeClaims(narrative, shape).length > 0)) return false;
        continue;
      }
      return false;
    }
    // An operation envelope and its sole row may both expose `status`, `title`,
    // or `id`. V1 has no schema authority to decide which unqualified label the
    // user meant, so ambiguity retains the ordinary judge instead of letting
    // metadata shadow the business row.
    if (matchingFields.length !== 1) return false;
    const field = matchingFields[0]!;
    const values = field.aliases.flatMap((alias) => assertions.get(alias) ?? []);
    const expected = normalizedPresentedValue(field.value);
    if (values.length === 0 || values.some((value) => value !== expected)) return false;
    const narrativeClaims = [
      ...explicitCurrentFieldClaims(narrative, field.aliases),
      ...explicitNarrativeFieldClaims(narrative, field.aliases),
      ...explicitPossessiveFieldClaims(narrative, field.aliases, shapeRowIdentifiers(shape)),
      ...(fieldIsRowStatus(field)
        ? explicitRowStatusNarrativeClaims(narrative, shape)
        : []),
    ];
    if (narrativeClaims.some((value) => value !== expected)) return false;
    requestedSnapshotFields.push(field);
    if (field.scope === 'metadata') metadataBindings += 1;
    if (field.scope === 'row' && stableRowIdentifierKey(field.key, shape.collectionKey)) rowIdentityBindings += 1;
  }

  if (!narrativeSnapshotClaimsMatch(
    narrative,
    requestedSnapshotFields,
    shape,
    expectedTool,
    ownerScope,
    noAccountSelected,
    objective,
  )) return false;
  if (metadataBindings < 1) return false;
  if (shape.rows.length === 0) return settledZeroCollection(record) && replyClaimsEmptyCollection(reply);
  return rowIdentityBindings >= 1 && !replyClaimsEmptyCollection(reply);
}

function collectionOutputIsPartial(
  record: Record<string, unknown>,
  returnedRows: number,
  rows: ReadonlySet<unknown>,
): boolean {
  const markerHasValue = (value: unknown): boolean => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value > 0;
    if (typeof value === 'string') {
      return value.trim().length > 0 && !/^(?:0|false|none|null)$/i.test(value.trim());
    }
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
    return false;
  };
  const pageTotalExceedsOne = (value: unknown): boolean => {
    const numeric = typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\s*\d+\s*$/.test(value)
        ? Number(value)
        : Number.NaN;
    return Number.isFinite(numeric) && numeric > 1;
  };
  const numericValue = (value: unknown): number | null => {
    const numeric = typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\s*\d+\s*$/.test(value)
        ? Number(value)
        : Number.NaN;
    return Number.isFinite(numeric) ? numeric : null;
  };
  const visit = (value: unknown, depth = 0, inPagination = false): boolean => {
    if (depth > 8 || value == null || rows.has(value)) return false;
    if (Array.isArray(value)) return value.some((child) => visit(child, depth + 1, inPagination));
    if (typeof value !== 'object') return false;
    return Object.entries(value as Record<string, unknown>).some(([rawKey, child]) => {
      const key = normalizedKeyWords(rawKey).replace(/\s+/g, '_');
      if ((PENDING_COLLECTION_KEYS.has(key) || key.startsWith('next_') || key.startsWith('odata_next'))
        && markerHasValue(child)) return true;
      if (PAGE_TOTAL_KEYS.has(key) && pageTotalExceedsOne(child)) return true;
      if (inPagination && key === 'next' && markerHasValue(child)) return true;
      if (inPagination && /^(?:record_count|result_count|total|total_count)$/.test(key)) {
        const total = numericValue(child);
        if (total !== null && total > returnedRows) return true;
      }
      if (inPagination && /^(?:offset|page|current_page)$/.test(key)) {
        const position = numericValue(child);
        if (position !== null && (key === 'offset' ? position > 0 : position > 1)) return true;
      }
      return visit(child, depth + 1, inPagination || PAGINATION_CONTAINER_KEYS.has(key));
    });
  };
  return visit(record);
}

function discoveryMatchesExactRead(
  events: readonly EventRow[],
  sourceUserSeq: number,
  attemptId: string,
  turn: number,
  discovery: ExactReadOccurrence,
  business: ExactReadOccurrence,
): boolean {
  const record = parseLeadingRecord(discovery.output, discovery.effectiveTool);
  if (!record || record.configured !== true || record.count !== 1 || !Array.isArray(record.matches) || record.matches.length !== 1) return false;
  if (collectionEnvelopeContainsFailure(record, new Set(record.matches))) return false;
  const match = record.matches[0];
  if (!match || typeof match !== 'object' || Array.isArray(match)) return false;
  const candidate = match as Record<string, unknown>;
  const identifier = typeof candidate.slug === 'string' && candidate.slug.trim()
    ? candidate.slug.trim()
    : typeof candidate.name === 'string'
      ? candidate.name.trim()
      : '';
  if (!identifier || identifier !== business.effectiveTool) return false;
  if (!candidate.inputParameters || typeof candidate.inputParameters !== 'object' || Array.isArray(candidate.inputParameters)) return false;

  const capabilities = events.filter((event) => (
    event.type === 'capability_discovered'
    && event.seq > discovery.call.seq
    && event.seq < business.call.seq
    && event.turn === turn
    && eventSourceUserSeq(event) === sourceUserSeq
    && eventText(event, 'attemptId') === attemptId
  ));
  if (capabilities.length !== 1) return false;
  const discovered = eventData(capabilities[0]).capabilities;
  if (!Array.isArray(discovered) || discovered.length !== 1) return false;
  const capability = discovered[0];
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)) return false;
  const capabilityRecord = capability as Record<string, unknown>;
  if (capabilityRecord.identifier !== identifier || capabilityRecord.effectClass !== 'read') return false;

  const outcomes = events.filter((event) => (
    event.type === 'discovery_governor_outcome'
    && event.seq > discovery.call.seq
    && event.seq < business.call.seq
    && event.turn === turn
    && eventSourceUserSeq(event) === sourceUserSeq
    && eventText(event, 'attemptId') === attemptId
    && eventData(event).callId === discovery.callId
  ));
  return outcomes.length === 1
    && eventData(outcomes[0]!).outcome === 'succeeded'
    && eventData(outcomes[0]!).recorded === true
    && eventData(outcomes[0]!).reason === 'outcome_recorded';
}

interface AffirmativeColdScaffold {
  line: string;
  query: string;
}

function affirmativeColdScaffold(objective: string): AffirmativeColdScaffold | null {
  const patterns = [
    /^\s*(?:please\s+)?call\s+composio_search_tools\s+exactly\s+once\s+with\s+query\s+(["'])(.*?)\1\.\s*choose\s+its\s+(?:single|one)\s+read[- ]only\s+match,\s*then\s+call\s+composio_execute_tool\s+exactly\s+once\s+with\s+that\s+action\s+and\s+the\s+empty\s+argument\s+object\s*\{\s*\}\.?\s*$/i,
    /^\s*you\s+do\s+not\s+know\s+the\s+action\s+identifier\s+yet\.\s*call\s+composio_search_tools\s+exactly\s+once\s+with\s+query\s+(["'])(.*?)\1,\s*choose\s+its\s+(?:single|one)\s+read[- ]only\s+match,\s*then\s+call\s+composio_execute_tool\s+exactly\s+once\s+with\s+that\s+action\s+and\s+the\s+empty\s+argument\s+object\s*\{\s*\}\.?\s*$/i,
  ];
  const matches = objective.split(/\r?\n/).flatMap((line) => {
    const match = patterns.map((pattern) => pattern.exec(line)).find(Boolean);
    const query = match?.[2]?.trim();
    return match && query ? [{ line, query }] : [];
  });
  if (matches.length !== 1) return null;
  if ((objective.match(/\bcall\s+composio_search_tools\s+exactly\s+once\b/gi)?.length ?? 0) !== 1
    || (objective.match(/\bcall\s+composio_execute_tool\s+exactly\s+once\b/gi)?.length ?? 0) !== 1) return null;
  return matches[0]!;
}

function objectiveHasOnlyReadDiscoveryTransportMutation(objective: string): boolean {
  const scaffold = affirmativeColdScaffold(objective);
  if (!scaffold) return false;
  // Project only the fully parsed, affirmative read carrier. Any adjacent or
  // separate intellectual/local/external work remains visible and fails shut.
  const projected = objective.replace(scaffold.line, 'Use the exact read transport once.');
  return !objectiveRequiresFreshExternalWrite(objective)
    && !objectiveRequiresMutatingEvidence(projected);
}

const NON_RETRIEVAL_WORK_RE =
  /\b(?:analy[sz](?:e|is)|assess|calculate|categori[sz]e|chart|choose|classify|compare|complete|compute|contrast|create|decide|delete|deploy|derive|determine|diagram|diagnose|draft|email|estimate|evaluate|explain|finish|forecast|graph|group|infer|interpret|invite|plot|post|prioriti[sz]e|publish|rank|recommend|render|resolve|review|save|score|send|sort|submit|summari[sz]e|synthesi[sz]e|tabulate|toggle|transform|triage|update|upload|verify|visuali[sz]e|write)\b/i;
const JUDGMENT_QUESTION_RE =
  /\b(?:why|how\s+should|what\s+should|is\s+it\s+(?:safe|ready|wise)|should\b[^.!?\n]{0,60}\b(?:ship|proceed)|which\b[^.!?\n]{0,60}\b(?:best|highest|lowest|most|risk|ship|urgent))\b/i;
// A verified-read receipt owns one retrieval clause, not work hidden inside a
// dependent clause. This structural boundary is deliberately independent of
// the action-verb blacklist: unknown work such as "while auditing ..." must
// keep the ordinary semantic completion judge.
const UNOWNED_DEPENDENT_CLAUSE_RE =
  /\b(?:after|although|because|before|if|once|though|unless|until|when|whenever|whereas|while)\b|\bas\s+(?:i|we|you|it|they|the)\b/i;
// Result modifiers and parallel-work attachments are compound objective
// structure even when their head word is not an imperative verb. This keeps
// passive transformations ("items ranked by risk") and noun work
// ("alongside an audit") with the semantic completion judge.
const UNOWNED_RESULT_TRANSFORMATION_RE =
  /\b(?:ranked|ordered|sorted|grouped|classified|categori[sz]ed|scored|prioriti[sz]ed)\s+(?:by|according\s+to)\b|\b(?:alongside|together\s+with|in\s+addition\s+to)\s+(?:an?|the|another)\b/i;
const FRESH_READ_REUSE_LINE_RES = [
  /^\s*(?:the\s+)?provider\s+state\s+(?:may\s+have\s+)?changed(?:\s+after\s+the\s+prior\s+answer)?,?\s+so\s+perform\s+a\s+fresh\s+read\s+with\s+the\s+capability\s+already\s+proved\.?\s*$/i,
  /^\s*the\s+provider\s+state\s+may\s+have\s+changed\.\s*use\s+the\s+capability\s+already\s+proved,\s*perform\s+a\s+fresh\s+read,\s*and\s+do\s+not\s+replay\s+an\s+old\s+answer\s+or\s+rediscover\s+anything\.?\s*$/i,
];

function isFreshReadReuseLine(line: string): boolean {
  return FRESH_READ_REUSE_LINE_RES.some((pattern) => pattern.test(line));
}

function stripConversationalReadNavigation(clause: string): string {
  const withoutNow = clause.replace(
    /^now\s+(?=(?:fetch|find|get|list|look\s+up|query|read|refresh|retrieve|search)\b)/i,
    '',
  );
  if (withoutNow !== clause) return withoutNow;

  const backTo = /^back\s+to\s+([^.!?\n;,:—–]{1,120}):\s*(.*)$/i.exec(clause);
  if (!backTo) return clause;
  const context = backTo[1]!.trim();
  const retrieval = backTo[2]!.trim();
  // A navigation label is a noun-like context marker, never a second action.
  // Conjunctions or action-shaped wording keep the generic judge.
  if (!context
    || NON_RETRIEVAL_WORK_RE.test(context)
    || /\b(?:also|and|but|call|fetch|find|get|however|instead|list|look\s+up|query|read|refresh|retrieve|search|then|use|yet)\b/i.test(context)
    || !/^(?:fetch|find|get|list|look\s+up|query|read|refresh|retrieve|search)\b/i.test(retrieval)) {
    return clause;
  }
  return retrieval;
}

const PLAIN_COLLECTION_RETRIEVAL_RE = new RegExp(
  [
    '^(?:fetch|find|get|list|look\\s+up|query|read|refresh|retrieve|search)\\s+',
    '(?:(?:the|its|my|our)\\s+)?',
    '(?:[a-z0-9][a-z0-9_\'/-]*\\s+){0,12}',
    'current\\s+(?:contacts?|documents?|events?|files?|items?|messages?|records?|results?|rows?|tasks?)(?:\\s+feed)?',
    '(?:\\s+from\\s+(?:the\\s+)?(?:(?:same|connected|local)\\s+){0,3}(?:source|provider))?',
    '(?:\\s+now)?$',
  ].join(''),
  'i',
);

function plainCollectionRetrievalClause(clause: string): boolean {
  if (PLAIN_COLLECTION_RETRIEVAL_RE.test(clause)) return true;
  const returnTo = /^return\s+to\s+([^.!?\n;,:—–]{1,120})\s+and\s+(refresh\s+[\s\S]+)$/i.exec(clause);
  if (!returnTo) return false;
  const context = returnTo[1]!.trim();
  return Boolean(context)
    && !NON_RETRIEVAL_WORK_RE.test(context)
    && !/\b(?:also|and|but|call|fetch|find|get|however|instead|list|look\s+up|query|read|refresh|retrieve|search|then|use|yet)\b/i.test(context)
    && PLAIN_COLLECTION_RETRIEVAL_RE.test(returnTo[2]!.trim());
}

interface PlainRetrievalAndPresentationContract {
  primaryRetrievalClause: string;
}

function plainRetrievalAndPresentationContract(
  objective: string,
): PlainRetrievalAndPresentationContract | null {
  const presentation = affirmativePresentationContract(objective);
  if (!presentation || presentation.fields.length < 3 || objective.includes('?')) return null;
  const cold = affirmativeColdScaffold(objective);
  const freshReadReuseLines = objective.split(/\r?\n/)
    .filter((line) => isFreshReadReuseLine(line));
  if (freshReadReuseLines.length > 1) return null;
  const freshReadReuseLine = freshReadReuseLines[0];
  const withoutOwnedDirectives = objective
    .replace(presentation.line, '')
    .replace(cold?.line ?? /$^/, '')
    .replace(freshReadReuseLine ?? /$^/, '');
  const positive = withoutOwnedDirectives
    .replace(/\b(?:you\s+)?(?:do\s+not|don't|dont|never|without)\b(?:(?!\b(?:but|however|instead|then|yet)\b)[^.!?\n;:—–])*/gi, ' prohibited work ');
  if (NON_RETRIEVAL_WORK_RE.test(positive)
    || JUDGMENT_QUESTION_RE.test(positive)
    || UNOWNED_DEPENDENT_CLAUSE_RE.test(positive)
    || UNOWNED_RESULT_TRANSFORMATION_RE.test(positive)
    || /\b(?:display|give|mention|provide|show|state|tell)\b/i.test(positive)
    || /\b(?:including|showing|with)\b/i.test(positive)) return null;

  const clauses = positive
    .split(/[.!?\n;]+/)
    .map((clause) => clause
      .replace(/\bprohibited work\b/gi, ' ')
      .trim()
      .replace(/^(?:(?:also|and|but|however|instead|then|yet)\b[,:]?\s*)+/i, '')
      .trim())
    .filter(Boolean);
  let primaryRetrievals = 0;
  let primaryRetrievalClause: string | null = null;
  let reuseClauses = freshReadReuseLine ? 1 : 0;
  let contextFragments = 0;
  for (const rawClause of clauses) {
    const clause = rawClause.replace(/^correction\s*:\s*/i, '').trim();
    if (!clause) return null;
    if (/^return\s+to\b/i.test(clause) && plainCollectionRetrievalClause(clause)) {
      primaryRetrievals += 1;
      primaryRetrievalClause = clause;
      continue;
    }
    if (/^reuse\b/i.test(clause)) {
      if (/[,;:—]|\b(?:and|but|however|instead|then|to|yet)\b/i.test(clause)) return null;
      reuseClauses += 1;
      continue;
    }
    const retrievalClause = stripConversationalReadNavigation(clause);
    if (/^(?:fetch|find|get|list|look\s+up|query|read|refresh|retrieve|search)\b/i.test(retrievalClause)) {
      const readVerbs = retrievalClause.match(/\b(?:fetch|find|get|list|look\s+up|query|read|refresh|retrieve|search)\b/gi) ?? [];
      if (readVerbs.length !== 1
        || !plainCollectionRetrievalClause(retrievalClause)) return null;
      primaryRetrievals += 1;
      primaryRetrievalClause = clause;
      continue;
    }
    if (/^proof\s+release\s+queue\s+current\s+items\s+[—-]\s+cold\s+learning\s+check$/i.test(clause)) {
      contextFragments += 1;
      continue;
    }
    return null;
  }
  return primaryRetrievals === 1
    && reuseClauses <= 1
    && contextFragments <= 1
    && primaryRetrievalClause
    ? { primaryRetrievalClause }
    : null;
}

function objectiveIsPlainRetrievalAndPresentation(objective: string): boolean {
  return plainRetrievalAndPresentationContract(objective) !== null;
}

function primaryRetrievalOwnerScope(clause: string): string | null {
  const compoundOwner = /\b(?:and|or|nor|plus|alongside|versus|vs|excluding|over|except|not|against)\b|\b(?:as\s+opposed\s+to|compared\s+to|other\s+than|instead\s+of|rather\s+than)\b/i;
  const exactSingleCollectionOwner = (raw: string, normalized: string): string | null => {
    const nouns = normalized.match(/\b(?:queue|feed|list|snapshot)\b/g) ?? [];
    return raw.includes('/')
      || compoundOwner.test(normalized)
      || nouns.length !== 1
      || !/(?:^|\s)(?:queue|feed|list|snapshot)$/.test(normalized)
      ? null
      : normalized;
  };
  const normalizedClause = clause.replace(/^correction\s*:\s*/i, '').trim();
  const backTo = /^back\s+to\s+([^.!?\n;,:—–]{1,120})\s*:/i.exec(normalizedClause);
  const returnTo = /^return\s+to\s+([^.!?\n;,:—–]{1,120})\s+and\s+refresh\b/i.exec(normalizedClause);
  const rawNavigationOwner = backTo?.[1] ?? returnTo?.[1] ?? '';
  const navigationOwner = normalizedKeyWords(rawNavigationOwner)
    .replace(/^(?:the|my|our)\s+/, '');
  if (navigationOwner) {
    return exactSingleCollectionOwner(rawNavigationOwner, navigationOwner);
  }

  const direct = normalizedClause.replace(
    /^now\s+(?=(?:fetch|find|get|list|look\s+up|query|read|refresh|retrieve|search)\b)/i,
    '',
  );
  const match = /^(?:fetch|find|get|list|look\s+up|query|read|refresh|retrieve|search)\s+(?:(?:the|its|my|our)\s+)?((?:[a-z0-9][a-z0-9_'/-]*\s+){1,12})current\s+(?:contacts?|documents?|events?|files?|items?|messages?|records?|results?|rows?|tasks?)(?:\s+feed)?/i.exec(direct);
  const rawOwner = match?.[1] ?? '';
  const owner = normalizedKeyWords(rawOwner);
  return owner ? exactSingleCollectionOwner(rawOwner, owner) : null;
}

function objectiveRetrievalOwnerScope(
  objective: string,
  contract: PlainRetrievalAndPresentationContract,
): string | null {
  const primary = primaryRetrievalOwnerScope(contract.primaryRetrievalClause);
  if (primary) return primary;
  if (!affirmativeColdScaffold(objective)) return null;
  const coldScopes = objective.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*([A-Za-z0-9_-]+(?:\s+[A-Za-z0-9_-]+){0,8}\s+(?:queue|feed|list|snapshot))\s+current\s+items\s+[—–-]\s+cold\s+learning\s+check[.!]?\s*$/i.exec(line);
    if (!match) return [];
    const scope = normalizedKeyWords(match[1] ?? '');
    return primaryRetrievalOwnerScope(`refresh the ${scope} current items`) === scope
      ? [scope]
      : [];
  });
  return coldScopes.length === 1 ? coldScopes[0]! : null;
}

function positiveRetrievalClauseOwnsScope(objective: string, scope: string): boolean {
  const contract = plainRetrievalAndPresentationContract(objective);
  const normalizedScope = normalizedKeyWords(scope);
  if (!contract || !normalizedScope) return false;
  return objectiveRetrievalOwnerScope(objective, contract) === normalizedScope;
}

function emptyObject(value: unknown): boolean {
  if (typeof value === 'string') {
    try { return emptyObject(JSON.parse(value) as unknown); } catch { return false; }
  }
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).length === 0;
}

function coldTransportMatchesLiteralObjective(
  objective: string,
  discovery: ExactReadOccurrence,
  business: ExactReadOccurrence,
): boolean {
  const scaffold = affirmativeColdScaffold(objective);
  if (!scaffold) return false;
  const requiredQuery = scaffold.query;
  const discoveryArgs = discovery.args && typeof discovery.args === 'object' && !Array.isArray(discovery.args)
    ? discovery.args as Record<string, unknown>
    : null;
  const businessArgs = business.args && typeof business.args === 'object' && !Array.isArray(business.args)
    ? business.args as Record<string, unknown>
    : null;
  if (!discoveryArgs || discoveryArgs.query !== requiredQuery || !businessArgs) return false;
  if (businessArgs.tool_slug !== business.effectiveTool || !emptyObject(businessArgs.arguments)) return false;
  const discoveryRecord = parseLeadingRecord(discovery.output, discovery.effectiveTool);
  return discoveryRecord?.query === requiredQuery;
}

function exactReadOccurrences(input: ExactVerifiedReadCompletionInput): {
  events: EventRow[];
  occurrences: ExactReadOccurrence[];
} | null {
  const sourceUserSeq = input.sourceUserSeq;
  const attemptId = input.runAttemptId?.trim();
  if (!Number.isSafeInteger(sourceUserSeq) || (sourceUserSeq ?? 0) <= 0) return null;
  if (!attemptId) return null;
  const events = listEvents(input.sessionId, { sinceSeq: sourceUserSeq as number });
  const afterSource = events;
  const canonical = projectCanonicalTopLevelToolEvents(afterSource);
  const currentTurn = canonical.filter((event) => event.turn === input.turn);
  if (currentTurn.length === 0) return null;
  // This certificate has no legacy/foreign attribution fallback. Every logical
  // tool edge in the physical turn belongs to the exact accepted source.
  if (currentTurn.some((event) => (
    eventSourceUserSeq(event) !== sourceUserSeq
    || eventText(event, 'attemptId') !== attemptId
  ))) return null;
  if (canonical.some((event) => eventSourceUserSeq(event) === sourceUserSeq && event.turn !== input.turn)) return null;

  const calls = currentTurn.filter((event) => event.type === 'tool_called');
  const returns = currentTurn.filter((event) => event.type === 'tool_returned');
  if (calls.length === 0 || calls.length !== returns.length) return null;
  const occurrences: ExactReadOccurrence[] = [];
  for (const call of calls) {
    const callId = eventText(call, 'callId');
    const outerTool = eventText(call, 'tool');
    if (!callId || !outerTool || eventText(call, 'effect') !== 'read') return null;
    const matches = returns.filter((returned) => (
      eventText(returned, 'callId') === callId
      && returned.parentEventId === call.id
      && returned.seq > call.seq
      && eventText(returned, 'tool') === outerTool
      && eventText(returned, 'effect') === 'read'
      && eventText(returned, 'effectiveTool') === eventText(call, 'effectiveTool')
    ));
    if (matches.length !== 1) return null;
    const returned = matches[0]!;
    if (eventData(returned).providerDispatched === false || eventData(returned).replayKind) return null;
    const returnValue = eventData(returned).result ?? eventData(returned).output;
    if (!toolOutputLooksSuccessful(returnValue, eventData(returned).ok)) return null;
    occurrences.push({
      call,
      returned,
      callId,
      outerTool,
      effectiveTool: effectiveToolName(call),
      args: toolCallInput(call),
      output: '',
    });
  }
  if (new Set(occurrences.map((occurrence) => occurrence.callId)).size !== occurrences.length) return null;

  const resolved = resolveToolOutputsForAuthority(
    input.sessionId,
    occurrences.map((occurrence) => ({ callId: occurrence.callId })),
    { readOrComputeOnly: true, allowedSourceUserSeqs: [sourceUserSeq as number] },
  );
  if (resolved.length !== occurrences.length) return null;
  const byCall = new Map(resolved.map((record) => [record.callId, record]));
  for (const occurrence of occurrences) {
    const authority = byCall.get(occurrence.callId);
    if (!authority
      || authority.effect !== 'read'
      || authority.sourceUserSeq !== sourceUserSeq
      || authority.truncatedAtWrite
      || !authority.output.trim()
      || !toolOutputLooksSuccessful(authority.output)) return null;
    occurrence.output = authority.output;
  }
  return { events, occurrences };
}

function replyHistoryClaimsMatch(input: {
  sessionId: string;
  currentSourceUserSeq: number;
  reply: string;
  work: ExactReadOccurrence;
  currentRecord: Record<string, unknown>;
  currentShape: ExactCollectionShape;
}): boolean {
  const parsed = parseReadHistoryClaims(input.reply);
  if (parsed.unparsedTemporalSegments.length > 0) return false;
  if (parsed.claims.length === 0) return true;

  const current = readHistorySnapshot(
    input.currentRecord,
    input.currentShape,
    input.work.effectiveTool,
    input.work.args,
  );
  if (!current) return false;
  const priorEvidence = resolveLatestTrustedPriorVerifiedRead({
    sessionId: input.sessionId,
    currentSourceUserSeq: input.currentSourceUserSeq,
    expectedEffectiveTool: input.work.effectiveTool,
    currentCallSeq: input.work.call.seq,
  });
  if (!priorEvidence) return false;
  const priorRecord = parseLeadingRecord(
    priorEvidence.rawOutput,
    input.work.effectiveTool,
    { allowReadRoutingRemainder: true },
  );
  if (!priorRecord) return false;
  const priorShape = exactCollectionShape(priorRecord);
  if (!priorShape
    || collectionOutputIsPartial(priorRecord, priorShape.rows.length, new Set(priorShape.rows))
    || collectionEnvelopeContainsFailure(priorRecord, new Set(priorShape.rows))) return false;
  const prior = readHistorySnapshot(
    priorRecord,
    priorShape,
    input.work.effectiveTool,
    priorEvidence.toolArgs,
  );
  if (!prior) return false;
  return validateReadHistoryClaims({ text: input.reply, current, prior }).decision === 'certified';
}

/**
 * Issue a narrow, provider-neutral read completion receipt. It removes only
 * the generic plural-noun completion judge; it does not publish, rewrite, or
 * bypass output-grounding, claim-grounding, approval, artifact, delivery, or
 * external-write gates.
 */
export function exactVerifiedReadCompletionCertificate(
  input: ExactVerifiedReadCompletionInput,
): ExactVerifiedReadCompletionCertificate | null {
  try {
    if (!input.runAttemptId?.trim() || input.openApprovalCard) return null;
    const sourceUserSeq = input.sourceUserSeq;
    if (!Number.isSafeInteger(sourceUserSeq) || (sourceUserSeq ?? 0) <= 0) return null;
    const accepted = currentAcceptedReadAuthority(
      input.sessionId,
      sourceUserSeq,
      input.runAttemptId,
      input.acceptedUserInput,
    );
    if (!accepted) return null;
    const reply = assertPublicPresentationText(input.reply);
    if (isPromiseShapedReply(reply) || isDirectionSeekingQuestion(reply) || matchesBlockedText(reply)) return null;
    if (objectiveRequiresFreshExternalWrite(input.objective)) return null;
    if (!objectiveIsPlainRetrievalAndPresentation(input.objective)) return null;

    const exact = exactReadOccurrences(input);
    if (!exact) return null;
    const { events, occurrences } = exact;
    if (events.some((event) => (
      event.seq > (sourceUserSeq as number)
      && (event.turn === input.turn || eventSourceUserSeq(event) === sourceUserSeq)
      && /^(?:approval_requested|awaiting_user_input|external_write|external_write_succeeded|external_write_failed|external_write_orphaned)$/.test(event.type)
    ))) return null;

    const controls = occurrences.filter((occurrence) => isControlOnlyTool(occurrence.effectiveTool));
    if (controls.length > 0) return null;
    const probes = occurrences.filter((occurrence) => isToolSurfaceProbeTool(occurrence.effectiveTool));
    const business = occurrences.filter((occurrence) => !isToolSurfaceProbeTool(occurrence.effectiveTool));
    if (business.length !== 1) return null;
    const work = business[0]!;
    // V1 is intentionally limited to the transport with a typed settled-read
    // classifier. This check also grants provenance for the exact read-routing
    // suffixes accepted by parseLeadingRecord; discovery and native/direct
    // outputs can never mint those rails from matching prose.
    if (work.outerTool !== 'composio_execute_tool') return null;
    const businessRecord = parseLeadingRecord(work.output, work.effectiveTool, {
      allowReadRoutingRemainder: true,
    });
    if (!businessRecord) return null;
    const collectionShape = exactCollectionShape(businessRecord);
    if (!collectionShape) return null;
    if (collectionOutputIsPartial(
      businessRecord,
      collectionShape.rows.length,
      new Set(collectionShape.rows),
    )) return null;
    if (collectionEnvelopeContainsFailure(businessRecord, new Set(collectionShape.rows))) return null;
    if (!replyHistoryClaimsMatch({
      sessionId: input.sessionId,
      currentSourceUserSeq: sourceUserSeq as number,
      reply,
      work,
      currentRecord: businessRecord,
      currentShape: collectionShape,
    })) return null;
    if (!replyCoversNamedReadFields(
      input.objective,
      reply,
      businessRecord,
      collectionShape,
      work.effectiveTool,
      readExplicitlyUsesNoConnectedAccount(work.args),
    )) return null;

    const settled = classifySettledDirectComposioRead({
      toolName: work.outerTool,
      args: work.args,
      output: work.output,
    });
    if (!settled || settled.toolSlug !== work.effectiveTool) return null;

    let kind: ExactVerifiedReadCompletionCertificate['kind'];
    if (
      probes.length === 0
      && occurrences.length === 1
      && singleSuccessfulCollectionReadCompletesObjective(
        input.objective,
        [work.effectiveTool],
      )
    ) {
      kind = 'single_collection_read';
    } else if (
      probes.length === 1
      && occurrences.length === 2
      && probes[0]!.effectiveTool === 'composio_search_tools'
      && probes[0]!.call.seq < work.call.seq
      && objectiveHasOnlyReadDiscoveryTransportMutation(input.objective)
      && coldTransportMatchesLiteralObjective(input.objective, probes[0]!, work)
      && singleSuccessfulCollectionReadHasNoHardMultiplicity(
        input.objective,
        [probes[0]!.effectiveTool, work.effectiveTool],
      )
      && discoveryMatchesExactRead(
        events,
        sourceUserSeq as number,
        accepted.attempt.attemptId,
        input.turn,
        probes[0]!,
        work,
      )
    ) {
      kind = 'read_discovery_scaffold';
    } else {
      return null;
    }

    return {
      version: 1,
      kind,
      sourceUserSeq: sourceUserSeq as number,
      attemptId: accepted.attempt.attemptId,
      callId: work.callId,
      toolName: work.effectiveTool,
      outputDigest: digest(work.output),
      objectiveDigest: digest(input.objective),
      presentationDigest: digest(reply),
    };
  } catch {
    return null;
  }
}
