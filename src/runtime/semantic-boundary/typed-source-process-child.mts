/** Child worker for process-level typed-source recovery tests. */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const HOME = process.argv[2];
const command = process.argv[3] ?? 'run';
const hangAfter = process.env.CLEM_HANG_AFTER ?? '';
const barrierPath = process.env.CLEM_BARRIER ?? '';
if (!HOME) {
  process.stderr.write('missing home\n');
  process.exit(2);
}
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMENTINE_SEMANTIC_CLAIM_WAIT_MS = '400';
process.env.CLEMENTINE_SEMANTIC_CLAIM_LEASE_MS = '250';
process.env.CLEMENTINE_GRAPH_LEASE_TTL_MS = process.env.CLEMENTINE_GRAPH_LEASE_TTL_MS ?? '800';

const storePath = path.join(HOME, 'fake-provider.json');
const resultPath = path.join(HOME, 'last-result.json');

function loadStore(): { creates: number; artifact: { id: string; handle: string; receipt: string; content: unknown } | null } {
  if (!existsSync(storePath)) return { creates: 0, artifact: null };
  return JSON.parse(readFileSync(storePath, 'utf8')) as {
    creates: number;
    artifact: { id: string; handle: string; receipt: string; content: unknown } | null;
  };
}

function saveStore(store: ReturnType<typeof loadStore>): void {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(storePath, JSON.stringify(store));
}

function mark(name: string): void {
  writeFileSync(path.join(HOME, `marker.${name}`), String(Date.now()));
}

function waitFor(file: string): Promise<void> {
  return new Promise((resolve) => {
    const tick = (): void => {
      if (existsSync(file)) resolve();
      else setTimeout(tick, 10);
    };
    tick();
  });
}

async function hang(): Promise<never> {
  await new Promise(() => { /* wait for SIGKILL */ });
  throw new Error('unreachable');
}

const FIVE = [
  { title: 'a', date: '1', link: 'l1' },
  { title: 'b', date: '2', link: 'l2' },
  { title: 'c', date: '3', link: 'l3' },
  { title: 'd', date: '4', link: 'l4' },
  { title: 'e', date: '5', link: 'l5' },
];

const { appendEvent, createSession, resetEventLog, listEvents } = await import('../harness/eventlog.js');
const { installTurnSemanticModelPort } = await import('./turn-semantic-port-registry.js');
const { admitAndCompileAcceptedSource } = await import('./admit-and-compile-accepted-source.js');
const { dispatchAdmittedSource } = await import('./typed-source-dispatch.js');
const { catalogFromConstructProviders } = await import('../harness/construct-provider-catalog.fixture.js');
const { entailedPlanGroundingJudge, fakeSemanticProposal } = await import('./fake-semantic-model.js');
const { saveProactivityPolicy } = await import('../../agents/proactivity-policy.js');
const { configureTypedExecutionRuntime } = await import('./configure-typed-execution-runtime.js');
const {
  createHostCapabilityCatalogFactory,
  installHostCapabilityCatalogFactory,
} = await import('../harness/host-capability-catalog-factory.js');

saveProactivityPolicy({ autoApproveScope: 'yolo' });
configureTypedExecutionRuntime();
installHostCapabilityCatalogFactory(createHostCapabilityCatalogFactory());
configureTypedExecutionRuntime();

if (barrierPath) {
  mark(`waiting-${process.pid}`);
  await waitFor(barrierPath);
}

const sessionId = process.env.CLEM_SESSION_ID ?? 'sess-process';
if (command === 'init') {
  resetEventLog();
  createSession({ id: sessionId, kind: 'chat', userId: 'user-1' });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'find five widgets and put them in a workbook' },
  });
  writeFileSync(path.join(HOME, 'source-seq'), String(source.seq));
  saveStore({ creates: 0, artifact: null });
  writeFileSync(path.join(HOME, 'ready'), '1');
  process.exit(0);
}

try { createSession({ id: sessionId, kind: 'chat', userId: 'user-1' }); } catch { /* already created by init */ }
installTurnSemanticModelPort({
  async interpret(call) {
    return {
      raw: fakeSemanticProposal('newConstruct', call.host),
      modelIdentity: 'process-child',
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
      modelIdentity: 'process-child-judge',
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
    };
  },
  async judgePlanGrounding(call) {
    return entailedPlanGroundingJudge(call, 'process-child-grounding');
  },
});

const reconcile = process.env.CLEM_RECONCILE === '1';
catalogFromConstructProviders({
  async sourceRead() { return { locator: 'src-1' }; },
  async collectionRead() { return { records: FIVE }; },
  async transform(records) { return records; },
  async create(records) {
    if (hangAfter === 'reservation') await hang();
    const store = loadStore();
    if (store.artifact) return store.artifact;
    store.creates += 1;
    store.artifact = {
      id: 'art-1',
      handle: 'https://example.invalid/sheet',
      receipt: 'prov-receipt-art-1',
      content: records,
    };
    saveStore(store);
    mark('remote_commit');
    if (hangAfter === 'remote_commit') await hang();
    return { id: 'art-1', handle: 'https://example.invalid/sheet', receipt: 'prov-receipt-art-1' };
  },
  ...(reconcile ? {
    async reconcile() {
      const store = loadStore();
      if (!store.artifact) return { exists: false };
      return {
        exists: true,
        id: store.artifact.id,
        handle: store.artifact.handle,
        receipt: store.artifact.receipt,
        content: store.artifact.content,
      };
    },
  } : {}),
  async readback(id) {
    const store = loadStore();
    return {
      id,
      handle: store.artifact?.handle ?? 'https://example.invalid/sheet',
      content: store.artifact?.content ?? FIVE,
    };
  },
});

const sourceSeq = existsSync(path.join(HOME, 'source-seq'))
  ? Number(readFileSync(path.join(HOME, 'source-seq'), 'utf8'))
  : undefined;
if (!Number.isSafeInteger(sourceSeq) || sourceSeq! <= 0) {
  throw new Error('accepted source identity is missing');
}
const identity = { sessionId, sourceUserSeq: sourceSeq!, turn: 1 };
const admitted = await admitAndCompileAcceptedSource({ identity, surface: 'direct' });
const dispatched = admitted.ok
  ? await dispatchAdmittedSource(identity)
  : { kind: 'blocked' as const, text: admitted.reason };
const result = dispatched.kind === 'typed'
  ? dispatched.result
  : dispatched.kind === 'blocked'
    ? { status: 'blocked' as const, error: dispatched.text }
    : dispatched.kind === 'needs_input'
      ? { status: 'blocked' as const, error: dispatched.text }
      : dispatched.kind === 'held'
        ? { status: 'blocked' as const, error: dispatched.hold.reason }
        : { status: 'failed' as const, error: 'typed executor did not accept the persisted graph' };
const store = loadStore();
const terminals = listEvents(sessionId, { types: ['conversation_completed'] });
writeFileSync(resultPath, JSON.stringify({
  pid: process.pid,
  result,
  creates: store.creates,
  artifact: store.artifact,
  terminals: terminals.length,
}));
process.stdout.write(JSON.stringify({ status: result.status, creates: store.creates, terminals: terminals.length }));
