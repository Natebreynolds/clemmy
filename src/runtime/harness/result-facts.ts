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
    const envelope = asRecord(result);
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

function statusOf(envelope: Record<string, unknown>): number | null {
  const statusKeys = new Set([
    'httpcode', 'httpstatus', 'httpstatuscode', 'responsecode', 'status', 'statuscode',
  ]);
  const resultArrays = new Set(RECORD_CONTAINERS.map(normalizedStructuralKey));
  const identityKeys = new Set(['id', 'identifier', 'key', 'recordid', 'uid', 'uuid']);
  let nodes = 0;
  const visit = (value: unknown, depth: number): number | null => {
    if (!value || typeof value !== 'object') return null;
    nodes += 1;
    if (depth > PAGINATION_MAX_DEPTH || nodes > PAGINATION_MAX_NODES) return null;
    if (Array.isArray(value)) return null;
    const entries = Object.entries(value as Record<string, unknown>);
    const businessEntity = entries.some(([key]) => identityKeys.has(normalizedStructuralKey(key)));
    for (const [rawKey, child] of entries.slice(0, PAGINATION_MAX_ENTRIES)) {
      const key = normalizedStructuralKey(rawKey);
      if (!statusKeys.has(key) || (key === 'status' && businessEntity)) continue;
      const numeric = typeof child === 'number'
        ? child
        : typeof child === 'string' && /^\d{3,5}$/.test(child.trim())
          ? Number(child.trim())
          : Number.NaN;
      if (Number.isFinite(numeric)) return numeric;
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
  const value = recordPath === ''
    ? payload
    : recordPath.split('.').reduce<unknown>((current, key) => {
      const record = asRecord(current);
      return record ? record[key] : undefined;
    }, payload);
  return Array.isArray(value) ? value : null;
}

/** Pure host interpretation of raw provider result bytes. */
export function deriveResultHandleFactsFromRaw(result: unknown): RawResultHandleFacts {
  try {
    const envelope = asRecord(result);
    if (!envelope) {
      const records = Array.isArray(result) ? result : [];
      return {
        success: true,
        recordPath: Array.isArray(result) ? '' : null,
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
    const status = statusOf(envelope);
    const successful = envelope.successful ?? envelope.success ?? envelope.ok;
    const isError = typeof envelope.isError === 'boolean' ? envelope.isError : undefined;
    const inspection = inspectProviderEnvelope(envelope);
    const errorish = inspection.verdict === 'contradicted'
      || (typeof status === 'number' && status >= 400);
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
      recordPath: found?.path ?? null,
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
