/**
 * Opaque, immediate approval hand-off from the host-owned outer carrier to its
 * exact nested tool. The token is never serialized or model-visible. It can be
 * consumed once, only while the same logical call is open, and only after
 * work_call has durably bound the exact requirement at the inner edge.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { acceptedTaskIdFor, currentLogicalCall } from './attempt-identity.js';
import { openEventLog } from './eventlog.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import {
  loadExpectedWorkCallBindingState,
} from './expected-work-admission.js';
import { loadExpectedWorkContract } from './expected-work-contract.js';
import {
  canonicalCatalogIdentityOf,
  peekHostCapabilityCatalogFactory,
} from './host-capability-catalog-factory.js';
import {
  capabilityManifestDigest,
  currentCapabilityManifest,
  type CapabilityManifestV1,
} from './capability-manifest.js';
import {
  classifyRuntimeToolEffect,
  type RuntimeToolEffect,
} from './tool-effect.js';
import type { HostCallAttestation } from './accepted-turn-call-authority.js';
import {
  loadHostCallCapabilityBinding,
  type HostCallCapabilityBinding,
} from './host-call-capability-binding.js';
import type { ExpectedWorkCallBinding } from './expected-work-admission.js';
import {
  consumeHostConsentGrantAdmission,
  type HostConsentGrantAdmissionV1,
} from './host-interactive-consent.js';

interface NestedApprovalToken {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  toolName: string;
  argumentDigest: string;
  effect: RuntimeToolEffect;
  accountId: string;
  schemaFingerprint: string;
  manifestId: string;
  manifestDigest: string;
  operationId: string;
  contractId: string;
  requirementId: string;
  requirementDigest: string;
  used: boolean;
}

const admissionStorage = new AsyncLocalStorage<NestedApprovalToken>();

interface GenericNestedCallAdmissionToken {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  toolName: string;
  argumentDigest: string;
  effect: RuntimeToolEffect;
  contractId: string;
  requirementId: string;
  hostCapabilityBindingDigest: string;
  authorityDigest: string;
  consentBasis:
    | 'no_effect'
    | 'exact_reversible_work'
    | 'exact_ordinary_work'
    | 'exact_user_grant';
  exactGrant?: {
    approvalId: string;
    consentSubjectDigest: string;
    grantDigest: string;
  };
  entered: boolean;
  used: boolean;
  stagedChildIssued: boolean;
  stagedParentAdmission?: StagedParentCallAdmission;
}

const issuedGenericAdmissions = new WeakMap<object, GenericNestedCallAdmissionToken>();
const genericAdmissionStorage = new AsyncLocalStorage<GenericNestedCallAdmissionToken>();

/** Process-opaque parent admission carried into the staged-transfer kernel.
 * It is minted only after the ordinary nested admission has been consumed at
 * the exact inner edge. */
export interface StagedParentCallAdmission {
  readonly version: 1;
}

export interface StagedParentCallAdmissionState {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  toolName: string;
  argumentDigest: string;
  effect: RuntimeToolEffect;
  contractId: string;
  requirementId: string;
  hostCapabilityBindingDigest: string;
  authorityDigest: string;
  consentBasis: GenericNestedCallAdmissionToken['consentBasis'];
  exactGrant?: GenericNestedCallAdmissionToken['exactGrant'];
}

