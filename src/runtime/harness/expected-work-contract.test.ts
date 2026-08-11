import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-expected-work-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-expected-work\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const authority = await import('./accepted-task-authority.js');
const contracts = await import('./expected-work-contract.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function accept(text: string) {
  const session = eventlog.createSession({ id: `expected-work-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  const graphEvent = shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  });
  assert.ok(graphEvent, 'fixture has one exact persisted graph');
  assert.equal(authority.armAcceptedTaskAuthority({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  }).status, 'armed');
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    graphEvent,
    graph: graphEvent.data.graph as import('../graph/turn-graph-ir.js').TurnGraphIR,
  };
}

function compoundProposal(): contracts.ExpectedWorkProposalV1 {
  return {
    version: 1,
    operations: [
      {
        id: 'source_snapshot',
        effect: 'read',
        coverage: 'complete_set',
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      },
      {
        id: 'commit_destination',
        effect: 'external_write',
        dependsOn: ['source_snapshot'],
        dataFrom: ['source_snapshot'],
        cardinality: { kind: 'once' },
      },
    ],
    universes: [],
  };
}

function writeOnlyProposal(): contracts.ExpectedWorkProposalV1 {
  return {
    version: 1,
    operations: [{
      id: 'commit_destination',
      effect: 'external_write',
      dependsOn: [],
      dataFrom: [],
      cardinality: { kind: 'once' },
    }],
    universes: [],
  };
}

test('migration 29 installs immutable contract authority and an optional authority binding', () => {
  const db = eventlog.openEventLog();
  assert.ok(db.prepare('SELECT 1 FROM schema_version WHERE version = 29').get());
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  assert.ok(tables.has('accepted_task_work_contracts'));
  const authorityColumns = new Set(
    (db.prepare('PRAGMA table_info(accepted_task_authority)').all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  assert.ok(authorityColumns.has('work_contract_id'));
});

test('direct conversation freezes a deterministic empty contract without tools or scripts', () => {
  const task = accept('Hello, how are you?');
  const compiled = contracts.compileDeterministicExpectedWorkProposal(task.graph);
  assert.deepEqual(compiled, { version: 1, operations: [], universes: [] });
  const fixed = contracts.freezeDeterministicExpectedWorkContract(task);
  assert.equal(fixed.status, 'fixed');
  if (fixed.status !== 'fixed') return;
  assert.equal(fixed.contract.plannerSource, 'deterministic');
  assert.deepEqual(fixed.contract.operations, []);
  assert.deepEqual(fixed.contract.universes, []);
  assert.match(fixed.contract.contractId, /^expected-work:v1:[a-f0-9]{64}$/);
  const encoded = JSON.stringify(fixed.contract);
  assert.equal(encoded.includes('tool'), false);
  assert.equal(encoded.includes('provider'), false);
  const armed = authority.loadAcceptedTaskAuthority(task.sessionId, task.sourceUserSeq);
  assert.equal(armed.status, 'ok');
  assert.equal(armed.status === 'ok' && armed.authority.workContractId, fixed.contract.contractId);
});

test('retrieve freezes one provider-neutral read without asserting point or collection coverage', () => {
  const task = accept('What is the current status of the Acme account?');
  const proposal = contracts.compileDeterministicExpectedWorkProposal(task.graph);
  assert.ok(proposal);
  assert.deepEqual(proposal?.universes, []);
  assert.deepEqual(proposal?.operations, [{
    id: task.graph.nodes.find((node) => node.kind === 'retrieve')?.id,
    effect: 'read',
    coverage: 'resolved_operation',
    dependsOn: [],
    dataFrom: [],
    cardinality: { kind: 'once' },
  }]);
  const fixed = contracts.freezeDeterministicExpectedWorkContract(task);
  assert.equal(fixed.status, 'fixed');
  assert.equal(fixed.status === 'fixed' && fixed.contract.operations.length, 1);
  assert.notEqual(
    fixed.status === 'fixed' && fixed.contract.operations[0]?.coverage,
    'complete_set',
    'a deterministic lookup never manufactures an exhaustion requirement',
  );
});

test('an arbitrary action requires an explicit validated proposal and exact replay survives restart', () => {
  const task = accept('Email alex@example.com with the update.');
  assert.equal(contracts.compileDeterministicExpectedWorkProposal(task.graph), null);
  assert.equal(contracts.freezeDeterministicExpectedWorkContract(task).status, 'planning_required');

  const first = contracts.freezeActionExpectedWorkContract({ ...task, proposal: compoundProposal() });
  assert.equal(first.status, 'fixed');
  if (first.status !== 'fixed') return;
  assert.equal(first.contract.plannerSource, 'structured_model');
  assert.equal(first.contract.operations.length, 2);

  const reordered: contracts.ExpectedWorkProposalV1 = {
    version: 1,
    operations: [...compoundProposal().operations].reverse(),
    universes: [],
  };
  const replay = contracts.freezeActionExpectedWorkContract({ ...task, proposal: reordered });
  assert.equal(replay.status, 'replayed');
  assert.equal(replay.status === 'replayed' && replay.contract.contractId, first.contract.contractId);

  eventlog.closeEventLog();
  const loaded = contracts.loadExpectedWorkContract(task.sessionId, task.sourceUserSeq);
  assert.equal(loaded.status, 'ok');
  assert.deepEqual(loaded.status === 'ok' && loaded.contract, first.contract);
});

test('the staged production binder defers an action without guessing or poisoning it', () => {
  const task = accept('Email alex@example.com with the update.');
  assert.deepEqual(contracts.requireKnownExpectedWorkContract(task), { status: 'action_deferred' });
  assert.equal(contracts.loadExpectedWorkContract(task.sessionId, task.sourceUserSeq).status, 'missing');
  const armed = authority.loadAcceptedTaskAuthority(task.sessionId, task.sourceUserSeq);
  assert.equal(armed.status === 'ok' && armed.authority.state, 'armed');
  assert.equal(armed.status === 'ok' && armed.authority.workContractId, undefined);
});

test('an external action cannot be weakened to a local write effect', () => {
  const task = accept('Email alex@example.com with the update.');
  const localOnly: contracts.ExpectedWorkProposalV1 = {
    version: 1,
    operations: [{
      id: 'commit_local_document',
      effect: 'local_write',
      dependsOn: [],
      dataFrom: [],
      cardinality: { kind: 'once' },
    }],
    universes: [],
  };
  const result = contracts.freezeActionExpectedWorkContract({ ...task, proposal: localOnly });
  assert.equal(result.status, 'invalid');
  assert.match(result.status === 'invalid' ? result.reason : '', /external-write/);
  assert.equal(contracts.loadExpectedWorkContract(task.sessionId, task.sourceUserSeq).status, 'missing');
});

test('strict validation rejects unknown fields, dangling/cyclic lineage, and invalid universe cardinality', () => {
  const base = compoundProposal();
  assert.equal(contracts.validateExpectedWorkProposal(base).ok, true);
  assert.equal(contracts.validateExpectedWorkProposal({
    version: 1,
    operations: [
      base.operations[0],
      {
        ...base.operations[1],
        cardinality: { kind: 'each', universeId: 'source_items' },
      },
    ],
    universes: [{
      id: 'source_items',
      seal: 'complete_source_receipt',
      producedBy: 'source_snapshot',
    }],
  }).ok, true, 'a sealed read-to-per-item-write fanout is a first-class structural contract');
  const cases: unknown[] = [
    { ...base, objective: 'hidden prose phase' },
    { ...base, operations: [{ ...base.operations[0], tool: 'OUTLOOK_LIST_EVENTS' }, base.operations[1]] },
    { ...base, operations: [{ ...base.operations[0], dependsOn: ['missing'] }, base.operations[1]] },
    {
      ...base,
      operations: [
        { ...base.operations[0], dependsOn: ['commit_destination'] },
        { ...base.operations[1], dependsOn: ['source_snapshot'] },
      ],
    },
    {
      ...base,
      operations: [{ ...base.operations[0], cardinality: { kind: 'each', universeId: 'missing' } }, base.operations[1]],
    },
    {
      version: 1,
      operations: [{ ...base.operations[0], cardinality: { kind: 'each', universeId: 'items' } }],
      universes: [{ id: 'items', seal: 'complete_source_receipt', producedBy: 'source_snapshot' }],
    },
  ];
  for (const candidate of cases) {
    assert.equal(contracts.validateExpectedWorkProposal(candidate).ok, false, JSON.stringify(candidate));
  }
});

test('a finite accepted-input batch is distinct from per-item and whole-source coverage', () => {
  const finiteBatch: contracts.ExpectedWorkProposalV1 = {
    version: 1,
    operations: [{
      id: 'read_requested_ranges',
      effect: 'read',
      coverage: 'accepted_set',
      dependsOn: [],
      dataFrom: [],
      cardinality: { kind: 'set', universeId: 'requested_ranges' },
    }],
    universes: [{
      id: 'requested_ranges',
      seal: 'accepted_input',
      members: ['Sheet1!A1:B2', 'Sheet1!D1:E2'],
    }],
  };
  const validated = contracts.validateExpectedWorkProposal(finiteBatch);
  assert.equal(validated.ok, true, validated.ok ? undefined : validated.errors.join('; '));
  if (!validated.ok) return;
  assert.deepEqual(validated.proposal.operations[0]?.cardinality, {
    kind: 'set',
    universeId: 'requested_ranges',
  });
  assert.equal(validated.proposal.operations[0]?.coverage, 'accepted_set');

  const wrongCoverage = contracts.validateExpectedWorkProposal({
    ...finiteBatch,
    operations: [{ ...finiteBatch.operations[0], coverage: 'complete_set' }],
  });
  assert.equal(wrongCoverage.ok, false, 'a finite caller set must not claim whole-source exhaustion');
});

test('structured action proposals cannot mint host-only resolved-operation coverage', () => {
  const task = accept('Read the two requested ranges and email me the summary.');
  const proposed: contracts.ExpectedWorkProposalV1 = {
    version: 1,
    operations: [
      {
        id: 'source',
        effect: 'read',
        coverage: 'resolved_operation',
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      },
      {
        id: 'send',
        effect: 'external_write',
        dependsOn: ['source'],
        dataFrom: ['source'],
        cardinality: { kind: 'once' },
      },
    ],
    universes: [],
  };
  const result = contracts.freezeActionExpectedWorkContract({ ...task, proposal: proposed });
  assert.equal(result.status, 'invalid');
  assert.match(result.status === 'invalid' ? result.reason : '', /resolved_operation|host-only/i);
});

test('a smaller second action proposal poisons authority and cannot shrink the first winner', () => {
  const task = accept('Email alex@example.com with the update.');
  const first = contracts.freezeActionExpectedWorkContract({ ...task, proposal: compoundProposal() });
  assert.equal(first.status, 'fixed');
  const conflict = contracts.freezeActionExpectedWorkContract({ ...task, proposal: writeOnlyProposal() });
  assert.equal(conflict.status, 'conflict');
  const armed = authority.loadAcceptedTaskAuthority(task.sessionId, task.sourceUserSeq);
  assert.equal(armed.status === 'ok' && armed.authority.state, 'conflict');
  const rows = eventlog.openEventLog().prepare(`
    SELECT contract_id, operation_count FROM accepted_task_work_contracts
     WHERE session_id = ? AND source_user_seq = ?
  `).all(task.sessionId, task.sourceUserSeq) as Array<{ contract_id: string; operation_count: number }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.contract_id, first.status === 'fixed' ? first.contract.contractId : '');
  assert.equal(rows[0]?.operation_count, 2);
  assert.equal(contracts.loadExpectedWorkContract(task.sessionId, task.sourceUserSeq).status, 'conflict');
});

test('contract mutation, standalone deletion, and missing bytes all fail closed', () => {
  const task = accept('What is the current status of the Acme account?');
  assert.equal(contracts.freezeDeterministicExpectedWorkContract(task).status, 'fixed');
  const db = eventlog.openEventLog();
  assert.throws(() => db.prepare(`
    UPDATE accepted_task_work_contracts SET contract_json = '{}'
     WHERE session_id = ? AND source_user_seq = ?
  `).run(task.sessionId, task.sourceUserSeq), /immutable/);
  db.exec('DROP TRIGGER trg_accepted_task_work_contracts_update_immutable');
  try {
    db.prepare(`
      UPDATE accepted_task_work_contracts SET contract_json = '{}'
       WHERE session_id = ? AND source_user_seq = ?
    `).run(task.sessionId, task.sourceUserSeq);
  } finally {
    db.exec(`
      CREATE TRIGGER trg_accepted_task_work_contracts_update_immutable
      BEFORE UPDATE ON accepted_task_work_contracts
      BEGIN
        SELECT RAISE(ABORT, 'accepted task work contracts are immutable');
      END;
    `);
  }
  assert.equal(contracts.loadExpectedWorkContract(task.sessionId, task.sourceUserSeq).status, 'corrupt');

  const deleted = accept('What is the current status of the Beta account?');
  assert.equal(contracts.freezeDeterministicExpectedWorkContract(deleted).status, 'fixed');
  db.prepare(`
    DELETE FROM accepted_task_work_contracts WHERE session_id = ? AND source_user_seq = ?
  `).run(deleted.sessionId, deleted.sourceUserSeq);
  assert.equal(contracts.loadExpectedWorkContract(deleted.sessionId, deleted.sourceUserSeq).status, 'corrupt');
  assert.equal(
    contracts.freezeDeterministicExpectedWorkContract(deleted).status,
    'conflict',
    'the immutable authority marker prevents silently replacing deleted expected work',
  );
});

test('parent session retention can cascade an expected-work contract cleanly', () => {
  const task = accept('Hello, how are you?');
  assert.equal(contracts.freezeDeterministicExpectedWorkContract(task).status, 'fixed');
  const db = eventlog.openEventLog();
  assert.doesNotThrow(() => db.prepare('DELETE FROM sessions WHERE id = ?').run(task.sessionId));
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS n FROM accepted_task_work_contracts WHERE session_id = ?
    `).get(task.sessionId) as { n: number }).n,
    0,
  );
});

