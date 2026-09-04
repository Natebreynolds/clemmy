/**
 * Pure provider-result interpretation.
 *
 * This module deliberately imports no event log, authority, or result-handle
 * runtime. Persistence, terminal publication, and receipt redemption can all
 * derive the same facts from the same raw bytes without creating an import
 * cycle or trusting stored projections.
 */
import {
  inspectProviderEnvelope,
  providerRequestEchoKey,
  providerResultBookkeepingKey,
  contradictionIsNestedStatusOnly,
} from './provider-read-evidence.js';

export type ResultCompleteness = 'complete' | 'partial' | 'unknown';

export const RESULT_PROJECTION_MAX_BYTES = 16_000;
export const RESULT_PROJECTION_MAX_RECORDS = 50;

export interface RawResultHandleFacts {
  success: boolean;
  recordPath: string | null;
  recordCount: number;
  envelopeMeta: Record<string, unknown> | null;
  completeness: ResultCompleteness;
  projectedRecords: unknown[];
  statusCode: number | null;
  /** Exact opaque provider cursor. Host-only; never render this to the model. */
  cursor: string | null;
}

/**
 * Read-only value used to verify a workflow's authored evidence paths.
 *
 * The raw provider result remains the durable settlement/result-handle value.
 * This projection only names the one payload owner whose fields the workflow
 * may cite: an ordinary root result, or one exact MCP result member.
 */
export type ProviderResultEvidenceViewV1 =
  | {
      version: 1;
      kind: 'provider_payload';
      owner: 'root' | 'sealed_invoke_result' | 'mcp_structured_content' | 'mcp_text_json';
      payload: unknown;
    }
  | {
      version: 1;
      kind: 'no_evidence';
      owner: 'mcp' | 'sealed_invoke';
      reason: 'mcp_result_error' | 'mcp_payload_missing' | 'mcp_envelope_malformed'
        | 'sealed_invoke_payload_missing' | 'sealed_invoke_envelope_malformed';
    };

export const LEGACY_ENVELOPE_LOG_ID_MAX_BYTES = 512;

export type StoredEnvelopeMetadataReconciliation =
  | {
    matches: true;
    metadata: Record<string, unknown> | null;
    legacyRehydrated: boolean;
  }
  | { matches: false };

function canonicalEnvelopeMetadata(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map(canonicalEnvelopeMetadata).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalEnvelopeMetadata(record[key])}`)
    .join(',')}}`;
}

function storedEnvelopeMetadataIsExact(
  storedJson: string | null,
  rederived: Record<string, unknown> | null,
): boolean {
  if (storedJson === null) return rederived === null;
  try {
    return canonicalEnvelopeMetadata(JSON.parse(storedJson) as unknown)
      === canonicalEnvelopeMetadata(rederived);
  } catch {
    return false;
  }
}

function isNarrowLegacyEnvelopeMetadata(metadata: Record<string, unknown>): boolean {
  const prototype = Object.getPrototypeOf(metadata);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const allowedKeys = new Set(['successful', 'success', 'ok', 'logId']);
  const ownKeys = Reflect.ownKeys(metadata);
  if (ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))) return false;

  const successKeys = ['successful', 'success', 'ok'] as const;
  const presentSuccessKeys = successKeys.filter((key) => (
    Object.prototype.hasOwnProperty.call(metadata, key)
  ));
  if (presentSuccessKeys.length === 0) return false;
  if (presentSuccessKeys.some((key) => metadata[key] !== true)) return false;
  if (!Object.prototype.hasOwnProperty.call(metadata, 'logId')) return false;

  const logId = metadata.logId;
  return typeof logId === 'string'
    && logId.trim().length > 0
    && Buffer.byteLength(logId, 'utf8') <= LEGACY_ENVELOPE_LOG_ID_MAX_BYTES;
}

/**
 * Reconcile immutable envelope metadata with facts re-derived from retained
 * provider bytes. Exact equality is always authoritative. The sole historical
 * exception is an absent stored projection from before root wrapper metadata
 * was persisted; that exception is intentionally limited to a positive,
 * bounded provider acknowledgement and never repairs conflicting stored data.
 */
export function reconcileStoredEnvelopeMetadata(input: {
  storedJson: string | null;
  rederived: Record<string, unknown> | null;
  rawPayload: unknown;
}): StoredEnvelopeMetadataReconciliation {
  if (storedEnvelopeMetadataIsExact(input.storedJson, input.rederived)) {
    return {
      matches: true,
      metadata: input.rederived,
      legacyRehydrated: false,
    };
  }
  if (
    input.storedJson !== null
    || input.rederived === null
    || !isNarrowLegacyEnvelopeMetadata(input.rederived)
    || inspectProviderEnvelope(input.rawPayload).verdict !== 'clean'
  ) {
    return { matches: false };
  }
  return {
    matches: true,
    metadata: input.rederived,
    legacyRehydrated: true,
  };
}

const CURSOR_KEYS = [
  'next_cursor', 'nextCursor', 'cursor', 'next_page_token', 'nextPageToken',
  'page_token', 'pageToken', 'next_link', 'nextLink', 'next_records_url',
  'nextRecordsUrl', 'nextrecordsurl', 'continuation', 'next',
];
/** `value` is included because it is a live provider shape. */
const RECORD_CONTAINERS = [
  'records', 'items', 'results', 'values', 'value', 'entries', 'rows', 'data', 'events',
];
const PROJECTION_MAX_DEPTH = 6;
const METADATA_MAX_BYTES = 64_000;
const PAGINATION_MAX_DEPTH = 8;
const PAGINATION_MAX_NODES = 512;
const PAGINATION_MAX_ENTRIES = 128;

