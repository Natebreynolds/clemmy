/**
 * Isolated-daemon fixture installer.
 *
 * Activates only when CLEMENTINE_ISOLATED_VERTICAL=1 and CLEMENTINE_HOME is
 * under the process temp directory. It never arms against a user home.
 * Fixtures go through the production manifest adapter, not runConversation.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveProactivityPolicy } from '../../agents/proactivity-policy.js';
import { attachSemanticContract, type CapabilityManifestV1 } from '../harness/capability-manifest.js';
import { resolveCapabilityManifestStore } from '../harness/capability-manifest-store.js';
import {
  createProductionCapabilityAdapter,
  installProductionCatalogAdapter,
  installProductionCapabilityAdapter,
  peekProductionCapabilityAdapter,
  registeredCapabilityFromManifest,
} from '../harness/production-capability-adapter.js';
import {
  fakeAccountForTemplate,
  productionCapabilityManifests,
  provisionAccountBoundCapabilitySuccessor,
} from '../harness/production-capability-catalog.js';
import {
  installIsolatedAttestedTransport,
  registerShippedTestPort,
} from '../harness/isolated-attested-transport.fixture.js';
import {
  createHostCapabilityCatalogFactory,
  installHostCapabilityCatalogFactory,
  peekHostCapabilityCatalogFactory,
} from '../harness/host-capability-catalog-factory.js';
import { registerIndependentCapabilityObservation } from '../harness/independent-capability-observation.js';
import { entailedCapabilityGroundingJudge, fakeSemanticProposal } from './fake-semantic-model.js';
import { installTurnSemanticModelPort } from './turn-semantic-port-registry.js';

export const ISOLATED_SESSION_ID = 'sess-isolated-daemon';

export const ISOLATED_UNSEEN_REQUEST =
  'assemble four warehouse lots with sku, qty, and bin onto a new workbook';

const LOTS = [
  { title: 'a', date: '1', link: 'l1' },
  { title: 'b', date: '2', link: 'l2' },
  { title: 'c', date: '3', link: 'l3' },
  { title: 'd', date: '4', link: 'l4' },
  { title: 'e', date: '5', link: 'l5' },
];

export interface IsolatedProviderStore {
  sourceReads: number;
  collectionReads: number;
  transforms: number;
  creates: number;
  readbacks: number;
  artifact: { id: string; handle: string; receipt: string; content: unknown } | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function isolatedVerticalEnabled(): boolean {
  if (process.env.CLEMENTINE_ISOLATED_VERTICAL !== '1') return false;
  const home = process.env.CLEMENTINE_HOME?.trim();
  if (!home) return false;
  const resolvedHome = path.resolve(home);
  const tmp = path.resolve(os.tmpdir());
  return resolvedHome === tmp || resolvedHome.startsWith(`${tmp}${path.sep}`);
}

export function isolatedHome(): string {
  const home = process.env.CLEMENTINE_HOME?.trim();
  if (!home || !isolatedVerticalEnabled()) {
    throw new Error('isolated vertical is not armed');
  }
  return path.resolve(home);
}

function storePath(home: string): string {
  return path.join(home, 'fake-provider.json');
}

export function loadIsolatedProviderStore(home = isolatedHome()): IsolatedProviderStore {
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
  return JSON.parse(readFileSync(storePath(home), 'utf8')) as IsolatedProviderStore;
}

function saveStore(home: string, store: IsolatedProviderStore): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(storePath(home), JSON.stringify(store));
}

function mark(home: string, name: string): void {
  writeFileSync(path.join(home, `marker.${name}`), String(Date.now()));
}

async function maybeHang(home: string, boundary: string): Promise<void> {
  if (process.env.CLEM_HANG_AFTER !== boundary) return;
  mark(home, `hang-${boundary}`);
  await new Promise(() => { /* wait for SIGKILL */ });
}

const ISOLATED_LIVE = {
  host_lookup: sha256('isolated-live:host_lookup:v1'),
  host_compute: sha256('isolated-live:host_compute:v1'),
  host_create: sha256('isolated-live:host_create:v1'),
} as const;

const ISOLATED_OBSERVED_AT = Date.now();

