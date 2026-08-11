import { createHash } from 'node:crypto';
import {
  openEventLog,
  resolveToolOutputsForAuthority,
  type EventRow,
} from './eventlog.js';
import {
  isSettledReadReplayReturnData,
  SETTLED_READ_REPLAY_KIND,
} from './settled-read-replay-semantics.js';
import { toolOutputLooksSuccessful } from './tool-evidence.js';
import { presentationEventFromCompletionData } from './turn-outcome.js';
import type { ExactVerifiedReadCompletionCertificate } from './verified-read-completion.js';
import {
  parseVerifiedReadCapabilityOrigin,
  type VerifiedReadCapabilityOrigin,
} from '../../memory/verified-read-origin.js';

const MAX_PRIOR_RECEIPT_TERMINALS = 64;
const MAX_CALL_LIFECYCLE_ROWS = 16;
const MAX_LATER_SAME_TOOL_CALLS = 128;
const LOCAL_HISTORY_CHANNELS = new Set(['cli', 'desktop', 'home']);
const SHA256_RE = /^[a-f0-9]{64}$/;
const RECEIPT_KEYS = new Set([
  'attemptId',
  'callId',
  'kind',
  'objectiveDigest',
  'outputDigest',
  'presentationDigest',
  'sourceUserSeq',
  'toolName',
  'version',
]);

interface RawEventRow {
  seq: number;
  id: string;
  session_id: string;
  turn: number;
  role: string;
  type: string;
  parent_event_id: string | null;
  data_json: string;
  created_at: string;
}

interface ReadHistoryPrincipal {
  channel: string;
  userId: string | null;
}

export interface VerifiedReadReceiptLineage {
  /** The exact bounded v1 certificate committed with the prior public answer. */
  receipt: ExactVerifiedReadCompletionCertificate;
  terminal: {
    eventId: string;
    seq: number;
    turn: number;
  };
  lifecycle: {
    callEventId: string;
    callSeq: number;
    returnEventId: string;
    returnSeq: number;
  };
}

export interface TrustedPriorVerifiedReadEvidence {
  lineage: VerifiedReadReceiptLineage;
  /** Arguments from the physical tool_called row, decoded when they are JSON. */
  toolArgs: unknown;
  /** Exact, untrimmed bytes from the authority tool-output store. */
  rawOutput: string;
}

export interface ResolveLatestTrustedPriorVerifiedReadInput {
  sessionId: string;
  /** Exact user_input_received event that owns the turn now being evaluated. */
  currentSourceUserSeq: number;
  /** Durable inner/provider identity, not a carrier such as call_tool. */
  expectedEffectiveTool: string;
  /** Physical current read call. Required before a cross-session origin may be
   * followed, so the capability event and intervening reads are ordered. */
  currentCallSeq?: number;
}

function decodeEvent(row: RawEventRow): EventRow | null {
  try {
    const data = JSON.parse(row.data_json) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return {
      seq: row.seq,
      id: row.id,
      sessionId: row.session_id,
      turn: row.turn,
      role: row.role,
      type: row.type as EventRow['type'],
      parentEventId: row.parent_event_id,
      data: data as Record<string, unknown>,
      createdAt: row.created_at,
    };
  } catch {
    return null;
  }
}

function boundedIdentifier(value: unknown): string | null {
  return typeof value === 'string'
    && value.trim() === value
    && value.length >= 1
    && value.length <= 512
    ? value
    : null;
}

function eventString(event: EventRow, key: string): string {
  const value = event.data[key];
  return typeof value === 'string' ? value.trim() : '';
}