const stagedParentAdmissions = new WeakMap<object, Readonly<StagedParentCallAdmissionState>>();

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function selectedAccount(args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const value = (args as Record<string, unknown>).connected_account_id
    ?? (args as Record<string, unknown>).connectedAccountId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function openLogicalContract(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
}): { toolName: string; argumentDigest: string } | null {
  try {
    const row = openEventLog().prepare(`
      SELECT accepted_task_id, tool_name, argument_digest, state
        FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(input.sessionId, input.sourceUserSeq, input.logicalToolCallId) as {
      accepted_task_id: string;
      tool_name: string;
      argument_digest: string;
      state: string;
    } | undefined;
    return row
      && row.accepted_task_id === input.acceptedTaskId
      && row.state === 'open'
      ? { toolName: row.tool_name, argumentDigest: row.argument_digest }
      : null;
  } catch {
    return null;
  }
}

/**
 * Issue one process-local, exact-call admission after the single interactive
 * consent reducer has returned `proceed`. The durable host/work bindings are
 * reopened here; a caller cannot turn arbitrary projected values into a token.
 */
export function issueNestedCallAdmission(input: {
  hostCapabilityBinding: HostCallCapabilityBinding;
  workBinding: ExpectedWorkCallBinding;
  targetName: string;
  targetArgs: unknown;
  effect: RuntimeToolEffect;
  authorityDigest: string;
  consentBasis: GenericNestedCallAdmissionToken['consentBasis'];
  exactGrantAdmission?: HostConsentGrantAdmissionV1;
}): object | null {
  try {
    const host = input.hostCapabilityBinding;
    const work = input.workBinding;
    const logical = durableLogicalCallContract(host.acceptedTaskId, input.targetName, input.targetArgs);
    if (
      !logical
      || logical.toolName !== host.toolName
      || logical.argumentDigest !== host.effectiveArgumentDigest
      || input.effect === 'unknown'
      || input.effect !== host.effect
      || work.sessionId !== host.sessionId
      || work.sourceUserSeq !== host.sourceUserSeq
      || work.acceptedTaskId !== host.acceptedTaskId
      || work.logicalToolCallId !== host.logicalToolCallId
      || work.effect !== input.effect
      || !input.authorityDigest.trim()
    ) return null;
    const hasRawExactGrant = Object.prototype.hasOwnProperty.call(
      input as unknown as Record<string, unknown>,
      'exactGrant',
    );
    if (
      hasRawExactGrant
      || (input.consentBasis === 'exact_user_grant') !== Boolean(input.exactGrantAdmission)
    ) return null;
    const exactGrant = input.exactGrantAdmission
      ? consumeHostConsentGrantAdmission({
          admission: input.exactGrantAdmission,
          expected: {
            sessionId: host.sessionId,
            sourceUserSeq: host.sourceUserSeq,
            acceptedTaskId: host.acceptedTaskId,
            logicalToolCallId: host.logicalToolCallId,
            toolName: logical.toolName,
            argumentDigest: logical.argumentDigest,
            effect: input.effect,
            contractId: work.contractId,
            requirementId: work.requirementId,
            hostCapabilityBindingDigest: host.durableBindingDigest,
            authorityDigest: input.authorityDigest,
          },
        })
      : null;
    if (input.consentBasis === 'exact_user_grant' && !exactGrant) return null;
    const reopenedHost = loadHostCallCapabilityBinding({
      db: openEventLog(),
      sessionId: host.sessionId,
      sourceUserSeq: host.sourceUserSeq,
      logicalToolCallId: host.logicalToolCallId,
    });
    const reopenedWork = loadExpectedWorkCallBindingState({
      sessionId: host.sessionId,
      sourceUserSeq: host.sourceUserSeq,
      logicalToolCallId: host.logicalToolCallId,
    });
    const open = openLogicalContract({
      sessionId: host.sessionId,
      sourceUserSeq: host.sourceUserSeq,
      acceptedTaskId: host.acceptedTaskId,
      logicalToolCallId: host.logicalToolCallId,
    });
    const physical = openEventLog().prepare(`
      SELECT COUNT(*) AS n FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(host.sessionId, host.sourceUserSeq, host.logicalToolCallId) as { n: number };
    if (
      reopenedHost.status !== 'ok'
      || reopenedHost.binding.durableBindingDigest !== host.durableBindingDigest
      || reopenedHost.binding.effectiveArgumentDigest !== host.effectiveArgumentDigest
      || reopenedWork.status !== 'ok'
      || JSON.stringify(reopenedWork.binding) !== JSON.stringify(work)
      || !open
      || open.toolName !== logical.toolName
      || open.argumentDigest !== logical.argumentDigest
      || physical.n !== 0
    ) return null;

    const candidate = Object.freeze({});
    issuedGenericAdmissions.set(candidate, {
      sessionId: host.sessionId,
      sourceUserSeq: host.sourceUserSeq,
      acceptedTaskId: host.acceptedTaskId,
      logicalToolCallId: host.logicalToolCallId,
      toolName: logical.toolName,
      argumentDigest: logical.argumentDigest,
      effect: input.effect,
      contractId: work.contractId,
      requirementId: work.requirementId,
      hostCapabilityBindingDigest: host.durableBindingDigest,
      authorityDigest: input.authorityDigest,
      consentBasis: input.consentBasis,
      ...(exactGrant ? { exactGrant: { ...exactGrant } } : {}),
      entered: false,
      used: false,
      stagedChildIssued: false,
    });
    return candidate;
  } catch {
    return null;
  }
}

export function withNestedCallAdmission<T>(
  candidate: object,
  run: () => Promise<T>,
): Promise<T> {
  const issued = issuedGenericAdmissions.get(candidate);
  if (!issued || issued.entered) throw new Error('nested call admission candidate is not a fresh host-issued token');
  issued.entered = true;
  return genericAdmissionStorage.run(issued, run);
}

/** Immediate inner-edge redemption. This performs no consent decision; it
 * only proves that the exact already-admitted call still owns both durable
 * bindings and has not crossed or consumed its one process token. */
export function consumeNestedCallAdmission(input: {
  sessionId: string;
  toolName: string;
  args: unknown;
}): boolean {
  const token = genericAdmissionStorage.getStore();
  if (!token || token.used || token.sessionId !== input.sessionId) return false;
  const current = currentLogicalCall();
  const logical = durableLogicalCallContract(token.acceptedTaskId, input.toolName, input.args);
  if (
    !current
    || current.acceptedTaskId !== token.acceptedTaskId
    || current.logicalToolCallId !== token.logicalToolCallId
    || !logical
    || logical.toolName !== token.toolName
    || logical.argumentDigest !== token.argumentDigest
    || classifyRuntimeToolEffect(input.toolName, input.args).effect !== token.effect
  ) return false;
  const open = openLogicalContract(token);
  const host = loadHostCallCapabilityBinding({
    db: openEventLog(),
    sessionId: token.sessionId,
    sourceUserSeq: token.sourceUserSeq,
    logicalToolCallId: token.logicalToolCallId,
  });
  const work = loadExpectedWorkCallBindingState({
    sessionId: token.sessionId,
    sourceUserSeq: token.sourceUserSeq,
    logicalToolCallId: token.logicalToolCallId,
  });
  let physicalCount = -1;
  try {
    physicalCount = (openEventLog().prepare(`
      SELECT COUNT(*) AS n FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(
      token.sessionId,
      token.sourceUserSeq,
      token.logicalToolCallId,
    ) as { n: number }).n;
  } catch {
    return false;
  }
  if (
    !open
    || open.toolName !== token.toolName
    || open.argumentDigest !== token.argumentDigest
    || host.status !== 'ok'
    || host.binding.durableBindingDigest !== token.hostCapabilityBindingDigest
    || host.binding.effectiveArgumentDigest !== token.argumentDigest
    || work.status !== 'ok'
    || work.binding.acceptedTaskId !== token.acceptedTaskId
    || work.binding.contractId !== token.contractId
    || work.binding.requirementId !== token.requirementId
    || work.binding.effect !== token.effect
    || physicalCount !== 0
  ) return false;
  token.used = true;
  return true;
}

/** Mint the only token accepted by staged plan preparation. The ordinary
 * nested call must already have consumed consent/work admission, and one
 * nested invocation may hand off to at most one staged saga. */
export function issueStagedParentCallAdmission(input: {
  sessionId: string;
  toolName: string;
  args: unknown;
}): StagedParentCallAdmission | null {
  const token = genericAdmissionStorage.getStore();
  if (!token || !token.used || token.stagedChildIssued || token.sessionId !== input.sessionId) return null;
  const current = currentLogicalCall();
  const logical = durableLogicalCallContract(token.acceptedTaskId, input.toolName, input.args);
  if (
    !current
    || current.acceptedTaskId !== token.acceptedTaskId
    || current.logicalToolCallId !== token.logicalToolCallId
    || !logical
    || logical.toolName !== token.toolName
    || logical.argumentDigest !== token.argumentDigest
    || classifyRuntimeToolEffect(input.toolName, input.args).effect !== token.effect
    || !openLogicalContract(token)
  ) return null;
  token.stagedChildIssued = true;
  const candidate = Object.freeze({ version: 1 as const });
  token.stagedParentAdmission = candidate;
  stagedParentAdmissions.set(candidate, Object.freeze({
    sessionId: token.sessionId,
    sourceUserSeq: token.sourceUserSeq,
    acceptedTaskId: token.acceptedTaskId,
    logicalToolCallId: token.logicalToolCallId,
    toolName: token.toolName,
    argumentDigest: token.argumentDigest,
    effect: token.effect,
    contractId: token.contractId,
    requirementId: token.requirementId,
    hostCapabilityBindingDigest: token.hostCapabilityBindingDigest,
    authorityDigest: token.authorityDigest,
    consentBasis: token.consentBasis,
    ...(token.exactGrant ? { exactGrant: Object.freeze({ ...token.exactGrant }) } : {}),
  }));
  return candidate;
}

/** The exact staged hand-off minted at the inner tool edge, if this invocation
 * needed one. This returns only the process-opaque WeakMap key; no ambient
 * call may synthesize authority from visible fields. */
export function currentStagedParentCallAdmission(): StagedParentCallAdmission | null {
  const token = genericAdmissionStorage.getStore();
  return token?.used && token.stagedParentAdmission
    ? token.stagedParentAdmission
    : null;
}

/** Internal staged-kernel inspection. Copying public fields cannot mint an
 * admission because only WeakMap identity is accepted. */
export function inspectStagedParentCallAdmission(
  candidate: StagedParentCallAdmission,
): Readonly<StagedParentCallAdmissionState> | null {
  const state = stagedParentAdmissions.get(candidate as object);
  return state ? { ...state, ...(state.exactGrant ? { exactGrant: { ...state.exactGrant } } : {}) } : null;
}

export async function withAcceptedTaskNestedApprovalAdmission<T>(input: {
  attestation: HostCallAttestation;
  manifest: CapabilityManifestV1;
  requirementId: string;
}, run: () => Promise<T>): Promise<T> {
  const attestation = input.attestation;
  const requirementId = input.requirementId.trim();
  const manifest = currentCapabilityManifest(input.manifest);
  if (
    !requirementId
    || !manifest
    || attestation.bindingKind !== 'catalog_manifest'
    || attestation.effect !== 'external_write'
    || attestation.acceptedTaskId !== acceptedTaskIdFor(
      attestation.sessionId,
      attestation.sourceUserSeq,
    )
    || manifest.effect !== 'external_write'
    || manifest.manifestId !== attestation.manifestId
    || capabilityManifestDigest(manifest) !== attestation.manifestDigest
    || manifest.operationId !== attestation.operationId
    || manifest.operationId.toLowerCase() !== attestation.toolName
    || manifest.accountId !== attestation.accountId
    || manifest.definitionFingerprint !== attestation.schemaFingerprint
  ) throw new Error('nested approval admission input is not the exact covered manifest call');

  const logical = openLogicalContract({
    sessionId: attestation.sessionId,
    sourceUserSeq: attestation.sourceUserSeq,
    acceptedTaskId: attestation.acceptedTaskId,
    logicalToolCallId: attestation.logicalToolCallId,
  });
  if (
    !logical
    || logical.toolName !== attestation.toolName
    || logical.argumentDigest !== attestation.argumentDigest
  ) throw new Error('nested approval admission requires its exact open logical call');

  const loaded = loadExpectedWorkContract(attestation.sessionId, attestation.sourceUserSeq);
  if (loaded.status !== 'ok' || loaded.contract.acceptedTaskId !== attestation.acceptedTaskId) {
    throw new Error('nested approval admission requires the exact expected-work contract');
  }
  const requirement = loaded.contract.operations.find((operation) => operation.id === requirementId);
  if (
    !requirement
    || requirement.effect !== 'external_write'
    || requirement.cardinality.kind !== 'once'
    || loadExpectedWorkCallBindingState({
      sessionId: attestation.sessionId,
      sourceUserSeq: attestation.sourceUserSeq,
      logicalToolCallId: attestation.logicalToolCallId,
    }).status !== 'missing'
  ) throw new Error('nested approval admission requires one unclaimed external-write requirement');

  const requirementDigest = digest({
    contractId: loaded.contract.contractId,
    requirementId,
    effect: requirement.effect,
    cardinality: requirement.cardinality,
    manifestId: manifest.manifestId,
    manifestDigest: attestation.manifestDigest,
    operationId: manifest.operationId,
    accountId: manifest.accountId,
    schemaFingerprint: manifest.definitionFingerprint,
  });
  return admissionStorage.run({
    sessionId: attestation.sessionId,
    sourceUserSeq: attestation.sourceUserSeq,
    acceptedTaskId: attestation.acceptedTaskId,
    logicalToolCallId: attestation.logicalToolCallId,
    toolName: attestation.toolName,
    argumentDigest: attestation.argumentDigest,
    effect: attestation.effect,
    accountId: attestation.accountId,
    schemaFingerprint: attestation.schemaFingerprint,
    manifestId: attestation.manifestId,
    manifestDigest: attestation.manifestDigest,
    operationId: attestation.operationId,
    contractId: loaded.contract.contractId,
    requirementId,
    requirementDigest,
    used: false,
  }, run);
}

/** Consume the token at the immediate nested needsApproval edge. */
export function consumeAcceptedTaskNestedApprovalAdmission(input: {
  sessionId: string;
  toolName: string;
  args: unknown;
}): boolean {
  const token = admissionStorage.getStore();
  if (!token || token.used || input.sessionId !== token.sessionId) return false;
  const current = currentLogicalCall();
  if (
    !current
    || current.acceptedTaskId !== token.acceptedTaskId
    || current.logicalToolCallId !== token.logicalToolCallId
  ) return false;
  const logical = openLogicalContract(token);
  if (
    !logical
    || logical.toolName !== token.toolName
    || logical.argumentDigest !== token.argumentDigest
  ) return false;
  const contract = durableLogicalCallContract(token.acceptedTaskId, input.toolName, input.args);
  if (
    !contract
    || contract.toolName !== token.toolName
    || contract.argumentDigest !== token.argumentDigest
    || classifyRuntimeToolEffect(input.toolName, input.args).effect !== token.effect
    || selectedAccount(input.args) !== token.accountId
  ) return false;

  const binding = loadExpectedWorkCallBindingState({
    sessionId: token.sessionId,
    sourceUserSeq: token.sourceUserSeq,
    logicalToolCallId: token.logicalToolCallId,
  });
  if (
    binding.status !== 'ok'
    || binding.binding.acceptedTaskId !== token.acceptedTaskId
    || binding.binding.contractId !== token.contractId
    || binding.binding.requirementId !== token.requirementId
    || binding.binding.effect !== token.effect
    || binding.binding.cardinality !== 'once'
  ) return false;

  const entry = peekHostCapabilityCatalogFactory()?.snapshot().find((candidate) => {
    const identity = canonicalCatalogIdentityOf(candidate);
    return Boolean(
      identity
      && identity.manifestId === token.manifestId
      && identity.manifestDigest === token.manifestDigest
      && identity.operationId === token.operationId
      && identity.operationId.toLowerCase() === token.toolName
      && identity.account === token.accountId
      && identity.schemaDigest === token.schemaFingerprint
      && identity.effect === token.effect,
    );
  });
  if (!entry) return false;

  const loaded = loadExpectedWorkContract(token.sessionId, token.sourceUserSeq);
  const requirement = loaded.status === 'ok'
    ? loaded.contract.operations.find((operation) => operation.id === token.requirementId)
    : undefined;
  if (!requirement || digest({
    contractId: token.contractId,
    requirementId: token.requirementId,
    effect: requirement.effect,
    cardinality: requirement.cardinality,
    manifestId: token.manifestId,
    manifestDigest: token.manifestDigest,
    operationId: token.operationId,
    accountId: token.accountId,
    schemaFingerprint: token.schemaFingerprint,
  }) !== token.requirementDigest) return false;

  token.used = true;
  return true;
}
