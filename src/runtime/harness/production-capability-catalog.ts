/**
 * Host-owned beta capability pack. Every externally executed capability is
 * an exact provider operation. Host-only nodes are explicit host_only
 * identities. Wrappers that rewrite one slug into another are refused.
 */
import { createHash } from 'node:crypto';
import type { CapabilityManifestV1 } from './capability-manifest.js';
import { capabilityManifestDigest, currentCapabilityManifest } from './capability-manifest.js';
import {
  provisionVersionedCapabilityManifest,
  resolveCapabilityManifestStore,
  successorManifestIdFor,
  type CapabilityManifestStore,
} from './capability-manifest-store.js';
import {
  peekProductionCapabilityPort,
  productionPortIdentityFromManifest,
  registerProductionCapabilityPort,
} from './production-capability-ports.js';
import { composioPreparationForManifest } from './production-composio-preparation.js';
import {
  adoptObservedCapabilityIdentity,
  independentlyObserveCapability,
  registerIndependentCapabilityObservation,
} from './independent-capability-observation.js';
import type { LiveCapabilityObservation } from './production-capability-adapter.js';
import {
  BETA_PROVIDER_OPERATIONS,
} from './production-capability-adapters.js';
import { loadShippedImplementations } from './shipped-implementation-identity.js';

export const PRODUCTION_CAPABILITY_IDS = {
  locator: 'cap:host_lookup:source',
  collection: 'cap:host_lookup:collection',
  transform: 'cap:host_compute:transform',
  create: 'cap:host_create:destination',
  readback: 'cap:host_lookup:readback',
} as const;

/** Competing writer used only in retrieval evals. Never selected by role. */
export const BETA_COMPETING_CALENDAR_ID = 'cap:beta:calendar-create:v1';

export { BETA_PROVIDER_OPERATIONS } from './production-capability-adapters.js';

export const BETA_ACCOUNTS = {
  search: 'acct:beta:search:v1',
  sheets: 'acct:beta:sheets:v1',
  transform: 'host:beta:transform:v1',
  calendar: 'acct:beta:calendar:v1',
} as const;

export function isPlaceholderBetaAccount(accountId: string): boolean {
  return /^(acct|host):beta:/.test(accountId);
}

/** Non-placeholder accounts used when tests provision successors from templates. */
export const FAKE_PROVISIONED_ACCOUNTS = {
  search: 'acct:fake:search:v1',
  sheets: 'acct:fake:sheets:v1',
  transform: 'host:fake:transform:v1',
  calendar: 'acct:fake:calendar:v1',
} as const;

export function fakeAccountForTemplate(manifest: CapabilityManifestV1): string {
  if (manifest.manifestId === PRODUCTION_CAPABILITY_IDS.locator
    || manifest.manifestId === PRODUCTION_CAPABILITY_IDS.collection) {
    return FAKE_PROVISIONED_ACCOUNTS.search;
  }
  if (manifest.manifestId === PRODUCTION_CAPABILITY_IDS.create
    || manifest.manifestId === PRODUCTION_CAPABILITY_IDS.readback) {
    return FAKE_PROVISIONED_ACCOUNTS.sheets;
  }
  if (manifest.manifestId === PRODUCTION_CAPABILITY_IDS.transform) {
    return FAKE_PROVISIONED_ACCOUNTS.transform;
  }
  if (manifest.manifestId === BETA_COMPETING_CALENDAR_ID) {
    return FAKE_PROVISIONED_ACCOUNTS.calendar;
  }
  return FAKE_PROVISIONED_ACCOUNTS.search;
}

export function isBuiltInBetaTemplateId(manifestId: string): boolean {
  return (Object.values(PRODUCTION_CAPABILITY_IDS) as string[]).includes(manifestId)
    || manifestId === BETA_COMPETING_CALENDAR_ID;
}

export const BETA_ARGUMENT_COMPILERS = {
  locator: { id: 'compile:locator-query:v1', version: '1' },
  collection: { id: 'compile:collection-locator:v1', version: '1' },
  transform: { id: 'compile:host-project:v1', version: '1' },
  create: { id: 'compile:sheet-from-json:v1', version: '1' },
  readback: { id: 'compile:sheet-batch-get:v1', version: '1' },
  calendar: { id: 'compile:calendar-create:v1', version: '1' },
} as const;

