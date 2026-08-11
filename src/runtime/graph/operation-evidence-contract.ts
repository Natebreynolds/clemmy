/**
 * Evidence semantics for one host-observed operation.
 *
 * Effect class alone is too coarse to decide what proof is meaningful. A
 * point lookup cannot be "read to exhaustion", an append must not be judged as
 * though it replaced the destination, and creating a fresh object has no stale
 * destination to reconcile. This classifier uses only the canonical operation
 * name and the already-derived effect/reversibility. It is provider-neutral:
 * no server, toolkit, or tool slug is privileged.
 */

export type OperationEvidenceMode =
  | 'point_read'
  | 'collection_read'
  /** Exact finite accepted-input set; proves requested members, not provider
   * source exhaustion. Issued only by pre-dispatch schema refinement. */
  | 'finite_read'
  | 'compute'
  | 'create'
  | 'append'
  | 'update'
  | 'replace'
  | 'delete'
  | 'send'
  | 'unknown_write'
  | 'none';

export interface OperationEvidenceContract {
  mode: OperationEvidenceMode;
  /** Whether a provider cursor is semantically meaningful for this read. */
  requiresExhaustion: boolean;
  /** Whether content that predates this task could survive the operation. */
  requiresStaleReconciliation: boolean;
}

function tokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

function includesAny(haystack: readonly string[], needles: ReadonlySet<string>): boolean {
  return haystack.some((token) => needles.has(token));
}

const POINT_TOKENS = new Set([
  'BYID', 'DETAIL', 'DETAILS', 'DESCRIBE', 'INSPECT', 'LOOKUP', 'PEEK',
]);
const COLLECTION_TOKENS = new Set([
  'ALL', 'BROWSE', 'ENUMERATE', 'FEED', 'HISTORY', 'LIST', 'QUERY',
  'SCAN', 'SEARCH', 'TIMELINE',
]);
const SEND_TOKENS = new Set([
  'BROADCAST', 'CALL', 'DIAL', 'DISPATCH', 'DM', 'EMAIL', 'FORWARD',
  'INVITE', 'NOTIFY', 'POST', 'PUBLISH', 'REPLY', 'SEND', 'SMS', 'TWEET',
]);
const DELETE_TOKENS = new Set([
  'ARCHIVE', 'DELETE', 'DESTROY', 'REMOVE', 'TRASH', 'UNREGISTER',
]);
const REPLACE_TOKENS = new Set([
  'IMPORT', 'OVERWRITE', 'REPLACE', 'REWRITE', 'SYNC', 'SYNCHRONIZE',
  'TRUNCATE',
]);
const APPEND_TOKENS = new Set(['APPEND', 'PREPEND']);
const CREATE_TOKENS = new Set([
  'ADD', 'COPY', 'CREATE', 'DUPLICATE', 'INSERT', 'NEW', 'REGISTER', 'UPLOAD',
]);
const UPDATE_TOKENS = new Set([
  'EDIT', 'MODIFY', 'MOVE', 'PATCH', 'RENAME', 'SAVE', 'SET', 'UPDATE',
]);

function pointIdentityIsExplicit(parts: readonly string[]): boolean {
  for (let index = 0; index < parts.length; index += 1) {
    if (POINT_TOKENS.has(parts[index] ?? '')) return true;
    if (
      (parts[index] === 'BY' && parts[index + 1] === 'ID')
      || (parts[index] === 'GET' && parts[index + 1] === 'ONE')
      || (parts[index] === 'FIND' && parts[index + 1] === 'ONE')
    ) return true;
  }
  return false;
}

export function operationEvidenceContract(input: {
  resolvedTool: string;
  effectKind: string;
  reversibility: string;
}): OperationEvidenceContract {
  const parts = tokens(input.resolvedTool);

  if (input.effectKind === 'read') {
    // Default an unfamiliar read to collection semantics. Failing closed here
    // may ask the host to establish that no continuation remains; defaulting
    // to point semantics could silently bless page one of an unknown API.
    const point = pointIdentityIsExplicit(parts) && !includesAny(parts, COLLECTION_TOKENS);
    return {
      mode: point ? 'point_read' : 'collection_read',
      requiresExhaustion: !point,
      requiresStaleReconciliation: false,
    };
  }
  if (input.effectKind === 'compute') {
    return { mode: 'compute', requiresExhaustion: false, requiresStaleReconciliation: false };
  }
  if (input.effectKind === 'none') {
    return { mode: 'none', requiresExhaustion: false, requiresStaleReconciliation: false };
  }

  const irreversible = input.reversibility === 'irreversible';
  if (irreversible || includesAny(parts, SEND_TOKENS)) {
    return { mode: 'send', requiresExhaustion: false, requiresStaleReconciliation: false };
  }
  if (includesAny(parts, DELETE_TOKENS)) {
    return { mode: 'delete', requiresExhaustion: false, requiresStaleReconciliation: false };
  }
  if (includesAny(parts, REPLACE_TOKENS)) {
    return { mode: 'replace', requiresExhaustion: false, requiresStaleReconciliation: true };
  }
  if (includesAny(parts, APPEND_TOKENS)) {
    return { mode: 'append', requiresExhaustion: false, requiresStaleReconciliation: false };
  }
  if (includesAny(parts, CREATE_TOKENS)) {
    return { mode: 'create', requiresExhaustion: false, requiresStaleReconciliation: false };
  }
  if (includesAny(parts, UPDATE_TOKENS)) {
    return { mode: 'update', requiresExhaustion: false, requiresStaleReconciliation: false };
  }
  return { mode: 'unknown_write', requiresExhaustion: false, requiresStaleReconciliation: false };
}
