/**
 * Run: npx tsx --test src/runtime/graph/graph-node-identity.test.ts
 *
 * R1B/B1 biting suite: semantic admission and node identity. Structural
 * id/kind was never enough — these pins prove that semantic configuration,
 * runner contracts, tenancy, authority, catalog/schema universe, effect
 * ceiling, binding revision, and budget version are all run identity (refuse
 * the old journal wholesale), while per-root input manifests bind at the
 * INPUT layer so a changed root input reruns exactly its dependency cone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  admitGraph,
  type AdmittedBudget,
  type GraphAdmission,
} from './graph-admission.js';
import {
  inputDigestFor,
  nodeDigestFor,
  sealExecutionIdentity,
  type GraphExecutionIdentity,
  type NodeSemanticIdentity,
} from './graph-node-identity.js';
import type { GraphJournalEntry } from './graph-journal.js';
import { runGraph, type ExecutableGraph, type ExecutableNode, type NodeOutcome, type NodeRunner } from './graph-executor.js';
import { computeNodeDigest } from './graph-admission.js';

const BUDGET: AdmittedBudget = {
  maxNodes: 100, maxWaves: 100, maxConcurrency: 4, maxElapsedMs: 60_000, maxExpansions: 0,
};

/** Two roots feeding two children — the dependency-cone fixture. */
const CONE: ExecutableGraph = {
  graphId: 'cone',
  nodes: [
    { id: 'r1', kind: 'read' }, { id: 'r2', kind: 'read' },
    { id: 'c1', kind: 'step' }, { id: 'c2', kind: 'step' },
  ],
  edges: [
    { id: 'e1', source: 'r1', target: 'c1' },
    { id: 'e2', source: 'r2', target: 'c2' },
  ],
};

function semanticNode(over: Partial<NodeSemanticIdentity> = {}): NodeSemanticIdentity {
  return {
    semanticDigest: 'cfg-v1',
    runner: { name: 'runner', version: '1.0', artifactDigest: 'impl-a', ...(over.runner ?? {}) },
    ...over,
  };
}

function identityFor(graph: ExecutableGraph, over: Partial<GraphExecutionIdentity> = {}): GraphExecutionIdentity {
  return {
    tenant: 'tenant-1',
    workspace: 'ws-1',
    accountScopeDigest: 'scope-1',
    authorityDigest: 'auth-1',
    schemaUniverseDigest: 'schemas-1',
    effectCeiling: 'read',
    bindingRevisionDigest: 'rev-1',
    budgetVersion: 'budget-v1',
    nodes: Object.fromEntries(graph.nodes.map((node) => [node.id, semanticNode()])),
    ...over,
  };
}