const HAS_MORE_KEYS = new Set([
  'hasmore', 'hasnext', 'hasnextpage', 'moreavailable', 'morepages',
]);
const EXPLICIT_COMPLETE_KEYS = new Set([
  'complete', 'iscomplete', 'completed', 'exhausted', 'islastpage',
]);
const CURRENT_CURSOR_VALUE_KEYS = new Set(['cursor', 'pagetoken']);
const NEXT_CURSOR_VALUE_KEYS = new Set([
  'nextcursor', 'nextpagetoken', 'nexttoken',
  'continuation', 'continuationtoken', 'nextlink', 'odatanextlink',
  'nextrecordsurl',
]);
const TOTAL_KEYS = new Set([
  'total', 'totalcount', 'totalrecords', 'totalitems', 'odatacount',
]);
const RETURNED_KEYS = new Set([
  'returned', 'returnedcount', 'itemsreturned', 'recordsreturned',
]);
const PAGE_SIZE_KEYS = new Set(['pagesize', 'perpage']);
const OFFSET_KEYS = new Set(['offset', 'start', 'startindex', 'skip']);
const PAGE_KEYS = new Set(['page', 'pagenumber', 'currentpage']);
const PAGE_COUNT_KEYS = new Set(['pagecount', 'totalpages', 'numpages']);
const PAGINATION_PARENT_KEYS = new Set([
  'links', 'meta', 'metadata', 'pageinfo', 'pagination', 'paging', 'pager',
]);
const REQUEST_ECHO_KEYS = new Set([
  'request', 'requestargs', 'requestarguments', 'requestbody', 'requestdata',
  'requestinput', 'requestparams', 'requestparameters', 'requestpayload',
  'originalrequest', 'originalrequestargs', 'originalrequestbody',
  'submittedinput', 'submittedinputargs', 'submittedinputbody',
]);

interface PaginationInspection {
  completeness: ResultCompleteness;
  cursor: string | null;
  /** The payload asserted a recognized pagination protocol but its fields
   * contradicted that protocol (for example, a page returned more records
   * than its own total). Unknown/absent pagination is not malformed. */
  malformed: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validateMetadataValue(value: unknown, stack = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > 256) return false;
  const object = value as object;
  if (stack.has(object)) return false;
  const prototype = Object.getPrototypeOf(object);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  if (Reflect.ownKeys(object).some((key) => typeof key === 'symbol')) return false;
  stack.add(object);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value) || !validateMetadataValue(value[index], stack, depth + 1)) return false;
      }
    } else {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (!validateMetadataValue((value as Record<string, unknown>)[key], stack, depth + 1)) return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    stack.delete(object);
  }
}

const EXACT_MCP_RESULT_KEYS = new Set([
  'content', 'structuredContent', 'isError', '_meta',
]);
const MCP_CONTENT_BLOCK_TYPES = new Set([
  'text', 'image', 'audio', 'resource', 'resource_link',
]);
const MCP_TEXT_JSON_MAX_BYTES = 8_000_000;

interface ExactMcpResultPayload {
  payload: unknown | null;
  pathPrefix: string | null;
  /** `undefined` means the MCP carrier omitted its optional call verdict. */
  isError: boolean | undefined;
  malformed: boolean;
}

function validMcpContentBlock(value: unknown): boolean {
  const block = asRecord(value);
  if (!block || !validateMetadataValue(block)) return false;
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string';
    case 'image':
    case 'audio':
      return typeof block.data === 'string' && typeof block.mimeType === 'string';
    case 'resource':
      return asRecord(block.resource) !== null;
    case 'resource_link':
      return typeof block.uri === 'string' && typeof block.name === 'string';
    default:
      return false;
  }
}

