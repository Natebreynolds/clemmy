/**
 * Evidence AUTHORITY — the consolidated Phase A contract.
 *
 * Every positive case runs through `buildEvidenceChain`, which records the real
 * shadow graph, refines its one unresolved `execute` node into the operations
 * that actually ran, persists a validated authoritative manifest, and proves
 * each obligation with a host-issued receipt that computes its own verdict.
 * Nothing here asserts its own meaning, and no test invents a node id.
 *
 * Tests that still fail do so against a real defect, named in the assertion.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-evidence-authority-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-evidence-authority\n', 'utf-8');

const eventlog = await import('./harness/eventlog.js');
const store = await import('./harness/obligation-store.js');
const receipts = await import('./harness/evidence-receipts.js');
const terminal = await import('./harness/terminal-truth.js');
const fixture = await import('./evidence-fixture.testsupport.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function runChild(file: string): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['tsx', file], { cwd: process.cwd() });
    let out = '';
    proc.stdout.on('data', (chunk) => { out += String(chunk); });
    proc.stderr.on('data', (chunk) => { out += String(chunk); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ out, code }));
  });
}

function childSource(body: string): string {
  return `
    process.env.CLEMENTINE_HOME = ${JSON.stringify(TMP_HOME)};
    process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
    ${body}
  `;
}

// ── A1. The positive chain itself ────────────────────────────────────────────
// Enters: recordTurnGraphShadow, compileObligationManifest,
//         persistObligationManifest, issue*Receipt, satisfyDeclaredObligation

test('A1: the whole evidence chain is authoritative and every satisfaction succeeds', () => {
  const chain = fixture.buildEvidenceChain({ label: 'a1' });

  assert.equal(chain.manifest.mode, 'authoritative', 'the shadow graph is never itself the authority');
  assert.deepEqual(
    chain.manifest.nodes.map((node) => node.nodeId).sort(),
    [fixture.READ_CHILD, fixture.WRITE_CHILD].sort(),
    'the manifest carries the REFINED nodes, not the compiled placeholders',
  );
  // buildEvidenceChain throws if any satisfaction is refused, so reaching here
  // already proves each one returned ok; this pins the exact set.
  assert.deepEqual(
    chain.order.map((entry) => entry.obligation),
    [
      'source_completeness',
      'derivation_from_current_source',
      'commit_effect',
      'verify_committed_readback',
      'stale_destination_reconciled',
    ],
    'every receipt-provable obligation is proved, in dependency order',
  );
  assert.deepEqual(
    store.outstandingDeclaredObligations(chain.task.sessionId, chain.task.sourceUserSeq),
    [{ nodeId: fixture.WRITE_CHILD, obligation: 'execution_terminal' }],
    'execution_terminal is not receipt-provable; it comes from the execution store',
  );
});

test('A1b: an irreversible send is proved by receipt and owes no read-back', () => {
  const chain = fixture.buildEvidenceChain({ label: 'a1b', writeMode: 'irreversible' });
  const proved = chain.order.map((entry) => entry.obligation);
  assert.ok(proved.includes('verify_committed_receipt'), 'a send is proved by a durable receipt');
  assert.ok(
    !proved.includes('verify_committed_readback'),
    'you cannot re-read a sent message; demanding it would block the turn forever',
  );
  const declared = chain.manifest.nodes.find((node) => node.nodeId === fixture.WRITE_CHILD);
  assert.equal(declared?.reversibility, 'irreversible');
  assert.ok(
    !declared?.obligations.includes('stale_destination_reconciled'),
    'there is no destination to reconcile for a send',
  );
});

test('A1c: a reversible write MUST owe an exact read-back', () => {
  const chain = fixture.buildEvidenceChain({ label: 'a1c' });
  const declared = chain.manifest.nodes.find((node) => node.nodeId === fixture.WRITE_CHILD);
  assert.equal(declared?.reversibility, 'reversible');
  assert.ok(
    declared?.obligations.includes('verify_committed_readback'),
    'a reversible target can be read back, so an acknowledgement alone is not verification',
  );
  assert.ok(declared?.obligations.includes('stale_destination_reconciled'));
});

// ── A2. One invalid dimension at a time ──────────────────────────────────────
// Enters: obligation-store.satisfyDeclaredObligation

test('A2: each single invalid dimension is independently refused', () => {
  // The baseline must be a request that WOULD succeed. Earlier this paired a
  // commit receipt with the reconciliation obligation, so the base was already
  // invalid and every "corruption" was refused for the wrong reason.
  const chain = fixture.buildEvidenceChain({ label: 'a2', omit: 'stale_destination_reconciled' });
  const evidence = fixture.redeemableOccurrence(chain.task, {
    tool: 'beta__read_rows', effect: 'read', output: { rows: [] },
  });
  const issued = receipts.issueReconciliationReceipt({
    identity: {
      sessionId: chain.task.sessionId, sourceUserSeq: chain.task.sourceUserSeq,
      physicalAttemptId: evidence.physicalAttemptId, callId: evidence.callId,
      tool: evidence.tool, effect: evidence.effect,
    },
    before: { rows: [] }, after: { rows: [] }, staleRemaining: 0, target: 'beta:sink-1',
  });
  assert.ok(issued.receiptId, 'fixture precondition: the reconciliation receipt must issue');

  const base = {
    sessionId: chain.task.sessionId,
    sourceUserSeq: chain.task.sourceUserSeq,
    manifestId: chain.manifest.manifestId,
    nodeId: fixture.WRITE_CHILD,
    obligation: 'stale_destination_reconciled',
    receiptId: issued.receiptId as string,
    physicalAttemptId: evidence.physicalAttemptId,
  };

  const wrongKind = chain.receipts.get(`${fixture.WRITE_CHILD}|commit_effect`) as string;
  const dimensions: Array<[string, Record<string, unknown>]> = [
    ['nonexistent receipt', { receiptId: 'receipt:reconciliation:deadbeef' }],
    ['wrong manifest', { manifestId: 'manifest:v1:0000' }],
    ['wrong node', { nodeId: 'n2:intent_authority' }],
    ['obligation not declared by that node', { nodeId: fixture.READ_CHILD }],
    ['wrong physical attempt', { physicalAttemptId: 'attempt-never-dispatched' }],
    ['wrong receipt kind for the obligation', { receiptId: wrongKind }],
  ];

  const accepted: string[] = [];
  for (const [name, override] of dimensions) {
    if (store.satisfyDeclaredObligation({ ...base, ...override } as never).ok) accepted.push(name);
  }
  assert.deepEqual(accepted, [], `each invalid dimension must be refused; accepted: ${accepted.join(', ')}`);

  // And the untouched baseline must genuinely succeed — otherwise the six
  // refusals above prove nothing.
  assert.equal(
    store.satisfyDeclaredObligation(base as never).ok,
    true,
    'the uncorrupted baseline must succeed, or every negative above is vacuous',
  );
});

test('A2b: a receipt from another accepted task is refused', () => {
  const mine = fixture.buildEvidenceChain({ label: 'a2b-mine', omit: 'stale_destination_reconciled' });
  const theirs = fixture.buildEvidenceChain({ label: 'a2b-theirs' });
  const outcome = store.satisfyDeclaredObligation({
    sessionId: mine.task.sessionId,
    sourceUserSeq: mine.task.sourceUserSeq,
    manifestId: mine.manifest.manifestId,
    nodeId: fixture.WRITE_CHILD,
    obligation: 'stale_destination_reconciled',
    receiptId: theirs.receipts.get(`${fixture.WRITE_CHILD}|stale_destination_reconciled`) as string,
    physicalAttemptId: mine.attempts.get(`${fixture.WRITE_CHILD}|commit_effect`) as string,
  });
  assert.equal(outcome.ok, false, 'a receipt is scoped to the task that produced it');
});

test('A2c: an out-of-order obligation is refused until its dependency is proved', () => {
  const chain = fixture.buildEvidenceChain({ label: 'a2c', manifestOnly: true });
  const evidence = fixture.redeemableOccurrence(chain.task, {
    tool: 'beta__read_rows', effect: 'read', output: { rows: [] },
  });
  const issued = receipts.issueReadbackReceipt({
    identity: {
      sessionId: chain.task.sessionId, sourceUserSeq: chain.task.sourceUserSeq,
      physicalAttemptId: evidence.physicalAttemptId, callId: evidence.callId,
      tool: evidence.tool, effect: evidence.effect,
    },
    expected: { rows: [] }, observed: { rows: [] }, target: 'beta:sink-1',
  });
  assert.ok(issued.receiptId, 'fixture precondition: the receipt must issue');

  const outcome = store.satisfyDeclaredObligation({
    sessionId: chain.task.sessionId,
    sourceUserSeq: chain.task.sourceUserSeq,
    manifestId: chain.manifest.manifestId,
    nodeId: fixture.WRITE_CHILD,
    obligation: 'verify_committed_readback',
    receiptId: issued.receiptId,
    physicalAttemptId: evidence.physicalAttemptId,
  });
  assert.equal(outcome.ok, false, 'nothing can verify a commit that has not been proved');
  assert.match(String((outcome as { reason: string }).reason), /commit_effect/);
});

test('A2d: a generic successful read cannot be relabelled as a read-back', () => {
  const chain = fixture.buildEvidenceChain({ label: 'a2d', omit: 'stale_destination_reconciled' });
  // Real, authoritative bytes — but they say nothing about reconciliation.
  const generic = fixture.redeemableOccurrence(chain.task, {
    tool: 'alpha__list_records', effect: 'read', output: { records: [{ id: 'r1' }], complete: true },
  });
  const collection = receipts.issueCollectionReceipt({
    identity: {
      sessionId: chain.task.sessionId, sourceUserSeq: chain.task.sourceUserSeq,
      physicalAttemptId: generic.physicalAttemptId, callId: generic.callId,
      tool: generic.tool, effect: generic.effect,
    },
    recordIdentities: ['r1'], continuationOutstanding: false,
  });
  assert.ok(collection.receiptId);

  const outcome = store.satisfyDeclaredObligation({
    sessionId: chain.task.sessionId,
    sourceUserSeq: chain.task.sourceUserSeq,
    manifestId: chain.manifest.manifestId,
    nodeId: fixture.WRITE_CHILD,
    obligation: 'stale_destination_reconciled',
    receiptId: collection.receiptId,
    physicalAttemptId: generic.physicalAttemptId,
  });
  assert.equal(outcome.ok, false, 'a collection receipt does not prove reconciliation');
});

test('A2e: an UNRESOLVED action node cannot finalise as an empty manifest', async () => {
  const task = fixture.acceptTask('a2e', 'read the alpha source and write it into the beta sink');
  const shadow = await import('./graph/turn-graph-shadow.js');
  const manifests = await import('./harness/obligation-manifest.js');

  const recorded = shadow.recordTurnGraphShadow({
    identity: { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, turn: task.turn },
  });
  assert.ok(recorded, 'precondition: the graph is recorded');

  // No resolution supplied: the execute node's effect is still unknown.
  const compiled = manifests.compileObligationManifest({
    graph: (recorded.data as Record<string, unknown>).graph as never,
  });
  assert.equal(
    compiled.manifest.readiness,
    'unresolved',
    'action work whose effect is unknown has no knowable obligations yet',
  );
  assert.equal(
    store.persistObligationManifest(compiled.manifest),
    false,
    'freezing an empty obligation set for half-planned action work would declare it owes nothing',
  );
  assert.equal(
    store.loadManifestState(task.sessionId, task.sourceUserSeq).status,
    'missing',
    'and a missing manifest must stay distinguishable from a zero-obligation conversational one',
  );
});

test('A2f: a caller cannot relabel a write as a read, nor omit the write operation', async () => {
  const task = fixture.acceptTask('a2f', 'send every alpha record to the beta recipients');
  const shadow = await import('./graph/turn-graph-shadow.js');
  const manifests = await import('./harness/obligation-manifest.js');
  const resolution = await import('./harness/resolution-ledger.js');
  const recorded = shadow.recordTurnGraphShadow({
    identity: { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, turn: task.turn },
  });
  const graph = (recorded as { data: Record<string, unknown> }).data.graph as never;

  // The host observes a sending capability. There is no caller-supplied effect
  // or resolution array to relabel: taxonomy/runtime classification owns it.
  assert.equal(resolution.recordResolvedOperation({
    sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, turn: task.turn,
    nodeId: fixture.EXECUTE_NODE, operationId: 'w', resolvedTool: 'alpha_records_send',
    logicalToolCallId: 'call:a2f-send',
  }), true);
  assert.equal(resolution.finalizeResolution({
    sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, turn: task.turn,
  }), true);
  const relabelled = manifests.compileObligationManifest({ graph });
  const node = relabelled.manifest.nodes.find((entry) => entry.operationId === 'w');
  assert.equal(node?.effectKind, 'external_write', 'the capability decides the effect, not the caller');
  assert.equal(node?.reversibility, 'irreversible');

  // A fresh task with the SAME write-shaped expectation observes only a read.
  // Closing it records expectationsSatisfied:false, so the smaller operation set
  // cannot become a ready read-only authority for the requested send.
  const partialTask = fixture.acceptTask('a2f-partial', 'send every alpha record to the beta recipients');
  const partialRecorded = shadow.recordTurnGraphShadow({
    identity: {
      sessionId: partialTask.sessionId,
      sourceUserSeq: partialTask.sourceUserSeq,
      turn: partialTask.turn,
    },
  });
  const partialGraph = (partialRecorded as { data: Record<string, unknown> }).data.graph as never;
  assert.equal(resolution.recordResolvedOperation({
    sessionId: partialTask.sessionId,
    sourceUserSeq: partialTask.sourceUserSeq,
    turn: partialTask.turn,
    nodeId: fixture.EXECUTE_NODE,
    operationId: 'r',
    resolvedTool: 'alpha_records_search',
    logicalToolCallId: 'call:a2f-read-only',
  }), true);
  assert.equal(resolution.finalizeResolution({
    sessionId: partialTask.sessionId,
    sourceUserSeq: partialTask.sourceUserSeq,
    turn: partialTask.turn,
  }), true);
  const partial = manifests.compileObligationManifest({ graph: partialGraph });
  assert.equal(
    partial.manifest.readiness,
    'unresolved',
    'a read-only observation cannot cover an accepted external-write expectation',
  );
  assert.equal(
    store.persistObligationManifest(partial.manifest),
    false,
    'the partial observed set never becomes terminal authority',
  );
  assert.notEqual(
    partial.manifest.manifestId,
    relabelled.manifest.manifestId,
    'an omitted operation is a different manifest, not a smaller one',
  );
});

// ── A3. Integrity ────────────────────────────────────────────────────────────
// Enters: evidence-receipts.redeemEvidenceReceipt

test('A3: altering the backing bytes after issue makes redemption fail closed', () => {
  const chain = fixture.buildEvidenceChain({ label: 'a3' });
  const receiptId = chain.receipts.get(`${fixture.READ_CHILD}|source_completeness`) as string;
  const before = receipts.redeemEvidenceReceipt(chain.task.sessionId, receiptId, {
    sourceUserSeq: chain.task.sourceUserSeq,
  });
  assert.equal(before.ok, true, 'precondition: the receipt redeems while its bytes are intact');

  const callId = String((before as { receipt: Record<string, unknown> }).receipt.callId);
  // Replace the EXACT invocation row authority reads. Writing a legacy row
  // instead proves nothing: the nonce-keyed row still wins, which is correct.
  const nonce = eventlog.listToolOutputInvocations(chain.task.sessionId, callId)[0]?.invocationNonce;
  assert.ok(nonce, 'precondition: the evidence is a nonce-bearing invocation');
  eventlog.writeToolOutput({
    sessionId: chain.task.sessionId, callId, tool: 'alpha__list_records',
    invocationNonce: nonce,
    output: JSON.stringify({ records: [{ id: 'TAMPERED' }], complete: true }),
  });

  const after = receipts.redeemEvidenceReceipt(chain.task.sessionId, receiptId, {
    sourceUserSeq: chain.task.sourceUserSeq,
  });
  assert.equal(after.ok, false, 'a receipt whose evidence changed no longer describes what is there');
});

test('A3b: truncated evidence cannot prove completeness', () => {
  const task = fixture.acceptTask('a3b');
  const evidence = fixture.recordOccurrence(task, {
    tool: 'alpha__list_records', effect: 'read',
    output: { records: [{ id: 'r1' }], complete: true },
  });
  const issued = receipts.issueCollectionReceipt({
    identity: {
      sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq,
      physicalAttemptId: evidence.physicalAttemptId, callId: evidence.callId,
      tool: evidence.tool, effect: evidence.effect,
    },
    recordIdentities: ['r1'],
    continuationOutstanding: true,
  });
  assert.equal(issued.receiptId, undefined, 'an outstanding continuation is not a complete collection');
});

// ── A4. Once-only, across processes and restarts ─────────────────────────────
// Enters: obligation-store.satisfyDeclaredObligation

test('A4: the identical satisfaction wins once and appends one transition', () => {
  const chain = fixture.buildEvidenceChain({ label: 'a4', omit: 'stale_destination_reconciled' });
  const evidence = fixture.redeemableOccurrence(chain.task, {
    tool: 'beta__read_rows', effect: 'read', output: { rows: [] },
  });
  const issued = receipts.issueReconciliationReceipt({
    identity: {
      sessionId: chain.task.sessionId, sourceUserSeq: chain.task.sourceUserSeq,
      physicalAttemptId: evidence.physicalAttemptId, callId: evidence.callId,
      tool: evidence.tool, effect: evidence.effect,
    },
    before: { rows: [] }, after: { rows: [] }, staleRemaining: 0, target: 'beta:sink-1',
  });
  const request = {
    sessionId: chain.task.sessionId,
    sourceUserSeq: chain.task.sourceUserSeq,
    manifestId: chain.manifest.manifestId,
    nodeId: fixture.WRITE_CHILD,
    obligation: 'stale_destination_reconciled',
    receiptId: issued.receiptId as string,
    physicalAttemptId: evidence.physicalAttemptId,
  };

  assert.equal(store.satisfyDeclaredObligation(request).ok, true, 'the first valid satisfaction wins');
  assert.equal(store.satisfyDeclaredObligation(request).ok, false, 'the resubmission loses');

  const transitions = store.satisfiedObligations(chain.task.sessionId, chain.task.sourceUserSeq)
    .filter((entry) => entry.obligation === 'stale_destination_reconciled');
  assert.equal(transitions.length, 1, 'exactly one durable transition');
  const mirrors = eventlog.listEvents(chain.task.sessionId, { types: ['obligation_satisfied'] })
    .filter((event) => event.data.obligation === 'stale_destination_reconciled');
  assert.equal(mirrors.length, 1, 'the winning transition and its audit mirror commit together');
});

test('A4b: two CONCURRENT processes released together produce exactly one winner', async () => {
  const chain = fixture.buildEvidenceChain({ label: 'a4b', omit: 'stale_destination_reconciled' });
  const evidence = fixture.redeemableOccurrence(chain.task, {
    tool: 'beta__read_rows', effect: 'read', output: { rows: [] },
  });
  const issued = receipts.issueReconciliationReceipt({
    identity: {
      sessionId: chain.task.sessionId, sourceUserSeq: chain.task.sourceUserSeq,
      physicalAttemptId: evidence.physicalAttemptId, callId: evidence.callId,
      tool: evidence.tool, effect: evidence.effect,
    },
    before: { rows: [] }, after: { rows: [] }, staleRemaining: 0, target: 'beta:sink-1',
  });
  const request = {
    sessionId: chain.task.sessionId,
    sourceUserSeq: chain.task.sourceUserSeq,
    manifestId: chain.manifest.manifestId,
    nodeId: fixture.WRITE_CHILD,
    obligation: 'stale_destination_reconciled',
    receiptId: issued.receiptId as string,
    physicalAttemptId: evidence.physicalAttemptId,
  };

  const readyDir = path.join(TMP_HOME, `ready-${chain.task.sourceUserSeq}`);
  mkdirSync(readyDir, { recursive: true });
  const barrier = path.join(TMP_HOME, `barrier-${chain.task.sourceUserSeq}`);

  const childFor = (id: string): string => {
    const file = path.join(TMP_HOME, `race-${chain.task.sourceUserSeq}-${id}.mts`);
    writeFileSync(file, childSource(`
      import { existsSync, writeFileSync } from 'node:fs';
      const s = await import(${JSON.stringify(path.resolve('src/runtime/harness/obligation-store.ts'))});
      writeFileSync(${JSON.stringify(path.join(readyDir, id))}, 'ready', 'utf-8');
      while (!existsSync(${JSON.stringify(barrier)})) { await new Promise((r) => setTimeout(r, 5)); }
      const outcome = s.satisfyDeclaredObligation(${JSON.stringify(request)});
      process.stdout.write('WON=' + outcome.ok + '\\n');
    `), 'utf-8');
    return file;
  };

  const running = [runChild(childFor('a')), runChild(childFor('b'))];
  // Release only once BOTH children have reported ready — never on a timer.
  const { readdirSync } = await import('node:fs');
  const deadline = Date.now() + 120_000;
  while (readdirSync(readyDir).length < 2) {
    if (Date.now() > deadline) throw new Error('children never reached the barrier');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  writeFileSync(barrier, 'go', 'utf-8');

  const finished = await Promise.all(running);
  for (const child of finished) {
    assert.equal(child.code, 0, `a child exited non-zero: ${child.out.slice(-400)}`);
  }
  const winners = finished.filter((child) => /WON=true/.test(child.out)).length;
  assert.equal(winners, 1, 'a database CAS boundary must admit exactly one concurrent winner');

  const transitions = store.satisfiedObligations(chain.task.sessionId, chain.task.sourceUserSeq)
    .filter((entry) => entry.obligation === 'stale_destination_reconciled');
  assert.equal(transitions.length, 1, 'exactly one durable transition survives the race');
});

test('A4c: a FRESH process cannot re-satisfy what is already proved', async () => {
  const chain = fixture.buildEvidenceChain({ label: 'a4c' });
  const request = {
    sessionId: chain.task.sessionId,
    sourceUserSeq: chain.task.sourceUserSeq,
    manifestId: chain.manifest.manifestId,
    nodeId: fixture.WRITE_CHILD,
    obligation: 'commit_effect',
    receiptId: chain.receipts.get(`${fixture.WRITE_CHILD}|commit_effect`),
    physicalAttemptId: chain.attempts.get(`${fixture.WRITE_CHILD}|commit_effect`),
  };
  const file = path.join(TMP_HOME, `restart-${chain.task.sourceUserSeq}.mts`);
  writeFileSync(file, childSource(`
    const s = await import(${JSON.stringify(path.resolve('src/runtime/harness/obligation-store.ts'))});
    const outcome = s.satisfyDeclaredObligation(${JSON.stringify(request)});
    process.stdout.write('WON=' + outcome.ok + '\\n');
  `), 'utf-8');

  const child = await runChild(file);
  assert.equal(child.code, 0, `child failed: ${child.out.slice(-400)}`);
  assert.match(child.out, /WON=false/, 'dedupe must survive a real process boundary');
});

// ── A5. The manifest survives a restart, exactly ─────────────────────────────
// Enters: obligation-store.loadObligationManifest in a separate process

test('A5: the authoritative manifest reopens in another process, byte-identical', async () => {
  const chain = fixture.buildEvidenceChain({ label: 'a5', manifestOnly: true });
  const file = path.join(TMP_HOME, `reopen-${chain.task.sourceUserSeq}.mts`);
  writeFileSync(file, childSource(`
    const s = await import(${JSON.stringify(path.resolve('src/runtime/harness/obligation-store.ts'))});
    const m = s.loadObligationManifest(${JSON.stringify(chain.task.sessionId)}, ${chain.task.sourceUserSeq});
    process.stdout.write('MANIFEST=' + JSON.stringify(m ?? null) + '\\n');
  `), 'utf-8');

  const child = await runChild(file);
  assert.equal(child.code, 0, `child failed: ${child.out.slice(-400)}`);
  const loaded = JSON.parse(/MANIFEST=(.*)/.exec(child.out)?.[1] ?? 'null');
  assert.ok(loaded, 'the manifest must rehydrate in a fresh process');

  assert.deepEqual(loaded, chain.manifest, 'canonical equality: identity, nodes, effects, obligations, dependencies');
  assert.equal(loaded.manifestId, chain.manifest.manifestId, 'recomputed content address matches');
  assert.equal(loaded.graphHash, chain.manifest.graphHash, 'pinned to the exact graph it refines');
  assert.equal(loaded.mode, 'authoritative');
});

test('A5b: the authority key is session + source + graph hash, not a bare graph id', async () => {
  const a = fixture.buildEvidenceChain({ label: 'a5b-a', manifestOnly: true });
  const b = fixture.buildEvidenceChain({ label: 'a5b-b', manifestOnly: true, writeMode: 'irreversible' });

  // Two accepted turns in different sessions may share a graphId; the manifest
  // must still be distinguishable, because it is addressed by content.
  assert.notEqual(a.manifest.manifestId, b.manifest.manifestId, 'different work, different manifest');
  assert.notEqual(a.task.sessionId, b.task.sessionId);

  const loadedA = store.loadObligationManifest(a.task.sessionId, a.task.sourceUserSeq);
  const loadedB = store.loadObligationManifest(b.task.sessionId, b.task.sourceUserSeq);
  assert.equal(loadedA?.manifestId, a.manifest.manifestId, 'each session resolves its own manifest');
  assert.equal(loadedB?.manifestId, b.manifest.manifestId);
});

test('A5c: a tampered manifest does not load', () => {
  const chain = fixture.buildEvidenceChain({ label: 'a5c', manifestOnly: true });
  const tampered = {
    ...chain.manifest,
    nodes: chain.manifest.nodes.map((node) => ({ ...node, obligations: [] })),
  };
  assert.equal(
    store.persistObligationManifest(tampered as never),
    false,
    'a manifest whose content no longer matches its address is not a manifest',
  );
});

// ── A6. Terminal truth ───────────────────────────────────────────────────────
// Enters: harness/terminal-truth.adjudicateTerminalForTask

async function completeExecutionFor(task: fixture.AcceptedTask): Promise<void> {
  const { ExecutionStore } = await import('../execution/store.js');
  const executions = new ExecutionStore();
  const created = executions.create({
    sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq,
    title: 'source to sink', objective: 'read the alpha source and write it into the beta sink',
    reason: 'test', startedFromMessage: 'do the thing', confidence: 1, reasons: ['fixture'],
  });
  executions.update(created.id, { status: 'completed' });
}

test('A6: a fully evidenced task with a closed execution reaches done', async () => {
  const chain = fixture.buildEvidenceChain({ label: 'a6' });
  await completeExecutionFor(chain.task);

  const verdict = await terminal.adjudicateTerminalForTask({
    sessionId: chain.task.sessionId, sourceUserSeq: chain.task.sourceUserSeq,
  });
  assert.equal(
    verdict.status,
    'done',
    'terminal truth still reads the old requirement-graph rather than the authoritative manifest, '
    + `so done is unreachable (missing: ${verdict.missing.join(', ')})`,
  );
});

test('A6b: each missing proof blocks, and supplying it on the SAME task releases', async () => {
  const cases: Array<[string, string]> = [
    ['verify_committed_readback', 'exact_read_back'],
    ['stale_destination_reconciled', 'stale_destination_reconciled'],
  ];
  for (const [omitted, classification] of cases) {
    const chain = fixture.buildEvidenceChain({ label: `a6b-${omitted}`, omit: omitted });
    await completeExecutionFor(chain.task);

    const blocked = await terminal.adjudicateTerminalForTask({
      sessionId: chain.task.sessionId, sourceUserSeq: chain.task.sourceUserSeq,
    });
    assert.notEqual(blocked.status, 'done', `omitting ${omitted} must block`);
    assert.deepEqual(
      blocked.missing,
      [classification],
      `omitting ${omitted} must report exactly ['${classification}'], got ${JSON.stringify(blocked.missing)}`,
    );

    // Repair on the SAME accepted task, then re-adjudicate.
    const repaired = fixture.proveObligation(chain, omitted);
    assert.equal(repaired.ok, true, `supplying ${omitted} must succeed: ${JSON.stringify(repaired)}`);

    const released = await terminal.adjudicateTerminalForTask({
      sessionId: chain.task.sessionId, sourceUserSeq: chain.task.sourceUserSeq,
    });
    assert.equal(released.status, 'done', `supplying ${omitted} on the same task must reach done`);
  }
});

test('A6c: an open execution is the SOLE missing item, and closing it reaches done', async () => {
  const chain = fixture.buildEvidenceChain({ label: 'a6c' });
  const { ExecutionStore } = await import('../execution/store.js');
  const executions = new ExecutionStore();
  const open = executions.create({
    sessionId: chain.task.sessionId, sourceUserSeq: chain.task.sourceUserSeq,
    title: 'still running', objective: 'read the alpha source and write it into the beta sink',
    reason: 'test', startedFromMessage: 'do the thing', confidence: 1, reasons: ['fixture'],
  });

  const blocked = await terminal.adjudicateTerminalForTask({
    sessionId: chain.task.sessionId, sourceUserSeq: chain.task.sourceUserSeq,
  });
  assert.deepEqual(
    blocked.missing,
    ['execution_terminal'],
    'every proof but the execution is in place, so nothing else may be reported missing',
  );

  executions.update(open.id, { status: 'completed' });
  const released = await terminal.adjudicateTerminalForTask({
    sessionId: chain.task.sessionId, sourceUserSeq: chain.task.sourceUserSeq,
  });
  assert.equal(released.status, 'done', 'closing the execution releases the turn');
});

// ── A7. The terminal boundary ────────────────────────────────────────────────
// Enters: harness/delivery-committer.commitTurnOutcome

async function commitDone(task: fixture.AcceptedTask, text: string): Promise<Record<string, unknown>> {
  const { commitTurnOutcome } = await import('./harness/delivery-committer.js');
  const committed = commitTurnOutcome({
    version: 2,
    id: `turn:${task.sourceUserSeq}`,
    status: 'done',
    resumable: false,
    identity: { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, turn: task.turn },
    presentation: { kind: 'answer', text },
  } as never);
  return (committed as { event: { data: Record<string, unknown> } }).event.data;
}

test('A7: a turn missing ONE proof cannot commit a delivered done winner', async () => {
  // A closed execution and a real effect graph: only the read-back is missing,
  // so an "active execution only" patch cannot satisfy this.
  const chain = fixture.buildEvidenceChain({ label: 'a7', omit: 'verify_committed_readback' });
  await completeExecutionFor(chain.task);

  const proposed = 'Done — I read the source and wrote the sink.';
  const data = await commitDone(chain.task, proposed);

  assert.notEqual(
    (data.turnOutcome as Record<string, unknown>)?.status,
    'done',
    'the write was never read back, and commitTurnOutcome never consults terminal truth',
  );
  assert.equal(data.delivered, false, 'an unverified turn is not delivered');
  assert.notEqual(data.reply, proposed, 'the proposed Done text must not be delivered verbatim');
});

test('A7b: a fully evidenced turn DOES commit a delivered done winner', async () => {
  const chain = fixture.buildEvidenceChain({ label: 'a7b' });
  await completeExecutionFor(chain.task);

  const text = 'I copied all 2 records into the sink and read them back.';
  const data = await commitDone(chain.task, text);
  assert.equal((data.turnOutcome as Record<string, unknown>)?.status, 'done', 'verified work completes');
  assert.equal(data.delivered, true);
  assert.equal(data.reply, text);
});

test('A7c: a conversational turn declares zero business obligations and commits', async () => {
  const task = fixture.acceptTask('a7c', 'hello');
  const shadow = await import('./graph/turn-graph-shadow.js');
  const manifestModule = await import('./harness/obligation-manifest.js');

  const recorded = shadow.recordTurnGraphShadow({
    identity: { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, turn: task.turn },
  });
  assert.ok(recorded, 'precondition: the conversational graph is recorded');
  assert.equal(
    ((recorded.data as Record<string, unknown>).graph as { classification?: { route?: string } })
      .classification?.route,
    'direct_reply',
    'precondition: this fixture is genuinely conversational, not an unevidenced lookup',
  );
  const resolution = await import('./harness/resolution-ledger.js');
  assert.equal(resolution.finalizeResolution({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
  }), true, 'a conversational task atomically closes with zero business operations');
  const compiled = manifestModule.compileObligationManifest({
    graph: (recorded.data as Record<string, unknown>).graph as never,
  });
  assert.ok(compiled.validation.ok);
  assert.ok(store.persistObligationManifest(compiled.manifest), 'precondition: persisted');

  const reloaded = store.loadObligationManifest(task.sessionId, task.sourceUserSeq);
  assert.deepEqual(
    reloaded?.nodes ?? [],
    [],
    'a turn that resolves no effect owes nothing; inventing an obligation would block honest answers',
  );

  const text = 'Hello! How can I help?';
  const data = await commitDone(task, text);
  assert.equal((data.turnOutcome as Record<string, unknown>)?.status, 'done');
  assert.equal(data.delivered, true);
  assert.equal(data.reply, text);
});

// ── A8. Fan-out block and release ────────────────────────────────────────────
// Enters: execution/durable-fanout.admitDurableFanoutPlan + scheduleDurableFanout

test('A8: real scheduled workers block the parent, and settling them releases it', async () => {
  const chain = fixture.buildEvidenceChain({ label: 'a8' });
  await completeExecutionFor(chain.task);
  const fanout = await import('../execution/durable-fanout.js');
  const background = await import('../execution/background-tasks.js');

  const before = await terminal.adjudicateTerminalForTask({
    sessionId: chain.task.sessionId, sourceUserSeq: chain.task.sourceUserSeq,
  });
  assert.equal(before.status, 'done', 'precondition: the parent alone is fully evidenced');

  const admission = fanout.admitDurableFanoutPlan(
    {
      kind: 'durable_manifest',
      objective: 'write one shard per item',
      successCriteria: ['every shard is durably settled and reduced'],
      missingRequiredInputs: [],
      effectCeiling: 'write',
      estimatedActivations: 2,
      manifest: {
        manifestId: 'a8-shards-v1',
        contractVersion: 'v1',
        canonicalItems: [{ id: 'shard-1' }, { id: 'shard-2' }],
        phases: [{ id: 'write', dependsOn: [], runnerClass: 'worker' }],
        reducer: { id: 'reduce', requiredPhases: ['write'], outputContract: 'report@1' },
      },
    } as never,
    { originSessionId: chain.task.sessionId, sourceUserSeq: chain.task.sourceUserSeq } as never,
  );
  const planId = (admission as { plan?: { planId?: string } }).plan?.planId;
  assert.ok(planId, `fixture precondition: plan admitted (${JSON.stringify(admission).slice(0, 200)})`);

  const scheduled = fanout.scheduleDurableFanout(planId);
  const workers = (scheduled as { workerTasks?: Array<{ id: string }> })?.workerTasks ?? [];
  assert.ok(
    workers.length > 0,
    `fixture precondition: at least one REAL worker must exist, got ${workers.length}`,
  );

  const during = await terminal.adjudicateTerminalForTask({
    sessionId: chain.task.sessionId, sourceUserSeq: chain.task.sourceUserSeq,
  });
  assert.ok(
    during.missing.includes('execution_terminal'),
    'terminal truth reads only ExecutionStore, which never sees the durable fan-out ledger, '
    + 'so the parent reports terminal while its workers are still writing',
  );

  // Worker task files are scheduling state, not item evidence. Merely marking
  // them done must NOT release the parent while the item×phase journal and
  // reducer remain open.
  for (const worker of workers) {
    background.markBackgroundTaskDone(worker.id, 'shard written');
  }
  const workersOnly = await terminal.adjudicateTerminalForTask({
    sessionId: chain.task.sessionId, sourceUserSeq: chain.task.sourceUserSeq,
  });
  assert.ok(
    workersOnly.missing.includes('execution_terminal'),
    'a worker saying it stopped is not durable proof that every shard settled or was reduced',
  );

  const taskState = (taskId: string): 'alive' | 'done' | 'failed' | 'missing' => {
    const task = background.getBackgroundTask(taskId);
    if (!task) return 'missing';
    if (task.status === 'pending' || task.status === 'running') return 'alive';
    if (task.status === 'done') return 'done';
    return 'failed';
  };
  const recovery = fanout.reconcileDurableFanout({ taskState });
  assert.ok(recovery.rescheduled.includes(planId),
    'ordinary reconciliation must retire the dead worker generation and reschedule its open window');

  const replacementWindows = fanout.listFanoutWindows(planId);
  for (const window of replacementWindows) {
    assert.ok(window.runSessionId && window.workerTaskId,
      'a replacement window must carry authenticated worker authority');
    for (const itemId of window.itemIds) {
      const settled = fanout.settleFanoutActivationAs({
        planId,
        itemId,
        phaseId: 'write',
        status: 'done',
        receiptRef: `receipt:${itemId}:write`,
        callerRunSessionId: window.runSessionId!,
      });
      assert.equal(settled.settled, true, JSON.stringify(settled));
    }
    background.markBackgroundTaskDone(window.workerTaskId!, 'authenticated shard window settled');
  }

  const reducerAdmission = fanout.reconcileDurableFanout({ taskState, reducerOwner: 'a8-test-reducer' });
  assert.ok(reducerAdmission.reduced.includes(planId),
    'ordinary reconciliation must close settled windows and admit the reducer');
  const reducerPlan = fanout.loadFanoutPlan(planId);
  assert.ok(reducerPlan?.reducerTaskId, 'the reducer must be a real scheduled background task');
  background.markBackgroundTaskDone(reducerPlan!.reducerTaskId!, 'combined result delivered');
  fanout.reconcileDurableFanout({ taskState });
  assert.equal(fanout.loadFanoutPlan(planId)?.status, 'reduced',
    'the reducer task terminal must be mapped through ordinary reconciliation');

  const after = await terminal.adjudicateTerminalForTask({
    sessionId: chain.task.sessionId, sourceUserSeq: chain.task.sourceUserSeq,
  });
  assert.equal(after.status, 'done', 'completing every worker must release the SAME parent');
});

// ── A9. Paginator unit contract ──────────────────────────────────────────────
// Enters: harness/host-pagination.collectCompleteSource

test('A9: a repeated cursor stops the collection and keeps it partial', async () => {
  const pagination = await import('./harness/host-pagination.js');
  const cursors = ['c1', 'c1', 'c2'];
  let page = 0;
  const result = await pagination.collectCompleteSource({
    read: async () => {
      const cursor = cursors[page];
      page += 1;
      return {
        successful: true,
        data: { items: [{ id: `r${page}` }], next_cursor: page < cursors.length ? cursor : undefined },
      };
    },
  } as never);

  assert.equal(result.complete, false, 'a provider repeating a cursor is looping, not completing');
  assert.match(String(result.stopReason), /cursor/i, 'the repeat must be named, not silently followed');
});
