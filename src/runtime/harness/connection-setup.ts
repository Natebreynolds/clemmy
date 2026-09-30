/** Connection setup belongs to the parked task, never to a global "connected"
 * flag. Only the server-returned account is eligible for automatic continuation.
 * This record contains no credentials, authorization URLs, or tool outputs. */
import { createHash } from 'node:crypto';
import { getHarnessChatCancellation, getHarnessChatRequestReceipt, openEventLog } from './eventlog.js';
import { currentConnectionDependency } from './dependency-request.js';
import { revalidateSelectedComposioConnections } from '../../integrations/composio/client.js';
import { parseTaskMode, type TaskMode } from './task-mode.js';

export interface ConnectionSetupContext {
  connectionRequestId: string;
  sessionId: string;
}

/** Server-only verification snapshot; never accepted from a chat payload. */
export interface ConnectionContinuationVerification { sourceUserSeq: number; binding: string }

function setupBinding(requestId: string, account: { connection_id: string; updated_at: string }): string {
  return createHash('sha256').update(JSON.stringify([requestId, account.connection_id, account.updated_at])).digest('hex');
}

export function connectionContinuationTaskMode(context: ConnectionSetupContext): TaskMode | undefined {
  const row = openEventLog().prepare(`SELECT e.data_json FROM dependency_requests d JOIN events e
    ON e.session_id = d.session_id AND e.seq = d.source_user_seq
    WHERE d.request_id = ? AND d.session_id = ? AND e.type = 'user_input_received'`
  ).get(context.connectionRequestId, context.sessionId) as { data_json: string } | undefined;
  if (!row) throw new Error('The original task is unavailable.');
  return parseTaskMode((JSON.parse(row.data_json) as { taskMode?: unknown }).taskMode);
}

/** A paired phone is another control surface for this owner's paused task.
 * Preserve the accepted audience only after the durable setup receipt proves
 * this exact continuation; never relax audience checks for ordinary chat. */
export function connectionContinuationAudience(context: ConnectionSetupContext, runId: string, text: string): {
  userId?: string; conversationKey?: string;
} {
  const clientId = `connection-${createHash('sha256').update(context.connectionRequestId).digest('hex').slice(0, 32)}`;
  const identity = connectionContinuationIdentity(context, text, clientId);
  const receipt = getHarnessChatRequestReceipt(identity.requestId);
  if (!receipt || receipt.sessionId !== context.sessionId || receipt.runId !== runId || receipt.inputHash !== identity.inputHash) {
    throw new Error('The connection continuation has no matching accepted receipt.');
  }
  const row = openEventLog().prepare(`SELECT e.data_json FROM dependency_requests d JOIN events e
    ON e.session_id = d.session_id AND e.seq = d.source_user_seq
    WHERE d.request_id = ? AND d.session_id = ? AND e.type = 'user_input_received'`
  ).get(context.connectionRequestId, context.sessionId) as { data_json: string } | undefined;
  if (!row) throw new Error('The original connection request is unavailable.');
  const source = JSON.parse(row.data_json) as Record<string, unknown>;
  return {
    ...(typeof source.userId === 'string' ? { userId: source.userId } : {}),
    ...(typeof source.conversationKey === 'string' ? { conversationKey: source.conversationKey } : {}),
  };
}

const EXECUTION_CONTINUATION_BLOCKER = 'This reviewed execution is still paused; it has not been restarted.';

/** The same task continuation has one durable receipt across desktop and
 * paired phones. Ordinary mobile chat retains its device-scoped identity. */
export function connectionContinuationIdentity(context: ConnectionSetupContext, text: string, clientRequestId: string) {
  const expected = `connection-${createHash('sha256').update(context.connectionRequestId).digest('hex').slice(0, 32)}`;
  if (!context.sessionId || !context.connectionRequestId || clientRequestId !== expected) {
    throw new Error('This connection continuation does not match the original task.');
  }
  return { requestId: expected, inputHash: createHash('sha256')
    .update(JSON.stringify({ connectionRequestId: context.connectionRequestId, sessionId: context.sessionId, text }))
    .digest('hex') };
}

/** Recheck synchronously immediately before the existing durable chat claim.
 * A new user turn or Stop while account verification awaited retires setup. */
export function assertConnectionContinuationCurrent(context: ConnectionSetupContext, sourceUserSeq: number, binding: string): void {
  const current = readConnectionSetup(context.sessionId, context.connectionRequestId);
  if (!current || current.sourceUserSeq !== sourceUserSeq) throw new Error('This task changed while connecting. Return to the current conversation.');
  ensureSetupTable();
  const account = openEventLog().prepare('SELECT connection_id, updated_at FROM connection_setup_attempts WHERE request_id = ? AND session_id = ?')
    .get(context.connectionRequestId, context.sessionId) as { connection_id: string; updated_at: string } | undefined;
  if (!account || setupBinding(context.connectionRequestId, account) !== binding) {
    throw new Error('The account changed while connecting. Check the connection again.');
  }
}

export function withConnectionContinuationAdmission<T>(context: ConnectionSetupContext,
  verified: ConnectionContinuationVerification | undefined, claim: () => T): T {
  if (!verified) throw new Error('This continuation needs a fresh connection check.');
  return openEventLog().transaction(() => {
    assertConnectionContinuationCurrent(context, verified.sourceUserSeq, verified.binding);
    return claim();
  }).immediate();
}