function parseMcpTextPayload(value: unknown): unknown | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (
    Buffer.byteLength(trimmed, 'utf8') > MCP_TEXT_JSON_MAX_BYTES
    || !((trimmed.startsWith('{') && trimmed.endsWith('}'))
      || (trimmed.startsWith('[') && trimmed.endsWith(']')))
  ) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return (asRecord(parsed) || Array.isArray(parsed)) && validateMetadataValue(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function exactJsonValueMatches(left: unknown, right: unknown): boolean {
  return canonicalEnvelopeMetadata(left) === canonicalEnvelopeMetadata(right);
}

/**
 * Select one business-payload owner from the exact MCP tools/call envelope.
 *
 * `structuredContent` is authoritative when present. The text JSON member is
 * only its compatibility copy (or the fallback when structured content is
 * absent), never a second result set. A malformed structured member cannot be
 * laundered through a valid-looking text fallback, and two current members
 * that disagree yield no provider facts.
 */
function exactDirectMcpResultPayload(value: unknown): ExactMcpResultPayload | null {
  const envelope = asRecord(value);
  if (
    !envelope
    || !Array.isArray(envelope.content)
    || Object.keys(envelope).some((key) => !EXACT_MCP_RESULT_KEYS.has(key))
  ) return null;

  const ownsIsError = Object.prototype.hasOwnProperty.call(envelope, 'isError');
  const contentIsValid = envelope.content.every(validMcpContentBlock);
  const isErrorIsValid = !ownsIsError || typeof envelope.isError === 'boolean';
  const textPayloads = envelope.content.flatMap((block, index) => {
    const record = asRecord(block);
    if (record?.type !== 'text') return [];
    const payload = parseMcpTextPayload(record.text);
    return payload === null ? [] : [{ payload, index }];
  });
  const textPayloadsAgree = textPayloads.every((candidate) => (
    exactJsonValueMatches(candidate.payload, textPayloads[0]?.payload)
  ));
  const ownsStructured = Object.prototype.hasOwnProperty.call(envelope, 'structuredContent');
  if (ownsStructured) {
    const structured = asRecord(envelope.structuredContent);
    const structuredIsValid = structured !== null && validateMetadataValue(structured);
    const textAgrees = textPayloads.every((candidate) => (
      structured !== null && exactJsonValueMatches(candidate.payload, structured)
    ));
    return {
      payload: structuredIsValid && textPayloadsAgree && textAgrees ? structured : null,
      pathPrefix: structuredIsValid && textPayloadsAgree && textAgrees
        ? 'structuredContent'
        : null,
      isError: typeof envelope.isError === 'boolean' ? envelope.isError : undefined,
      malformed: !contentIsValid || !isErrorIsValid
        || !structuredIsValid || !textPayloadsAgree || !textAgrees,
    };
  }

  const fallback = textPayloadsAgree ? textPayloads[0] : undefined;
  return {
    payload: fallback?.payload ?? null,
    pathPrefix: fallback ? `content.${fallback.index}.text` : null,
    isError: typeof envelope.isError === 'boolean' ? envelope.isError : undefined,
    malformed: !contentIsValid || !isErrorIsValid || !textPayloadsAgree,
  };
}

function claimsMcpResultEnvelope(value: unknown): boolean {
  const envelope = asRecord(value);
  if (!envelope) return false;
  if (['structuredContent', 'isError', '_meta'].some((key) => (
    Object.prototype.hasOwnProperty.call(envelope, key)
  ))) return true;
  if (!Object.prototype.hasOwnProperty.call(envelope, 'content')) return false;
  const keys = Object.keys(envelope);
  if (keys.every((key) => EXACT_MCP_RESULT_KEYS.has(key))) return true;
  return Array.isArray(envelope.content) && envelope.content.some((entry) => {
    const block = asRecord(entry);
    return block !== null
      && typeof block.type === 'string'
      && MCP_CONTENT_BLOCK_TYPES.has(block.type);
  });
}

type ExactSealedInvokeResult =
  | { status: 'absent' }
  | { status: 'malformed' }
  | { status: 'valid'; payload: unknown };

function exactSealedInvokeResult(value: unknown): ExactSealedInvokeResult {
  const envelope = asRecord(value);
  if (!envelope) return { status: 'absent' };
  const ownsResult = Object.prototype.hasOwnProperty.call(envelope, 'result');
  const ownsComplete = Object.prototype.hasOwnProperty.call(envelope, 'complete');
  if (!ownsResult || !ownsComplete) return { status: 'absent' };
  if (
    envelope.complete !== true
    || Object.keys(envelope).length !== 2
  ) return { status: 'malformed' };
  return { status: 'valid', payload: envelope.result };
}

function exactMcpResultPayload(value: unknown): ExactMcpResultPayload | null {
  const sealed = exactSealedInvokeResult(value);
  if (sealed.status === 'malformed') {
    return { payload: null, pathPrefix: null, isError: undefined, malformed: true };
  }
  const candidate = sealed.status === 'valid' ? sealed.payload : value;
  const direct = exactDirectMcpResultPayload(candidate);
  if (direct) {
    return {
      ...direct,
      pathPrefix: direct.pathPrefix && sealed.status === 'valid'
        ? `result.${direct.pathPrefix}`
        : direct.pathPrefix,
    };
  }
  if (claimsMcpResultEnvelope(candidate)) {
    return { payload: null, pathPrefix: null, isError: undefined, malformed: true };
  }
  return null;
}

/**
 * Project the provider-neutral value against which workflow evidence paths are
 * checked. Exact MCP ownership follows the same selector as result handles:
 * valid structuredContent is authoritative, identical JSON text is only a
 * compatibility copy/fallback, and malformed or conflicting envelopes cite
 * no evidence. Ordinary non-MCP results are returned unchanged at the root.
 */
export function projectProviderResultEvidenceView(
  result: unknown,
): ProviderResultEvidenceViewV1 {
  const sealed = exactSealedInvokeResult(result);
  if (sealed.status === 'malformed') {
    return {
      version: 1,
      kind: 'no_evidence',
      owner: 'sealed_invoke',
      reason: 'sealed_invoke_envelope_malformed',
    };
  }
  if (sealed.status === 'valid' && sealed.payload === undefined) {
    return {
      version: 1,
      kind: 'no_evidence',
      owner: 'sealed_invoke',
      reason: 'sealed_invoke_payload_missing',
    };
  }
  const candidate = sealed.status === 'valid' ? sealed.payload : result;
  const mcp = exactMcpResultPayload(result);
  if (mcp) {
    if (mcp.isError) {
      return { version: 1, kind: 'no_evidence', owner: 'mcp', reason: 'mcp_result_error' };
    }
    if (mcp.malformed) {
      return { version: 1, kind: 'no_evidence', owner: 'mcp', reason: 'mcp_envelope_malformed' };
    }
    if (mcp.payload === null || mcp.pathPrefix === null) {
      return { version: 1, kind: 'no_evidence', owner: 'mcp', reason: 'mcp_payload_missing' };
    }
    return {
      version: 1,
      kind: 'provider_payload',
      owner: mcp.pathPrefix.endsWith('structuredContent')
        ? 'mcp_structured_content'
        : 'mcp_text_json',
      payload: mcp.payload,
    };
  }
  return {
    version: 1,
    kind: 'provider_payload',
    owner: sealed.status === 'valid' ? 'sealed_invoke_result' : 'root',
    payload: candidate,
  };
}

function prefixedRecordPath(prefix: string | null, path: string | null): string | null {
  if (path === null) return null;
  if (!prefix) return path;
  return path === '' ? prefix : `${prefix}.${path}`;
}

function recordsAtPlainPath(payload: unknown, recordPath: string): unknown[] | null {
  const value = recordPath === ''
    ? payload
    : recordPath.split('.').reduce<unknown>((current, key) => {
      const record = asRecord(current);
      return record ? record[key] : undefined;
    }, payload);
  return Array.isArray(value) ? value : null;
}

function normalizedStructuralKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function booleanSignal(value: unknown): boolean | undefined {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  return undefined;
}

function nonnegativeSafeInteger(value: unknown): number | undefined {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

function inspectIntegerFields(
  normalized: Map<string, unknown>,
  keys: ReadonlySet<string>,
): { present: boolean; value: number | undefined; malformed: boolean } {
  let present = false;
  let value: number | undefined;
  let malformed = false;
  for (const key of keys) {
    if (!normalized.has(key)) continue;
    present = true;
    const candidate = nonnegativeSafeInteger(normalized.get(key));
    if (candidate === undefined) {
      malformed = true;
      continue;
    }
    if (value !== undefined && value !== candidate) malformed = true;
    value ??= candidate;
  }
  return { present, value, malformed };
}

function inspectOffsetFields(
  normalized: Map<string, unknown>,
): {
  present: boolean;
  value: number | undefined;
  opaqueCursor: string | null;
  malformed: boolean;
} {
  let present = false;
  let value: number | undefined;
  let opaqueCursor: string | null = null;
  let malformed = false;
  for (const key of OFFSET_KEYS) {
    if (!normalized.has(key)) continue;
    present = true;
    const raw = normalized.get(key);
    const candidate = nonnegativeSafeInteger(raw);
    if (candidate !== undefined) {
      if (opaqueCursor !== null || (value !== undefined && value !== candidate)) malformed = true;
      value ??= candidate;
      continue;
    }
    // Airtable and other cursor APIs call their opaque continuation token
    // `offset`. Preserve those bytes as a cursor. Numeric-looking but invalid
    // offsets (-1, fractions, overflow) remain malformed rather than being
    // laundered into opaque continuation authority.
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    const numericLooking = /^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/i.test(trimmed);
    if (key === 'offset' && trimmed.length > 0 && !numericLooking) {
      if (value !== undefined || (opaqueCursor !== null && opaqueCursor !== raw)) malformed = true;
      opaqueCursor ??= raw as string;
      continue;
    }
    malformed = true;
  }
  return { present, value, opaqueCursor, malformed };
}

function cursorValue(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ['href', 'url', 'uri']) {
    const nested = record[key];
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  return null;
}

/** Provider-neutral pagination normalization. */
function inspectPagination(
  envelope: Record<string, unknown>,
  recordCount: number,
  recordPath: string | null,
  structuralCollectionPaths: readonly string[],
  structuralCollectionHasValues: boolean,
): PaginationInspection {
  let nodes = 0;
  let sawPartial = false;
  let sawTerminal = false;
  let explicitComplete = false;
  let explicitIncomplete = false;
  let malformedPagination = false;
  let cursor: string | null = null;
  let sawNextTerminal = false;
  const hasRecordCollection = recordPath !== null;
  const collectionOwnerPaths = structuralCollectionPaths.map((path) => (
    path === ''
      ? []
      : path.split('.').slice(0, -1).map(normalizedStructuralKey)
  ));
  const hasCollectionShape = collectionOwnerPaths.length > 0;

  const isCollectionAncestor = (path: readonly string[]): boolean => (
    collectionOwnerPaths.some((ownerPath) => (
      path.length <= ownerPath.length
      && path.every((segment, index) => segment === ownerPath[index])
    ))
  );

  const markNextCursor = (value: unknown): void => {
    const candidate = cursorValue(value);
    if (candidate !== null) {
      if (sawNextTerminal || (cursor !== null && cursor !== candidate)) {
        malformedPagination = true;
        return;
      }
      sawPartial = true;
      cursor ??= candidate;
    }
  };

  const markNextTerminal = (): void => {
    if (cursor !== null) malformedPagination = true;
    sawNextTerminal = true;
    sawTerminal = true;
  };

  const visit = (
    value: unknown,
    depth: number,
    parentKey: string,
    path: readonly string[],
    paginationScope: boolean,
  ): void => {
    if (!value || typeof value !== 'object') return;
    nodes += 1;
    if (depth > PAGINATION_MAX_DEPTH || nodes > PAGINATION_MAX_NODES) {
      if (paginationScope) sawPartial = true;
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value.slice(0, PAGINATION_MAX_ENTRIES)) {
        visit(child, depth + 1, parentKey, path, paginationScope);
      }
      if (value.length > PAGINATION_MAX_ENTRIES && paginationScope) sawPartial = true;
      return;
    }

    const record = value as Record<string, unknown>;
    const entries = Object.entries(record);
    if (entries.length > PAGINATION_MAX_ENTRIES && paginationScope) sawPartial = true;
    const normalized = new Map(entries.map(([key, child]) => [normalizedStructuralKey(key), child]));

    // Salesforce REST/CLI query pages use `{ totalSize, done, records }`
    // rather than the more common `hasMore`/`complete` vocabulary. `done`
    // is also a routine BUSINESS field, so it is pagination authority only
    // when the SAME object owns both a recognized records array and a valid
    // nonnegative totalSize. This is deliberately structural/provider-neutral:
    // wrappers may nest the page under `result`, but a record inside the
    // collection can never promote its own `done` field into exhaustion.
    const recognizedRecordCounts = entries
      .filter(([rawKey, child]) => (
        Array.isArray(child)
        && RECORD_CONTAINERS.some(
          (candidate) => normalizedStructuralKey(candidate) === normalizedStructuralKey(rawKey),
        )
      ))
      .map(([, child]) => (child as unknown[]).length);
    const ownsRecognizedRecords = recognizedRecordCounts.length > 0;
    if (ownsRecognizedRecords && normalized.has('totalsize') && normalized.has('done')) {
      const totalSize = nonnegativeSafeInteger(normalized.get('totalsize'));
      const done = booleanSignal(normalized.get('done'));
      if (
        totalSize === undefined
        || done === undefined
        || recognizedRecordCounts.some((count) => count > totalSize)
      ) {
        malformedPagination = true;
      } else if (done === true) {
        explicitComplete = true;
      } else {
        explicitIncomplete = true;
      }
    }

    // OData defines continuation by the optional @odata.nextLink member. A
    // response carrying @odata.context is an OData envelope, so absence (or a
    // null value handled below) is positive terminal protocol evidence.
    if (paginationScope && normalized.has('odatacontext') && !normalized.has('odatanextlink')) {
      sawTerminal = true;
    }

    let objectHasMore: boolean | undefined;
    if (paginationScope) {
      for (const key of EXPLICIT_COMPLETE_KEYS) {
        if (!normalized.has(key)) continue;
        const signal = booleanSignal(normalized.get(key));
        if (signal === true) explicitComplete = true;
        else if (signal === false) explicitIncomplete = true;
        else malformedPagination = true;
      }
      for (const key of HAS_MORE_KEYS) {
        if (!normalized.has(key)) continue;
        const signal = booleanSignal(normalized.get(key));
        if (signal === true) {
          objectHasMore = true;
          sawPartial = true;
        } else if (signal === false) {
          objectHasMore ??= false;
          sawTerminal = true;
        } else malformedPagination = true;
      }
    }

    const pageRecordCount = recordCount;
    const hasObservedCollectionValues = hasRecordCollection
      ? pageRecordCount > 0
      : structuralCollectionHasValues;
    if (paginationScope) {
      const totalField = inspectIntegerFields(normalized, TOTAL_KEYS);
      const returnedField = inspectIntegerFields(normalized, RETURNED_KEYS);
      const offsetField = inspectOffsetFields(normalized);
      const pageSizeField = inspectIntegerFields(normalized, PAGE_SIZE_KEYS);
      if (
        (totalField.present && totalField.malformed)
        || (returnedField.present && returnedField.malformed)
        || (offsetField.present && offsetField.malformed)
        || (pageSizeField.present && pageSizeField.malformed)
      ) malformedPagination = true;
      if (offsetField.opaqueCursor !== null) markNextCursor(offsetField.opaqueCursor);

      const total = totalField.value;
      const returned = returnedField.value;
      const offset = offsetField.value;
      const pageSize = pageSizeField.value;
      // `returned` is an actual page count; `pageSize` is only a ceiling.
      // Conflating the latter with the former used to turn a short first page
      // into false exhaustion. Comparison with retained collection bytes is
      // possible only when one exact projection was selected. Intrinsic
      // protocol contradictions remain invalid even when several plausible
      // arrays make projection ambiguous.
      if (
        hasRecordCollection
        && returned !== undefined
        && returned !== pageRecordCount
      ) malformedPagination = true;
      if (
        hasRecordCollection
        && pageSize !== undefined
        && pageRecordCount > pageSize
      ) malformedPagination = true;
      if (total !== undefined) {
        const start = offset ?? 0;
        const protocolReturned = returned ?? (hasRecordCollection ? pageRecordCount : undefined);
        if (protocolReturned !== undefined) {
          if (
            protocolReturned > total
            || (protocolReturned > 0 && start > total)
            || start + protocolReturned > total
            || (hasRecordCollection && pageRecordCount > total)
            || (hasRecordCollection && start + pageRecordCount > total)
          ) {
            malformedPagination = true;
          } else if (start + protocolReturned < total) {
            sawPartial = true;
          } else {
            sawTerminal = true;
          }
        } else if (hasObservedCollectionValues && offset !== undefined && offset > total) {
          malformedPagination = true;
        }
      }
    }

    const pageField = paginationScope
      ? inspectIntegerFields(normalized, PAGE_KEYS)
      : { present: false, value: undefined, malformed: false };
    const pageCountField = paginationScope
      ? inspectIntegerFields(normalized, PAGE_COUNT_KEYS)
      : { present: false, value: undefined, malformed: false };
    if (
      paginationScope
      && ((pageField.present && pageField.malformed)
        || (pageCountField.present && pageCountField.malformed))
    ) malformedPagination = true;
    if (
      paginationScope
      && pageField.present
      && pageCountField.present
      && !pageField.malformed
      && !pageCountField.malformed
    ) {
      const page = pageField.value!;
      const pageCount = pageCountField.value!;
      if (page > pageCount || (pageCount === 0 && hasObservedCollectionValues)) {
        malformedPagination = true;
      } else if (pageCount > 0) {
        const terminalPage = page === 0 ? page + 1 >= pageCount : page >= pageCount;
        if (terminalPage) sawTerminal = true;
        else sawPartial = true;
      }
    }

    if (objectHasMore === true && normalized.has('endcursor')) {
      const endCursor = normalized.get('endcursor');
      if (cursorValue(endCursor) === null) malformedPagination = true;
      else markNextCursor(endCursor);
    }

    for (const [rawKey, child] of entries.slice(0, PAGINATION_MAX_ENTRIES)) {
      const key = normalizedStructuralKey(rawKey);
      if (REQUEST_ECHO_KEYS.has(key)) continue;
      const isRecordCollection = RECORD_CONTAINERS.some(
        (candidate) => normalizedStructuralKey(candidate) === key,
      ) && Array.isArray(child);
      if (isRecordCollection) continue;

      if (paginationScope && NEXT_CURSOR_VALUE_KEYS.has(key)) {
        const candidate = cursorValue(child);
        if (candidate !== null) markNextCursor(child);
        else if (child === null || child === false || child === '') {
          markNextTerminal();
        } else malformedPagination = true;
        continue;
      }
      if (paginationScope && CURRENT_CURSOR_VALUE_KEYS.has(key)) {
        // `cursor` / `pageToken` commonly echo the current page position. They
        // neither prove another page nor conflict with an explicit next token.
        // Null is deliberately neutral; other malformed types fail closed.
        if (
          cursorValue(child) === null
          && child !== null
          && child !== ''
        ) malformedPagination = true;
        continue;
      }
      if (
        paginationScope
        && key === 'next'
        && (PAGINATION_PARENT_KEYS.has(parentKey) || parentKey === '')
      ) {
        const candidate = cursorValue(child);
        if (candidate !== null) markNextCursor(child);
        else if (child === null || child === false || child === '') markNextTerminal();
        else malformedPagination = true;
        continue;
      }

      if (child && typeof child === 'object') {
        const childPath = [...path, key];
        const childPaginationScope = isCollectionAncestor(childPath)
          || (paginationScope && PAGINATION_PARENT_KEYS.has(key));
        if (childPaginationScope) {
          visit(child, depth + 1, key, childPath, childPaginationScope);
        }
      }
    }
  };

  visit(envelope, 0, '', [], hasCollectionShape);
  if (malformedPagination) return { completeness: 'unknown', cursor: null, malformed: true };
  if (sawPartial || explicitIncomplete) {
    return { completeness: 'partial', cursor, malformed: false };
  }
  if (explicitComplete || sawTerminal) {
    return { completeness: 'complete', cursor: null, malformed: false };
  }
  return { completeness: 'unknown', cursor: null, malformed: false };
}

interface RecordDiscovery {
  found: { path: string; records: unknown[] } | null;
  /** All structurally plausible collections, including ambiguous fallbacks.
   * Pagination can scope to their owners without guessing which array should
   * become the retained record projection. */
  structuralCollectionPaths: string[];
  structuralCollectionHasValues: boolean;
  truncated: boolean;
}

function discoverRecords(envelope: Record<string, unknown>): RecordDiscovery {
  // Provider-neutral bounded discovery. Provider wrappers are not uniformly
  // one level deep, so collection and pagination interpretation must traverse
  // the same structural envelope. Arrays are terminal candidates: never walk
  // record elements and accidentally promote a business field's nested array
  // into a second result collection.
  const recognizedCandidates: Array<{ path: string; records: unknown[] }> = [];
  const fallbackCandidates: Array<{ path: string; records: unknown[] }> = [];
  const ignoredFallbackKeys = new Set([
    'error', 'errors', 'warning', 'warnings', 'message', 'messages',
    'log', 'logs', 'debug', 'meta', 'metadata',
    ...PAGINATION_PARENT_KEYS,
  ]);
  let nodes = 0;
  let truncated = false;
  const visit = (
    record: Record<string, unknown>,
    path: readonly string[],
    depth: number,
  ): void => {
    nodes += 1;
    if (depth > PAGINATION_MAX_DEPTH || nodes > PAGINATION_MAX_NODES) {
      truncated = true;
      return;
    }
    const entries = Object.entries(record);
    if (entries.length > PAGINATION_MAX_ENTRIES) truncated = true;
    for (const [rawKey, child] of entries.slice(0, PAGINATION_MAX_ENTRIES)) {
      const key = normalizedStructuralKey(rawKey);
      if (
        ignoredFallbackKeys.has(key)
        || REQUEST_ECHO_KEYS.has(key)
        || providerResultBookkeepingKey(rawKey)
      ) continue;

      const childPath = [...path, rawKey];
      if (Array.isArray(child)) {
        const candidate = { path: childPath.join('.'), records: child };
        const recognized = RECORD_CONTAINERS.some(
          (container) => normalizedStructuralKey(container) === key,
        );
        (recognized ? recognizedCandidates : fallbackCandidates).push(candidate);
        continue;
      }
      const nested = asRecord(child);
      if (nested) visit(nested, childPath, depth + 1);
    }
  };
  visit(envelope, [], 0);

  // Known collection nouns remain the stronger projection signal. When more
  // than one equally strong candidate exists, retain every structural path for
  // pagination scoping but do not guess which bytes form the projection.
  const candidates = recognizedCandidates.length > 0
    ? recognizedCandidates
    : fallbackCandidates;
  return {
    found: candidates.length === 1 ? candidates[0]! : null,
    structuralCollectionPaths: candidates.map((candidate) => candidate.path),
    structuralCollectionHasValues: candidates.some((candidate) => candidate.records.length > 0),
    truncated,
  };
}

/** Whether recognized pagination metadata contradicts its own protocol.
 *
 * This is intentionally distinct from `completeness === 'unknown'`: an
 * opaque provider result with no pagination claims may still contain useful
 * data, while an impossible total or malformed terminal flag must never
 * become provisional dependency authority. */
export function resultHasMalformedPagination(result: unknown): boolean {
  try {
    const mcp = exactMcpResultPayload(result);
    if (mcp?.malformed) return true;
    const envelope = asRecord(mcp ? mcp.payload : result);
    if (!envelope) return false;
    const discovery = discoverRecords(envelope);
    return inspectPagination(
      envelope,
      discovery.found?.records.length ?? 0,
      discovery.found?.path ?? null,
      discovery.structuralCollectionPaths,
      discovery.structuralCollectionHasValues,
    ).malformed;
  } catch {
    return true;
  }
}

function envelopeMetadata(
  envelope: Record<string, unknown>,
  recordPath: string | null,
): { value: Record<string, unknown> | null; malformed: boolean } {
  const explicit = asRecord(envelope.meta) ?? asRecord(envelope.metadata);
  const candidate = explicit ?? (() => {
    const rootRecordKey = recordPath?.split('.')[0];
    const meta: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(envelope)) {
      if (key === rootRecordKey || CURSOR_KEYS.includes(key)) continue;
      if (value === null || typeof value === 'object') continue;
      meta[key] = value;
    }
    return Object.keys(meta).length > 0 ? meta : null;
  })();
  if (!candidate) return { value: null, malformed: false };
  if (!validateMetadataValue(candidate)) return { value: null, malformed: true };
  try {
    const json = JSON.stringify(candidate);
    if (Buffer.byteLength(json, 'utf8') > METADATA_MAX_BYTES) {
      return { value: null, malformed: true };
    }
    return { value: JSON.parse(json) as Record<string, unknown>, malformed: false };
  } catch {
    return { value: null, malformed: true };
  }
}

