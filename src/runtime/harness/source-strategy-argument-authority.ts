/**
 * Opaque, call-bound authority for the exact provider-ready arguments of a
 * current material-source crossing.
 *
 * The durable source-strategy binding intentionally proves only provider,
 * account and schema identity. Provider arguments are authorized separately:
 * the call lease reopens the raw accepted bytes, while the logical-call row
 * freezes the current provider-ready digest after the host's one permitted
 * refinement. A token is useful only while both of those durable owners still
 * name the same open call and the exact lease generation remains current.
 */
import { openCanonicalArguments } from './authority-argument-seal.js';
import {
  currentDispatchLease,
  isDispatchLeaseCurrent,
  type DispatchLeaseRef,
} from './dispatch-lease.js';
import { openEventLog } from './eventlog.js';
import {
  durableLogicalCallContract,
  durableLogicalCallRecoveryMaterial,
} from './logical-call-contract.js';

const CURRENT_REQUEST_SOURCE_ARGUMENT_AUTHORITY = Symbol(
  'clem.currentRequestSourceArgumentAuthority',
);
const issuedAuthorities = new WeakSet<object>();

/** Runtime opacity is supplied by the module-private WeakSet. The symbol also
 * keeps ordinary TypeScript callers from constructing a structural lookalike. */
export interface CurrentRequestSourceArgumentAuthorityV1 {
  readonly version: 1;
  readonly acceptedSource: Readonly<{
    sessionId: string;
    sourceUserSeq: number;
  }>;
  readonly acceptedTaskId: string;
  readonly logicalToolCallId: string;
  readonly toolName: string;
  readonly argumentDigest: string;
  readonly lease: Readonly<{
    scopeId: string;
    leaseId: string;
  }>;
  readonly [CURRENT_REQUEST_SOURCE_ARGUMENT_AUTHORITY]: true;
}

export interface CurrentRequestSourceArgumentAuthorityInput {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  tool: string;
  args?: unknown;
  lease: DispatchLeaseRef;
}

interface CurrentCallContractRow {
  lease_session_id: string;
  lease_source_user_seq: number | null;
  lease_accepted_task_id: string | null;
  lease_logical_tool_call_id: string | null;
  revoked_at: string | null;
  recovery_tool_name: string | null;
  recovery_argument_digest: string | null;
  recovery_argument_cipher: string | null;
  call_accepted_task_id: string;
  tool_name: string;
  argument_digest: string;
  raw_argument_digest: string;
  effective_argument_digest: string | null;
  state: string;
}

function sameLease(left: DispatchLeaseRef | undefined, right: DispatchLeaseRef): boolean {
  return Boolean(left)
    && left!.sessionId === right.sessionId
    && left!.scopeId === right.scopeId
    && left!.leaseId === right.leaseId
    && left!.sourceUserSeq === right.sourceUserSeq
    && left!.acceptedTaskId === right.acceptedTaskId
    && left!.logicalToolCallId === right.logicalToolCallId;
}

