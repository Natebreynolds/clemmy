/** Process-local exact approved SDK call context. Deliberately has no runtime
 * eventlog, tools, provider or client imports. Copyable IDs are evidence only. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DispatchLeaseRef } from './dispatch-lease.js';

export const APPROVED_COMPOSIO_DISPATCH_PROTOCOL = 'approved_composio_sdk_v1' as const;
export interface ApprovedComposioPreparation {
  readonly __approvedComposioPreparation: unique symbol;
}
export interface ApprovedComposioDispatchPermit {
  readonly __approvedComposioDispatchPermit: unique symbol;
}
export interface ApprovedComposioPreparationIdentity {
  protocol: typeof APPROVED_COMPOSIO_DISPATCH_PROTOCOL;
  intentId: string;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  attemptId: string;
  toolName: string;
  rawArgumentDigest: string;
  /** Exact existing SDK carrier-normalizer projection, logical preparation only. */
  preparationArgumentDigest: string;
  effect: 'external_write' | 'admin';
  connectedAccountId: string;
  lease: Readonly<DispatchLeaseRef>;
}
export interface ApprovedComposioResolvedIdentity {
  providerOperationId: string;
  providerOperationVersion: string;
  providerArgumentDigest: string;
  providerInputSchemaDigest: string;
  schemaFingerprint: string;
  connectedAccountId: string;
  accountIdentityDigest: string;
  providerOwnerIdentityDigest: string;
  effectiveArgumentDigest: string;
  refinementEventId: string | null;
  invokePortId: 'composio_sdk_v3_execute';
}
export interface ApprovedComposioPermitIdentity extends ApprovedComposioPreparationIdentity,
  ApprovedComposioResolvedIdentity {
  physicalDispatchId: string;
}

// Only validated runtime issuers register these opaque handles. Neither an
// object copied from a tool result nor a literal/callback is a registered owner.
const preparations = new WeakMap<object, Readonly<ApprovedComposioPreparationIdentity>>();
const permits = new WeakMap<object, Readonly<ApprovedComposioPermitIdentity>>();
const active = new AsyncLocalStorage<ApprovedComposioPreparation>();
export function registerApprovedComposioPreparation(
  identity: ApprovedComposioPreparationIdentity,
): ApprovedComposioPreparation {
  const handle = Object.freeze(Object.create(null)) as ApprovedComposioPreparation;
  preparations.set(handle, Object.freeze({ ...identity, lease: Object.freeze({ ...identity.lease }) }));
  return handle;
}
export function withApprovedComposioPreparation<T>(handle: ApprovedComposioPreparation, work: () => T): T {
  if (!preparations.has(handle as object)) throw new Error('Exact approved SDK preparation is not registered.');
  return active.run(handle, work);
}
export function currentApprovedComposioPreparation(): Readonly<ApprovedComposioPreparationIdentity> | null {
  const handle = active.getStore();
  return handle ? preparations.get(handle as object) ?? null : null;
}
export function registerApprovedComposioDispatchPermit(
  preparation: Readonly<ApprovedComposioPreparationIdentity>,
  resolved: ApprovedComposioResolvedIdentity,
  physicalDispatchId: string,
  lease: Readonly<DispatchLeaseRef>,
): ApprovedComposioDispatchPermit {
  const current = currentApprovedComposioPreparation();
  if (!current || current !== preparation || resolved.connectedAccountId !== preparation.connectedAccountId
    || lease.sessionId !== preparation.sessionId || lease.runAttemptId !== preparation.attemptId
    || lease.sourceUserSeq !== preparation.sourceUserSeq || lease.acceptedTaskId !== preparation.acceptedTaskId
    || lease.logicalToolCallId !== preparation.logicalToolCallId
    || (lease.scopeId === preparation.lease.scopeId
      ? lease.leaseId !== preparation.lease.leaseId
      : lease.parentScopeId !== preparation.lease.scopeId || lease.parentLeaseId !== preparation.lease.leaseId))
    throw new Error('Exact approved SDK preparation scope/account/generation changed.');
  const permit = Object.freeze(Object.create(null)) as ApprovedComposioDispatchPermit;
  permits.set(permit, Object.freeze({ ...preparation,
    providerOperationId:resolved.providerOperationId,providerOperationVersion:resolved.providerOperationVersion,
    providerArgumentDigest:resolved.providerArgumentDigest,providerInputSchemaDigest:resolved.providerInputSchemaDigest,
    schemaFingerprint:resolved.schemaFingerprint,connectedAccountId:resolved.connectedAccountId,
    accountIdentityDigest:resolved.accountIdentityDigest,providerOwnerIdentityDigest:resolved.providerOwnerIdentityDigest,
    effectiveArgumentDigest:resolved.effectiveArgumentDigest,refinementEventId:resolved.refinementEventId,invokePortId:resolved.invokePortId,
    physicalDispatchId,lease:Object.freeze({...lease}) }));
  return permit;
}
export function inspectApprovedComposioDispatchPermit(
  permit: ApprovedComposioDispatchPermit | undefined,
): Readonly<ApprovedComposioPermitIdentity> | null {
  return permit ? permits.get(permit as object) ?? null : null;
}
export function consumeApprovedComposioDispatchPermit(permit: ApprovedComposioDispatchPermit): void {
  if (!permits.delete(permit as object)) throw new Error('Exact approved SDK dispatch permit was already consumed.');
}