function eventSourceUserSeq(event: EventRow): number | null {
  const value = event.data.sourceUserSeq;
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function exactReceipt(value: unknown): ExactVerifiedReadCompletionCertificate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  const keys = Object.keys(receipt);
  if (keys.length !== RECEIPT_KEYS.size || keys.some((key) => !RECEIPT_KEYS.has(key))) return null;
  if (receipt.version !== 1
    || (receipt.kind !== 'single_collection_read' && receipt.kind !== 'read_discovery_scaffold')
    || !Number.isSafeInteger(receipt.sourceUserSeq)
    || Number(receipt.sourceUserSeq) <= 0) return null;
  const attemptId = boundedIdentifier(receipt.attemptId);
  const callId = boundedIdentifier(receipt.callId);
  const toolName = boundedIdentifier(receipt.toolName);
  if (!attemptId || !callId || !toolName) return null;
  for (const key of ['objectiveDigest', 'outputDigest', 'presentationDigest'] as const) {
    if (typeof receipt[key] !== 'string' || !SHA256_RE.test(receipt[key] as string)) return null;
  }
  return {
    version: 1,
    kind: receipt.kind,
    sourceUserSeq: Number(receipt.sourceUserSeq),
    attemptId,
    callId,
    toolName,
    outputDigest: receipt.outputDigest as string,
    objectiveDigest: receipt.objectiveDigest as string,
    presentationDigest: receipt.presentationDigest as string,
  };
}

function trustedTerminalReceipt(
  terminal: EventRow,
  expectedEffectiveTool: string,
): ExactVerifiedReadCompletionCertificate | null {
  if (terminal.type !== 'conversation_completed' || terminal.role !== 'system') return null;
  const receipt = exactReceipt(terminal.data.verifiedReadCompletionReceipt);
  if (!receipt || receipt.toolName !== expectedEffectiveTool) return null;
  if (terminal.seq <= receipt.sourceUserSeq
    || eventSourceUserSeq(terminal) !== receipt.sourceUserSeq
    || terminal.data.logicalTerminalVersion !== 1
    || terminal.data.delivered !== true) return null;
  try {
    const presentation = presentationEventFromCompletionData(terminal.data);
    if (!presentation
      || presentation.status !== 'done'
      || presentation.kind !== 'answer'
      || presentation.identity.sessionId !== terminal.sessionId
      || presentation.identity.sourceUserSeq !== receipt.sourceUserSeq
      || presentation.identity.turn !== terminal.turn
      || terminal.data.terminalKey !== presentation.outcomeId
      || terminal.data.reply !== presentation.text
      || createHash('sha256').update(presentation.text).digest('hex') !== receipt.presentationDigest) {
      return null;
    }
    const terminalAttemptId = boundedIdentifier(terminal.data.attemptId)
      ?? boundedIdentifier(presentation.identity.attemptId);
    if (terminalAttemptId && terminalAttemptId !== receipt.attemptId) return null;
  } catch {
    return null;
  }
  return receipt;
}

