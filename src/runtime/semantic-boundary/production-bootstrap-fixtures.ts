/**
 * Shared restaurant/calendar fixtures for the honest production-bootstrap
 * child. Manifest bytes are the durable identity; ports observe independently.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { attachSemanticContract, type CapabilityManifestV1 } from '../harness/capability-manifest.js';
import { entailedPlanGroundingJudge } from './fake-semantic-model.js';
import {
  accountBoundSuccessorManifest,
  fakeAccountForTemplate,
  observeHostCallable,
  productionCapabilityManifests,
} from '../harness/production-capability-catalog.js';
import { sealedPortsForManifest } from '../harness/production-capability-adapters.js';
import { resolveCapabilityManifestStore } from '../harness/capability-manifest-store.js';
import {
  installIsolatedAttestedTransport,
  registerShippedTestPort,
} from '../harness/isolated-attested-transport.fixture.js';
import {
  productionPortIdentityFromManifest,
  registerFixtureCapabilityPort,
} from '../harness/production-capability-ports.js';
import type { TurnSemanticProposalV1 } from './turn-semantic-proposal.js';

export const BOOTSTRAP_SESSION_ID = 'sess-production-bootstrap';

export const RESTAURANT_REQUEST =
  'can you find me the top 5 resturants in santa monica please get me thier latest reviews and links to thier social media accounts put them in a google sheet for me please';

export const FIVE_ROWS = [
  { name: 'One', latest_reviews: 'r1', social_media: 's1' },
  { name: 'Two', latest_reviews: 'r2', social_media: 's2' },
  { name: 'Three', latest_reviews: 'r3', social_media: 's3' },
  { name: 'Four', latest_reviews: 'r4', social_media: 's4' },
  { name: 'Five', latest_reviews: 'r5', social_media: 's5' },
];

export const SHEET_HANDLE = 'https://example.invalid/sheet/santa-monica';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export const LIVE = {
  host_lookup: sha256('live:web_read:v1'),
  host_compute: sha256('live:host_compute:v1'),
  host_create: sha256('live:sheet_create:v1'),
  calendar_create: sha256('live:calendar_create:v1'),
} as const;

function baseManifest(input: {
  role: string;
  operationId: keyof typeof LIVE | 'host_create';
  effect: CapabilityManifestV1['effect'];
  fingerprint: string;
  accountId: string;
  manifestId: string;
}): CapabilityManifestV1 {
  const write = input.effect === 'external_write';
  return attachSemanticContract({
    version: 1,
    manifestId: input.manifestId,
    providerKind: 'local_registry',
    operationId: input.operationId,
    providerIdentity: 'local_registry',
    providerVersion: 'tool-registry-v1',
    operationVersion: '1',
    definitionFingerprint: input.fingerprint,
    effect: input.effect,
    ...(write ? { destination: { family: 'created_resource', posture: 'create_new' } } : {}),
    accountId: input.accountId,
    idempotency: { required: write, policy: write ? 'key_before_dispatch' : 'none' },
    reconciliation: { supported: write, policy: write ? 'exact_artifact' : 'none' },
    outputContract: { kind: write ? 'created_resource' : 'records' },
    evidenceContract: {
      kinds: write ? ['receipt', 'readback'] : ['payload'],
      readbackRequired: write,
    },
    ...(write ? { readbackContract: { required: true, contentDigestRequired: true } } : {}),
    provenance: { issuer: 'host:production-bootstrap', issuedAt: '2026-08-15T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: [input.role],
  });
}

export function restaurantManifests(): CapabilityManifestV1[] {
  return productionCapabilityManifests().map((template) => {
    const accountId = fakeAccountForTemplate(template);
    const write = template.effect === 'external_write' || template.effect === 'local_write';
    const next = accountBoundSuccessorManifest({
      template,
      accountId,
      observation: {
        definitionFingerprint: template.definitionFingerprint,
        providerVersion: template.providerVersion,
        operationVersion: template.operationVersion,
        accountId,
      },
      reconciliation: write
        ? { supported: true, policy: 'exact_artifact' }
        : template.reconciliation,
    });
    if ('ok' in next) {
      throw new Error(`restaurant successor ${template.manifestId} ${next.reason}`);
    }
    return next;
  });
}

export function calendarOnlyManifests(): CapabilityManifestV1[] {
  return [
    baseManifest({
      role: 'destination',
      operationId: 'host_create',
      effect: 'external_write',
      fingerprint: LIVE.calendar_create,
      accountId: 'acct-calendar',
      manifestId: 'cap:host_create:calendar',
    }),
  ];
}

export function restaurantProposal(): TurnSemanticProposalV1 {
  return {
    version: 1,
    relation: 'new_goal',
    targetGoal: null,
    goal: {
      objective: 'Produce the requested collection in one destination.',
      criteria: [
        { id: 'c_set', statement: 'Bounded collection is present.' },
        { id: 'c_dest', statement: 'Destination artifact is verifiable.' },
      ],
      openSlots: [],
      candidates: [],
    },
    work: {
      construct: 'collect_then_construct',
      cardinality: { count: 5, fields: ['latest_reviews', 'social_media'] },
      destination: { posture: 'create_new', family: 'spreadsheet', handleRequired: false },
      requestedEffect: 'external_write',
      operations: [
        { id: 'op_source', role: 'source', requestedEffect: 'read', dependsOn: [], evidence: ['source_locator'], capabilityRef: 'cap:host_lookup:source' },
        { id: 'op_collect', role: 'collection', requestedEffect: 'read', dependsOn: ['op_source'], evidence: ['collection'], capabilityRef: 'cap:host_lookup:collection' },
        { id: 'op_transform', role: 'transform', requestedEffect: 'host_only', dependsOn: ['op_collect'], evidence: ['lineage'], capabilityRef: 'cap:host_compute:transform' },
        { id: 'op_write', role: 'destination', requestedEffect: 'external_write', dependsOn: ['op_transform'], evidence: ['create_receipt'], capabilityRef: 'cap:host_create:destination' },
        { id: 'op_readback', role: 'readback', requestedEffect: 'read', dependsOn: ['op_write'], evidence: ['readback'], capabilityRef: 'cap:host_lookup:readback' },
      ],
      deliverables: [{ id: 'artifact_1', kind: 'spreadsheet' }],
      evidenceRequirements: ['collection', 'create_receipt', 'readback'],
    },
    slotAnswers: [],
    rationale: 'production-bootstrap',
  };
}

export interface BootstrapProviderStore {
  sourceReads: number;
  collectionReads: number;
  transforms: number;
  creates: number;
  readbacks: number;
  artifact: { id: string; handle: string; receipt: string; content: unknown } | null;
}

function storePath(home: string): string {
  return path.join(home, 'fake-provider.json');
}

export function loadBootstrapProviderStore(home: string): BootstrapProviderStore {
  if (!existsSync(storePath(home))) {
    return {
      sourceReads: 0,
      collectionReads: 0,
      transforms: 0,
      creates: 0,
      readbacks: 0,
      artifact: null,
    };
  }
  return JSON.parse(readFileSync(storePath(home), 'utf8')) as BootstrapProviderStore;
}

function saveStore(home: string, store: BootstrapProviderStore): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(storePath(home), JSON.stringify(store));
}

export function mark(home: string, name: string): void {
  writeFileSync(path.join(home, `marker.${name}`), String(Date.now()));
}

async function maybeHang(home: string, boundary: string): Promise<void> {
  if (process.env.CLEM_HANG_AFTER !== boundary) return;
  mark(home, `hang-${boundary}`);
  await new Promise(() => { /* wait for SIGKILL */ });
}

