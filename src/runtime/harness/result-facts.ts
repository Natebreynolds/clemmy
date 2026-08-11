/**
 * Pure provider-result interpretation.
 *
 * This module deliberately imports no event log, authority, or result-handle
 * runtime. Persistence, terminal publication, and receipt redemption can all
 * derive the same facts from the same raw bytes without creating an import
 * cycle or trusting stored projections.
 */
import {
  providerEnvelopeHasContradiction,
  providerRequestEchoKey,
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

const CURSOR_KEYS = [
  'next_cursor', 'nextCursor', 'cursor', 'next_page_token', 'nextPageToken',
  'page_token', 'pageToken', 'next_link', 'nextLink', 'continuation', 'next',
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
const CURSOR_VALUE_KEYS = new Set([
  'cursor', 'nextcursor', 'nextpagetoken', 'pagetoken', 'nexttoken',
  'continuation', 'continuationtoken', 'nextlink', 'odatanextlink',
]);
const TOTAL_KEYS = new Set([
  'total', 'totalcount', 'totalrecords', 'totalitems', 'odatacount',
]);
const RETURNED_KEYS = new Set([
  'returned', 'returnedcount', 'itemsreturned', 'recordsreturned', 'pagesize',
]);
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

function nonnegativeNumber(value: unknown): number | undefined {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
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
  hasRecordCollection: boolean,
): PaginationInspection {
  let nodes = 0;
  let sawPartial = false;
  let sawTerminal = false;
  let explicitComplete = false;
  let explicitIncomplete = false;
  let cursor: string | null = null;

  const markCursor = (value: unknown): void => {
    const candidate = cursorValue(value);
    if (candidate !== null) {
      sawPartial = true;
      cursor ??= candidate;
    }
  };

  const visit = (value: unknown, depth: number, parentKey: string): void => {
    if (!value || typeof value !== 'object') return;
    nodes += 1;
    if (depth > PAGINATION_MAX_DEPTH || nodes > PAGINATION_MAX_NODES) {
      sawPartial = true;
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value.slice(0, PAGINATION_MAX_ENTRIES)) visit(child, depth + 1, parentKey);
      if (value.length > PAGINATION_MAX_ENTRIES) sawPartial = true;
      return;
    }

    const record = value as Record<string, unknown>;
    const entries = Object.entries(record);
    if (entries.length > PAGINATION_MAX_ENTRIES) sawPartial = true;
    const normalized = new Map(entries.map(([key, child]) => [normalizedStructuralKey(key), child]));

    // OData defines continuation by the optional @odata.nextLink member. A
    // response carrying @odata.context is an OData envelope, so absence (or a
    // null value handled below) is positive terminal protocol evidence.
    if (normalized.has('odatacontext') && !normalized.has('odatanextlink')) {
      sawTerminal = true;
    }

    for (const key of EXPLICIT_COMPLETE_KEYS) {
      if (!normalized.has(key)) continue;
      const signal = booleanSignal(normalized.get(key));
      if (signal === true) explicitComplete = true;
      else if (signal === false) explicitIncomplete = true;
    }

    let objectHasMore: boolean | undefined;
    for (const key of HAS_MORE_KEYS) {
      if (!normalized.has(key)) continue;
      const signal = booleanSignal(normalized.get(key));
      if (signal === true) {
        objectHasMore = true;
        sawPartial = true;
      } else if (signal === false) {
        objectHasMore ??= false;
        sawTerminal = true;
      }
    }

    const total = [...TOTAL_KEYS].map((key) => nonnegativeNumber(normalized.get(key)))
      .find((value) => value !== undefined);
    const returned = [...RETURNED_KEYS].map((key) => nonnegativeNumber(normalized.get(key)))
      .find((value) => value !== undefined);
    const offset = [...OFFSET_KEYS].map((key) => nonnegativeNumber(normalized.get(key)))
      .find((value) => value !== undefined);
    if (hasRecordCollection && total !== undefined) {
      const window = returned ?? recordCount;
      const start = offset ?? 0;
      if (start + window < total) sawPartial = true;
      else sawTerminal = true;
    }

    const page = [...PAGE_KEYS].map((key) => nonnegativeNumber(normalized.get(key)))
      .find((value) => value !== undefined);
    const pageCount = [...PAGE_COUNT_KEYS].map((key) => nonnegativeNumber(normalized.get(key)))
      .find((value) => value !== undefined);
    if (hasRecordCollection && page !== undefined && pageCount !== undefined && pageCount > 0) {
      const terminalPage = page === 0 ? page + 1 >= pageCount : page >= pageCount;
      if (terminalPage) sawTerminal = true;
      else sawPartial = true;
    }

    if (objectHasMore === true && normalized.has('endcursor')) markCursor(normalized.get('endcursor'));

    for (const [rawKey, child] of entries.slice(0, PAGINATION_MAX_ENTRIES)) {
      const key = normalizedStructuralKey(rawKey);
      if (REQUEST_ECHO_KEYS.has(key)) continue;
      const isRecordCollection = RECORD_CONTAINERS.some(
        (candidate) => normalizedStructuralKey(candidate) === key,
      ) && Array.isArray(child);
      if (isRecordCollection) continue;

      if (CURSOR_VALUE_KEYS.has(key)) {
        const candidate = cursorValue(child);
        if (candidate !== null) markCursor(child);
        else if (child === null || child === false || child === '') {
          if (key !== 'cursor' && key !== 'pagetoken') sawTerminal = true;
        }
      } else if (key === 'next' && (PAGINATION_PARENT_KEYS.has(parentKey) || parentKey === '')) {
        const candidate = cursorValue(child);
        if (candidate !== null) markCursor(child);
        else if (child === null || child === false || child === '') sawTerminal = true;
      }

      if (child && typeof child === 'object') visit(child, depth + 1, key);
    }
  };

  visit(envelope, 0, '');
  if (sawPartial || explicitIncomplete) return { completeness: 'partial', cursor };
  if (explicitComplete || sawTerminal) return { completeness: 'complete', cursor: null };
  return { completeness: 'unknown', cursor: null };
}

function findRecords(envelope: Record<string, unknown>): { path: string; records: unknown[] } | null {
  for (const key of RECORD_CONTAINERS) {
    if (Array.isArray(envelope[key])) return { path: key, records: envelope[key] as unknown[] };
  }
  for (const container of ['data', 'result', 'payload']) {
    const nested = asRecord(envelope[container]);
    if (!nested) continue;
    for (const key of RECORD_CONTAINERS) {
      if (Array.isArray(nested[key])) {
        return { path: `${container}.${key}`, records: nested[key] as unknown[] };
      }
    }
  }
  return null;
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

    const found = findRecords(envelope);
    const pagination = inspectPagination(envelope, found?.records.length ?? 0, found !== null);
    const status = statusOf(envelope);
    const successful = envelope.successful ?? envelope.success ?? envelope.ok;
    const isError = typeof envelope.isError === 'boolean' ? envelope.isError : undefined;
    const errorish = providerEnvelopeHasContradiction(envelope)
      || Boolean(envelope.error)
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
      completeness: !success || meta.malformed ? 'unknown' : pagination.completeness,
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