function toolArgs(call: EventRow): unknown {
  const raw = call.data.args ?? call.data.arguments;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function explicitReadAccountSelector(args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  const keys = ['connected_account_id', 'connectedAccountId']
    .filter((key) => Object.prototype.hasOwnProperty.call(record, key));
  if (keys.length !== 1) return null;
  const value = record[keys[0]!] as unknown;
  if (value === null) return 'none';
  return typeof value === 'string'
    && value.trim() === value
    && value.length >= 1
    && value.length <= 512
    ? `id:${value}`
    : null;
}

function returnExplicitOk(event: EventRow): boolean | undefined {
  for (const key of ['ok', 'successful', 'success'] as const) {
    if (event.data[key] === false) return false;
  }
  if (event.data.failed === true || event.data.error === true) return false;
  if (typeof event.data.error === 'string' && event.data.error.trim()) return false;
  if (Array.isArray(event.data.errors) && event.data.errors.length > 0) return false;
  for (const key of ['ok', 'successful', 'success'] as const) {
    if (event.data[key] === true) return true;
  }
  return undefined;
}

function exactPhysicalLifecycle(input: {
  events: readonly EventRow[];
  receipt: ExactVerifiedReadCompletionCertificate;
  terminal: EventRow;
  expectedEffectiveTool: string;
}): { call: EventRow; returned: EventRow } | null {
  const canonical = input.events.filter((event) => event.data.accounting !== 'transport_mirror');
  const replayReturns = canonical.filter((event) => (
    event.type === 'tool_returned' && isSettledReadReplayReturnData(event.data)
  ));
  const replayParentIds = new Set(replayReturns
    .map((event) => event.parentEventId)
    .filter((id): id is string => typeof id === 'string'));
  const calls = canonical.filter((event) => (
    event.type === 'tool_called'
    && eventString(event, 'callId') === input.receipt.callId
    && !replayParentIds.has(event.id)
  ));
  const returns = canonical.filter((event) => (
    event.type === 'tool_returned'
    && eventString(event, 'callId') === input.receipt.callId
    && !isSettledReadReplayReturnData(event.data)
  ));
  if (calls.length !== 1 || returns.length !== 1) return null;
  const call = calls[0]!;
  const returned = returns[0]!;
  const outerTool = eventString(call, 'tool');
  if (!outerTool
    || returned.parentEventId !== call.id
    || call.seq <= input.receipt.sourceUserSeq
    || returned.seq <= call.seq
    || returned.seq >= input.terminal.seq
    // `event.turn` on the physical lifecycle is the provider/model step, while
    // the terminal presentation owns the accepted logical conversation turn.
    // They legitimately differ (for example physical 2/4/8 vs logical 1).
    // Exact source, attempt, call, parent, and ordering lineage below is the
    // immutable ownership boundary; the physical pair must agree with itself.
    || call.turn !== returned.turn
    || eventString(returned, 'tool') !== outerTool
    || eventString(call, 'effect') !== 'read'
    || eventString(returned, 'effect') !== 'read'
    || eventString(call, 'effectiveTool') !== input.expectedEffectiveTool
    || eventString(returned, 'effectiveTool') !== input.expectedEffectiveTool
    || eventSourceUserSeq(call) !== input.receipt.sourceUserSeq
    || eventSourceUserSeq(returned) !== input.receipt.sourceUserSeq
    || eventString(call, 'attemptId') !== input.receipt.attemptId
    || eventString(returned, 'attemptId') !== input.receipt.attemptId
    || returned.data.providerDispatched === false
    || eventString(returned, 'replayKind')) return null;
  return { call, returned };
}

function newerOrOverlappingPhysicalReadExists(input: {
  scope: { sessionId: string } | { principal: ReadHistoryPrincipal };
  beforeSeq: number;
  expectedEffectiveTool: string;
  candidateCall: EventRow;
  candidateReturn: EventRow;
}): boolean {
  const db = openEventLog();
  const principal = 'principal' in input.scope ? input.scope.principal : null;
  const ownerJoin = principal ? 'JOIN sessions AS owners ON owners.id = calls.session_id' : '';
  const ownerClause = principal
    ? `AND owners.kind = 'chat'
       AND owners.channel = ?
       AND ${principal.userId === null ? 'owners.user_id IS NULL' : 'owners.user_id = ?'}`
    : 'AND calls.session_id = ?';
  const ownerParams = principal
    ? [principal.channel, ...(principal.userId === null ? [] : [principal.userId])]
    : [(input.scope as { sessionId: string }).sessionId];

  // Bound only calls that can actually supersede the candidate. Ancient,
  // fully settled reads must not consume the window or poison history after a
  // long-running daemon has accumulated more than 128 observations.
  const laterRows = db.prepare(`
    SELECT calls.seq, calls.id, calls.session_id, calls.turn, calls.role,
           calls.type, calls.parent_event_id, calls.data_json, calls.created_at
      FROM events AS calls
      ${ownerJoin}
     WHERE calls.seq > ?
       AND calls.seq < ?
       AND calls.type = 'tool_called'
       AND COALESCE(json_extract(calls.data_json, '$.accounting'), '') <> 'transport_mirror'
       AND json_extract(calls.data_json, '$.effect') = 'read'
       AND json_extract(calls.data_json, '$.effectiveTool') = ?
       AND NOT (
         (SELECT COUNT(*)
            FROM events AS replay_returns
           WHERE replay_returns.session_id = calls.session_id
             AND replay_returns.seq < ?
             AND replay_returns.type = 'tool_returned'
             AND replay_returns.parent_event_id = calls.id) = 1
         AND EXISTS (
           SELECT 1
             FROM events AS replay_return
            WHERE replay_return.session_id = calls.session_id
              AND replay_return.seq < ?
              AND replay_return.type = 'tool_returned'
              AND replay_return.parent_event_id = calls.id
              AND json_extract(replay_return.data_json, '$.replayKind') = ?
              AND json_extract(replay_return.data_json, '$.providerDispatched') = 0
         )
       )
       ${ownerClause}
     ORDER BY calls.seq ASC
     LIMIT 1
  `).all(
    input.candidateCall.seq,
    input.beforeSeq,
    input.expectedEffectiveTool,
    input.beforeSeq,
    input.beforeSeq,
    SETTLED_READ_REPLAY_KIND,
    ...ownerParams,
  ) as RawEventRow[];
  for (const row of laterRows) {
    const call = decodeEvent(row);
    if (!call) return true;
    const returnedRows = db.prepare(`
      SELECT seq, id, session_id, turn, role, type, parent_event_id, data_json, created_at
        FROM events
       WHERE session_id = ?
         AND seq < ?
         AND type = 'tool_returned'
         AND parent_event_id = ?
       ORDER BY seq ASC
       LIMIT 2
    `).all(call.sessionId, input.beforeSeq, call.id) as RawEventRow[];
    if (returnedRows.length !== 1) return true;
    const returned = decodeEvent(returnedRows[0]!);
    // Only the runtime's exact no-dispatch replay contract proves that this
    // logical call was not a newer provider observation. Everything else is a
    // physical or ambiguous read and invalidates the older receipt.
    if (!returned) return true;
    if (isSettledReadReplayReturnData(returned.data)) continue;
    return true;
  }

  // A call that started before the candidate but physically returned after it
  // is the other ambiguous overlap. Query those returns directly so malformed
  // or missing ancient lifecycles do not permanently disable future history.
  const overlappingReturns = db.prepare(`
    SELECT returned.seq, returned.id, returned.session_id, returned.turn,
           returned.role, returned.type, returned.parent_event_id,
           returned.data_json, returned.created_at
      FROM events AS returned
      JOIN events AS calls ON calls.id = returned.parent_event_id
      ${ownerJoin}
     WHERE calls.seq < ?
       AND returned.seq > ?
       AND returned.seq < ?
       AND calls.type = 'tool_called'
       AND returned.type = 'tool_returned'
       AND COALESCE(json_extract(calls.data_json, '$.accounting'), '') <> 'transport_mirror'
       AND json_extract(calls.data_json, '$.effect') = 'read'
       AND json_extract(calls.data_json, '$.effectiveTool') = ?
       ${ownerClause}
     ORDER BY returned.seq ASC
     LIMIT ?
  `).all(
    input.candidateCall.seq,
    input.candidateReturn.seq,
    input.beforeSeq,
    input.expectedEffectiveTool,
    ...ownerParams,
    MAX_LATER_SAME_TOOL_CALLS + 1,
  ) as RawEventRow[];
  if (overlappingReturns.length > MAX_LATER_SAME_TOOL_CALLS) return true;
  for (const row of overlappingReturns) {
    const returned = decodeEvent(row);
    if (!returned) return true;
    if (!isSettledReadReplayReturnData(returned.data)) return true;
  }

  // An earlier call from the candidate's exact accepted turn that never
  // settled is still a live ambiguity. Scope this narrowly to the same source
  // and turn so an abandoned call from ancient history cannot poison every
  // future receipt for the tool.
  const earlierSameTurn = db.prepare(`
    SELECT seq, id, session_id, turn, role, type, parent_event_id, data_json, created_at
      FROM events
     WHERE session_id = ?
       AND seq < ?
       AND turn = ?
       AND type = 'tool_called'
       AND COALESCE(json_extract(data_json, '$.accounting'), '') <> 'transport_mirror'
       AND json_extract(data_json, '$.effect') = 'read'
       AND json_extract(data_json, '$.effectiveTool') = ?
       AND json_extract(data_json, '$.sourceUserSeq') = ?
     ORDER BY seq ASC
     LIMIT ?
  `).all(
    input.candidateCall.sessionId,
    input.candidateCall.seq,
    input.candidateCall.turn,
    input.expectedEffectiveTool,
    eventSourceUserSeq(input.candidateCall),
    MAX_LATER_SAME_TOOL_CALLS + 1,
  ) as RawEventRow[];
  if (earlierSameTurn.length > MAX_LATER_SAME_TOOL_CALLS) return true;
  for (const row of earlierSameTurn) {
    const call = decodeEvent(row);
    if (!call) return true;
    const returns = db.prepare(`
      SELECT seq, id, session_id, turn, role, type, parent_event_id, data_json, created_at
        FROM events
       WHERE session_id = ?
         AND seq < ?
         AND type = 'tool_returned'
         AND parent_event_id = ?
       ORDER BY seq ASC
       LIMIT 2
    `).all(call.sessionId, input.beforeSeq, call.id) as RawEventRow[];
    if (returns.length !== 1) return true;
  }
  return false;
}

function candidateLifecycleRows(
  sessionId: string,
  callId: string,
  currentSourceUserSeq: number,
): EventRow[] | null {
  const rows = openEventLog().prepare(`
    SELECT seq, id, session_id, turn, role, type, parent_event_id, data_json, created_at
      FROM events
     WHERE session_id = ?
       AND seq < ?
       AND type IN ('tool_called', 'tool_returned')
       AND json_extract(data_json, '$.callId') = ?
     ORDER BY seq ASC
     LIMIT ?
  `).all(sessionId, currentSourceUserSeq, callId, MAX_CALL_LIFECYCLE_ROWS + 1) as RawEventRow[];
  if (rows.length > MAX_CALL_LIFECYCLE_ROWS) return null;
  const decoded = rows.map(decodeEvent);
  return decoded.every((event): event is EventRow => event !== null) ? decoded : null;
}

function acceptedSourceExists(sessionId: string, sourceUserSeq: number): boolean {
  const row = openEventLog().prepare(`
    SELECT type, role
      FROM events
     WHERE session_id = ? AND seq = ?
     LIMIT 1
  `).get(sessionId, sourceUserSeq) as { type: string; role: string } | undefined;
  return row?.type === 'user_input_received' && row.role === 'user';
}

function readHistoryPrincipal(sessionId: string): ReadHistoryPrincipal | null {
  const row = openEventLog().prepare(`
    SELECT kind, channel, user_id
      FROM sessions
     WHERE id = ?
     LIMIT 1
  `).get(sessionId) as {
    kind: unknown;
    channel: unknown;
    user_id: unknown;
  } | undefined;
  if (!row || row.kind !== 'chat') return null;
  const channel = boundedIdentifier(row.channel);
  if (!channel) return null;
  const userId = row.user_id === null ? null : boundedIdentifier(row.user_id);
  if (row.user_id !== null && !userId) return null;
  // External surfaces are not yet tenant-qualified. Even an exact provider
  // user ID can collide across Slack workspaces, webhook tenants, or mobile
  // installations, so v1 cross-session history stays on local principals.
  if (!LOCAL_HISTORY_CHANNELS.has(channel)) return null;
  return { channel, userId };
}

function sameReadHistoryPrincipal(
  currentSessionId: string,
  originSessionId: string,
): ReadHistoryPrincipal | null {
  const current = readHistoryPrincipal(currentSessionId);
  const origin = readHistoryPrincipal(originSessionId);
  if (!current || !origin
    || current.channel !== origin.channel
    || current.userId !== origin.userId) return null;
  return current;
}

function exactCurrentPhysicalReadCall(input: {
  sessionId: string;
  sourceUserSeq: number;
  callSeq: number;
  expectedEffectiveTool: string;
}): EventRow | null {
  const row = openEventLog().prepare(`
    SELECT seq, id, session_id, turn, role, type, parent_event_id, data_json, created_at
      FROM events
     WHERE session_id = ?
       AND seq = ?
       AND type = 'tool_called'
     LIMIT 1
  `).get(input.sessionId, input.callSeq) as RawEventRow | undefined;
  const call = row ? decodeEvent(row) : null;
  return call
    && call.data.accounting !== 'transport_mirror'
    && eventString(call, 'effect') === 'read'
    && eventString(call, 'effectiveTool') === input.expectedEffectiveTool
    && eventSourceUserSeq(call) === input.sourceUserSeq
    ? call
    : null;
}

function trustedEvidenceForTerminal(input: {
  sessionId: string;
  terminal: EventRow;
  expectedEffectiveTool: string;
}): (TrustedPriorVerifiedReadEvidence & {
  call: EventRow;
  returned: EventRow;
}) | null {
  const receipt = trustedTerminalReceipt(input.terminal, input.expectedEffectiveTool);
  if (!receipt || !acceptedSourceExists(input.sessionId, receipt.sourceUserSeq)) return null;
  const lifecycleRows = candidateLifecycleRows(
    input.sessionId,
    receipt.callId,
    input.terminal.seq,
  );
  if (!lifecycleRows) return null;
  const lifecycle = exactPhysicalLifecycle({
    events: lifecycleRows,
    receipt,
    terminal: input.terminal,
    expectedEffectiveTool: input.expectedEffectiveTool,
  });
  if (!lifecycle) return null;
  const authority = resolveToolOutputsForAuthority(
    input.sessionId,
    [{ callId: receipt.callId }],
    { readOrComputeOnly: true, allowedSourceUserSeqs: [receipt.sourceUserSeq] },
  );
  if (authority.length !== 1) return null;
  const output = authority[0]!;
  if (output.callId !== receipt.callId
    || output.effect !== 'read'
    || output.sourceUserSeq !== receipt.sourceUserSeq
    || output.truncatedAtWrite
    || output.contentBytes !== Buffer.byteLength(output.output, 'utf8')
    || !output.output.trim()
    || !toolOutputLooksSuccessful(output.output, returnExplicitOk(lifecycle.returned))
    || createHash('sha256').update(output.output).digest('hex') !== receipt.outputDigest) return null;
  return {
    lineage: {
      receipt,
      terminal: {
        eventId: input.terminal.id,
        seq: input.terminal.seq,
        turn: input.terminal.turn,
      },
      lifecycle: {
        callEventId: lifecycle.call.id,
        callSeq: lifecycle.call.seq,
        returnEventId: lifecycle.returned.id,
        returnSeq: lifecycle.returned.seq,
      },
    },
    toolArgs: toolArgs(lifecycle.call),
    rawOutput: output.output,
    call: lifecycle.call,
    returned: lifecycle.returned,
  };
}

interface AuthorizedCapabilityOrigin {
  origin: VerifiedReadCapabilityOrigin;
  accountIdentity: string;
}

function authorizedCapabilityOrigin(input: {
  sessionId: string;
  sourceUserSeq: number;
  currentCallSeq: number;
  expectedEffectiveTool: string;
}): AuthorizedCapabilityOrigin | null {
  const rows = openEventLog().prepare(`
    SELECT seq, id, session_id, turn, role, type, parent_event_id, data_json, created_at
      FROM events
     WHERE session_id = ?
       AND seq > ?
       AND seq < ?
       AND type = 'capability_resolution'
       AND json_extract(data_json, '$.sourceUserSeq') = ?
       AND json_extract(data_json, '$.authoritativeForTask') = 1
     ORDER BY seq ASC
     LIMIT 17
  `).all(
    input.sessionId,
    input.sourceUserSeq,
    input.currentCallSeq,
    input.sourceUserSeq,
  ) as RawEventRow[];
  if (rows.length === 0 || rows.length > 16) return null;
  const candidates = new Map<string, AuthorizedCapabilityOrigin>();
  for (const row of rows) {
    const event = decodeEvent(row);
    if (!event || event.role !== 'system' || event.turn !== 0) return null;
    const entries = event.data.entries;
    if (!Array.isArray(entries) || entries.length > 16) return null;
    for (const raw of entries) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      if (entry.status !== 'proven'
        || entry.identifier !== input.expectedEffectiveTool
        || (entry.effectClass !== undefined && entry.effectClass !== 'read')) continue;
      const origin = parseVerifiedReadCapabilityOrigin(entry.verifiedReadOrigin);
      if (!origin
        || origin.sessionId === input.sessionId
        || origin.sourceUserSeq >= input.sourceUserSeq) continue;
      const accountIdentity = entry.accountIdentity === undefined
        ? ''
        : typeof entry.accountIdentity === 'string' && entry.accountIdentity.trim() === entry.accountIdentity
          ? entry.accountIdentity
          : null;
      if (accountIdentity === null) return null;
      const candidate = { origin, accountIdentity };
      candidates.set(JSON.stringify(candidate), candidate);
    }
  }
  return candidates.size === 1 ? [...candidates.values()][0]! : null;
}