/** Mobile ordinarily stops only its device-derived key. The one exception is
 * a host-issued shared setup continuation proven to belong to this session,
 * including the pre-ack window before its durable chat receipt exists. */
export function connectionContinuationCancellationId(sessionId: string, clientRequestId: string): string | null {
  if (!/^connection-[a-f0-9]{32}$/.test(clientRequestId)) return null;
  const receipt = getHarnessChatRequestReceipt(clientRequestId);
  if (receipt) return receipt.sessionId === sessionId ? clientRequestId : null;
  const setup = readConnectionSetup(sessionId);
  return setup?.awaitingSignIn && setup.clientRequestId === clientRequestId ? clientRequestId : null;
}

function ensureSetupTable(): void {
  openEventLog().exec(`CREATE TABLE IF NOT EXISTS connection_setup_attempts (
    request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    connection_id TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
}

export function readConnectionSetup(sessionId: string, requestId?: string) {
  const dependency = currentConnectionDependency(sessionId, requestId);
  if (!dependency) return null;
  const clientRequestId = `connection-${createHash('sha256').update(dependency.requestId).digest('hex').slice(0, 32)}`;
  if (getHarnessChatCancellation(clientRequestId)) return null;
  ensureSetupTable();
  const attempt = openEventLog().prepare(`SELECT connection_id FROM connection_setup_attempts
    WHERE request_id = ? AND session_id = ?`).get(dependency.requestId, sessionId) as { connection_id: string } | undefined;
  return {
    ...dependency,
    ...(connectionContinuationTaskMode({ sessionId, connectionRequestId: dependency.requestId })?.kind === 'execute'
      ? { continuationBlocker: EXECUTION_CONTINUATION_BLOCKER } : {}),
    awaitingSignIn: Boolean(attempt),
    // Reopening the same setup card cannot create a second chat continuation.
    clientRequestId,
  };
}

export function requireConnectionSetupContext(body: unknown, toolkit: string): ConnectionSetupContext | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const input = body as Record<string, unknown>;
  if (input.connectionRequestId === undefined) return undefined;
  if (typeof input.connectionRequestId !== 'string' || typeof input.sessionId !== 'string') {
    throw new Error('This connection request is incomplete. Return to the conversation and try again.');
  }
  const dependency = currentConnectionDependency(input.sessionId, input.connectionRequestId);
  if (!dependency || dependency.toolkit !== toolkit) {
    throw new Error('This connection no longer belongs to the current task. Return to the conversation.');
  }
  return { connectionRequestId: dependency.requestId, sessionId: dependency.sessionId };
}

/** Call only with an account id returned by the connection provider, never
 * with a connection id supplied by the browser. */
export function recordConnectionSetupResult(context: ConnectionSetupContext | undefined, result: unknown): void {
  if (!context || !result || typeof result !== 'object') return;
  const connectionId = (result as { connectionId?: unknown }).connectionId;
  if (typeof connectionId !== 'string' || !connectionId.trim()) return;
  if (!currentConnectionDependency(context.sessionId, context.connectionRequestId)) return;
  ensureSetupTable();
  openEventLog().prepare(`INSERT INTO connection_setup_attempts (request_id, session_id, connection_id, updated_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(request_id) DO UPDATE SET connection_id = excluded.connection_id,
    updated_at = excluded.updated_at WHERE session_id = excluded.session_id`
  ).run(context.connectionRequestId, context.sessionId, connectionId.trim(), new Date().toISOString());
}

export async function verifyConnectionSetup(
  context: ConnectionSetupContext,
  verify = revalidateSelectedComposioConnections,
) {
  const request = readConnectionSetup(context.sessionId, context.connectionRequestId);
  if (!request) return { request: null, ready: false };
  const attempt = openEventLog().prepare(`SELECT connection_id, updated_at FROM connection_setup_attempts
    WHERE request_id = ? AND session_id = ?`).get(request.requestId, request.sessionId) as { connection_id: string; updated_at: string } | undefined;
  if (!attempt) return { request, ready: false };
  // This verifier refreshes the provider snapshot without last-good fallback.
  // A stale account list or a different connected mailbox cannot resume work.
  const result = await verify([{ identifier: request.capability, connectionId: attempt.connection_id }]);
  const current = readConnectionSetup(context.sessionId, context.connectionRequestId);
  const stillBound = openEventLog().prepare(`SELECT connection_id, updated_at FROM connection_setup_attempts
    WHERE request_id = ? AND session_id = ?`).get(request.requestId, request.sessionId) as { connection_id: string; updated_at: string } | undefined;
  const verificationBinding = setupBinding(request.requestId, attempt);
  const connectionVerified = Boolean(result.ok && current && stillBound && setupBinding(request.requestId, stillBound) === verificationBinding);
  return { request: current, ready: Boolean(connectionVerified && current && !current.continuationBlocker),
    ...(connectionVerified ? { connectionVerified: true as const, verificationBinding } : {}) };
  // Do NOT satisfy dependency_requests here. The existing continuation spine
  // must still discover and attest the exact account-bound callable capability.
}