function exactCurrentContract(
  input: CurrentRequestSourceArgumentAuthorityInput,
): { toolName: string; argumentDigest: string } | null {
  const lease = input.lease;
  if (
    !input.sessionId.trim()
    || !Number.isSafeInteger(input.sourceUserSeq)
    || input.sourceUserSeq <= 0
    || !input.acceptedTaskId.trim()
    || !input.logicalToolCallId.trim()
    || lease.sessionId !== input.sessionId
    || lease.sourceUserSeq !== input.sourceUserSeq
    || lease.acceptedTaskId !== input.acceptedTaskId
    || lease.logicalToolCallId !== input.logicalToolCallId
    || !sameLease(currentDispatchLease(), lease)
    || !isDispatchLeaseCurrent(lease)
  ) return null;

  const row = openEventLog().prepare(`
    SELECT lease.session_id AS lease_session_id,
           lease.source_user_seq AS lease_source_user_seq,
           lease.accepted_task_id AS lease_accepted_task_id,
           lease.logical_tool_call_id AS lease_logical_tool_call_id,
           lease.revoked_at,
           lease.recovery_tool_name,
           lease.recovery_argument_digest,
           lease.recovery_argument_cipher,
           call.accepted_task_id AS call_accepted_task_id,
           call.tool_name,
           call.argument_digest,
           call.raw_argument_digest,
           call.effective_argument_digest,
           call.state
      FROM run_dispatch_leases AS lease
      JOIN logical_tool_calls AS call
        ON call.session_id = lease.session_id
       AND call.source_user_seq = lease.source_user_seq
       AND call.logical_tool_call_id = lease.logical_tool_call_id
     WHERE lease.session_id = ?
       AND lease.scope_id = ?
       AND lease.lease_id = ?
       AND lease.source_user_seq = ?
       AND lease.accepted_task_id = ?
       AND lease.logical_tool_call_id = ?
  `).get(
    lease.sessionId,
    lease.scopeId,
    lease.leaseId,
    input.sourceUserSeq,
    input.acceptedTaskId,
    input.logicalToolCallId,
  ) as CurrentCallContractRow | undefined;
  if (
    !row
    || row.lease_session_id !== input.sessionId
    || row.lease_source_user_seq !== input.sourceUserSeq
    || row.lease_accepted_task_id !== input.acceptedTaskId
    || row.lease_logical_tool_call_id !== input.logicalToolCallId
    || row.call_accepted_task_id !== input.acceptedTaskId
    || row.revoked_at !== null
    || row.state !== 'open'
    || !row.recovery_tool_name
    || !row.recovery_argument_digest
    || !row.recovery_argument_cipher
  ) return null;

  const opened = openCanonicalArguments(row.recovery_argument_cipher);
  const rawArgs = opened?.args;
  if (
    !opened
    || Reflect.ownKeys(opened).length !== 1
    || !rawArgs
    || typeof rawArgs !== 'object'
    || Array.isArray(rawArgs)
  ) return null;
  const recovery = durableLogicalCallRecoveryMaterial(
    input.acceptedTaskId,
    row.recovery_tool_name,
    rawArgs,
  );
  if (
    !recovery
    || recovery.toolName !== row.recovery_tool_name
    || recovery.argumentDigest !== row.recovery_argument_digest
    || row.raw_argument_digest !== row.recovery_argument_digest
    || (row.effective_argument_digest === null
      ? row.argument_digest !== row.raw_argument_digest
      : row.argument_digest !== row.effective_argument_digest)
  ) return null;

  const providerReady = durableLogicalCallContract(
    input.acceptedTaskId,
    input.tool,
    input.args,
  );
  if (
    !providerReady
    || providerReady.toolName !== row.tool_name
    || providerReady.argumentDigest !== row.argument_digest
  ) return null;
  return providerReady;
}

/** Mint only at the live call edge, after trusted provider resolution and
 * before any physical row or provider I/O exists. */
export function mintCurrentRequestSourceArgumentAuthority(
  input: CurrentRequestSourceArgumentAuthorityInput,
): CurrentRequestSourceArgumentAuthorityV1 | null {
  try {
    const contract = exactCurrentContract(input);
    if (!contract) return null;
    const authority = Object.freeze({
      version: 1 as const,
      acceptedSource: Object.freeze({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
      }),
      acceptedTaskId: input.acceptedTaskId,
      logicalToolCallId: input.logicalToolCallId,
      toolName: contract.toolName,
      argumentDigest: contract.argumentDigest,
      lease: Object.freeze({
        scopeId: input.lease.scopeId,
        leaseId: input.lease.leaseId,
      }),
      [CURRENT_REQUEST_SOURCE_ARGUMENT_AUTHORITY]: true as const,
    });
    issuedAuthorities.add(authority);
    return authority;
  } catch {
    return null;
  }
}

/** Revalidate the opaque token and every durable owner immediately before the
 * physical reservation. A JSON/structural copy, widened args, another task or
 * call, and a stale/revoked lease all fail closed. */
export function currentRequestSourceArgumentAuthorityMatches(input: {
  authority: unknown;
} & CurrentRequestSourceArgumentAuthorityInput): boolean {
  try {
    if (
      !input.authority
      || typeof input.authority !== 'object'
      || !issuedAuthorities.has(input.authority)
    ) return false;
    const authority = input.authority as CurrentRequestSourceArgumentAuthorityV1;
    if (
      authority.version !== 1
      || authority.acceptedSource.sessionId !== input.sessionId
      || authority.acceptedSource.sourceUserSeq !== input.sourceUserSeq
      || authority.acceptedTaskId !== input.acceptedTaskId
      || authority.logicalToolCallId !== input.logicalToolCallId
      || authority.lease.scopeId !== input.lease.scopeId
      || authority.lease.leaseId !== input.lease.leaseId
    ) return false;
    const contract = exactCurrentContract(input);
    return Boolean(contract)
      && authority.toolName === contract!.toolName
      && authority.argumentDigest === contract!.argumentDigest;
  } catch {
    return false;
  }
}