function originLearningReceiptAttempt(input: {
  origin: VerifiedReadCapabilityOrigin;
  accountIdentity: string;
  expectedEffectiveTool: string;
  beforeSeq: number;
}): string | null {
  const rows = openEventLog().prepare(`
    SELECT seq, id, session_id, turn, role, type, parent_event_id, data_json, created_at
      FROM events
     WHERE session_id = ?
       AND seq < ?
       AND type = 'read_receipt'
       AND json_extract(data_json, '$.record.receiptId') = ?
     ORDER BY seq ASC
     LIMIT 2
  `).all(
    input.origin.sessionId,
    input.beforeSeq,
    input.origin.receiptId,
  ) as RawEventRow[];
  if (rows.length !== 1) return null;
  const event = decodeEvent(rows[0]!);
  const record = event?.data.record;
  if (!event
    || event.role !== 'system'
    || !record
    || typeof record !== 'object'
    || Array.isArray(record)) return null;
  const receipt = record as Record<string, unknown>;
  const scope = receipt.scope;
  const source = receipt.source;
  const sourceRecord = source && typeof source === 'object' && !Array.isArray(source)
    ? source as Record<string, unknown>
    : null;
  const attemptId = sourceRecord ? boundedIdentifier(sourceRecord.attemptId) : null;
  const noAccountProof = input.accountIdentity === ''
    && receipt.provider === 'proof'
    && input.expectedEffectiveTool.startsWith('PROOF_');
  const matches = receipt.receiptId === input.origin.receiptId
    && receipt.identifier === input.expectedEffectiveTool
    && receipt.effectClass === 'read'
    && receipt.dispatchOutcome === 'succeeded'
    && receipt.readEvidenceRef === `evt:${input.origin.evidenceDigest}`
    && typeof receipt.schemaFingerprint === 'string'
    && receipt.schemaFingerprint.trim().length > 0
    && Boolean(scope && typeof scope === 'object' && !Array.isArray(scope))
    && (scope as Record<string, unknown>).accountIdentity === input.accountIdentity
    && Boolean(input.accountIdentity || noAccountProof)
    && sourceRecord?.sessionId === input.origin.sessionId
    && sourceRecord?.sourceUserSeq === input.origin.sourceUserSeq
    && attemptId !== null;
  return matches ? attemptId : null;
}