function isolatedLiveObservation(operationId: keyof typeof ISOLATED_LIVE) {
  return {
    definitionFingerprint: ISOLATED_LIVE[operationId],
    providerVersion: 'tool-registry-v1',
    operationVersion: '1',
    accountId: 'host:isolated-vertical',
    observedAt: ISOLATED_OBSERVED_AT,
  };
}

function fixtureManifest(input: {
  role: string;
  toolName: keyof typeof ISOLATED_LIVE;
  effect: CapabilityManifestV1['effect'];
}): CapabilityManifestV1 {
  const write = input.effect === 'external_write' || input.effect === 'local_write';
  const schemaDigest = ISOLATED_LIVE[input.toolName];
  const acceptedInputKinds = write
    ? ['records']
    : input.role === 'source' ? ['query']
      : input.role === 'collection' || input.role === 'collect' ? ['locator']
        : input.role === 'readback' ? ['created_resource']
          : ['records'];
  const producedOutputKinds = input.role === 'source'
    ? ['locator']
    : write ? ['created_resource']
      : ['records'];
  return attachSemanticContract({
    version: 1,
    manifestId: `host:${input.toolName}:${input.role}`,
    providerKind: 'local_registry',
    operationId: input.toolName,
    providerIdentity: 'local_registry',
    providerVersion: 'tool-registry-v1',
    operationVersion: '1',
    definitionFingerprint: schemaDigest,
    effect: input.effect,
    ...(write ? { destination: { family: 'workbook', posture: 'create_new' } } : {}),
    accountId: 'host:isolated-vertical',
    idempotency: {
      required: write,
      policy: write ? 'key_before_dispatch' : 'none',
    },
    reconciliation: {
      supported: false,
      policy: write ? 'uncertain_if_absent' : 'none',
    },
    outputContract: { kind: producedOutputKinds[0] ?? 'records' },
    purpose: write ? 'persist_collection'
      : input.role === 'source' ? 'locate_source'
        : input.role === 'collection' || input.role === 'collect' ? 'collect_records'
          : input.role === 'transform' || input.role === 'extract' ? 'project_records'
            : input.role === 'readback' ? 'verify_created_resource'
              : 'host_capability',
    acceptedInputKinds,
    producedOutputKinds,
    applicableDeliverableKinds: producedOutputKinds,
    evidenceContract: {
      kinds: write ? ['receipt', 'readback'] : ['payload'],
      readbackRequired: write,
    },
    provenance: {
      issuer: 'host:isolated-vertical',
      issuedAt: '1970-01-01T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: [input.role],
  });
}

function asRecords(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  if (payload && typeof payload === 'object' && Array.isArray((payload as { records?: unknown }).records)) {
    return (payload as { records: Array<Record<string, unknown>> }).records;
  }
  return [];
}

/**
 * Install the production-shaped fake semantic port and manifest-backed
 * fake capabilities through the shared adapter. Safe no-op when the
 * isolated vertical is not armed.
 */
export function installIsolatedVerticalFixtures(): { registered: number } {
  if (!isolatedVerticalEnabled()) return { registered: 0 };
  const home = isolatedHome();
  mkdirSync(home, { recursive: true });
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  peekHostCapabilityCatalogFactory()?.clear();
  installTurnSemanticModelPort({
    async interpret(call) {
      return {
        raw: fakeSemanticProposal('newConstruct', call.host),
        modelIdentity: 'isolated-vertical/semantic',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
    async judgeSourceEffect(call) {
      return {
        verdict: 'entailed',
        effect: call.proposedEffect,
        destinationPosture: call.proposedDestinationPosture,
        proposalDigest: call.proposalDigest,
        modelIdentity: 'isolated-vertical/judge',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
    async judgePlanGrounding(call) {
      return entailedCapabilityGroundingJudge(call, 'isolated-vertical/grounding');
    },
  });

  const specs: Array<{
    role: string;
    toolName: keyof typeof ISOLATED_LIVE;
    effect: CapabilityManifestV1['effect'];
  }> = [
    { role: 'source', toolName: 'host_lookup', effect: 'read' },
    { role: 'collection', toolName: 'host_lookup', effect: 'read' },
    { role: 'collect', toolName: 'host_lookup', effect: 'read' },
    { role: 'transform', toolName: 'host_compute', effect: 'host_only' },
    { role: 'extract', toolName: 'host_compute', effect: 'host_only' },
    { role: 'destination', toolName: 'host_create', effect: 'external_write' },
    { role: 'create', toolName: 'host_create', effect: 'external_write' },
    { role: 'readback', toolName: 'host_lookup', effect: 'read' },
  ];
  const manifests = specs.map((spec) => fixtureManifest(spec));
  const store = resolveCapabilityManifestStore();
  for (const manifest of manifests) store.install(manifest);

  const invokeFor = (manifest: CapabilityManifestV1) => ({
      invoke: async ({ payload, role: nodeRole }: { payload: unknown; role?: string }) => {
        const current = loadIsolatedProviderStore(home);
        const role = manifest.advisoryRoles?.[0] ?? '';
        if (nodeRole === 'readback' && role === 'source') {
          throw new Error('source capability refuses readback role before transport');
        }
        if (role === 'source') {
          current.sourceReads += 1;
          saveStore(home, current);
          return { locator: 'src-isolated' };
        }
        if (role === 'collection' || role === 'collect') {
          current.collectionReads += 1;
          saveStore(home, current);
          return { records: LOTS };
        }
        if (role === 'transform' || role === 'extract') {
          current.transforms += 1;
          saveStore(home, current);
          return asRecords(payload).length > 0 ? asRecords(payload) : LOTS;
        }
        if (role === 'destination' || role === 'create') {
          await maybeHang(home, 'reservation');
          if (current.artifact) {
            saveStore(home, current);
            return current.artifact;
          }
          current.creates += 1;
          current.artifact = {
            id: 'art-isolated',
            handle: 'https://example.invalid/isolated-workbook',
            receipt: 'prov-receipt-art-isolated',
            content: asRecords(payload).length > 0 ? asRecords(payload) : LOTS,
          };
          saveStore(home, current);
          mark(home, 'remote_commit');
          await maybeHang(home, 'remote_commit');
          return {
            id: current.artifact.id,
            handle: current.artifact.handle,
            receipt: current.artifact.receipt,
          };
        }
        if (role === 'readback') {
          current.readbacks += 1;
          saveStore(home, current);
          const id = typeof payload === 'string' ? payload : String((payload as { id?: unknown })?.id ?? '');
          return {
            id,
            handle: current.artifact?.handle ?? 'https://example.invalid/isolated-workbook',
            content: current.artifact?.content ?? LOTS,
          };
        }
        throw new Error(`isolated fixture has no invoke for ${manifest.manifestId}`);
      },
      reconcile: async () => {
        const current = loadIsolatedProviderStore(home);
        if (!current.artifact) return { exists: false };
        return {
          exists: true,
          id: current.artifact.id,
          handle: current.artifact.handle,
          receipt: current.artifact.receipt,
          content: current.artifact.content,
        };
      },
    observe: () => {
      if (manifest.operationId !== 'host_lookup'
        && manifest.operationId !== 'host_compute'
        && manifest.operationId !== 'host_create') {
        return 'unknown' as const;
      }
      return isolatedLiveObservation(manifest.operationId);
    },
  });
  installIsolatedAttestedTransport(async (call) => {
    const current = loadIsolatedProviderStore(home);
    if (call.operationId === 'TAVILY_TAVILY_SEARCH' || call.operationId === 'host_lookup') {
      current.sourceReads += 1;
      saveStore(home, current);
      return { locator: 'src-isolated', query: String(call.args.query ?? '') };
    }
    if (call.operationId === 'TAVILY_TAVILY_EXTRACT') {
      current.collectionReads += 1;
      saveStore(home, current);
      return { records: LOTS };
    }
    if (call.operationId === 'GOOGLESHEETS_SHEET_FROM_JSON' || call.operationId === 'host_create') {
      if (current.artifact) {
        return { spreadsheet_id: current.artifact.id, spreadsheet_url: current.artifact.handle };
      }
      current.creates += 1;
      current.artifact = {
        id: 'art-isolated',
        handle: 'https://example.invalid/isolated-workbook',
        receipt: 'prov-receipt-art-isolated',
        content: LOTS,
      };
      saveStore(home, current);
      return { spreadsheet_id: current.artifact.id, spreadsheet_url: current.artifact.handle };
    }
    if (call.operationId === 'GOOGLESHEETS_GET_SPREADSHEET_INFO') {
      if (!current.artifact) return { exists: false };
      return { spreadsheet_id: current.artifact.id, spreadsheet_url: current.artifact.handle };
    }
    if (call.operationId === 'GOOGLESHEETS_BATCH_GET') {
      current.readbacks += 1;
      saveStore(home, current);
      return { spreadsheetId: current.artifact?.id, values: LOTS };
    }
    return {};
  });
  for (const manifest of manifests) {
    registerShippedTestPort(manifest);
  }
  const adapter = peekProductionCapabilityAdapter() ?? installProductionCatalogAdapter();
  const refreshed = adapter.refresh();
  const factory = peekHostCapabilityCatalogFactory();
  factory?.clear();
  for (const manifest of manifests) {
    const ports = invokeFor(manifest);
    const observation = isolatedLiveObservation(manifest.operationId as keyof typeof ISOLATED_LIVE);
    registerIndependentCapabilityObservation({
      operationId: manifest.operationId,
      accountId: manifest.accountId,
      definitionFingerprint: observation.definitionFingerprint,
      providerVersion: observation.providerVersion,
      operationVersion: observation.operationVersion,
      observedAt: observation.observedAt,
      origin: 'independent',
      observe: () => ({
        operationId: manifest.operationId,
        ...isolatedLiveObservation(manifest.operationId as keyof typeof ISOLATED_LIVE),
      }),
    });
    factory?.register(registeredCapabilityFromManifest({
      manifest,
      observation,
      invoke: ports.invoke,
      reconcile: ports.reconcile,
    }));
  }
  return refreshed;
}

/**
 * Test-only: register a live observer implementation for the built-in pack
 * so compile/execute fixtures can use cap:host_* identities. Production
 * bootstrap never calls this.
 */
export function installIndependentProductionPackForTests(input: {
  invoke: import('../harness/graph-node-capability.js').GraphNodeCapabilityInvoke;
  reconcile?: import('../harness/graph-node-capability.js').GraphNodeCapabilityReconcile;
}): { registered: number } {
  const factory = peekHostCapabilityCatalogFactory() ?? createHostCapabilityCatalogFactory();
  if (!peekHostCapabilityCatalogFactory()) {
    installHostCapabilityCatalogFactory(factory);
  }
  const store = resolveCapabilityManifestStore();
  const observe = (manifest: CapabilityManifestV1) => ({
    definitionFingerprint: manifest.definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    accountId: manifest.accountId,
    observedAt: ISOLATED_OBSERVED_AT,
  });
  const invokePorts = (manifest: CapabilityManifestV1) => ({
    invoke: input.invoke,
    observe,
    ...(manifest.reconcilePortId || manifest.effect === 'external_write' || manifest.effect === 'local_write'
      ? { reconcile: input.reconcile ?? (async () => ({ exists: false })) }
      : {}),
  });
  const adapter = createProductionCapabilityAdapter({
    factory,
    store,
    observe: {
      local_registry: observe,
      composio: observe,
      native_mcp: observe,
      reviewed_cli: observe,
    },
    invokePorts,
  });
  installProductionCatalogAdapter();
  installProductionCapabilityAdapter(adapter);
  for (const template of productionCapabilityManifests()) {
    const accountId = fakeAccountForTemplate(template);
    const provisioned = provisionAccountBoundCapabilitySuccessor({
      store,
      template,
      accountId,
      observation: {
        definitionFingerprint: template.definitionFingerprint,
        providerVersion: template.providerVersion,
        operationVersion: template.operationVersion,
        accountId,
        observedAt: Date.now(),
      },
    });
    if (provisioned.ok) {
      registerShippedTestPort(provisioned.manifest);
    }
  }
  const registered = adapter.refresh().registered;
  return { registered };
}