interface ProviderStatusObservation {
  code: number;
  /** Depth within the selected provider payload; zero is the carrier root. */
  depth: number;
}

function statusOf(envelope: Record<string, unknown>): ProviderStatusObservation | null {
  const statusKeys = new Set([
    'httpcode', 'httpstatus', 'httpstatuscode', 'responsecode', 'status', 'statuscode',
  ]);
  const resultArrays = new Set(RECORD_CONTAINERS.map(normalizedStructuralKey));
  const identityKeys = new Set(['id', 'identifier', 'key', 'recordid', 'uid', 'uuid']);
  let nodes = 0;
  const visit = (value: unknown, depth: number): ProviderStatusObservation | null => {
    if (!value || typeof value !== 'object') return null;
    nodes += 1;
    if (depth > PAGINATION_MAX_DEPTH || nodes > PAGINATION_MAX_NODES) return null;
    if (Array.isArray(value)) return null;
    const entries = Object.entries(value as Record<string, unknown>);
    const businessEntity = entries.some(([key]) => identityKeys.has(normalizedStructuralKey(key)));
    for (const [rawKey, child] of entries.slice(0, PAGINATION_MAX_ENTRIES)) {
      const key = normalizedStructuralKey(rawKey);
      // Every status-shaped field on an identified returned entity is domain
      // data. The carrier can successfully READ a failed job/order/task.
      if (!statusKeys.has(key) || businessEntity) continue;
      const numeric = typeof child === 'number'
        ? child
        : typeof child === 'string' && /^\d{3,5}$/.test(child.trim())
          ? Number(child.trim())
          : Number.NaN;
      if (Number.isFinite(numeric)) return { code: numeric, depth };
    }
    for (const [rawKey, child] of entries.slice(0, PAGINATION_MAX_ENTRIES)) {
      if (!child || typeof child !== 'object') continue;
      const key = normalizedStructuralKey(rawKey);
      if (providerRequestEchoKey(rawKey) && key !== 'payload') continue;
      if (Array.isArray(child) && resultArrays.has(key)) continue;
      const nested = visit(child, depth + 1);
      if (nested !== null) return nested;
    }
    return null;
  };
  return visit(envelope, 0);
}

