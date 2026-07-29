/**
 * Security boundary for agent-authored Workspace views.
 *
 * Views run in an opaque-origin iframe. They can ask the trusted console parent
 * for one of these narrow operations, but they never receive an authenticated
 * fetch primitive. Keep parsing here pure so the confused-deputy boundary is
 * deterministic and independently testable.
 */

export const WORKSPACE_RPC_CHANNEL = 'clementine.workspace.rpc.v1';
export const WORKSPACE_GESTURE_CHANNEL = 'clementine.workspace.gesture.v1';
export const WORKSPACE_IFRAME_SANDBOX = 'allow-scripts';

export type WorkspaceRpcOp =
  | 'data'
  | 'history'
  | 'diff'
  | 'refresh'
  | 'note'
  | 'compose'
  | 'action';

/**
 * Privileged browser effects never share the script-callable RPC port. The
 * injected bridge receives a second capability port and uses it only from its
 * capture-phase `isTrusted` click handler.
 */
export type WorkspaceGestureOp = 'open_external' | 'download';

interface WorkspaceRpcBase {
  channel: typeof WORKSPACE_RPC_CHANNEL;
  version: 1;
  workspaceId: string;
  id: string;
}

export interface WorkspaceRpcRequest extends WorkspaceRpcBase {
  kind: 'request';
  op: WorkspaceRpcOp;
  payload: Record<string, unknown>;
}

export interface WorkspaceGestureRequest {
  channel: typeof WORKSPACE_GESTURE_CHANNEL;
  version: 1;
  kind: 'gesture';
  workspaceId: string;
  documentId: string;
  id: string;
  op: WorkspaceGestureOp;
  payload: Record<string, unknown>;
}

export interface WorkspaceRpcBootstrap {
  channel: typeof WORKSPACE_RPC_CHANNEL;
  version: 1;
  kind: 'bootstrap';
  workspaceId: string;
  documentId: string;
}

export interface WorkspaceRpcBootstrapAck {
  channel: typeof WORKSPACE_RPC_CHANNEL;
  version: 1;
  kind: 'bootstrap_ack';
  workspaceId: string;
  documentId: string;
}

export interface WorkspaceRpcSuccess extends WorkspaceRpcBase {
  kind: 'response';
  ok: true;
  result: unknown;
}

export interface WorkspaceRpcFailure extends WorkspaceRpcBase {
  kind: 'response';
  ok: false;
  error: string;
}

export type WorkspaceRpcResponse = WorkspaceRpcSuccess | WorkspaceRpcFailure;

export interface WorkspaceRpcEventLike {
  data: unknown;
  origin: string;
  source: unknown;
}

export type WorkspaceRpcParseResult =
  | { ok: true; request: WorkspaceRpcRequest }
  | { ok: false; reason: string };

export type WorkspaceRpcBootstrapParseResult =
  | { ok: true; bootstrap: WorkspaceRpcBootstrap }
  | { ok: false; reason: string };

export type WorkspaceGestureParseResult =
  | { ok: true; gesture: WorkspaceGestureRequest }
  | { ok: false; reason: string };

const OPS = new Set<WorkspaceRpcOp>([
  'data',
  'history',
  'diff',
  'refresh',
  'note',
  'compose',
  'action',
]);
const GESTURE_OPS = new Set<WorkspaceGestureOp>(['open_external', 'download']);
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,96}$/;
const MAX_PAYLOAD_BYTES = 100_000;
const SAFE_DOWNLOAD_NAME_RE = /^(?!\.{1,2}$)[^/\\\0]{1,180}$/;
const SAFE_DOWNLOAD_DATA_RE = /^data:(?:image\/(?:svg\+xml|png|jpeg|webp)|text\/(?:plain|csv|markdown)|application\/json)(?:;charset=[^,;]{1,80})?(?:;base64)?,/i;
const OBSERVATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_KEY_RE = /^[^\u0000-\u001f\u007f]{1,200}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function boundedString(value: unknown, max: number, allowBlank = false): value is string {
  return typeof value === 'string'
    && value.length <= max
    && (allowBlank || value.trim().length > 0);
}

