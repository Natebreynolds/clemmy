/** Honest production-bootstrap child. Ports first, then configureHarnessRuntime. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Agent } from '@openai/agents';

const HOME = process.argv[2];
const command = process.argv[3] ?? 'run';
if (!HOME) {
  process.stderr.write('missing home\n');
  process.exit(2);
}
process.env.CLEMENTINE_HOME = HOME;
mkdirSync(HOME, { recursive: true });

const {
  BOOTSTRAP_SESSION_ID,
  RESTAURANT_REQUEST,
  restaurantManifests,
  calendarOnlyManifests,
  registerBootstrapPorts,
  restaurantSemanticPort,
  loadBootstrapProviderStore,
} = await import('./production-bootstrap-fixtures.js');
const {
  fakeAccountForTemplate,
  productionCapabilityManifests,
  provisionAccountBoundCapabilitySuccessor,
} = await import('../harness/production-capability-catalog.js');
const { saveProactivityPolicy } = await import('../../agents/proactivity-policy.js');
const { installTurnSemanticModelPort } = await import('./turn-semantic-port-registry.js');
const { peekHostCapabilityCatalogFactory } = await import('../harness/host-capability-catalog-factory.js');
const { peekProductionCapabilityAdapter } = await import('../harness/production-capability-adapter.js');
const { peekCapabilityManifestStore } = await import('../harness/capability-manifest-store.js');
const {
  typedExecutionCatalogReady,
  typedExecutionCatalogRefusals,
} = await import('./configure-typed-execution-runtime.js');

saveProactivityPolicy({ autoApproveScope: 'yolo' });

if (command === 'provision' || command === 'provision-calendar') {
  const { configureTypedExecutionRuntime } = await import('./configure-typed-execution-runtime.js');
  configureTypedExecutionRuntime();
  const store = peekCapabilityManifestStore();
  if (!store) {
    process.stderr.write('durable manifest store missing after configure\n');
    process.exit(3);
  }
  if (command === 'provision-calendar') {
    const manifests = calendarOnlyManifests();
    for (const manifest of manifests) {
      const installed = store.install(manifest);
      if (!installed.ok) {
        process.stderr.write(`manifest install failed ${manifest.manifestId} ${installed.reason}\n`);
        process.exit(4);
      }
    }
    writeFileSync(path.join(HOME, 'provisioned'), JSON.stringify({
      command,
      count: manifests.length,
      ids: manifests.map((item) => item.manifestId),
    }));
    process.exit(0);
  }
  const provisionedIds: string[] = [];
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
    if (!provisioned.ok) {
      process.stderr.write(`successor provision failed ${template.manifestId} ${provisioned.reason}\n`);
      process.exit(4);
    }
    provisionedIds.push(provisioned.manifest.manifestId);
  }
  writeFileSync(path.join(HOME, 'provisioned'), JSON.stringify({
    command,
    count: provisionedIds.length,
    ids: provisionedIds,
  }));
  process.exit(0);
}

const manifests = command === 'calendar'
  ? calendarOnlyManifests()
  : restaurantManifests();
registerBootstrapPorts(HOME, manifests);

if (command === 'unclaimed') {
  installTurnSemanticModelPort({
    async interpret() {
      throw new Error('unclaimed forged event must not be treated as claimed');
    },
  });
} else {
  installTurnSemanticModelPort(restaurantSemanticPort());
}

const factoryBefore = peekHostCapabilityCatalogFactory();
const adapterBefore = peekProductionCapabilityAdapter();
const { configureHarnessRuntime } = await import('../harness/codex-client.js');
await configureHarnessRuntime();
if (factoryBefore || adapterBefore) {
  process.stderr.write('child replaced catalog/adapter globals before configure\n');
  process.exit(5);
}
if (!peekHostCapabilityCatalogFactory() || !peekProductionCapabilityAdapter()) {
  process.stderr.write('configureHarnessRuntime did not install catalog/adapter\n');
  process.exit(6);
}

// The durable manifest store only resolves after configure, so the fake remote
// can only now report the versioned successors that provisioning bound. Refresh
// readiness against what was actually observed.
const { registerBootstrapObservationsForCurrentManifests } = await import('./production-bootstrap-fixtures.js');
const { refreshTypedExecutionReadiness } = await import('./configure-typed-execution-runtime.js');
registerBootstrapObservationsForCurrentManifests();
refreshTypedExecutionReadiness();

const { appendEvent, createSession, listEvents } = await import('../harness/eventlog.js');
const { runConversation } = await import('../harness/loop.js');

try {
  createSession({ id: BOOTSTRAP_SESSION_ID, kind: 'chat', userId: 'user-1' });
} catch {
  // Restart against the same home reuses the durable session.
}

if (command === 'unclaimed') {
  appendEvent({
    sessionId: BOOTSTRAP_SESSION_ID,
    turn: 1,
    role: 'system',
    type: 'turn_semantics_interpreted',
    data: {
      purpose: 'turn_semantics',
      sourceUserSeq: 1,
      validationOutcome: 'admitted',
      raw: restaurantSemanticPort() && (await restaurantSemanticPort().interpret()).raw,
    },
  });
}

const existing = listEvents(BOOTSTRAP_SESSION_ID, { types: ['user_input_received'] })[0];
const sourceUserSeq = existing && Number.isSafeInteger(existing.seq) && existing.seq > 0
  ? existing.seq
  : undefined;

const result = await runConversation({
  sessionId: BOOTSTRAP_SESSION_ID,
  input: RESTAURANT_REQUEST,
  ...(sourceUserSeq ? { sourceUserSeq, reuseRecordedUserInput: true } : {}),
  agent: new Agent({ name: 'production-bootstrap', instructions: 'unused', tools: [] }),
});
const store = loadBootstrapProviderStore(HOME);
const terminals = listEvents(BOOTSTRAP_SESSION_ID, { types: ['conversation_completed'] });
const semantics = listEvents(BOOTSTRAP_SESSION_ID, { types: ['turn_semantics_interpreted'] });
const lastSemantic = semantics.at(-1)?.data as {
  validationOutcome?: string;
  validationIssue?: { code?: string; message?: string; capabilityRef?: string };
} | undefined;
const payload = {
  pid: process.pid,
  command,
  status: result.status,
  error: result.error ?? null,
  creates: store.creates,
  artifact: store.artifact,
  terminals: terminals.length,
  catalogSize: peekHostCapabilityCatalogFactory()?.snapshot().length ?? 0,
  catalogReady: typedExecutionCatalogReady(),
  refusals: typedExecutionCatalogRefusals(),
  validationOutcome: lastSemantic?.validationOutcome ?? null,
  validationIssue: lastSemantic?.validationIssue ?? null,
};
writeFileSync(path.join(HOME, 'last-result.json'), JSON.stringify(payload));
process.stdout.write(JSON.stringify(payload));