/** Trim to depth, then account in UTF-8 bytes, including array punctuation. */
function boundedProjection(records: unknown[]): unknown[] {
  const clamp = (value: unknown, depth = 0, stack = new Set<object>()): unknown => {
    if (depth >= PROJECTION_MAX_DEPTH) return '[depth]';
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : '[non-finite]';
    if (typeof value === 'string') return value.length > 512 ? `${value.slice(0, 512)}…` : value;
    if (typeof value !== 'object') return `[${typeof value}]`;
    const object = value as object;
    if (stack.has(object)) return '[cycle]';
    stack.add(object);
    try {
      if (Array.isArray(value)) {
        return value.slice(0, 20).map((entry) => clamp(entry, depth + 1, stack));
      }
      const record = asRecord(value);
      if (!record) return '[object]';
      return Object.fromEntries(
        Object.entries(record).slice(0, 40)
          .map(([key, entry]) => [key, clamp(entry, depth + 1, stack)]),
      );
    } catch {
      return '[unreadable]';
    } finally {
      stack.delete(object);
    }
  };

  const projected: unknown[] = [];
  let bytes = 2;
  for (const record of records.slice(0, RESULT_PROJECTION_MAX_RECORDS)) {
    const clamped = clamp(record);
    const json = JSON.stringify(clamped) ?? 'null';
    const size = Buffer.byteLength(json, 'utf8') + (projected.length > 0 ? 1 : 0);
    if (bytes + size > RESULT_PROJECTION_MAX_BYTES) break;
    projected.push(clamped);
    bytes += size;
  }
  return projected;
}