function isJsonSafe(value: unknown, depth = 0, seen = new Set<object>()): boolean {
  // Optional bridge fields arrive as own properties with value `undefined`;
  // JSON.stringify drops them before the parent API call, so they are safe.
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > 12 || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 2_000) return false;
    const ok = value.every((entry) => isJsonSafe(entry, depth + 1, seen));
    seen.delete(value);
    return ok;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > 2_000) return false;
  const ok = keys.every((key) => key.length <= 256 && isJsonSafe(record[key], depth + 1, seen));
  seen.delete(value);
  return ok;
}

function payloadIsBounded(payload: Record<string, unknown>): boolean {
  if (!isJsonSafe(payload)) return false;
  try {
    return JSON.stringify(payload).length <= MAX_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

function optionalSourceKey(value: unknown): boolean {
  return value === undefined
    || (typeof value === 'string' && value.trim() === value && SOURCE_KEY_RE.test(value));
}

function optionalObservationId(value: unknown): boolean {
  return value === undefined
    || (typeof value === 'string' && OBSERVATION_ID_RE.test(value));
}

function optionalIsoTimestamp(value: unknown): boolean {
  return value === undefined
    || (typeof value === 'string'
      && value.length <= 32
      && ISO_TIMESTAMP_RE.test(value)
      && Number.isFinite(Date.parse(value)));
}

function payloadMatchesOperation(op: WorkspaceRpcOp, payload: Record<string, unknown>): boolean {
  if (!payloadIsBounded(payload)) return false;
  if (op === 'data') return Object.keys(payload).length === 0;
  if (op === 'history') {
    return hasOnlyKeys(payload, ['sourceKey', 'limit', 'cursor', 'before'])
      && optionalSourceKey(payload.sourceKey)
      && (payload.limit === undefined
        || (Number.isInteger(payload.limit) && Number(payload.limit) >= 1 && Number(payload.limit) <= 100))
      && optionalObservationId(payload.cursor)
      && !(payload.cursor !== undefined && payload.before !== undefined)
      && optionalIsoTimestamp(payload.before);
  }
  if (op === 'diff') {
    return hasOnlyKeys(payload, ['sourceKey', 'from', 'to'])
      && optionalSourceKey(payload.sourceKey)
      && optionalObservationId(payload.from)
      && optionalObservationId(payload.to);
  }
  if (op === 'refresh') {
    return hasOnlyKeys(payload, ['sourceId'])
      && (payload.sourceId === undefined || boundedString(payload.sourceId, 200));
  }
  if (op === 'note') {
    return hasOnlyKeys(payload, ['text', 'kind', 'meta'])
      && boundedString(payload.text, 10_000)
      && (payload.kind === undefined || boundedString(payload.kind, 100))
      && (payload.meta === undefined || isRecord(payload.meta));
  }
  if (op === 'compose') {
    return hasOnlyKeys(payload, ['instructions', 'context', 'maxChars'])
      && boundedString(payload.instructions, 20_000)
      && (payload.maxChars === undefined
        || (Number.isInteger(payload.maxChars) && Number(payload.maxChars) >= 1 && Number(payload.maxChars) <= 20_000));
  }
  return hasOnlyKeys(payload, ['actionId', 'args'])
    && boundedString(payload.actionId, 200)
    && isRecord(payload.args);
}

function payloadMatchesGesture(
  op: WorkspaceGestureOp,
  payload: Record<string, unknown>,
): boolean {
  if (!payloadIsBounded(payload)) return false;
  if (op === 'open_external') {
    if (!hasOnlyKeys(payload, ['url']) || !boundedString(payload.url, 4_096)) return false;
    try {
      const parsed = new URL(payload.url);
      return [
        'https:',
        'http:',
        'mailto:',
        'tel:',
        'callto:',
        'sms:',
        'facetime:',
        'facetime-audio:',
        'maps:',
        'webcal:',
        'zoommtg:',
        'msteams:',
      ].includes(parsed.protocol)
        && !parsed.username
        && !parsed.password;
    } catch {
      return false;
    }
  }
  if (op === 'download') {
    return hasOnlyKeys(payload, ['filename', 'dataUrl'])
      && boundedString(payload.filename, 180)
      && SAFE_DOWNLOAD_NAME_RE.test(payload.filename)
      && boundedString(payload.dataUrl, MAX_PAYLOAD_BYTES)
      && SAFE_DOWNLOAD_DATA_RE.test(payload.dataUrl);
  }
  return false;
}

/** Parse a request received on the document-pinned MessagePort. Source/origin
 * checks happen once during bootstrap; every port request still repeats the
 * immutable workspace envelope and bounded operation schema. */
export function parseWorkspaceRpcRequest(
  data: unknown,
  expectedWorkspaceId: string,
): WorkspaceRpcParseResult {
  if (!isRecord(data)) return { ok: false, reason: 'invalid_envelope' };
  const message = data;
  if (
    message.channel !== WORKSPACE_RPC_CHANNEL
    || message.version !== 1
    || message.kind !== 'request'
  ) {
    return { ok: false, reason: 'invalid_envelope' };
  }
  if (message.workspaceId !== expectedWorkspaceId) return { ok: false, reason: 'wrong_workspace' };
  if (!boundedString(message.id, 96) || !REQUEST_ID_RE.test(message.id)) {
    return { ok: false, reason: 'invalid_id' };
  }
  if (typeof message.op !== 'string' || !OPS.has(message.op as WorkspaceRpcOp)) {
    return { ok: false, reason: 'invalid_operation' };
  }
  if (!isRecord(message.payload)) return { ok: false, reason: 'invalid_payload' };
  const op = message.op as WorkspaceRpcOp;
  if (!payloadMatchesOperation(op, message.payload)) return { ok: false, reason: 'invalid_payload' };
  return {
    ok: true,
    request: {
      channel: WORKSPACE_RPC_CHANNEL,
      version: 1,
      kind: 'request',
      workspaceId: expectedWorkspaceId,
      id: message.id,
      op,
      payload: message.payload,
    },
  };
}

/**
 * Parse an intent received only on the private gesture capability port.
 * Calling this parser on the general RPC port would erase the authority
 * separation; the parent host keeps distinct MessageChannel listeners.
 */
export function parseWorkspaceGestureRequest(
  data: unknown,
  expectedWorkspaceId: string,
  expectedDocumentId: string,
): WorkspaceGestureParseResult {
  if (!isRecord(data)) return { ok: false, reason: 'invalid_envelope' };
  const message = data;
  if (
    message.channel !== WORKSPACE_GESTURE_CHANNEL
    || message.version !== 1
    || message.kind !== 'gesture'
  ) {
    return { ok: false, reason: 'invalid_envelope' };
  }
  if (message.workspaceId !== expectedWorkspaceId) {
    return { ok: false, reason: 'wrong_workspace' };
  }
  if (message.documentId !== expectedDocumentId) {
    return { ok: false, reason: 'wrong_document' };
  }
  if (!boundedString(message.id, 96) || !REQUEST_ID_RE.test(message.id)) {
    return { ok: false, reason: 'invalid_id' };
  }
  if (
    typeof message.op !== 'string'
    || !GESTURE_OPS.has(message.op as WorkspaceGestureOp)
  ) {
    return { ok: false, reason: 'invalid_operation' };
  }
  if (!isRecord(message.payload)) return { ok: false, reason: 'invalid_payload' };
  const op = message.op as WorkspaceGestureOp;
  if (!payloadMatchesGesture(op, message.payload)) {
    return { ok: false, reason: 'invalid_payload' };
  }
  if (!hasOnlyKeys(message, [
    'channel',
    'version',
    'kind',
    'workspaceId',
    'documentId',
    'id',
    'op',
    'payload',
  ])) {
    return { ok: false, reason: 'invalid_envelope' };
  }
  return {
    ok: true,
    gesture: {
      channel: WORKSPACE_GESTURE_CHANNEL,
      version: 1,
      kind: 'gesture',
      workspaceId: expectedWorkspaceId,
      documentId: expectedDocumentId,
      id: message.id,
      op,
      payload: message.payload,
    },
  };
}

/** Recover only a safe response correlation from an otherwise-invalid request.
 * This is used after the MessagePort security envelope is established so bad
 * authored payloads fail immediately instead of looking like a 30s hang. */
export function workspaceRpcCorrelation(
  data: unknown,
  expectedWorkspaceId: string,
): Pick<WorkspaceRpcBase, 'workspaceId' | 'id'> | null {
  if (!isRecord(data)) return null;
  if (
    data.channel !== WORKSPACE_RPC_CHANNEL
    || data.version !== 1
    || data.kind !== 'request'
    || data.workspaceId !== expectedWorkspaceId
    || !boundedString(data.id, 96)
    || !REQUEST_ID_RE.test(data.id)
  ) return null;
  return { workspaceId: expectedWorkspaceId, id: data.id };
}

/** Establish authority for exactly one opaque document. Subsequent documents
 * in the same WindowProxy cannot silently inherit this bootstrap. */
export function parseWorkspaceRpcBootstrapEvent(
  event: WorkspaceRpcEventLike,
  expectedSource: unknown,
  expectedWorkspaceId: string,
): WorkspaceRpcBootstrapParseResult {
  if (event.source !== expectedSource) return { ok: false, reason: 'wrong_source' };
  if (event.origin !== 'null') return { ok: false, reason: 'non_opaque_origin' };
  if (!isRecord(event.data)) return { ok: false, reason: 'invalid_envelope' };
  const message = event.data;
  if (
    message.channel !== WORKSPACE_RPC_CHANNEL
    || message.version !== 1
    || message.kind !== 'bootstrap'
  ) return { ok: false, reason: 'invalid_envelope' };
  if (message.workspaceId !== expectedWorkspaceId) return { ok: false, reason: 'wrong_workspace' };
  if (!boundedString(message.documentId, 96) || !REQUEST_ID_RE.test(message.documentId)) {
    return { ok: false, reason: 'invalid_document_id' };
  }
  if (!hasOnlyKeys(message, ['channel', 'version', 'kind', 'workspaceId', 'documentId'])) {
    return { ok: false, reason: 'invalid_envelope' };
  }
  return {
    ok: true,
    bootstrap: {
      channel: WORKSPACE_RPC_CHANNEL,
      version: 1,
      kind: 'bootstrap',
      workspaceId: expectedWorkspaceId,
      documentId: message.documentId,
    },
  };
}

/**
 * Validate the browser event and message together. A sandboxed frame serializes
 * its origin as "null"; accepting the console origin here would silently
 * restore the same-origin privilege this boundary exists to remove.
 */
export function parseWorkspaceRpcEvent(
  event: WorkspaceRpcEventLike,
  expectedSource: unknown,
  expectedWorkspaceId: string,
): WorkspaceRpcParseResult {
  if (event.source !== expectedSource) return { ok: false, reason: 'wrong_source' };
  if (event.origin !== 'null') return { ok: false, reason: 'non_opaque_origin' };
  return parseWorkspaceRpcRequest(event.data, expectedWorkspaceId);
}

export function workspaceRpcOpAllowed(op: WorkspaceRpcOp, readOnly: boolean): boolean {
  return !readOnly || op === 'data' || op === 'history' || op === 'diff';
}

export function workspaceGestureAllowed(readOnly: boolean): boolean {
  return !readOnly;
}

export function workspaceRpcSuccess(request: WorkspaceRpcRequest, result: unknown): WorkspaceRpcSuccess {
  return {
    channel: WORKSPACE_RPC_CHANNEL,
    version: 1,
    kind: 'response',
    workspaceId: request.workspaceId,
    id: request.id,
    ok: true,
    result,
  };
}

export function workspaceRpcFailure(request: WorkspaceRpcRequest, error: string): WorkspaceRpcFailure {
  return {
    channel: WORKSPACE_RPC_CHANNEL,
    version: 1,
    kind: 'response',
    workspaceId: request.workspaceId,
    id: request.id,
    ok: false,
    error: error.slice(0, 1_000),
  };
}
