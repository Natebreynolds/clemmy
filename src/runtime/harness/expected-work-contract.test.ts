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
const capabilityCandidates = await import('../read-path/capability-candidates.js');
const authority = await import('./accepted-task-authority.js');
const contracts = await import('./expected-work-contract.js');
const admission = await import('./expected-work-admission.js');
const { discoveryGovernor } = await import('./discovery-governor.js');
const composioClient = await import('../../integrations/composio/client.js');

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

function readOnlyProposal(): contracts.ExpectedWorkProposalV1 {
  return {
    version: 1,
    operations: [{
      id: 'resolve_current_state',
      effect: 'read',
      coverage: 'single',
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

test('retrieve authority never depends on literal overlap with an eventually resolved provider', async (t) => {
  // Live 2026-08-19, source 68028: "What was my teams call volume today"
  // correctly resolved to a Salesforce CLI read after graph admission. A
  // nonempty registry containing unrelated toolkit names made the contract
  // demote that retrieve to zero work before resolution, so the successful
  // read was later condemned as unexpected business work and the correct
  // answer was withheld. The accepted graph owns topology; provider names
  // cannot erase it before capability resolution.
  composioClient.__test__.setConnectedAccountsLoader(async () => [{
    id: 'ca_unrelated',
    status: 'ACTIVE',
    toolkit: { slug: 'googlesheets' },
  }]);
  t.after(() => composioClient.__test__.setConnectedAccountsLoader(null));
  await composioClient.listConnectedToolkits({ requireFresh: true });

  const task = accept('What was my teams call volume today?');
  assert.equal(task.graph.classification.route, 'retrieve');
  const fixed = contracts.freezeDeterministicExpectedWorkContract(task);
  assert.equal(fixed.status, 'fixed');
  assert.equal(
    fixed.status === 'fixed' && fixed.contract.operations.length,
    1,
    'an unrelated connected toolkit cannot turn a current-state retrieve into conversation',
  );
  assert.equal(fixed.status === 'fixed' && fixed.contract.operations[0]?.effect, 'read');
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

test('unknown tool planning may resolve to reads or writes, but an affirmative action may not weaken', () => {
  const unknown = accept('Weather in Seattle');
  assert.equal(unknown.graph.classification.messageIntent, 'tool_intent');
  assert.equal(unknown.graph.classification.route, 'act');
  assert.equal(unknown.graph.effectCeiling, 'unknown');
  const resolvedRead = contracts.freezeActionExpectedWorkContract({
    ...unknown,
    proposal: readOnlyProposal(),
  });
  assert.equal(resolvedRead.status, 'fixed', JSON.stringify(resolvedRead));
  assert.equal(
    resolvedRead.status === 'fixed' && resolvedRead.contract.operations[0]?.effect,
    'read',
  );

  const unknownWrite = accept('Opaque workspace task');
  assert.equal(unknownWrite.graph.classification.messageIntent, 'tool_intent');
  assert.equal(unknownWrite.graph.effectCeiling, 'unknown');
  const resolvedWrite = contracts.freezeActionExpectedWorkContract({
    ...unknownWrite,
    proposal: writeOnlyProposal(),
  });
  assert.equal(resolvedWrite.status, 'fixed', JSON.stringify(resolvedWrite));
  assert.equal(
    resolvedWrite.status === 'fixed' && resolvedWrite.contract.operations[0]?.effect,
    'external_write',
  );

  const action = accept('Create a new file.');
  assert.equal(action.graph.classification.messageIntent, 'action');
  assert.equal(action.graph.classification.route, 'act');
  const weakened = contracts.freezeActionExpectedWorkContract({
    ...action,
    proposal: readOnlyProposal(),
  });
  assert.equal(weakened.status, 'invalid');
  assert.match(
    weakened.status === 'invalid' ? weakened.reason : '',
    /cannot be weakened to read-only work/,
  );
});

test('collect-then-construct freezes one set read and one write, and refuses per-item writes', () => {
  const pronounSet = accept(
    'Find the best widgets with the highest ratings 5 of them and put all the info in a workbook for me and give me the link.',
  );
  assert.equal(pronounSet.graph.classification.multiItem.collectThenConstruct, true);
  assert.equal(contracts.requireKnownExpectedWorkContract(pronounSet).status, 'bound');

  const task = accept(
    'Find the top 5 widgets based on ratings and add them to a new workbook for me.',
  );
  assert.equal(task.graph.classification.route, 'act');
  assert.equal(task.graph.classification.multiItem.collectThenConstruct, true);
  assert.ok(task.graph.nodes.some((node) => node.kind === 'retrieve'));
  assert.ok(task.graph.nodes.some((node) => node.kind === 'execute'));

  const proposal = contracts.compileDeterministicExpectedWorkProposal(task.graph);
  assert.ok(proposal);
  const reads = proposal.operations.filter((operation) => operation.effect === 'read');
  const writes = proposal.operations.filter((operation) => operation.effect === 'external_write');
  assert.equal(reads.length, 1, 'the counted source set is one aggregate read');
  assert.equal(writes.length, 1);
  assert.equal(reads[0]?.coverage, 'complete_set',
    'the graph-derived counted aggregate read owns collection evidence');
  assert.equal(reads[0]?.cardinality.kind, 'once');
  assert.equal(writes[0]?.cardinality.kind, 'once');
  assert.ok(writes[0]?.dependsOn.includes(reads[reads.length - 1]!.id));

  const fixed = contracts.freezeDeterministicExpectedWorkContract(task);
  assert.equal(fixed.status, 'fixed');
  assert.equal(fixed.status === 'fixed' && fixed.contract.plannerSource, 'deterministic');
  assert.deepEqual(contracts.requireKnownExpectedWorkContract(task), {
    status: 'bound',
    contract: fixed.status === 'fixed' ? fixed.contract : undefined,
  });
  const activated = admission.activateActionExpectedWork(task);
  assert.ok(activated.status === 'activated' || activated.status === 'replayed', JSON.stringify(activated));
  assert.equal(admission.actionExpectedWorkState(task).status, 'required');

  const eachWrite = contracts.freezeActionExpectedWorkContract({
    ...task,
    proposal: {
      version: 1,
      operations: [
        {
          id: 'read_source',
          effect: 'read',
          coverage: 'complete_set',
          dependsOn: [],
          dataFrom: [],
          cardinality: { kind: 'once' },
        },
        {
          id: 'write_per_record',
          effect: 'external_write',
          dependsOn: ['read_source'],
          dataFrom: ['read_source'],
          cardinality: { kind: 'each', universeId: 'widgets' },
        },
      ],
      universes: [{
        id: 'widgets',
        seal: 'complete_source_receipt',
        producedBy: 'read_source',
        memberIdPointer: '/id',
      }],
    },
  });
  assert.equal(eachWrite.status, 'invalid');
  assert.match(eachWrite.status === 'invalid' ? eachWrite.reason : '', /per-item writes/);
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

test('a local-write ceiling accepts its exact local outcome without requiring an external write', () => {
  const task = accept('Create one simple Workspace called Inline Proof.');
  const graph = {
    ...task.graph,
    effectCeiling: 'local_write' as const,
    classification: {
      ...task.graph.classification,
      route: 'act' as const,
      messageIntent: 'action' as const,
      externalEffectRequested: true,
    },
  };
  const errors = contracts.validateActionProposalForGraph({
    version: 1,
    operations: [{
      id: 'author_workspace',
      effect: 'local_write',
      dependsOn: [],
      dataFrom: [],
      cardinality: { kind: 'once' },
    }],
    universes: [],
  }, graph);
  assert.deepEqual(errors, [], 'the exact local-write ceiling owns the outcome effect');
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
      memberIdPointer: '/id',
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
      universes: [{
        id: 'items',
        seal: 'complete_source_receipt',
        producedBy: 'source_snapshot',
        memberIdPointer: '/id',
      }],
    },
    // A source-derived universe the host cannot identify members in is
    // unsealable, so it may never freeze: the per-item lane would be
    // structurally unreachable for the whole turn.
    {
      version: 1,
      operations: [
        base.operations[0],
        { ...base.operations[1], cardinality: { kind: 'each', universeId: 'source_items' } },
      ],
      universes: [{ id: 'source_items', seal: 'complete_source_receipt', producedBy: 'source_snapshot' }],
    },
    {
      version: 1,
      operations: [
        base.operations[0],
        { ...base.operations[1], cardinality: { kind: 'each', universeId: 'source_items' } },
      ],
      universes: [{
        id: 'source_items',
        seal: 'complete_source_receipt',
        producedBy: 'source_snapshot',
        memberIdPointer: 'id',
      }],
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

test('structured action proposals admit only an unconstrained resolved-operation root read', () => {
  const task = accept('Run one bounded current-news lookup and save one grounded report.');
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
  assert.equal(result.status, 'fixed', result.status === 'fixed' ? '' : result.reason);

  const dependentTask = accept('Resolve a locator, search it, and save one grounded report.');
  const dependent: contracts.ExpectedWorkProposalV1 = {
    version: 1,
    operations: [
      {
        id: 'locator', effect: 'read', coverage: 'single', dependsOn: [], dataFrom: [],
        cardinality: { kind: 'once' },
      },
      {
        id: 'source', effect: 'read', coverage: 'resolved_operation', dependsOn: ['locator'], dataFrom: [],
        cardinality: { kind: 'once' },
      },
      {
        id: 'save', effect: 'local_write', dependsOn: ['source'], dataFrom: ['source'],
        cardinality: { kind: 'once' },
      },
    ],
    universes: [],
  };
  const refused = contracts.freezeActionExpectedWorkContract({ ...dependentTask, proposal: dependent });
  assert.equal(refused.status, 'invalid');
  assert.match(refused.status === 'invalid' ? refused.reason : '', /resolved_operation|root read/i);

  const completedBatchTask = accept('Resolve candidate URLs, finish their exact bounded read batch, and save one grounded report.');
  const completedBatch = contracts.freezeActionExpectedWorkContract({
    ...completedBatchTask,
    proposal: {
      ...dependent,
      operations: dependent.operations.map((operation) => operation.id === 'source'
        ? { ...operation, coverage: 'complete_set' as const }
        : operation),
    },
  });
  assert.equal(
    completedBatch.status,
    'fixed',
    completedBatch.status === 'fixed' ? '' : completedBatch.reason,
  );
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

test('unambiguous proposal shapes are repaired, not refused (live 2026-08-12 fan-out)', () => {
  // A fan-out worker burned its entire budget re-proposing against
  // "coverage is only valid for reads" and "dataFrom X must also be a
  // dependency", made zero business calls, and reported it could not verify
  // anything. Both shapes state their intent unambiguously.
  const session = eventlog.createSession({ id: `contract-normalize-${Date.now()}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Scrape the five restaurants and put them in a new sheet.' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));

  const prepared = contracts.prepareActionExpectedWorkContract({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    proposal: {
      version: 1,
      operations: [
        {
          id: 'collect_places',
          effect: 'read',
          coverage: 'complete_set',
          dependsOn: [],
          dataFrom: [],
          cardinality: { kind: 'once' },
        },
        {
          // coverage on a WRITE — read vocabulary, meaningless here.
          id: 'create_sheet',
          effect: 'external_write',
          coverage: 'single',
          dependsOn: ['collect_places'],
          dataFrom: ['collect_places'],
          cardinality: { kind: 'once' },
        },
        {
          // dataFrom naming an op absent from dependsOn — deriving from it IS
          // depending on it.
          id: 'write_rows',
          effect: 'external_write',
          dependsOn: [],
          dataFrom: ['collect_places', 'create_sheet'],
          cardinality: { kind: 'once' },
        },
        {
          // a READ that named a producer: pure ordering, not derivation.
          id: 'verify_sheet',
          effect: 'read',
          coverage: 'complete_set',
          dependsOn: [],
          dataFrom: ['write_rows'],
          cardinality: { kind: 'once' },
        },
      ],
      universes: [],
    } as never,
  });
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
  if (prepared.status !== 'prepared') throw new Error('the proposal was refused');

  const byId = new Map(prepared.contract.operations.map((op) => [op.id, op]));
  assert.equal(byId.get('create_sheet')?.coverage, undefined, 'write coverage is dropped');
  assert.deepEqual(
    [...(byId.get('write_rows')?.dependsOn ?? [])].sort(),
    ['collect_places', 'create_sheet'],
    'dataFrom entries become dependencies',
  );
  assert.deepEqual(byId.get('verify_sheet')?.dataFrom, [], 'a read derives nothing');
  assert.deepEqual(byId.get('verify_sheet')?.dependsOn, ['write_rows'], 'its ordering survives');

  // Genuinely ambiguous shapes are still refused with their exact reason.
  const refused = contracts.prepareActionExpectedWorkContract({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    proposal: {
      version: 1,
      operations: [{
        id: 'bad_read',
        effect: 'read',
        coverage: 'complete_set',
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'each', universeId: 'items' },
      }],
      universes: [],
    } as never,
  });
  assert.notEqual(refused.status, 'prepared', 'a coverage/cardinality contradiction still refuses');
});

test('source 50404 freezes the full restaurant to Sheet to verified email lineage, never one read', () => {
  const request = 'Find me the best date night restaurants maybe 5 of them in pismo beach ca '
    + 'put them in a sheet with reviews and send me an email with the link to the sheet please';
  const task = accept(request);

  assert.equal(task.graph.classification.route, 'act');
  assert.equal(task.graph.classification.externalEffectRequested, true);
  assert.ok(task.graph.classification.externalEffectKinds.includes('communication'));
  assert.equal(contracts.requiresPostConstructCommunicationDelivery(task.graph), true);
  assert.equal(task.graph.effectCeiling, 'external_write');
  assert.equal(contracts.compileDeterministicExpectedWorkProposal(task.graph), null,
    'the compound request cannot be reduced to the retrieve route\'s one read');
  assert.equal(contracts.freezeDeterministicExpectedWorkContract(task).status, 'planning_required');

  const sourceRead: contracts.ExpectedWorkOperationV1 = {
    id: 'fetch_restaurants', effect: 'read', coverage: 'complete_set',
    dependsOn: [], dataFrom: [], cardinality: { kind: 'once' },
  };
  const constructWrite: contracts.ExpectedWorkOperationV1 = {
    id: 'create_sheet', effect: 'external_write',
    dependsOn: ['fetch_restaurants'], dataFrom: ['fetch_restaurants'],
    cardinality: { kind: 'once' },
  };
  const verificationRead: contracts.ExpectedWorkOperationV1 = {
    id: 'verify_sheet', effect: 'read', coverage: 'complete_set',
    dependsOn: ['create_sheet'], dataFrom: ['create_sheet'],
    cardinality: { kind: 'once' },
  };
  const terminalDelivery: contracts.ExpectedWorkOperationV1 = {
    id: 'send_link', effect: 'external_write',
    dependsOn: ['verify_sheet'], dataFrom: ['verify_sheet'],
    cardinality: { kind: 'once' },
  };
  const proposal = (
    operations: contracts.ExpectedWorkOperationV1[]
  ): contracts.ExpectedWorkProposalV1 => ({ version: 1, operations, universes: [] });
  const assertIncompleteRefused = (
    label: string,
    operations: contracts.ExpectedWorkOperationV1[],
  ): void => {
    const prepared = contracts.prepareActionExpectedWorkContract({
      ...task,
      proposal: proposal(operations),
    });
    assert.equal(prepared.status, 'invalid', `${label}: ${JSON.stringify(prepared)}`);
    assert.match(
      prepared.status === 'invalid' ? prepared.reason : '',
      /source read -> construct write -> verification read -> terminal external write/,
      label,
    );
    const frozen = contracts.freezeActionExpectedWorkContract({
      ...task,
      proposal: proposal(operations),
    });
    assert.equal(frozen.status, 'invalid', `${label}: an incomplete topology cannot freeze`);
    assert.equal(
      contracts.loadExpectedWorkContract(task.sessionId, task.sourceUserSeq).status,
      'missing',
      `${label}: refusal cannot leave contract authority behind`,
    );
  };

  assertIncompleteRefused('one write', [sourceRead, constructWrite]);
  assertIncompleteRefused('parallel delivery', [
    sourceRead,
    constructWrite,
    verificationRead,
    { ...terminalDelivery, dependsOn: ['fetch_restaurants'], dataFrom: ['fetch_restaurants'] },
  ]);
  assertIncompleteRefused('readback before construction', [
    sourceRead,
    { ...verificationRead, dependsOn: ['fetch_restaurants'], dataFrom: [] },
    { ...constructWrite, dependsOn: ['verify_sheet'], dataFrom: ['verify_sheet'] },
    { ...terminalDelivery, dependsOn: ['create_sheet'], dataFrom: ['create_sheet'] },
  ]);
  assertIncompleteRefused('missing readback', [
    sourceRead,
    constructWrite,
    { ...terminalDelivery, dependsOn: ['create_sheet'], dataFrom: ['create_sheet'] },
  ]);

  const crossing = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: 'compound-incomplete-create',
    proposal: proposal([sourceRead, constructWrite]),
    requirementId: 'create_sheet',
    tool: 'resource_create',
    args: { title: 'Date night restaurants' },
  });
  assert.equal(crossing.status, 'refused');
  assert.equal(crossing.status === 'refused' && crossing.kind, 'work_contract_invalid',
    'the fused physical admission seam refuses before an incomplete contract can cross');
  assert.equal(contracts.loadExpectedWorkContract(task.sessionId, task.sourceUserSeq).status, 'missing');

  const roleProjectionPromise = capabilityCandidates.resolveTurnCapabilityCandidates({
    userInput: request,
    semantic: false,
    limit: 5,
    choices: [{
      intent: 'googlesheets.get_sheet_names',
      description: 'Get names of sheets in a spreadsheet and put them in a list.',
      choice: {
        kind: 'composio', identifier: 'GOOGLESHEETS_GET_SHEET_NAMES',
        testedAt: '2026-08-13T00:00:00.000Z',
      },
      fallbacks: [], body: '', filePath: '/fixture/GOOGLESHEETS_GET_SHEET_NAMES',
    }] as never,
  });

  const frozen = contracts.freezeActionExpectedWorkContract({
    ...task,
    proposal: proposal([sourceRead, constructWrite, verificationRead, terminalDelivery]),
  });
  assert.equal(frozen.status, 'fixed', JSON.stringify(frozen));
  if (frozen.status !== 'fixed') return;

  assert.equal(frozen.contract.operations.length, 4, 'accepted action contract is nonzero and multi-step');
  const byId = new Map(frozen.contract.operations.map((operation) => [operation.id, operation]));
  assert.deepEqual(byId.get('fetch_restaurants'), {
    id: 'fetch_restaurants', effect: 'read', coverage: 'complete_set',
    dependsOn: [], dataFrom: [], cardinality: { kind: 'once' },
  });
  assert.deepEqual(byId.get('create_sheet')?.dependsOn, ['fetch_restaurants']);
  assert.deepEqual(byId.get('create_sheet')?.dataFrom, ['fetch_restaurants']);
  assert.deepEqual(byId.get('verify_sheet')?.dependsOn, ['create_sheet']);
  assert.deepEqual(byId.get('verify_sheet')?.dataFrom, [],
    'verification is ordered after the Sheet receipt without pretending a read is a derived write');
  assert.deepEqual(byId.get('send_link')?.dependsOn, ['verify_sheet']);
  assert.deepEqual(byId.get('send_link')?.dataFrom, ['verify_sheet']);

  const loaded = contracts.loadExpectedWorkContract(task.sessionId, task.sourceUserSeq);
  assert.equal(loaded.status, 'ok');
  assert.equal(loaded.status === 'ok' && loaded.contract.contractId, frozen.contract.contractId);
  assert.equal(loaded.status === 'ok' && loaded.contract.operations.length, 4);

  return roleProjectionPromise.then((projection) => {
    assert.deepEqual(projection.requirements.map((requirement) => ({
      roleKey: requirement.roleKey,
      resolved: requirement.resolved,
    })), [
      { roleKey: 'clause-0:read', resolved: false },
      { roleKey: 'clause-1:write', resolved: false },
      { roleKey: 'clause-2:write', resolved: false },
    ]);

    discoveryGovernor.initializeTask({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      // Reproduce the live state: whole-request advisory memory exists, but it
      // does not cover any of the three requirement roles.
      knownCapability: projection.candidates.length > 0,
    });
    const initialized = discoveryGovernor.initializeRoles({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      requirements: projection.requirements,
      brokerCoverage: 'authorized_external_v1',
    });
    assert.equal(initialized.policy.roleScoped, true);
    assert.equal(initialized.policy.roleCount, 3);
    assert.equal(initialized.policy.unresolvedRoleCount, 3);
    assert.deepEqual(initialized.roles.map((role) => role.roleKey), [
      'clause-0:read',
      'clause-1:write',
      'clause-2:write',
    ]);
    for (const [index, role] of initialized.roles.entries()) {
      const admitted = discoveryGovernor.admit({
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        category: 'broad_discovery',
        subject: role.roleKey,
        callId: `source-50404-role-${index}`,
      });
      assert.equal(admitted.admitted, true, `${role.roleKey}: ${admitted.reason}`);
    }
  });
});