/**
 * Re-resolve the record collection a stored handle named, from the exact raw
 * bytes. `recordPath` is host-derived, so this reads the same array the handle
 * counted rather than trusting the byte-bounded projection beside it.
 */
export function recordsAtRecordPath(payload: unknown, recordPath: string | null): unknown[] | null {
  if (recordPath === null) return null;
  const mcp = exactMcpResultPayload(payload);
  if (mcp) {
    if (mcp.malformed || mcp.payload === null || mcp.pathPrefix === null) return null;
    const relativePath = recordPath === mcp.pathPrefix
      ? ''
      : recordPath.startsWith(`${mcp.pathPrefix}.`)
        ? recordPath.slice(mcp.pathPrefix.length + 1)
        : null;
    return relativePath === null ? null : recordsAtPlainPath(mcp.payload, relativePath);
  }
  return recordsAtPlainPath(payload, recordPath);
}

/** Pure host interpretation of raw provider result bytes. */

/**
 * A reviewed-CLI read settles as a process observation — `{version: 1,
 * status, operationId, executableRealpath, argv, exitCode, stdout, stderr, …}`,
 * usually inside the sealed `{result, complete: true}` invoke envelope. Its
 * records live in the stdout JSON document, not in the observation: record
 * discovery on the observation itself picked `argv` (seven tokens) as "the
 * records" of every Friday-dashboard SOQL read (2026-09-02). Project from the
 * parsed stdout with the exact path prefix so a redeemed record path resolves.
 */