function independentObservation(operationId: string, fingerprint: string, accountId: string, observedAt: number) {
  return {
    operationId,
    definitionFingerprint: fingerprint,
    providerVersion: 'tool-registry-v1',
    operationVersion: '1',
    accountId,
    observedAt,
  };
}

export function registerBootstrapPorts(home: string, manifests: readonly CapabilityManifestV1[]): void {
  installIsolatedAttestedTransport(async (call) => {
    const current = loadBootstrapProviderStore(home);
    if (call.operationId === 'TAVILY_TAVILY_SEARCH') {
      current.sourceReads += 1;
      saveStore(home, current);
      return { locator: 'src-rest', query: String(call.args.query ?? '') };
    }
    if (call.operationId === 'TAVILY_TAVILY_EXTRACT' || (call.operationId === 'host_lookup' && 'locator' in call.args)) {
      current.collectionReads += 1;
      saveStore(home, current);
      return { records: FIVE_ROWS };
    }
    if (call.operationId === 'GOOGLESHEETS_SHEET_FROM_JSON' || call.operationId === 'host_create') {
      await maybeHang(home, 'reservation');
      if (current.artifact) {
        saveStore(home, current);
        return {
          spreadsheet_id: current.artifact.id,
          spreadsheet_url: current.artifact.handle,
        };
      }
      current.creates += 1;
      current.artifact = {
        id: 'sheet-1',
        handle: SHEET_HANDLE,
        receipt: 'prov-receipt-sheet-1',
        content: FIVE_ROWS,
      };
      saveStore(home, current);
      mark(home, 'remote_commit');
      await maybeHang(home, 'remote_commit');
      return {
        spreadsheet_id: current.artifact.id,
        spreadsheet_url: current.artifact.handle,
      };
    }
    if (call.operationId === 'GOOGLESHEETS_GET_SPREADSHEET_INFO') {
      if (!current.artifact) throw new Error('bootstrap reconcile has no artifact');
      return {
        spreadsheet_id: current.artifact.id,
        spreadsheet_url: current.artifact.handle,
        receipt: current.artifact.receipt,
      };
    }
    if (call.operationId === 'GOOGLESHEETS_BATCH_GET') {
      current.readbacks += 1;
      saveStore(home, current);
      return {
        spreadsheetId: String(call.args.spreadsheet_id ?? current.artifact?.id ?? ''),
        valueRanges: [{
          values: [
            ['name', 'latest_reviews', 'social_media'],
            ...FIVE_ROWS.map((row) => [row.name, row.latest_reviews, row.social_media]),
          ],
        }],
      };
    }
    throw new Error(`bootstrap transport has no handler for ${call.operationId}`);
  });
  for (const manifest of manifests) {
    const fingerprint = manifest.operationId === 'host_compute'
      ? LIVE.host_compute
      : manifest.manifestId === 'cap:host_create:calendar'
        ? LIVE.calendar_create
        : manifest.effect === 'external_write'
          ? LIVE.host_create
          : LIVE.host_lookup;
    void fingerprint;
    registerShippedTestPort(manifest, Date.now());
  }
}