function admittedWith(graph: ExecutableGraph, identity: GraphExecutionIdentity): GraphAdmission {
  const sealed = sealExecutionIdentity(graph, identity);
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  const result = admitGraph({
    graph, compilerVersion: 'c1', policyHash: 'p1', catalogHash: 'k1', budget: BUDGET,
    identity: (sealed as Extract<typeof sealed, { ok: true }>).identity,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as Extract<typeof result, { ok: true }>).admission;
}

function attempts(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
}

let headerSeq = 0;
function withHeader(admission: GraphAdmission, entries: GraphJournalEntry[]): GraphJournalEntry[] {
  if (entries[0]?.type === 'run_header') return entries;
  return [{
    type: 'run_header', admissionDigest: admission.admissionDigest,
    journalSchemaVersion: admission.journalSchemaVersion,
    activationId: `hdr-${(headerSeq += 1)}`,
  } as GraphJournalEntry, ...entries];
}

function adapter() {
  const entries: GraphJournalEntry[] = [];
  return { entries, adapter: { async append(entry: GraphJournalEntry) { entries.push(entry); } } };
}

/** Run the cone to completion under an admission and return its journal. */
async function journalOf(admission: GraphAdmission, prefix: string): Promise<GraphJournalEntry[]> {
  const { entries, adapter: journalAdapter } = adapter();
  const result = await runGraph(CONE, {
    runner: { run: (node): NodeOutcome => ({ status: 'completed', outputRef: `art-${node.id}` }) },
    admission, journalAdapter, clock: () => 0, attemptIds: attempts(prefix),
  });
  assert.equal(result.status, 'completed', result.haltReason ?? '');
  return entries;
}

// ─── sealing refusals ────────────────────────────────────────────────────────

test('sealing refuses incomplete coverage, empty fields, and misplaced root manifests', () => {
  const missing = identityFor(CONE);
  delete (missing.nodes as Record<string, unknown>).c1;
  assert.equal(sealExecutionIdentity(CONE, missing).ok, false, 'an undescribed node was admitted');

  const empty = identityFor(CONE, { authorityDigest: '  ' });
  assert.equal(sealExecutionIdentity(CONE, empty).ok, false, 'an empty authority digest was admitted');

  const misplaced = identityFor(CONE);
  misplaced.nodes.c1 = semanticNode({ rootInputManifestDigest: 'manifest' });
  assert.equal(sealExecutionIdentity(CONE, misplaced).ok, false,
    'a non-root carried a root input manifest');

  const stranger = identityFor(CONE);
  stranger.nodes.ghost = semanticNode();
  assert.equal(sealExecutionIdentity(CONE, stranger).ok, false,
    'identity for a node the graph does not contain was accepted');
});

test('sealing refuses secret-shaped identity — rotating connection ids and credential keys are never identity', () => {
  const rotating = identityFor(CONE, { accountScopeDigest: 'ca_8f3kq29zx' });
  const rotatingResult = sealExecutionIdentity(CONE, rotating);
  assert.equal(rotatingResult.ok, false);
  assert.ok((rotatingResult as Extract<typeof rotatingResult, { ok: false }>).errors
    .some((e) => /rotating/.test(e)));

  const credential = identityFor(CONE) as GraphExecutionIdentity & { apiKey?: string };
  credential.apiKey = 'sk-not-really';
  const credentialResult = sealExecutionIdentity(CONE, credential);
  assert.equal(credentialResult.ok, false);
  assert.ok((credentialResult as Extract<typeof credentialResult, { ok: false }>).errors
    .some((e) => /credential-shaped/.test(e)));
});

// ─── canonical bytes ─────────────────────────────────────────────────────────

test('canonical construction: map insertion order is not identity; declaration order still is', () => {
  const forward = identityFor(CONE);
  const reversed = identityFor(CONE, {
    nodes: Object.fromEntries([...CONE.nodes].reverse().map((node) => [node.id, semanticNode()])),
  });
  const a = sealExecutionIdentity(CONE, forward);
  const b = sealExecutionIdentity(CONE, reversed);
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  assert.equal(
    (a as Extract<typeof a, { ok: true }>).identity.identityDigest,
    (b as Extract<typeof b, { ok: true }>).identity.identityDigest,
    'object insertion order leaked into identity',
  );

  // Node/edge DECLARATION order is scheduling-meaningful and stays identity.
  const reorderedGraph: ExecutableGraph = { ...CONE, nodes: [...CONE.nodes].reverse() };
  const admissionA = admittedWith(CONE, identityFor(CONE));
  const admissionB = admittedWith(reorderedGraph, identityFor(reorderedGraph));
  assert.notEqual(admissionA.admissionDigest, admissionB.admissionDigest,
    'declaration order stopped being identity — scheduling depends on it');
});

// ─── identity changes refuse the old journal wholesale ───────────────────────

const SCOPE_VARIANTS: Array<[string, Partial<GraphExecutionIdentity>]> = [
  ['tenant', { tenant: 'tenant-2' }],
  ['workspace', { workspace: 'ws-2' }],
  ['account scope', { accountScopeDigest: 'scope-2' }],
  ['authority', { authorityDigest: 'auth-2' }],
  ['schema universe', { schemaUniverseDigest: 'schemas-2' }],
  ['effect ceiling', { effectCeiling: 'write' }],
  ['binding revision', { bindingRevisionDigest: 'rev-2' }],
  ['budget version', { budgetVersion: 'budget-v2' }],
];

test('changed tenancy, authority, catalog, ceiling, revision, or budget version is a different run', async () => {
  const original = admittedWith(CONE, identityFor(CONE));
  const journal = await journalOf(original, 'o');
  for (const [label, over] of SCOPE_VARIANTS) {
    const changed = admittedWith(CONE, identityFor(CONE, over));
    assert.notEqual(changed.admissionDigest, original.admissionDigest, `${label} did not change identity`);
    const { adapter: journalAdapter } = adapter();
    const result = await runGraph(CONE, {
      runner: { run: (): NodeOutcome => ({ status: 'completed' }) },
      admission: changed, journalAdapter, clock: () => 0,
      attemptIds: attempts('n'), resumeEntries: withHeader(changed, journal),
    });
    assert.equal(result.status, 'halted', `${label}: the old journal was accepted under a changed scope`);
    assert.match(result.haltReason ?? '', /different run/);
  }
});

test('changed semantic config or runner version is a different run — never silent reuse', async () => {
  const original = admittedWith(CONE, identityFor(CONE));
  const journal = await journalOf(original, 'o');
  const variants: Array<[string, NodeSemanticIdentity]> = [
    ['semantic config', semanticNode({ semanticDigest: 'cfg-v2' })],
    ['runner version', semanticNode({ runner: { name: 'runner', version: '2.0', artifactDigest: 'impl-a' } })],
    ['runner artifact', semanticNode({ runner: { name: 'runner', version: '1.0', artifactDigest: 'impl-b' } })],
  ];
  for (const [label, semantic] of variants) {
    const identity = identityFor(CONE);
    identity.nodes.r1 = semantic;
    const changed = admittedWith(CONE, identity);
    assert.notEqual(changed.admissionDigest, original.admissionDigest, `${label} did not change identity`);
    const { adapter: journalAdapter } = adapter();
    const result = await runGraph(CONE, {
      runner: { run: (): NodeOutcome => ({ status: 'completed' }) },
      admission: changed, journalAdapter, clock: () => 0,
      attemptIds: attempts('n'), resumeEntries: withHeader(changed, journal),
    });
    assert.equal(result.status, 'halted', `${label}: old work was reusable under a changed definition`);
  }
});

// ─── root input manifests bind at the input layer ────────────────────────────

function coneIdentityWithManifests(r1Manifest: string, r2Manifest: string): GraphExecutionIdentity {
  const identity = identityFor(CONE);
  identity.nodes.r1 = semanticNode({ rootInputManifestDigest: r1Manifest });
  identity.nodes.r2 = semanticNode({ rootInputManifestDigest: r2Manifest });
  return identity;
}

test('a changed root input manifest is the SAME run and reruns exactly its dependency cone', async () => {
  const before = admittedWith(CONE, coneIdentityWithManifests('m-r1-a', 'm-r2'));
  const after = admittedWith(CONE, coneIdentityWithManifests('m-r1-b', 'm-r2'));
  assert.equal(after.admissionDigest, before.admissionDigest,
    'root manifests leaked into the identity digest — a changed input would refuse instead of rerunning its cone');
  assert.notEqual(
    inputDigestFor(before, 'r1', []), inputDigestFor(after, 'r1', []),
    'the changed manifest did not change the root input digest',
  );
  assert.equal(inputDigestFor(before, 'r2', []), inputDigestFor(after, 'r2', []));

  const journal = await journalOf(before, 'o');
  const ran: string[] = [];
  const { adapter: journalAdapter } = adapter();
  const result = await runGraph(CONE, {
    runner: {
      run: (node): NodeOutcome => {
        ran.push(node.id);
        return { status: 'completed', outputRef: `art-${node.id}-new` };
      },
    },
    admission: after, journalAdapter, clock: () => 0,
    attemptIds: attempts('n'), resumeEntries: withHeader(after, journal),
  });
  assert.equal(result.status, 'completed', result.haltReason ?? '');
  assert.deepEqual(ran, ['r1', 'c1'],
    'the changed root and its cone must rerun; the unchanged root and its cone must reuse');
  assert.equal(result.trace.find((entry) => entry.nodeId === 'r2')?.reused, true);
  assert.equal(result.trace.find((entry) => entry.nodeId === 'c2')?.reused, true);
});

test('identical root and semantic identities reuse exactly — zero dispatch', async () => {
  const admission = admittedWith(CONE, coneIdentityWithManifests('m-r1', 'm-r2'));
  const journal = await journalOf(admission, 'o');
  const ran: string[] = [];
  const { adapter: journalAdapter } = adapter();
  const result = await runGraph(CONE, {
    runner: { run: (node): NodeOutcome => { ran.push(node.id); return { status: 'completed' }; } },
    admission, journalAdapter, clock: () => 0,
    attemptIds: attempts('n'), resumeEntries: withHeader(admission, journal),
  });
  assert.equal(result.status, 'completed', result.haltReason ?? '');
  assert.deepEqual(ran, [], 'identical identities re-dispatched settled work');
  assert.equal(result.trace.filter((entry) => entry.reused).length, 4);
});

// ─── identity anchors, digests, and fallbacks ────────────────────────────────

test('a structural-only digest cannot impersonate a semantic identity — forged pairs anchor nothing', async () => {
  const admission = admittedWith(CONE, identityFor(CONE));
  const r1 = CONE.nodes[0]!;
  // Forged internally-consistent pair carrying the STRUCTURAL digest under a
  // semantic admission: it never described the admitted definition.
  const journal: GraphJournalEntry[] = [
    {
      type: 'node_started', admissionDigest: admission.admissionDigest, nodeId: 'r1',
      nodeDigest: computeNodeDigest(r1), inputDigest: inputDigestFor(admission, 'r1', []),
      attemptId: 'f-1', wave: 0,
    },
    {
      type: 'node_settled', admissionDigest: admission.admissionDigest, nodeId: 'r1',
      nodeDigest: computeNodeDigest(r1), inputDigest: inputDigestFor(admission, 'r1', []),
      attemptId: 'f-1', wave: 0, status: 'completed', outputRef: 'art', firedEdgeIds: ['e1'],
    } as GraphJournalEntry,
  ];
  const { adapter: journalAdapter } = adapter();
  const result = await runGraph(CONE, {
    runner: { run: (): NodeOutcome => ({ status: 'completed' }) },
    admission, journalAdapter, clock: () => 0,
    attemptIds: attempts('n'), resumeEntries: withHeader(admission, journal),
  });
  assert.equal(result.status, 'halted', 'a structural digest was trusted under a semantic admission');
  assert.match(result.haltReason ?? '', /does not match the definition/);
});

test('nodeDigestFor: semantic when admitted, structural for the pure walker and patch-added nodes', () => {
  const admission = admittedWith(CONE, identityFor(CONE));
  const r1 = CONE.nodes[0]!;
  assert.notEqual(nodeDigestFor(admission, r1), computeNodeDigest(r1),
    'the semantic admission did not change the node digest');
  assert.equal(nodeDigestFor(undefined, r1), computeNodeDigest(r1));
  const patchAdded: ExecutableNode = { id: 'not-admitted', kind: 'worker' };
  assert.equal(nodeDigestFor(admission, patchAdded), computeNodeDigest(patchAdded),
    'a patch-added node without a semantic row must fall back to structural identity');
});