function reviewedCliObservationPayload(result: unknown): {
  payload: unknown;
  pathPrefix: string;
  success: boolean;
  exitCode: number | null;
} | null {
  const sealed = exactSealedInvokeResult(result);
  const observation = asRecord(sealed.status === 'valid' ? sealed.payload : result);
  if (
    !observation
    || observation.version !== 1
    || typeof observation.status !== 'string'
    || typeof observation.operationId !== 'string'
    || typeof observation.executableRealpath !== 'string'
    || !Array.isArray(observation.argv)
    || typeof observation.stdout !== 'string'
  ) return null;
  const exitCode = typeof observation.exitCode === 'number' ? observation.exitCode : null;
  const success = observation.status === 'exited' && (exitCode === null || exitCode === 0);
  const prefix = sealed.status === 'valid' ? 'result.stdout' : 'stdout';
  const text = observation.stdout.trim();
  if (!success) return { payload: null, pathPrefix: prefix, success, exitCode };
  if (!text.startsWith('{') && !text.startsWith('[')) {
    return { payload: null, pathPrefix: prefix, success, exitCode };
  }
  try {
    return { payload: JSON.parse(text) as unknown, pathPrefix: prefix, success, exitCode };
  } catch {
    return { payload: null, pathPrefix: prefix, success, exitCode };
  }
}