function resolveAuthorizedCrossSessionPrior(input: {
  sessionId: string;
  currentSourceUserSeq: number;
  currentCallSeq: number;
  expectedEffectiveTool: string;
}): TrustedPriorVerifiedReadEvidence | null {
  const authorized = authorizedCapabilityOrigin({
    sessionId: input.sessionId,
    sourceUserSeq: input.currentSourceUserSeq,
    currentCallSeq: input.currentCallSeq,
    expectedEffectiveTool: input.expectedEffectiveTool,
  });
  if (!authorized) return null;
  const principal = sameReadHistoryPrincipal(input.sessionId, authorized.origin.sessionId);
  if (!principal) return null;
  const learningAttemptId = originLearningReceiptAttempt({
    ...authorized,
    expectedEffectiveTool: input.expectedEffectiveTool,
    beforeSeq: input.currentSourceUserSeq,
  });
  if (!learningAttemptId) return null;
  const terminalRows = openEventLog().prepare(`
    SELECT seq, id, session_id, turn, role, type, parent_event_id, data_json, created_at
      FROM events
     WHERE session_id = ?
       AND seq > ?
       AND seq < ?
       AND type = 'conversation_completed'
       AND json_extract(data_json, '$.verifiedReadCompletionReceipt.sourceUserSeq') = ?
       AND json_extract(data_json, '$.verifiedReadCompletionReceipt.toolName') = ?
     ORDER BY seq ASC
     LIMIT 2
  `).all(
    authorized.origin.sessionId,
    authorized.origin.sourceUserSeq,
    input.currentSourceUserSeq,
    authorized.origin.sourceUserSeq,
    input.expectedEffectiveTool,
  ) as RawEventRow[];
  if (terminalRows.length !== 1) return null;
  const terminal = decodeEvent(terminalRows[0]!);
  if (!terminal) return null;
  const evidence = trustedEvidenceForTerminal({
    sessionId: authorized.origin.sessionId,
    terminal,
    expectedEffectiveTool: input.expectedEffectiveTool,
  });
  const currentCall = exactCurrentPhysicalReadCall({
    sessionId: input.sessionId,
    sourceUserSeq: input.currentSourceUserSeq,
    callSeq: input.currentCallSeq,
    expectedEffectiveTool: input.expectedEffectiveTool,
  });
  const priorAccountSelector = evidence ? explicitReadAccountSelector(evidence.toolArgs) : null;
  const currentAccountSelector = currentCall
    ? explicitReadAccountSelector(toolArgs(currentCall))
    : null;
  const accountRouteMatches = priorAccountSelector !== null
    && priorAccountSelector === currentAccountSelector
    && (authorized.accountIdentity === ''
      ? priorAccountSelector === 'none' && input.expectedEffectiveTool.startsWith('PROOF_')
      : priorAccountSelector.startsWith('id:'));
  if (!evidence
    || evidence.lineage.receipt.attemptId !== learningAttemptId
    || !currentCall
    || !accountRouteMatches
    || newerOrOverlappingPhysicalReadExists({
    scope: { principal },
    beforeSeq: input.currentCallSeq,
    expectedEffectiveTool: input.expectedEffectiveTool,
    candidateCall: evidence.call,
    candidateReturn: evidence.returned,
  })) return null;
  const { call: _call, returned: _returned, ...trusted } = evidence;
  return trusted;
}

