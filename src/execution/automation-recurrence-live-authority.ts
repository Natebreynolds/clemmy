import { createHash } from 'node:crypto';

import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import { loadCurrentAutomationReadPilotProjectionAuthorityForRun } from './automation-read-pilot-control-plane.js';
import {
  designApprovedAutomationWorkflowBridge,
  type AutomationWorkflowBridgePreviewV1,
} from './automation-workflow-bridge.js';
import {
  getAutomationRecurrenceActivationContract,
  type AutomationRecurrenceAuthoritySnapshotV1,
} from './automation-recurrence-control-plane.js';

function canonicalJson(value: unknown): string {
  return closedCanonicalJson(value, {
    maxDepth: 40,
    maxNodes: 40_000,
    maxStringBytes: 96_000,
    maxTotalBytes: 768_000,
  });
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function projectCurrentAutomationPilotAuthority(runId: string):
  | {
      ok: true;
      projection: Extract<ReturnType<typeof loadCurrentAutomationReadPilotProjectionAuthorityForRun>, { ok: true }>['projection'];
      compilation: Extract<ReturnType<typeof loadCurrentAutomationReadPilotProjectionAuthorityForRun>, { ok: true }>['compilation'];
      workflowInputs: Record<string, string>;
      preview: AutomationWorkflowBridgePreviewV1;
    }
  | { ok: false; code: string; reason: string } {
  const authority = loadCurrentAutomationReadPilotProjectionAuthorityForRun(runId);
  if (!authority.ok) return authority;
  const compiled = designApprovedAutomationWorkflowBridge({
    ...authority.compilation,
    activation: { kind: 'preview', target: 'pilot' },
  });
  if (
    !compiled.ok
    || compiled.issues.length > 0
    || !compiled.preview
    || compiled.preview.compilationDigest !== authority.projection.compilationDigest
  ) return {
    ok: false,
    code: 'pilot_compilation_drift',
    reason: compiled.issues.map((issue) => issue.message).join('; ')
      || 'The exact pilot compilation no longer matches its durable projection.',
  };
  return { ...authority, preview: compiled.preview };
}

export function automationRecurrenceAuthoritySnapshotFromPreview(
  preview: AutomationWorkflowBridgePreviewV1,
): AutomationRecurrenceAuthoritySnapshotV1 {
  const bindings = [...preview.capabilityBindings].sort((left, right) => (
    left.capabilityId.localeCompare(right.capabilityId)
  ));
  return {
    version: 1,
    capabilitySnapshotDigest: preview.liveSnapshotDigest,
    accountSnapshotDigest: sha256({
      domain: 'automation-recurrence-account-snapshot',
      version: 1,
      accounts: bindings.map((binding) => ({
        capabilityId: binding.capabilityId,
        account: binding.account,
      })),
    }),
    schemaSnapshotDigest: sha256({
      domain: 'automation-recurrence-schema-snapshot',
      version: 1,
      schemas: bindings.map((binding) => ({
        capabilityId: binding.capabilityId,
        operationId: binding.operationId,
        schemaVersion: binding.schemaVersion,
        schemaDigest: binding.schemaDigest,
        liveFingerprint: binding.liveFingerprint,
      })),
    }),
    bindingSnapshotDigest: preview.bindingSnapshotDigest,
    controlContractDigest: preview.controlContractDigest,
    ...(preview.canonicalEntityWorkspaceBinding
      ? { workspaceBindingDigest: preview.canonicalEntityWorkspaceBinding.bindingDigest }
      : {}),
  };
}

export function resolveCurrentAutomationRecurrenceAuthoritySnapshot(
  activationId: string,
): { ok: true; snapshot: AutomationRecurrenceAuthoritySnapshotV1 } | { ok: false; reason: string } {
  const contract = getAutomationRecurrenceActivationContract(activationId);
  if (!contract) return { ok: false, reason: 'recurrence activation contract is missing' };
  const current = projectCurrentAutomationPilotAuthority(contract.pilotSuccess.runId);
  if (
    !current.ok
    || current.projection.approvalId !== contract.pilotSuccess.pilotAuthorizationRef
    || current.preview.compilationDigest !== contract.pilotSuccess.pilotCompilationDigest
  ) return { ok: false, reason: current.ok ? 'pilot authority lineage drifted' : current.reason };
  const snapshot = automationRecurrenceAuthoritySnapshotFromPreview(current.preview);
  if (canonicalJson(snapshot) !== canonicalJson(contract.pilotSuccess.authoritySnapshot)) {
    return { ok: false, reason: 'current capability, account, schema, binding, or control authority drifted' };
  }
  return { ok: true, snapshot };
}
