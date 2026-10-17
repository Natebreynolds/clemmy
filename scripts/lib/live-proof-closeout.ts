import type { AcceptedTaskMeasurement } from '../session-comparison.js';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

type ProofFailureReason = 'request_transport_unavailable' | 'response_json_unavailable'
  | 'response_object_required' | 'chat_not_accepted' | 'proof_evidence_unavailable';
export class ProofRunnerFailure extends Error {
  constructor(readonly reason: ProofFailureReason) { super(reason); this.name = 'ProofRunnerFailure'; }
}
/** Unknown exceptions may contain response bytes, query strings or credentials. */
export function proofFailureReason(error: unknown): ProofFailureReason {
  return error instanceof ProofRunnerFailure ? error.reason : 'proof_evidence_unavailable';
}
export async function proofTransport<T>(request: () => Promise<T>): Promise<T> {
  try { return await request(); } catch { throw new ProofRunnerFailure('request_transport_unavailable'); }
}
export async function proofResponseObject(decode: () => Promise<unknown>): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await decode(); } catch { throw new ProofRunnerFailure('response_json_unavailable'); }
  if (!object(value)) throw new ProofRunnerFailure('response_object_required');
  return value;
}

/** A route label is sufficient for timing; never retain query/capability bytes. */
export function proofRequestOperation(route: string): string {
  if (route === '/api/console/build-info') return 'build_info';
  if (route === '/api/harness/chat') return 'desktop_chat';
  if (route === '/m/api/chat/send') return 'mobile_chat';
  if (/^\/api\/console\/harness-sessions\/[^/?#]+\/cancel\?/.test(route)) return 'desktop_exact_cancel';
  if (/^\/m\/api\/chat\/sessions\/[^/?#]+\/cancel$/.test(route)) return 'mobile_request_cancel';
  return 'other_application_request';
}

const identity = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 512 && !/[\u0000-\u0020\u007f/?#\\]/.test(value);

/** Error responses are not acceptance records. Project known identities only
 * after the exact success shape has been checked; omit server URLs/prose. */
export function proofAcceptanceMetadata(input: {
  status: number; body: unknown; clientRequestId: string; mobile: boolean;
}): { sessionId: string; runId: string; clientRequestId?: string; accepted?: true;
  attemptId?: string; runScopeId?: string; replayed?: boolean } | null {
  const value = input.body;
  if (input.status !== 202 || !object(value) || !identity(value.sessionId) || !identity(value.runId)
    || (input.mobile ? value.accepted !== true : value.clientRequestId !== input.clientRequestId)) return null;
  const runScopeId = `${value.sessionId}::brain:${value.runId}`;
  return { sessionId: value.sessionId, runId: value.runId,
    ...(input.mobile ? { accepted: true as const } : { clientRequestId: input.clientRequestId }),
    ...(identity(value.attemptId) ? { attemptId: value.attemptId } : {}),
    ...(value.runScopeId === runScopeId ? { runScopeId } : {}),
    ...(typeof value.replayed === 'boolean' ? { replayed: value.replayed } : {}) };
}

/** Selected-home inputs only. No environment/global home or credential I/O.
 * Match the daemon's first-party vault override without logging parse bytes. */
export function parseProofHomeAuth(input: { envText?: string; vaultText?: string }): { port: number; secret: string } {
  const env: Record<string, string> = Object.create(null);
  for (const raw of (input.envText ?? '').split('\n')) {
    const line = raw.replace(/^\s+|\r+$/g, '');
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals < 0) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[key] = value;
  }
  let fromVault: string | undefined;
  if (input.vaultText !== undefined) {
    try {
      const vault: unknown = JSON.parse(input.vaultText);
      if (!object(vault) || vault.version !== 'v1' || !object(vault.entries)
        || (Object.hasOwn(vault.entries, 'webhook_secret') && typeof vault.entries.webhook_secret !== 'string')) throw new Error();
      fromVault = Object.hasOwn(vault.entries, 'webhook_secret') ? vault.entries.webhook_secret as string : undefined;
    } catch { throw new Error('The selected home’s webhook vault is unreadable or malformed; no request submitted.'); }
  }
  const secret = fromVault || env.WEBHOOK_SECRET;
  if (!secret || /[\r\n\u0000]/.test(secret)) throw new Error('The selected home has no usable webhook credential; no request submitted.');
  const portText = env.WEBHOOK_PORT || '8420';
  if (!/^[0-9]{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    throw new Error('The selected home has an invalid loopback webhook port; no request submitted.');
  }
  return { port: Number(portText), secret };
}

/** Credentials are sent only to one literal loopback origin. In particular a
 * server-supplied cancel endpoint cannot select another origin or redirect. */
export function proofLoopbackRequestUrl(base: string, route: string): string {
  try {
    const origin = new URL(base);
    if (!['http:', 'https:'].includes(origin.protocol)
      || !['127.0.0.1', '[::1]'].includes(origin.hostname)
      || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
      || !route.startsWith('/') || route.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(route)) throw new Error();
    const target = new URL(route, origin);
    if (target.origin !== origin.origin || target.username || target.password || target.hash) throw new Error();
    return target.href;
  } catch { throw new Error('Proof requests require the selected loopback origin and a relative application route.'); }
}

export interface ProofBuildIdentity {
  version: string;
  entry: string;
  packaged: boolean;
  gitSha: string;
  gitDirty: boolean;
  sourceFingerprint: string;
  schemaVersion: number;
  expectedSchemaVersion: number;
  daemonProcessId: number;
  daemonInstanceId: string;
  startedAt: string;
}
const identityKeys = ['version', 'entry', 'packaged', 'gitSha', 'gitDirty', 'sourceFingerprint',
  'schemaVersion', 'expectedSchemaVersion', 'daemonProcessId', 'daemonInstanceId', 'startedAt'] as const;

/** Pick the exact stable build/process identity, never an entire volatile or
 * server-authored response object. Missing fields make the window unqualified. */
export function proofBuildIdentity(value: unknown): ProofBuildIdentity {
  if (!object(value) || typeof value.version !== 'string' || !value.version || value.version === 'unknown'
    || typeof value.entry !== 'string' || !value.entry || typeof value.packaged !== 'boolean'
    || typeof value.gitSha !== 'string' || !/^[a-f0-9]{40}$/.test(value.gitSha) || typeof value.gitDirty !== 'boolean'
    || typeof value.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint)
    || !Number.isSafeInteger(value.schemaVersion) || Number(value.schemaVersion) <= 0
    || value.expectedSchemaVersion !== value.schemaVersion
    || !Number.isSafeInteger(value.daemonProcessId) || Number(value.daemonProcessId) <= 0
    || typeof value.daemonInstanceId !== 'string' || !value.daemonInstanceId || value.daemonInstanceId.length > 128
    || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))) {
    throw new Error('The authenticated daemon did not provide a complete ready build/process identity.');
  }
  return Object.fromEntries(identityKeys.map(key => [key, value[key]])) as unknown as ProofBuildIdentity;
}

export function sameProofBuildIdentity(left: ProofBuildIdentity, right: ProofBuildIdentity): boolean {
  return identityKeys.every(key => left[key] === right[key]);
}

export interface ProofAcceptedSource { seq: number; sessionId: string }
export interface ProofRequestReceipt { sessionId: string; runId: string }

/** A timed-out request can stop only its one exact durable active attempt.
 * The server's cancelEndpoint is deliberately not an input. */
export function proofDesktopCancellationTarget(input: {
  receipt: ProofRequestReceipt; source: ProofAcceptedSource;
  attempts: ReadonlyArray<{ attempt_id: unknown; session_id: unknown; run_id: unknown;
    source_user_seq: unknown; status: unknown; finished_at: unknown }>;
}): { route: string; attemptId: string; runScopeId: string } | null {
  if (!identity(input.receipt.sessionId) || !identity(input.receipt.runId)
    || input.source.sessionId !== input.receipt.sessionId || !Number.isSafeInteger(input.source.seq)
    || input.source.seq <= 0 || input.attempts.length !== 1) return null;
  const attempt = input.attempts[0]!;
  if (!identity(attempt.attempt_id) || attempt.session_id !== input.receipt.sessionId
    || attempt.run_id !== input.receipt.runId || attempt.source_user_seq !== input.source.seq
    || attempt.status !== 'active' || attempt.finished_at !== null) return null;
  const runScopeId = `${input.receipt.sessionId}::brain:${input.receipt.runId}`;
  return { attemptId: attempt.attempt_id, runScopeId,
    route: `/api/console/harness-sessions/${encodeURIComponent(input.receipt.sessionId)}/cancel?${new URLSearchParams({
      attemptId: attempt.attempt_id, runScopeId,
    }).toString()}` };
}

/** The request ID is generated by this runner before submission. Its exact
 * journal receipt may recover accounting after a lost HTTP response, never
 * execution authority or permission to dispatch again. */
export function proofAcceptedSource(input: {
  receipt: ProofRequestReceipt;
  returned?: ProofRequestReceipt;
  knownSourceUserSeq?: number;
  sources: ReadonlyArray<{ seq: number; session_id: string; role: string; data_json: string }>;
}): ProofAcceptedSource | null {
  if (!input.receipt.sessionId || !input.receipt.runId
    || (input.returned && (input.returned.sessionId !== input.receipt.sessionId || input.returned.runId !== input.receipt.runId))
    || input.sources.length > 1) throw new Error('The proof request has conflicting durable accepted-source identity.');
  const source = input.sources[0];
  if (!source) return null;
  let data: unknown;
  try { data = JSON.parse(source.data_json); } catch { throw new Error('The proof accepted source is malformed.'); }
  if (!Number.isSafeInteger(source.seq) || source.seq <= 0 || source.session_id !== input.receipt.sessionId
    || source.role !== 'user' || !object(data) || data.synthetic === true || data.runId !== input.receipt.runId
    || (input.knownSourceUserSeq !== undefined && source.seq !== input.knownSourceUserSeq)) {
    throw new Error('The proof request lost its exact accepted human source.');
  }
  return { seq: source.seq, sessionId: source.session_id };
}

export interface ProofTaskCloseout {
  status: 'recorded' | 'unavailable';
  qualification: 'unqualified';
  allLegUsageCertified: false;
  totals: 'recorded_lower_bound';
  providerPricedCost: 'not_measured';
  actualBilling: 'not_measured';
  measurement?: AcceptedTaskMeasurement;
  reason?: string;
}
export function unavailableProofTaskCloseout(reason = 'canonical_task_measurement_unavailable'): ProofTaskCloseout {
  return { status: 'unavailable', qualification: 'unqualified', allLegUsageCertified: false,
    totals: 'recorded_lower_bound', providerPricedCost: 'not_measured', actualBilling: 'not_measured', reason };
}

/** Recomputed at final closeout, including failed/unfinished tasks. Recorded
 * usage is retained without certifying unknown auxiliary legs or billing. */
export function captureProofTaskCloseout(source: ProofAcceptedSource,
  measure: () => AcceptedTaskMeasurement): ProofTaskCloseout {
  if (!source.sessionId || !Number.isSafeInteger(source.seq) || source.seq <= 0) {
    return unavailableProofTaskCloseout('canonical_task_identity_unavailable');
  }
  try {
    const measurement = measure();
    if (measurement.scope !== 'task' || measurement.sessionId !== source.sessionId
      || measurement.rootSourceUserSeq !== source.seq) return unavailableProofTaskCloseout('canonical_task_identity_mismatch');
    return { ...unavailableProofTaskCloseout(), status: 'recorded', reason: undefined, measurement };
  } catch { return unavailableProofTaskCloseout(); }
}
