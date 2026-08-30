/**
 * Test-only current capability catalog fixture.
 *
 * Runtime effect and artifact authority now come from one exact current
 * callable manifest. Tests that replace the provider/SDK boundary must install
 * that same positive authority instead of recovering semantics from a familiar
 * operation name.
 */
import { createHash } from 'node:crypto';
import {
  attachSemanticContract,
  capabilityManifestDigest,
  type CapabilityManifestOperationSemanticsV1,
  type CapabilityManifestV1,
  type CapabilityProviderKind,
  type ManifestEffect,
} from './capability-manifest.js';
import {
  createHostCapabilityCatalogFactory,
  installHostCapabilityCatalogFactory,
  peekHostCapabilityCatalogFactory,
  type HostCapabilityCatalogFactory,
  type RegisteredHostCapability,
} from './host-capability-catalog-factory.js';
import type { OperationVerificationContractV1 } from './mutation-verification-contract.js';

export interface CurrentCapabilityManifestFixture {
  operationId: string;
  providerKind: Extract<CapabilityProviderKind, 'composio' | 'native_mcp' | 'reviewed_cli'>;
  effect: Extract<ManifestEffect, 'read' | 'external_write'>;
  destination?: { family: string; posture: string };
  operationSemantics?: CapabilityManifestOperationSemanticsV1;
  verification?: OperationVerificationContractV1;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function manifestFor(input: CurrentCapabilityManifestFixture): CapabilityManifestV1 {
  const write = input.effect === 'external_write';
  const identity = `${input.providerKind}:${input.operationId}`;
  const atomicEvidence = input.operationSemantics?.atomicInputContent?.evidence;
  return attachSemanticContract({
    version: 1,
    manifestId: `cap:current-fixture:${digest(identity).slice(0, 24)}`,
    providerKind: input.providerKind,
    operationId: input.operationId,
    providerIdentity: `fixture:${input.providerKind}:connected`,
    providerVersion: digest(`provider:${input.providerKind}`),
    operationVersion: '1',
    definitionFingerprint: digest(`definition:${identity}`),
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest: digest(`input:${identity}`),
      providerOutputSchemaObserved: true,
      providerOutputSchemaDigest: digest(`output:${identity}`),
      semanticName: input.operationId,
      ...(input.verification ? { verification: input.verification } : {}),
      behaviorHints: {
        readOnly: !write,
        destructive: false,
        idempotent: !write,
        openWorld: false,
      },
    },
    effect: input.effect,
    ...(input.destination ? { destination: input.destination } : {}),
    ...(input.operationSemantics ? { operationSemantics: input.operationSemantics } : {}),
    accountId: `account:${input.providerKind}:fixture`,
    idempotency: write
      ? { required: true, policy: 'key_before_dispatch' }
      : { required: false, policy: 'none' },
    reconciliation: write
      ? { supported: true, policy: 'exact_artifact' }
      : { supported: false, policy: 'none' },
    outputContract: { kind: write ? 'created_resource' : 'records' },
    evidenceContract: {
      kinds: atomicEvidence ?? (write ? ['receipt', 'readback'] : ['records']),
      readbackRequired: write && atomicEvidence == null,
    },
    provenance: {
      issuer: `test:${input.providerKind}:current-manifest-fixture`,
      issuedAt: '2026-08-30T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: write ? ['destination'] : ['source'],
  });
}

function registered(manifest: CapabilityManifestV1): RegisteredHostCapability {
  return {
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    ...(manifest.destination ? { destination: manifest.destination } : {}),
    account: manifest.accountId,
    advisoryRoles: manifest.advisoryRoles,
    manifestDigest: capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    providerInputSchemaDigest: manifest.externalDefinition?.providerInputSchemaDigest,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => ({ successful: true }),
  };
}

/** Install fixtures and return the exact prior factory for caller restoration. */
export function installCurrentCapabilityManifestFixtures(
  definitions: readonly CurrentCapabilityManifestFixture[],
): HostCapabilityCatalogFactory | null {
  const prior = peekHostCapabilityCatalogFactory();
  installHostCapabilityCatalogFactory(createHostCapabilityCatalogFactory(
    definitions.map((definition) => registered(manifestFor(definition))),
  ));
  return prior;
}

export function restoreCurrentCapabilityManifestFixtures(
  prior: HostCapabilityCatalogFactory | null,
): void {
  installHostCapabilityCatalogFactory(prior);
}