/**
 * Recover the newest prior verified-read bytes that still represent the last
 * physical observation of one effective tool before the current accepted
 * source. This does not parse, summarize, or otherwise reinterpret the output.
 */
export function resolveLatestTrustedPriorVerifiedRead(
  input: ResolveLatestTrustedPriorVerifiedReadInput,
): TrustedPriorVerifiedReadEvidence | null {
  try {
    const sessionId = boundedIdentifier(input.sessionId);
    const expectedEffectiveTool = boundedIdentifier(input.expectedEffectiveTool);
    if (!sessionId
      || !expectedEffectiveTool
      || !Number.isSafeInteger(input.currentSourceUserSeq)
      || input.currentSourceUserSeq <= 0) return null;
    const db = openEventLog();
    if (!acceptedSourceExists(sessionId, input.currentSourceUserSeq)) return null;

    const terminalRows = db.prepare(`
      SELECT seq, id, session_id, turn, role, type, parent_event_id, data_json, created_at
        FROM events
       WHERE session_id = ?
         AND seq < ?
         AND type = 'conversation_completed'
         AND json_type(data_json, '$.verifiedReadCompletionReceipt') = 'object'
         AND json_extract(data_json, '$.verifiedReadCompletionReceipt.toolName') = ?
       ORDER BY seq DESC
       LIMIT ?
    `).all(
      sessionId,
      input.currentSourceUserSeq,
      expectedEffectiveTool,
      MAX_PRIOR_RECEIPT_TERMINALS + 1,
    ) as RawEventRow[];
    for (const row of terminalRows.slice(0, MAX_PRIOR_RECEIPT_TERMINALS)) {
      const terminal = decodeEvent(row);
      if (!terminal) continue;
      const evidence = trustedEvidenceForTerminal({
        sessionId,
        terminal,
        expectedEffectiveTool,
      });
      if (!evidence || newerOrOverlappingPhysicalReadExists({
        scope: { sessionId },
        beforeSeq: input.currentSourceUserSeq,
        expectedEffectiveTool,
        candidateCall: evidence.call,
        candidateReturn: evidence.returned,
      })) continue;
      const { call: _call, returned: _returned, ...trusted } = evidence;
      return trusted;
    }
    if (!Number.isSafeInteger(input.currentCallSeq)
      || Number(input.currentCallSeq) <= input.currentSourceUserSeq) return null;
    return resolveAuthorizedCrossSessionPrior({
      sessionId,
      currentSourceUserSeq: input.currentSourceUserSeq,
      currentCallSeq: Number(input.currentCallSeq),
      expectedEffectiveTool,
    });
  } catch {
    return null;
  }
}