function runRaceChild(input: {
  script: string;
  proposal: contracts.ExpectedWorkProposalV1;
  ready: string;
  barrier: string;
}): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', input.script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        EXPECTED_WORK_PROPOSAL: JSON.stringify(input.proposal),
        EXPECTED_WORK_READY: input.ready,
        EXPECTED_WORK_BARRIER: input.barrier,
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

test('concurrent different proposals elect one immutable winner and poison the source', async () => {
  const task = accept('Email alex@example.com with the update.');
  const script = path.join(TMP_HOME, 'expected-work-race-child.mts');
  const barrier = path.join(TMP_HOME, 'expected-work-race.release');
  const firstReady = path.join(TMP_HOME, 'expected-work-race.first.ready');
  const secondReady = path.join(TMP_HOME, 'expected-work-race.second.ready');
  const modulePath = path.resolve('src/runtime/harness/expected-work-contract.ts');
  writeFileSync(script, `
    import { existsSync, writeFileSync } from 'node:fs';
    const contracts = await import(${JSON.stringify(modulePath)});
    const proposal = JSON.parse(process.env.EXPECTED_WORK_PROPOSAL || '{}');
    const ready = process.env.EXPECTED_WORK_READY || '';
    const barrier = process.env.EXPECTED_WORK_BARRIER || '';
    writeFileSync(ready, 'ready');
    while (!existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 2));
    const result = contracts.freezeActionExpectedWorkContract({
      sessionId: ${JSON.stringify(task.sessionId)},
      sourceUserSeq: ${task.sourceUserSeq},
      proposal,
    });
    console.log(JSON.stringify(result));
  `, 'utf8');
  const first = runRaceChild({ script, proposal: compoundProposal(), ready: firstReady, barrier });
  const second = runRaceChild({ script, proposal: writeOnlyProposal(), ready: secondReady, barrier });
  const deadline = Date.now() + 30_000;
  while ((!existsSync(firstReady) || !existsSync(secondReady)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(existsSync(firstReady) && existsSync(secondReady), 'both processes reached the barrier');
  writeFileSync(barrier, 'release\n', 'utf8');
  const outcomes = await Promise.all([first, second]);
  for (const outcome of outcomes) assert.equal(outcome.code, 0, outcome.output);
  const statuses = outcomes.map((outcome) => {
    const line = outcome.output.trim().split('\n')
      .findLast((entry) => entry.startsWith('{') && entry.includes('"status"'));
    return (JSON.parse(line ?? '{}') as { status?: string }).status;
  }).sort();
  assert.deepEqual(statuses, ['conflict', 'fixed']);
  assert.equal(
    (eventlog.openEventLog().prepare(`
      SELECT COUNT(*) AS n FROM accepted_task_work_contracts
       WHERE session_id = ? AND source_user_seq = ?
    `).get(task.sessionId, task.sourceUserSeq) as { n: number }).n,
    1,
  );
  assert.equal(contracts.loadExpectedWorkContract(task.sessionId, task.sourceUserSeq).status, 'conflict');
});
