/**
 * Production-sandbox pins for the action-scoped code-mode work carrier.
 *
 * These tests intentionally enter runCodeModeForSession, the child-process RPC
 * bridge, dispatchCodeModeTool, and the ordinary wrapped inner-tool boundary.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-codemode-work-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.HARNESS_TOOL_BRACKETS = 'on';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-codemode-work\n', 'utf8');

const eventlog = await import('../runtime/harness/eventlog.js');
const shadow = await import('../runtime/graph/turn-graph-shadow.js');
const contracts = await import('../runtime/harness/expected-work-contract.js');
const admission = await import('../runtime/harness/expected-work-admission.js');
const codeMode = await import('./code-mode-tool.js');
const { ToolCallsCounter, withHarnessRunContext } = await import('../runtime/harness/brackets.js');

test.after(() => {
  codeMode._setCodeModeToolsForTests(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const ASK = 'Read my Outlook calendar and write a local calendar summary.';

function proposal() {
  return {
    version: 1 as const,
    operations: [
      {
        id: 'read_outlook_calendar',
        effect: 'read' as const,
        coverage: 'complete_set' as const,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' as const },
      },
      {
        id: 'write_calendar_summary',
        effect: 'local_write' as const,
        coverage: null,
        dependsOn: ['read_outlook_calendar'],
        dataFrom: ['read_outlook_calendar'],
        cardinality: { kind: 'once' as const },
      },
    ],
    universes: [],
  };
}

function createActionTask(suffix: string) {
  const session = eventlog.createSession({ id: `sess-codemode-work-${suffix}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: ASK },
  });
  const task = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  assert.ok(shadow.recordTurnGraphShadow({ identity: task }), 'fixture graph persisted');
  const activated = admission.activateActionExpectedWork(task);
  assert.ok(activated.status === 'activated' || activated.status === 'replayed', JSON.stringify(activated));
  return task;
}

function freeze(task: ReturnType<typeof createActionTask>): void {
  const proposed = proposal();
  const prepared = contracts.prepareActionExpectedWorkContract({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    proposal: {
      ...proposed,
      operations: proposed.operations.map((operation) => {
        const { coverage, ...rest } = operation;
        return coverage === null ? rest : operation;
      }),
    },
  });
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
  if (prepared.status !== 'prepared') throw new Error('fixture contract did not prepare');
  const db = eventlog.openEventLog();
  const frozen = db.transaction(() => contracts.freezePreparedExpectedWorkContractInTransaction(db, {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    contract: prepared.contract,
  })).immediate();
  assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed', JSON.stringify(frozen));
}

function installReadFixture(): void {
  codeMode._setCodeModeToolsForTests(new Map([['read_file', {
    name: 'read_file',
    invoke: async () => ({
      successful: true,
      data: { records: [{ id: 'not-an-outlook-event', source: 'unrelated.txt' }] },
      meta: { complete: true },
    }),
  }]]));
}

function scopedWorkOptions() {
  return {
    workCallOptions: {
      reachableBuiltinNames: new Set(['read_file', 'write_file']),
      firstClassNames: new Set<string>(),
      deniedNames: new Set<string>(),
      mcpToolScope: null,
    },
  };
}

test('active action refuses a plain unrelated same-effect child before admission', async () => {
  const task = createActionTask('plain-refusal');
  freeze(task);
  installReadFixture();

  const result = await withHarnessRunContext(
    { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, counter: new ToolCallsCounter(100) },
    () => codeMode.runCodeModeForSession(
      'return await clem.read_file({ path: "unrelated.txt", max_chars: null });',
      task.sessionId,
      scopedWorkOptions(),
    ),
  );

  assert.equal(result.ok, false, 'plain business child must receive a typed repair, not execute');
  assert.match(result.ok ? '' : result.error, /work_binding_required|clem\.work/i);
  const db = eventlog.openEventLog();
  const bindingCount = (db.prepare(`
    SELECT COUNT(*) AS n FROM expected_work_call_bindings
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as { n: number }).n;
  assert.equal(bindingCount, 0, 'unrelated read must never become Outlook-calendar truth');
  const openCount = (db.prepare(`
    SELECT COUNT(*) AS n FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND state = 'OPEN'
  `).get(task.sessionId, task.sourceUserSeq) as { n: number }).n;
  assert.equal(openCount, 0, 'pre-dispatch repair must leave no orphan logical child');
});

test('clem.work freezes the proposal and explicitly binds the real child in one sandbox call', async () => {
  const task = createActionTask('explicit-carrier');
  installReadFixture();
  const input = {
    proposal: proposal(),
    requirement_id: 'read_outlook_calendar',
    universe_item_id: null,
    universe_selector: null,
    name: 'read_file',
    args_json: JSON.stringify({ path: 'calendar.json', max_chars: null }),
  };

  const result = await withHarnessRunContext(
    { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, counter: new ToolCallsCounter(100) },
    () => codeMode.runCodeModeForSession(
      `return await clem.work(${JSON.stringify(input)});`,
      task.sessionId,
      scopedWorkOptions(),
    ),
  );

  assert.equal(result.ok, true, result.ok ? undefined : result.error);
  const binding = eventlog.openEventLog().prepare(`
    SELECT requirement_id, tool_name, effect_kind
      FROM expected_work_call_bindings
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as {
    requirement_id: string;
    tool_name: string;
    effect_kind: string;
  } | undefined;
  assert.deepEqual(binding, {
    requirement_id: 'read_outlook_calendar',
    tool_name: 'read_file',
    effect_kind: 'read',
  }, `program=${JSON.stringify(result)} events=${JSON.stringify(eventlog.listEvents(task.sessionId).map((event) => ({ type: event.type, data: event.data }))).slice(0, 4000)}`);
  const openCount = (eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS n FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ? AND state = 'OPEN'
  `).get(task.sessionId, task.sourceUserSeq) as { n: number }).n;
  assert.equal(openCount, 0, 'successful explicit child must settle its exact logical row');
});

test('later clem.work calls use proposal:null and explicit ids even for same-effect siblings', async () => {
  const task = createActionTask('later-explicit');
  const paths: string[] = [];
  codeMode._setCodeModeToolsForTests(new Map([['read_file', {
    name: 'read_file',
    invoke: async (_ctx: unknown, raw: string) => {
      const parsed = JSON.parse(raw) as { path: string };
      paths.push(parsed.path);
      return { successful: true, data: { records: [{ path: parsed.path }] }, meta: { complete: true } };
    },
  }]]));
  const semanticProposal = {
    version: 1,
    operations: [
      { id: 'read_calendar', effect: 'read', coverage: 'complete_set', dependsOn: [], dataFrom: [], cardinality: { kind: 'once' } },
      { id: 'read_notes', effect: 'read', coverage: 'complete_set', dependsOn: ['read_calendar'], dataFrom: [], cardinality: { kind: 'once' } },
      { id: 'write_summary', effect: 'local_write', coverage: null, dependsOn: ['read_calendar', 'read_notes'], dataFrom: ['read_calendar', 'read_notes'], cardinality: { kind: 'once' } },
    ],
    universes: [],
  };
  const first = {
    proposal: semanticProposal,
    requirement_id: 'read_calendar',
    universe_item_id: null,
    universe_selector: null,
    name: 'read_file',
    args_json: JSON.stringify({ path: 'calendar.json', max_chars: null }),
  };
  const later = {
    ...first,
    proposal: null,
    requirement_id: 'read_notes',
    args_json: JSON.stringify({ path: 'notes.json', max_chars: null }),
  };
  const program = [
    `const calendar = await clem.work(${JSON.stringify(first)});`,
    `const notes = await clem.work(${JSON.stringify(later)});`,
    'return { calendar, notes };',
  ].join('\n');

  const result = await withHarnessRunContext(
    { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, counter: new ToolCallsCounter(100) },
    () => codeMode.runCodeModeForSession(program, task.sessionId, scopedWorkOptions()),
  );
  assert.equal(result.ok, true, result.ok ? undefined : result.error);
  assert.deepEqual(paths, ['calendar.json', 'notes.json'], `program=${JSON.stringify(result)}`);
  const bindings = eventlog.openEventLog().prepare(`
    SELECT requirement_id, tool_name FROM expected_work_call_bindings
     WHERE session_id = ? AND source_user_seq = ? ORDER BY bound_at, requirement_id
  `).all(task.sessionId, task.sourceUserSeq) as Array<{ requirement_id: string; tool_name: string }>;
  assert.deepEqual(bindings, [
    { requirement_id: 'read_calendar', tool_name: 'read_file' },
    { requirement_id: 'read_notes', tool_name: 'read_file' },
  ]);
});

test('clem.work cannot bypass the program irreversible-send ceiling', async () => {
  const task = createActionTask('send-ceiling');
  let executed = 0;
  codeMode._setCodeModeToolsForTests(new Map([['composio_execute_tool', {
    name: 'composio_execute_tool',
    invoke: async () => { executed += 1; return { successful: true }; },
  }]]));
  const input = {
    proposal: {
      version: 1,
      operations: [{
        id: 'send_message',
        effect: 'external_write',
        coverage: null,
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      }],
      universes: [],
    },
    requirement_id: 'send_message',
    universe_item_id: null,
    universe_selector: null,
    name: 'composio_execute_tool',
    args_json: JSON.stringify({
      tool_slug: 'OUTLOOK_SEND_EMAIL',
      arguments: JSON.stringify({ to: 'recipient@example.com', subject: 'Hi', body: 'Hello' }),
    }),
  };
  const options = {
    workCallOptions: {
      reachableBuiltinNames: new Set(['composio_execute_tool']),
      firstClassNames: new Set<string>(),
      deniedNames: new Set<string>(),
      mcpToolScope: null,
    },
  };

  const result = await withHarnessRunContext(
    { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, counter: new ToolCallsCounter(100) },
    () => codeMode.runCodeModeForSession(
      `return await clem.work(${JSON.stringify(input)});`,
      task.sessionId,
      options,
    ),
  );
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /irreversible external send|run_batch/i);
  assert.equal(executed, 0, 'send ceiling fires before the nested inner tool body');
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS n FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ?
  `).get(task.sessionId, task.sourceUserSeq) as { n: number }).n, 0);
});