export function deriveResultHandleFactsFromRaw(result: unknown): RawResultHandleFacts {
  try {
    const mcp = exactMcpResultPayload(result);
    if (mcp?.malformed) {
      return {
        success: false,
        recordPath: null,
        recordCount: 0,
        envelopeMeta: null,
        completeness: 'unknown',
        projectedRecords: [],
        statusCode: null,
        cursor: null,
      };
    }
    const cli = reviewedCliObservationPayload(result);
    const interpreted = cli ? cli.payload : mcp ? mcp.payload : result;
    const pathPrefix = cli ? cli.pathPrefix : mcp?.pathPrefix ?? null;
    const envelope = asRecord(interpreted);
    if (cli && !cli.success) {
      return {
        success: false,
        recordPath: null,
        recordCount: 0,
        envelopeMeta: null,
        completeness: 'unknown',
        projectedRecords: [],
        statusCode: cli.exitCode,
        cursor: null,
      };
    }
    if (cli && !envelope) {
      // A reviewed-CLI read whose stdout is not a JSON document has no records
      // to project; its evidence is the text itself, redeemable from the raw
      // handle. Never count argv tokens as records.
      return {
        success: true,
        recordPath: null,
        recordCount: 0,
        envelopeMeta: null,
        completeness: 'unknown',
        projectedRecords: [],
        statusCode: cli.exitCode,
        cursor: null,
      };
    }
    if (!envelope) {
      const records = Array.isArray(interpreted) ? interpreted : [];
      return {
        success: mcp?.isError !== true,
        recordPath: Array.isArray(interpreted)
          ? prefixedRecordPath(pathPrefix, '')
          : null,
        recordCount: records.length,
        envelopeMeta: null,
        completeness: 'unknown',
        projectedRecords: boundedProjection(records),
        statusCode: null,
        cursor: null,
      };
    }

    const discovery = discoverRecords(envelope);
    const found = discovery.found;
    const pagination = inspectPagination(
      envelope,
      found?.records.length ?? 0,
      found?.path ?? null,
      discovery.structuralCollectionPaths,
      discovery.structuralCollectionHasValues,
    );
    const statusObservation = statusOf(envelope);
    const status = statusObservation?.code ?? null;
    const successful = envelope.successful ?? envelope.success ?? envelope.ok;
    // MCP states the call's outcome in `CallToolResult.isError`. Only `true` was
    // propagated here, so the protocol's explicit "this call did NOT fail" was
    // thrown away and a status found in the payload decided by default —
    // e.g. a Firecrawl scrape of a bot-blocked page,
    // {content:[…], isError:false} carrying metadata.statusCode 404, derived
    // success=false even though the scrape returned its markdown.
    //
    // Any explicit `true` still wins (the carrier or the payload reporting a
    // real failure); only when nothing says true does an explicit `false` count
    // as the carrier stating success.
    const envelopeIsError = typeof envelope.isError === 'boolean'
      ? envelope.isError
      : undefined;
    const isError = mcp?.isError === true || envelopeIsError === true
      ? true
      : mcp?.isError === false || envelopeIsError === false
        ? false
        : undefined;
    const inspection = inspectProviderEnvelope(envelope);
    // `status >= 400` is an HTTP rule, so it may only judge an HTTP status.
    // Providers that publish their own numeric code in a status-shaped key
    // (DataForSEO's `status_code: 20000` = OK) were read as HTTP and failed the
    // comparison — and so did their ERROR codes (40501), so the heuristic gave
    // this provider ZERO discrimination while destroying every success.
    //
    // Live 2026-09-04, both canary brains: three DataForSEO calls returned real
    // records; the handle writer derived success=false here while the
    // settlement independently classified the same bytes as a successful
    // provider result. The disagreement threw
    // "successful provider result did not produce redeemable result authority",
    // rolled the transaction back, and the model was told the tool errored. The
    // SEO leg never produced data, so the drafts were never written.
    //
    // Out-of-range codes are not evidence of success either — they are simply
    // not an HTTP verdict, so they leave the decision to the signals that CAN
    // speak: an explicit successful/success/ok key, the envelope inspection,
    // and whether any records were projected. A code outside the HTTP range
    // with no success key and NO records stays unsuccessful rather than being
    // laundered into a pass.
    const httpStatus = typeof status === 'number' && status >= 100 && status <= 599
      ? status
      : null;
    const unexplainedNonHttpStatus = typeof status === 'number'
      && httpStatus === null
      && typeof successful !== 'boolean'
      && (found?.records.length ?? 0) === 0
      // A reviewed process observation already owns the execution verdict.
      // Its JSON stdout may use status:0 as the provider's ordinary success
      // code; an empty result must not reverse the enclosing exited/zero fact.
      // Explicit errors, negative success flags and failing status codes still
      // flow through `inspection` below and remain contradictions.
      && cli?.success !== true;
    // CARRIER FIRST. MCP states the call's outcome outside its selected business
    // payload as `isError`. When that outer carrier has spoken explicitly, a
    // nested status-shaped payload key must not overrule it — that value is
    // describing what the tool fetched, not whether the call worked. Measured:
    // {isError:false, data:{markdown:"...", metadata:{statusCode:404}}} derived
    // success=false, so a successful scrape of a bot-blocked page was discarded.
    // Every stronger contradiction still wins (negative_*, error_*, failure
    // flags) — those are the carrier contradicting itself.
    //
    // A carrier success carrying nothing usable does not become a false
    // `succeeded`: recordCount stays 0 and classifyAttemptOutcome reports
    // `empty_result` — "the call worked and returned nothing", which consumers
    // already treat as a non-failure.
    // A payload's own `successful:true` (or root
    // `isError:false`) can still contradict a root/nested transport status and
    // therefore must not receive this precedence.
    const mcpCarrierStatedSuccess = mcp?.isError === false;
    const nestedMcpPayloadStatus = mcpCarrierStatedSuccess
      && (statusObservation?.depth ?? 0) > 0;
    const contradicted = inspection.verdict === 'contradicted'
      && !(mcpCarrierStatedSuccess && contradictionIsNestedStatusOnly(inspection));
    // The same nested value reaches this decision by TWO paths — the
    // contradiction walker and `statusOf` — so both retain depth and apply the
    // same boundary. Root status remains carrier evidence; only status inside
    // the MCP-selected payload yields to the outer MCP call verdict.
    const errorish = contradicted
      || (!nestedMcpPayloadStatus && httpStatus !== null && httpStatus >= 400)
      || (!nestedMcpPayloadStatus && unexplainedNonHttpStatus);
    const success = isError === true
      ? false
      : errorish
        ? false
        : typeof successful === 'boolean'
          ? successful
          : true;
    const meta = envelopeMetadata(envelope, found?.path ?? null);

    return {
      success,
      recordPath: prefixedRecordPath(pathPrefix, found?.path ?? null),
      recordCount: found?.records.length ?? 0,
      envelopeMeta: meta.value,
      completeness: !success || meta.malformed || pagination.malformed
        ? 'unknown'
        : discovery.truncated
          ? 'partial'
          : inspection.verdict !== 'clean'
            ? 'unknown'
            : pagination.completeness,
      projectedRecords: boundedProjection(found?.records ?? []),
      statusCode: status,
      cursor: pagination.cursor,
    };
  } catch {
    return {
      success: false,
      recordPath: null,
      recordCount: 0,
      envelopeMeta: null,
      completeness: 'unknown',
      projectedRecords: [],
      statusCode: null,
      cursor: null,
    };
  }
}