/**
 * Let the fake remote report the identities that provisioning actually bound.
 *
 * Must run after the runtime is configured: provisioning installs versioned
 * successors on their own accounts, and the durable manifest store is not
 * resolvable until configure. Registering only the template set would leave
 * every successor unobserved, which is honestly refused as
 * `observation_unavailable`.
 */
export function registerBootstrapObservationsForCurrentManifests(): number {
  const store = resolveCapabilityManifestStore();
  let registered = 0;
  for (const entry of store.list()) {
    const manifest = entry.manifest;
    if (manifest.lifecycle.state !== 'current') continue;
    registerShippedTestPort(manifest, Date.now());
    registered += 1;
  }
  return registered;
}

export function restaurantSemanticPort() {
  return {
    async interpret() {
      return {
        raw: restaurantProposal(),
        modelIdentity: 'production-bootstrap/semantic',
        inputTokens: 100,
        outputTokens: 40,
        latencyMs: 5,
      };
    },
    async judgeSourceEffect(call: {
      proposedEffect: string;
      proposedDestinationPosture: 'create_new' | 'named_existing' | null;
      proposalDigest: string;
    }) {
      return {
        verdict: 'entailed' as const,
        effect: call.proposedEffect,
        destinationPosture: call.proposedDestinationPosture,
        proposalDigest: call.proposalDigest,
        modelIdentity: 'production-bootstrap/judge',
        inputTokens: 20,
        outputTokens: 8,
        latencyMs: 3,
      };
    },
    async judgePlanGrounding(call: Parameters<typeof entailedPlanGroundingJudge>[0]) {
      return entailedPlanGroundingJudge(call, 'production-bootstrap/grounding');
    },
  };
}