const OBSERVED_SCHEMAS = {
  locator: {
    version: '1',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string' }, fields: { type: 'array' }, count: { type: 'number' } },
    },
    outputSchema: {
      type: 'object',
      required: ['locator'],
      properties: { locator: { type: 'string' }, query: { type: 'string' } },
    },
  },
  collection: {
    version: '1',
    inputSchema: {
      type: 'object',
      required: ['locator'],
      properties: { locator: { type: 'string' }, query: { type: 'string' } },
    },
    outputSchema: {
      type: 'object',
      required: ['records'],
      properties: { records: { type: 'array' } },
    },
  },
  transform: {
    version: '1',
    inputSchema: { type: 'object', properties: { records: { type: 'array' } } },
    outputSchema: { type: 'object', properties: { records: { type: 'array' } } },
  },
  create: {
    version: '1',
    inputSchema: {
      type: 'object',
      required: ['title', 'sheet_name', 'sheet_json'],
      properties: {
        title: { type: 'string' },
        sheet_name: { type: 'string' },
        sheet_json: { type: 'array' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['spreadsheet_id'],
      properties: {
        spreadsheet_id: { type: 'string' },
        spreadsheet_url: { type: 'string' },
      },
    },
  },
  readback: {
    version: '1',
    inputSchema: {
      type: 'object',
      required: ['spreadsheet_id', 'ranges'],
      properties: {
        spreadsheet_id: { type: 'string' },
        ranges: { type: 'array' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: { valueRanges: { type: 'array' }, spreadsheetId: { type: 'string' } },
    },
  },
  calendar: {
    version: '1',
    inputSchema: {
      type: 'object',
      required: ['summary'],
      properties: { summary: { type: 'string' }, start: { type: 'string' } },
    },
    outputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, htmlLink: { type: 'string' } },
    },
  },
} as const;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function betaObservedFingerprint(kind: keyof typeof OBSERVED_SCHEMAS): string {
  return sha256(JSON.stringify({
    operationId: BETA_PROVIDER_OPERATIONS[kind],
    ...OBSERVED_SCHEMAS[kind],
  }));
}

export function observeHostCallable(
  operationId: string,
  accountId: string = BETA_ACCOUNTS.transform,
): LiveCapabilityObservation | 'unknown' {
  const kind = (Object.keys(BETA_PROVIDER_OPERATIONS) as Array<keyof typeof BETA_PROVIDER_OPERATIONS>)
    .find((key) => BETA_PROVIDER_OPERATIONS[key] === operationId);
  if (!kind) return 'unknown';
  return {
    definitionFingerprint: betaObservedFingerprint(kind),
    providerVersion: kind === 'transform' ? 'host-catalog-v1' : betaObservedFingerprint(kind),
    operationVersion: OBSERVED_SCHEMAS[kind].version,
    accountId,
    observedAt: Date.now(),
  };
}

function betaManifest(input: {
  manifestId: string;
  role: string;
  kind: keyof typeof OBSERVED_SCHEMAS;
  effect: CapabilityManifestV1['effect'];
  purpose: string;
  acceptedInputKinds: readonly string[];
  producedOutputKinds: readonly string[];
  deliverableKind: string;
  accountId: string;
  providerKind: CapabilityManifestV1['providerKind'];
  providerIdentity: string;
}): CapabilityManifestV1 {
  const write = input.effect === 'external_write' || input.effect === 'local_write';
  const operationId = BETA_PROVIDER_OPERATIONS[input.kind];
  const fingerprint = betaObservedFingerprint(input.kind);
  return {
    version: 1,
    manifestId: input.manifestId,
    providerKind: input.providerKind,
    operationId,
    providerIdentity: input.providerIdentity,
    providerVersion: input.providerKind === 'local_registry' ? 'host-catalog-v1' : fingerprint,
    operationVersion: OBSERVED_SCHEMAS[input.kind].version,
    definitionFingerprint: fingerprint,
    effect: input.effect,
    ...(write ? { destination: { family: input.deliverableKind, posture: 'create_new' } } : {}),
    accountId: input.accountId,
    idempotency: { required: write, policy: write ? 'key_before_dispatch' : 'none' },
    reconciliation: {
      supported: false,
      policy: write ? 'uncertain_if_absent' : 'none',
    },
    outputContract: { kind: input.deliverableKind },
    purpose: input.purpose,
    acceptedInputKinds: [...input.acceptedInputKinds],
    producedOutputKinds: [...input.producedOutputKinds],
    applicableDeliverableKinds: [input.deliverableKind],
    evidenceContract: {
      kinds: write ? ['receipt', 'readback'] : ['payload'],
      readbackRequired: write,
    },
    ...(write ? { readbackContract: { required: true, contentDigestRequired: true } } : {}),
    provenance: {
      issuer: 'host:beta-catalog',
      issuedAt: '2026-08-16T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: [input.role],
    argumentCompiler: BETA_ARGUMENT_COMPILERS[input.kind],
    invokePortId: `port:${input.manifestId}:${operationId}`,
    ...(write ? { reconcilePortId: `reconcile:port:${input.manifestId}:${operationId}` } : {}),
  };
}

export function productionCapabilityManifests(): CapabilityManifestV1[] {
  return [
    betaManifest({
      manifestId: PRODUCTION_CAPABILITY_IDS.locator,
      role: 'source',
      kind: 'locator',
      effect: 'read',
      purpose: 'locate_source',
      acceptedInputKinds: ['query'],
      producedOutputKinds: ['locator'],
      deliverableKind: 'locator',
      accountId: BETA_ACCOUNTS.search,
      providerKind: 'composio',
      providerIdentity: 'composio',
    }),
    betaManifest({
      manifestId: PRODUCTION_CAPABILITY_IDS.collection,
      role: 'collection',
      kind: 'collection',
      effect: 'read',
      purpose: 'collect_records',
      acceptedInputKinds: ['locator'],
      producedOutputKinds: ['records'],
      deliverableKind: 'records',
      accountId: BETA_ACCOUNTS.search,
      providerKind: 'composio',
      providerIdentity: 'composio',
    }),
    betaManifest({
      manifestId: PRODUCTION_CAPABILITY_IDS.transform,
      role: 'transform',
      kind: 'transform',
      effect: 'host_only',
      purpose: 'project_records',
      acceptedInputKinds: ['records'],
      producedOutputKinds: ['records'],
      deliverableKind: 'records',
      accountId: BETA_ACCOUNTS.transform,
      providerKind: 'local_registry',
      providerIdentity: 'local_registry',
    }),
    betaManifest({
      manifestId: PRODUCTION_CAPABILITY_IDS.create,
      role: 'destination',
      kind: 'create',
      effect: 'external_write',
      purpose: 'persist_collection',
      acceptedInputKinds: ['records'],
      producedOutputKinds: ['created_resource'],
      deliverableKind: 'created_resource',
      accountId: BETA_ACCOUNTS.sheets,
      providerKind: 'composio',
      providerIdentity: 'composio',
    }),
    betaManifest({
      manifestId: PRODUCTION_CAPABILITY_IDS.readback,
      role: 'readback',
      kind: 'readback',
      effect: 'read',
      purpose: 'verify_created_resource',
      acceptedInputKinds: ['created_resource'],
      producedOutputKinds: ['records'],
      deliverableKind: 'records',
      accountId: BETA_ACCOUNTS.sheets,
      providerKind: 'composio',
      providerIdentity: 'composio',
    }),
  ];
}

export function competingCalendarManifest(): CapabilityManifestV1 {
  return betaManifest({
    manifestId: BETA_COMPETING_CALENDAR_ID,
    role: 'destination',
    kind: 'calendar',
    effect: 'external_write',
    purpose: 'persist_event',
    acceptedInputKinds: ['records'],
    producedOutputKinds: ['created_resource'],
    deliverableKind: 'created_resource',
    accountId: BETA_ACCOUNTS.calendar,
    providerKind: 'composio',
    providerIdentity: 'composio',
  });
}

export function registerProductionCatalogPorts(): void {
  for (const manifest of productionCapabilityManifests()) {
    const identity = productionPortIdentityFromManifest(manifest);
    if (peekProductionCapabilityPort(identity)) continue;
    const shipped = loadShippedImplementations();
    const write = manifest.effect === 'external_write' || manifest.effect === 'local_write';
    registerProductionCapabilityPort(identity, {
      ...composioPreparationForManifest(manifest),
      invoke: shipped.invokeForSealedManifest(manifest),
      ...(write ? { reconcile: shipped.reconcileForSealedManifest(manifest) } : {}),
    });
    registerIndependentCapabilityObservation({
      operationId: manifest.operationId,
      accountId: manifest.accountId,
      definitionFingerprint: manifest.definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      observedAt: Date.now(),
      origin: 'pack_attested',
    });
  }
}

export function accountBoundSuccessorManifest(input: {
  template: CapabilityManifestV1;
  accountId: string;
  observation: {
    definitionFingerprint: string;
    providerVersion: string;
    operationVersion: string;
    accountId: string;
  };
  successorId?: string;
  reconciliation?: CapabilityManifestV1['reconciliation'];
}): CapabilityManifestV1 | { ok: false; reason: 'placeholder_account' | 'account_mismatch' } {
  if (isPlaceholderBetaAccount(input.accountId) || isPlaceholderBetaAccount(input.observation.accountId)) {
    return { ok: false, reason: 'placeholder_account' };
  }
  if (input.observation.accountId !== input.accountId) {
    return { ok: false, reason: 'account_mismatch' };
  }
  const write = input.template.effect === 'external_write' || input.template.effect === 'local_write';
  const successorId = input.successorId ?? successorManifestIdFor(input.template.manifestId);
  const reconciliation = input.reconciliation ?? (
    write
      ? { supported: true as const, policy: 'exact_artifact' as const }
      : input.template.reconciliation
  );
  return {
    ...input.template,
    manifestId: successorId,
    accountId: input.accountId,
    definitionFingerprint: input.observation.definitionFingerprint,
    providerVersion: input.observation.providerVersion,
    operationVersion: input.observation.operationVersion,
    invokePortId: `port:${successorId}:${input.template.operationId}`,
    ...(write ? { reconcilePortId: `reconcile:port:${successorId}:${input.template.operationId}` } : {}),
    reconciliation,
    provenance: {
      ...input.template.provenance,
      issuer: 'host:provisioned-successor',
    },
    lifecycle: { state: 'current' },
  };
}

/**
 * Production path: bind a versioned successor to a host-observed account/schema.
 * Never overwrites a changed same-ID manifest. Templates stay non-authoritative.
 */
export function provisionAccountBoundCapabilitySuccessor(input: {
  store?: CapabilityManifestStore;
  template: CapabilityManifestV1;
  accountId: string;
  observation: {
    definitionFingerprint: string;
    providerVersion: string;
    operationVersion: string;
    accountId: string;
    observedAt?: number;
  };
  successorId?: string;
  reconciliation?: CapabilityManifestV1['reconciliation'];
}): { ok: true; manifest: CapabilityManifestV1; digest: string } | { ok: false; reason: string } {
  const next = accountBoundSuccessorManifest(input);
  if ('ok' in next) return next;
  const store = input.store ?? resolveCapabilityManifestStore();
  const provisioned = provisionVersionedCapabilityManifest(store, {
    predecessorId: input.template.manifestId,
    next,
  });
  if (!provisioned.ok) return provisioned;
  return { ok: true, manifest: next, digest: provisioned.digest };
}

export function reconstructShippedPortsForDurableSuccessors(): void {
  const store = resolveCapabilityManifestStore();
  const shipped = loadShippedImplementations();
  for (const entry of store.list()) {
    const current = currentCapabilityManifest(entry.manifest);
    if (!current || current.lifecycle.state !== 'current') continue;
    if (isPlaceholderBetaAccount(current.accountId)) continue;
    const identity = productionPortIdentityFromManifest(current);
    if (peekProductionCapabilityPort(identity)) continue;
    const write = current.effect === 'external_write' || current.effect === 'local_write';
    registerProductionCapabilityPort(identity, {
      ...composioPreparationForManifest(current),
      invoke: shipped.invokeForSealedManifest(current),
      ...(write ? { reconcile: shipped.reconcileForSealedManifest(current) } : {}),
    });
    // Restart may reconstruct ports; it may not manufacture an observation.
    // Re-deriving one from the durable manifest would only prove we can read
    // our own bytes. Adopt what the attested transport actually reports, and
    // stay unready when it reports nothing.
    adoptObservedCapabilityIdentity({
      operationId: current.operationId,
      accountId: current.accountId,
      definitionFingerprint: current.definitionFingerprint,
      providerVersion: current.providerVersion,
      operationVersion: current.operationVersion,
    });
  }
}

export function installProductionCapabilityCatalog(): {
  installed: number;
  refused: Array<{ manifestId: string; reason: string }>;
} {
  registerProductionCatalogPorts();
  reconstructShippedPortsForDurableSuccessors();
  const store = resolveCapabilityManifestStore();
  const refused: Array<{ manifestId: string; reason: string }> = [];
  let installed = 0;
  for (const manifest of productionCapabilityManifests()) {
    const existing = store.get(manifest.manifestId);
    if (existing?.manifest.lifecycle.state === 'current') {
      if (isPlaceholderBetaAccount(existing.manifest.accountId)) {
        refused.push({ manifestId: manifest.manifestId, reason: 'placeholder_account' });
      }
      if (existing.digest !== capabilityManifestDigest(existing.manifest)) {
        refused.push({ manifestId: manifest.manifestId, reason: 'identity_mismatch' });
      } else if (
        existing.digest !== capabilityManifestDigest(manifest)
        && existing.manifest.accountId === manifest.accountId
      ) {
        refused.push({ manifestId: manifest.manifestId, reason: 'identity_mismatch' });
      } else {
        installed += 1;
      }
    }
  }
  return { installed, refused };
}

/** @deprecated Use betaObservedFingerprint. Kept for isolated host-only fixtures. */
export function hostCallableFingerprint(operationId: string): string {
  const kind = (Object.keys(BETA_PROVIDER_OPERATIONS) as Array<keyof typeof BETA_PROVIDER_OPERATIONS>)
    .find((key) => BETA_PROVIDER_OPERATIONS[key] === operationId || key === operationId);
  if (kind) return betaObservedFingerprint(kind);
  return sha256(JSON.stringify({ operationId }));
}
