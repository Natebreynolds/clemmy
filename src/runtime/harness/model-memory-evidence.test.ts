import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-model-memory-evidence-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const log = await import('./eventlog.js');
const memory = await import('./model-memory-evidence.js');
after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

test('only producer-owned memory that survives request filtering is visible', () => {
  const instructions = memory.withInstructionMemory(() => '', ['remembered preference', 'removed memory']);
  assert.deepEqual(memory.visibleInstructionMemory(instructions, 'prefix remembered preference suffix', []), ['remembered preference']);
  assert.deepEqual(memory.visibleInstructionMemory(instructions, '', [{ content: [{ type: 'input_text', text: 'remembered preference' }] }]), ['remembered preference']);
  assert.deepEqual(memory.visibleInstructionMemory(instructions, 'a summary replacing all exact fragments', []), []);
  assert.deepEqual(memory.visibleInstructionMemory(() => '', 'remembered preference', []), []);
});

test('the latest accepted memory snapshot survives reopen, remains source-specific and detects corrupt evidence', () => {
  const session = log.createSession({ id: 'memory-evidence', kind: 'chat' });
  const source = log.appendEvent({ sessionId: session.id, turn: 1, type: 'user_input_received', role: 'user', data: { text: 'Plan a briefing.' } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  memory.recordAcceptedModelMemory(identity, ['old preference'], 'response-1');
  memory.recordAcceptedModelMemory(identity, ['current preference'], 'response-2');
  memory.recordAcceptedModelMemory(identity, ['current preference'], 'response-3');
  assert.equal(log.listEvents(session.id, { types: ['guardrail_tripped'] }).length, 2, 'unchanged context is stored once');
  log.closeEventLog();
  assert.match(memory.acceptedModelMemoryEvidence(identity)!, /current preference/);
  assert.doesNotMatch(memory.acceptedModelMemoryEvidence(identity)!, /old preference/);
  const other = log.appendEvent({ sessionId: session.id, turn: 2, type: 'user_input_received', role: 'user', data: { text: 'Another task.' } });
  assert.equal(memory.acceptedModelMemoryEvidence({ sessionId: session.id, sourceUserSeq: other.seq }), undefined);
  log.appendEvent({ sessionId: session.id, turn: 0, type: 'guardrail_tripped', role: 'system', data: { kind: 'model_memory_context', version: 1, sourceUserSeq: source.seq, fragments: ['tampered'], digest: 'wrong' } });
  assert.match(memory.acceptedModelMemoryEvidence(identity)!, /unreadable/);
  assert.doesNotMatch(memory.acceptedModelMemoryEvidence(identity)!, /tampered/);
});

test('a version-2 record names each section by tier with totals and the core address, and version 1 stays readable', () => {
  const session = log.createSession({ id: 'memory-evidence-v2', kind: 'chat' });
  const source = log.appendEvent({ sessionId: session.id, turn: 1, type: 'user_input_received', role: 'user', data: { text: 'Plan a briefing.' } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  const entry = (section: string, tier: 'core' | 'relevant' | 'now', tokens: number, refs: Array<{ type: string; id: string }> = []) =>
    ({ section, tier, tokens, bytes: tokens * 4, refs });
  const instructions = memory.withInstructionMemory(() => '', [
    { text: 'CORE TEXT', manifest: [entry('Standing Policies', 'core', 30, [{ type: 'policy', id: '7' }])], coreSha: 'a'.repeat(64) },
    { text: 'NOW TEXT', manifest: [entry('Right Now', 'now', 5)] },
  ]);
  memory.registerMemoryTail('TAIL TEXT', [entry('Relevant To This Request', 'relevant', 12, [{ type: 'fact', id: '3' }])]);
  const visible = memory.visibleModelMemory(instructions, 'CORE TEXT NOW TEXT', [{ role: 'system', content: 'TAIL TEXT' }]);
  memory.recordAcceptedModelMemory(identity, visible, 'response-v2');
  const row = log.listEvents(session.id, { types: ['guardrail_tripped'] }).at(-1)!.data;
  assert.equal(row.version, 2);
  assert.deepEqual((row.manifest as Array<{ section: string; tier: string }>).map((e) => [e.section, e.tier]),
    [['Standing Policies', 'core'], ['Right Now', 'now'], ['Relevant To This Request', 'relevant']]);
  assert.deepEqual(row.totals, { tokens: 47, bytes: 188, coreTokens: 30, relevantTokens: 12, nowTokens: 5 });
  assert.equal(row.coreSha, 'a'.repeat(64));
  assert.match(memory.acceptedModelMemoryEvidence(identity)!, /CORE TEXT[\s\S]*TAIL TEXT/, 'reviewers read version 2 as they read version 1');
  const record = memory.latestModelMemoryManifest(session.id)!;
  assert.equal(record.sourceUserSeq, source.seq);
  assert.equal(record.version, 2);
  assert.equal(JSON.stringify(record).includes('CORE TEXT'), false, 'the manifest never carries memory text');
  log.appendEvent({ sessionId: session.id, turn: 0, type: 'guardrail_tripped', role: 'system', data: { kind: 'model_memory_context', version: 1, sourceUserSeq: source.seq + 100, fragments: ['legacy'], digest: memory._digestForTests(['legacy']) } });
  assert.match(memory.acceptedModelMemoryEvidence({ sessionId: session.id, sourceUserSeq: source.seq + 100 })!, /legacy/);
  assert.deepEqual(memory.latestModelMemoryManifest(session.id)?.manifest, [], 'a version-1 row has no sections to list');
  assert.equal(memory.latestModelMemoryManifest(session.id, source.seq)?.version, 2, 'a named source is looked up exactly');
});

test('a registered tail contained in the tail a request carries is not a second view', () => {
  const instructions = memory.withInstructionMemory(() => '', ['CORE']);
  memory.registerMemoryTail('_pointer line_');
  memory.registerMemoryTail('ranked lines\n\n_pointer line_');
  const visible = memory.visibleModelMemory(instructions, 'CORE', [{ role: 'system', content: 'ranked lines\n\n_pointer line_' }]);
  assert.deepEqual(visible.map((fragment) => fragment.text), ['CORE', 'ranked lines\n\n_pointer line_']);
});

test('a canonical source decodes only its event suffix while late source views remain exact', t => {
  const session = log.createSession({ id: 'memory-source-floor', kind: 'chat' });
  const earlier = log.appendEvent({ sessionId: session.id, type: 'user_input_received', role: 'user', turn: 1, data: { text: 'Earlier task.' } });
  for (let i = 0; i < 240; i++) log.appendEvent({ sessionId: session.id, type: 'guardrail_tripped', role: 'system', turn: 0,
    data: { kind: 'old-unrelated-view', payload: 'x'.repeat(1024) } });
  memory.recordAcceptedModelMemory({ sessionId: session.id, sourceUserSeq: earlier.seq }, ['earlier preference']);
  const source = log.appendEvent({ sessionId: session.id, type: 'user_input_received', role: 'user', turn: 2, data: { text: 'Current task.' } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  memory.recordAcceptedModelMemory(identity, ['current preference']);
  const later = log.appendEvent({ sessionId: session.id, type: 'user_input_received', role: 'user', turn: 3, data: { text: 'Later task.' } });
  memory.recordAcceptedModelMemory({ sessionId: session.id, sourceUserSeq: later.seq }, ['later preference']);
  memory.recordAcceptedModelMemory(identity, ['late current preference']);
  log.closeEventLog(); // Start measurement without previously cached statements.
  const db = log.openEventLog();
  const prepare = db.prepare.bind(db);
  const decoded: Array<{ bounded: boolean; rows: number }> = [];
  t.mock.method(db, 'prepare', ((sql: string) => {
    const statement = prepare(sql);
    if (!sql.startsWith('SELECT * FROM events WHERE session_id = ?')) return statement;
    const all = statement.all.bind(statement) as (...args: unknown[]) => unknown[];
    return new Proxy(statement, { get(target, key) {
      if (key === 'all') return (...args: unknown[]) => {
        const rows = all(...args);
        if (args.includes('guardrail_tripped')) decoded.push({ bounded: sql.includes('seq > ?'), rows: rows.length });
        return rows;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }) as typeof db.prepare);
  t.after(() => log.closeEventLog());
  const actual = memory.acceptedModelMemoryEvidence(identity)!;
  assert.match(actual, /late current preference/);
  assert.doesNotMatch(actual, /earlier preference|later preference/);
  assert.equal(memory.latestModelMemoryManifest(session.id, source.seq)?.sourceUserSeq, source.seq);
  assert.equal(memory.latestModelMemoryManifest(session.id)?.sourceUserSeq, source.seq, 'session-wide view still selects the latest recorded view');
  const full = log.listEvents(session.id, { types: ['guardrail_tripped'], desc: true }).reverse()
    .find(event => event.data.kind === 'model_memory_context' && event.data.sourceUserSeq === source.seq)!.data;
  assert.deepEqual(full.fragments, ['late current preference']);
  assert.ok(decoded.some(read => read.bounded && read.rows === 3), 'only the three current/later view rows were decoded');
  assert.ok(decoded.some(read => !read.bounded && read.rows === 244), 'the unchanged unrestricted reader decodes the full history');
  const before = log.countEvents(session.id, 'guardrail_tripped');
  memory.recordAcceptedModelMemory(identity, ['late current preference']);
  assert.equal(log.countEvents(session.id, 'guardrail_tripped'), before, 'unchanged view is still stored once');
  assert.equal(memory.acceptedModelMemoryEvidence(identity), actual);
});

test('a pre-source forged context cannot become current memory and foreign metadata lends no floor', () => {
  const session = log.createSession({ id: 'memory-pre-source', kind: 'chat' });
  const max = (log.openEventLog().prepare('SELECT MAX(seq) AS seq FROM events').get() as { seq: number }).seq;
  log.appendEvent({ sessionId: session.id, type: 'guardrail_tripped', role: 'system', turn: 0,
    data: { kind: 'model_memory_context', version: 1, sourceUserSeq: max + 2, fragments: ['forged prior view'], digest: 'wrong' } });
  const source = log.appendEvent({ sessionId: session.id, type: 'user_input_received', role: 'user', turn: 1, data: { text: 'Current task.' } });
  assert.equal(source.seq, max + 2);
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  assert.equal(memory.acceptedModelMemoryEvidence(identity), undefined);
  assert.equal(memory.latestModelMemoryManifest(session.id, source.seq), undefined);
  memory.recordAcceptedModelMemory(identity, ['actually supplied view']);
  assert.match(memory.acceptedModelMemoryEvidence(identity)!, /actually supplied view/);
  assert.doesNotMatch(memory.acceptedModelMemoryEvidence(identity)!, /forged prior view/);
  const foreign = log.createSession({ id: 'memory-foreign-source', kind: 'chat' });
  assert.equal(memory.acceptedModelMemoryEvidence({ sessionId: foreign.id, sourceUserSeq: source.seq }), undefined);
  assert.equal(memory.latestModelMemoryManifest(foreign.id, source.seq), undefined);
});

test('selected corrupt JSON remains a failure and cannot rescue an earlier successful view', () => {
  const session = log.createSession({ id: 'memory-corrupt-selected', kind: 'chat' });
  const source = log.appendEvent({ sessionId: session.id, type: 'user_input_received', role: 'user', turn: 1, data: { text: 'Current task.' } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq };
  memory.recordAcceptedModelMemory(identity, ['earlier view']);
  memory.recordAcceptedModelMemory(identity, ['latest view']);
  const selected = log.listEvents(session.id, { types: ['guardrail_tripped'] }).at(-1)!;
  log.openEventLog().prepare('UPDATE events SET data_json = ? WHERE seq = ?').run('{invalid', selected.seq);
  assert.throws(() => memory.acceptedModelMemoryEvidence(identity), SyntaxError);
  assert.throws(() => memory.latestModelMemoryManifest(session.id, source.seq), SyntaxError);
  const before = log.countEvents(session.id, 'guardrail_tripped');
  assert.throws(() => memory.recordAcceptedModelMemory(identity, ['rescue attempt']), SyntaxError);
  assert.equal(log.countEvents(session.id, 'guardrail_tripped'), before);
});

test('legacy unknown sources and exotic identities keep the original lookup without new hooks', () => {
  const session = log.createSession({ id: 'memory-legacy-exotics', kind: 'chat' });
  const source = log.appendEvent({ sessionId: session.id, type: 'user_input_received', role: 'user', turn: 1, data: { text: 'Current task.' } });
  memory.recordAcceptedModelMemory({ sessionId: session.id, sourceUserSeq: source.seq }, ['current view']);
  const unknown = source.seq + 100_000;
  log.appendEvent({ sessionId: session.id, type: 'guardrail_tripped', role: 'system', turn: 0,
    data: { kind: 'model_memory_context', version: 1, sourceUserSeq: unknown, fragments: ['legacy view'], digest: memory._digestForTests(['legacy view']) } });
  assert.match(memory.acceptedModelMemoryEvidence({ sessionId: session.id, sourceUserSeq: unknown })!, /legacy view/);
  let sessionReads = 0; let sourceReads = 0; let descriptorTraps = 0;
  const getter = { get sessionId() { sessionReads++; return session.id; }, get sourceUserSeq() { sourceReads++; return source.seq; } };
  assert.match(memory.acceptedModelMemoryEvidence(getter)!, /current view/);
  assert.equal(sessionReads, 1); assert.equal(sourceReads, 2, 'legacy find reads one source getter for each eligible row');
  const proxy = new Proxy({ sessionId: session.id, sourceUserSeq: source.seq }, {
    getOwnPropertyDescriptor() { descriptorTraps++; throw new Error('must not reflect an exotic owner'); },
  });
  assert.match(memory.acceptedModelMemoryEvidence(proxy)!, /current view/);
  assert.equal(descriptorTraps, 0);
  let coercions = 0;
  const nested = { valueOf() { coercions++; return source.seq; } };
  assert.equal(memory.acceptedModelMemoryEvidence({ sessionId: session.id, sourceUserSeq: nested } as never), undefined);
  assert.equal(coercions, 0);
});

test('a reentrant metadata probe cannot lend its floor to a changed owner', t => {
  const session = log.createSession({ id: 'memory-changing-owner', kind: 'chat' });
  const first = log.appendEvent({ sessionId: session.id, type: 'user_input_received', role: 'user', turn: 1, data: { text: 'First task.' } });
  const second = log.appendEvent({ sessionId: session.id, type: 'user_input_received', role: 'user', turn: 2, data: { text: 'Second task.' } });
  memory.recordAcceptedModelMemory({ sessionId: session.id, sourceUserSeq: first.seq }, ['first view']);
  memory.recordAcceptedModelMemory({ sessionId: session.id, sourceUserSeq: second.seq }, ['second view']);
  const identity = { sessionId: session.id, sourceUserSeq: first.seq };
  const db = log.openEventLog(); const prepare = db.prepare.bind(db);
  t.mock.method(db, 'prepare', ((sql: string) => {
    const statement = prepare(sql);
    if (!sql.startsWith('SELECT seq FROM events')) return statement;
    const get = statement.get.bind(statement) as (...args: unknown[]) => unknown;
    return new Proxy(statement, { get(target, key) {
      if (key === 'get') return (...args: unknown[]) => { const row = get(...args); identity.sourceUserSeq = second.seq; return row; };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
  }) as typeof db.prepare);
  assert.match(memory.acceptedModelMemoryEvidence(identity)!, /second view/);
  assert.doesNotMatch(memory.acceptedModelMemoryEvidence(identity)!, /first view/);
});
