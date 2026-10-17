import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { readAcceptedTaskWorkflowCandidates } from './accepted-task-workflow-candidates.js';

const accepted = { sessionId: 'fixture-parent', sourceUserSeq: 10 };
const dispatch = { version: 2, kind: 'workflow_run_group', status: 'dispatched', sourceUserSeq: 10,
  sourceGroupId: `workflow-origin-group-v1:${'a'.repeat(64)}`, sourceGroupDigest: 'b'.repeat(64),
  runIds: ['job-123', 'existing.456:retry'], dispatchKey: 'fixture-public-dispatch-key', replyTargetDigest: 'c'.repeat(64) };
function fixture(options: { schema?: boolean } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-candidate-inventory-'));
  mkdirSync(path.join(home, 'state'));
  const file = path.join(home, 'state', 'harness.db');
  const db = new Database(file);
  if (options.schema !== false) db.exec(`CREATE TABLE events (id TEXT, seq INTEGER, session_id TEXT,
    turn INTEGER, role TEXT, type TEXT, parent_event_id TEXT, data_json TEXT);
    CREATE INDEX fixture_events_source ON events(session_id, seq);
    CREATE INDEX fixture_events_dispatch ON events(session_id, type, parent_event_id);`);
  const insert = (row: { id?: string; seq: number; session?: string; turn?: number; role?: string;
    type?: string; parent?: string | null; data?: unknown; raw?: string }) => {
    db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(row.id ?? `event-${row.seq}`, row.seq,
      row.session ?? accepted.sessionId, row.turn ?? 1, row.role ?? 'system', row.type ?? 'async_work_dispatched',
      row.parent ?? null, row.raw ?? JSON.stringify(row.data ?? {}));
  };
  const source = (extra: Partial<Parameters<typeof insert>[0]> = {}) => insert({ id: 'source-10', seq: 10,
    role: 'user', type: 'user_input_received', data: { text: 'private fixture objective must stay out of results' }, ...extra });
  const addDispatch = (extra: Partial<Parameters<typeof insert>[0]> = {}) => insert({ seq: 11, parent: 'source-10', data: dispatch, ...extra });
  return { home, file, db, insert, source, addDispatch, cleanup: () => { db.close(); rmSync(home, { recursive: true, force: true }); } };
}
function frozenFiles(home: string): Record<string, string> {
  return Object.fromEntries(readdirSync(path.join(home, 'state')).sort().map(name => [name,
    createHash('sha256').update(readFileSync(path.join(home, 'state', name))).digest('hex')]));
}

test('workflow candidates use only explicit-home exact parented human sources and remain unproved', () => {
  const a = fixture(); const b = fixture();
  const previous = process.env.CLEMENTINE_HOME;
  try {
    a.source(); a.addDispatch(); b.source(); b.addDispatch({ data: { ...dispatch, runIds: ['foreign-home-run'] } });
    process.env.CLEMENTINE_HOME = b.home;
    const beforeA = frozenFiles(a.home); const beforeB = frozenFiles(b.home);
    const result = readAcceptedTaskWorkflowCandidates(a.home, [accepted, accepted]);
    assert.deepEqual(result.candidates, [{ parentAcceptedSource: 'fixture-parent:10', sourceGroupId: dispatch.sourceGroupId,
      runIds: dispatch.runIds, dispatchSeq: 11 }]);
    assert.deepEqual(result.issues, ['workflow_candidate_authority_and_usage_unproved']);
    assert.doesNotMatch(JSON.stringify(result), /private fixture objective|foreign-home-run/);
    assert.deepEqual(frozenFiles(a.home), beforeA); assert.deepEqual(frozenFiles(b.home), beforeB);
  } finally {
    if (previous === undefined) delete process.env.CLEMENTINE_HOME; else process.env.CLEMENTINE_HOME = previous;
    a.cleanup(); b.cleanup();
  }
});

test('workflow candidate overlap dedups the same accepted source without conflating distinct parent claims', () => {
  const f = fixture();
  try {
    f.source(); f.addDispatch();
    f.source({ id: 'source-20', seq: 20 });
    f.addDispatch({ seq: 21, parent: 'source-20', data: { ...dispatch, sourceUserSeq: 20 } });
    const result = readAcceptedTaskWorkflowCandidates(f.home, [accepted, { ...accepted, sourceUserSeq: 20 }, accepted]);
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(result.candidates.map(row => row.parentAcceptedSource), ['fixture-parent:10', 'fixture-parent:20']);
    assert.deepEqual(result.candidates.map(row => row.runIds), [dispatch.runIds, dispatch.runIds]);
    assert.equal('promptTokens' in result, false, 'overlapping candidate relationships never become summed usage');
    assert.match(result.issues.join('\n'), /authority_and_usage_unproved/);
  } finally { f.cleanup(); }
});

test('foreign parent, source, role, turn and synthetic claims cannot become workflow usage lineage', () => {
  for (const variant of ['parent', 'source', 'role', 'turn', 'synthetic', 'foreign_session'] as const) {
    const f = fixture();
    try {
      f.source(variant === 'synthetic' ? { data: { synthetic: true } } : {});
      f.addDispatch(variant === 'parent' ? { parent: 'foreign-source' }
        : variant === 'source' ? { data: { ...dispatch, sourceUserSeq: 999 } }
        : variant === 'role' ? { role: 'assistant' }
        : variant === 'turn' ? { turn: 2 }
        : variant === 'foreign_session' ? { session: 'foreign-session' } : {});
      const before = frozenFiles(f.home);
      const result = readAcceptedTaskWorkflowCandidates(f.home, [accepted]);
      assert.deepEqual(result.candidates, [], variant);
      if (variant !== 'foreign_session') assert.ok(result.issues.length, variant);
      assert.deepEqual(frozenFiles(f.home), before);
    } finally { f.cleanup(); }
  }
});

test('ambiguous, malformed and unsafe workflow metadata is explicit unknown rather than a latest winner', () => {
  for (const variant of ['ambiguous', 'malformed', 'duplicate_run', 'unsafe_run', 'unsafe_group', 'oversized', 'unknown_version', 'source_missing', 'source_ambiguous'] as const) {
    const f = fixture();
    try {
      if (variant !== 'source_missing') f.source();
      if (variant === 'source_ambiguous') f.source({ id: 'another-source-10' });
      f.addDispatch(variant === 'malformed' ? { raw: '{"private-parse-bytes":' }
        : variant === 'duplicate_run' ? { data: { ...dispatch, runIds: ['same', 'same'] } }
        : variant === 'unsafe_run' ? { data: { ...dispatch, runIds: ['../outside'] } }
        : variant === 'unsafe_group' ? { data: { ...dispatch, sourceGroupId: 'https://example.invalid/?private=token' } }
        : variant === 'oversized' ? { data: { ...dispatch, runIds: Array.from({ length: 129 }, (_, i) => `run-${i}`) } }
        : variant === 'unknown_version' ? { data: { ...dispatch, version: 3 } } : {});
      if (variant === 'ambiguous') f.addDispatch({ seq: 12, data: { ...dispatch, runIds: ['newer-cannot-win'] } });
      const before = frozenFiles(f.home);
      const result = readAcceptedTaskWorkflowCandidates(f.home, [accepted]);
      assert.deepEqual(result.candidates, [], variant);
      assert.ok(result.issues.length, variant);
      assert.doesNotMatch(JSON.stringify(result), /private-parse-bytes|outside|example\.invalid|newer-cannot-win/);
      assert.deepEqual(frozenFiles(f.home), before);
    } finally { f.cleanup(); }
  }
});

test('unrelated malformed events do not break a valid candidate and unavailable stores are never created or migrated', () => {
  const f = fixture(); const old = fixture({ schema: false });
  const missing = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-candidate-missing-'));
  try {
    f.source(); f.addDispatch(); f.insert({ seq: 13, parent: 'other-source', raw: '{"unrelated-private-bytes":' });
    assert.equal(readAcceptedTaskWorkflowCandidates(f.home, [accepted]).candidates.length, 1);
    const before = frozenFiles(old.home);
    assert.deepEqual(readAcceptedTaskWorkflowCandidates(old.home, [accepted]), { candidates: [],
      issues: ['workflow_candidate_schema_or_inventory_unavailable'] });
    assert.deepEqual(frozenFiles(old.home), before);
    assert.deepEqual(readAcceptedTaskWorkflowCandidates(missing, [accepted]), { candidates: [],
      issues: ['workflow_candidate_store_unavailable'] });
    assert.equal(existsSync(path.join(missing, 'state')), false);
    writeFileSync(path.join(missing, 'harness-unrelated.txt'), 'retained');
    assert.equal(readAcceptedTaskWorkflowCandidates(missing, []).issues.length, 0);
    assert.deepEqual(readdirSync(missing), ['harness-unrelated.txt']);
  } finally { f.cleanup(); old.cleanup(); rmSync(missing, { recursive: true, force: true }); }
});

test('historical ordinary tasks need no optional async parent schema until a workflow claim exists', () => {
  const f = fixture({ schema: false });
  try {
    f.db.exec(`CREATE TABLE events (seq INTEGER, session_id TEXT, turn INTEGER, role TEXT, type TEXT, data_json TEXT)`);
    const insert = f.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)');
    insert.run(10, accepted.sessionId, 0, 'user', 'user_input_received', '{}');
    const ordinaryBefore = frozenFiles(f.home);
    assert.deepEqual(readAcceptedTaskWorkflowCandidates(f.home, [accepted]), { candidates: [], issues: [] });
    assert.deepEqual(frozenFiles(f.home), ordinaryBefore);
    insert.run(11, accepted.sessionId, 0, 'system', 'async_work_dispatched', JSON.stringify(dispatch));
    const claimedBefore = frozenFiles(f.home);
    assert.deepEqual(readAcceptedTaskWorkflowCandidates(f.home, [accepted]), { candidates: [],
      issues: ['workflow_candidate_dispatch_parent_schema_unavailable:fixture-parent:10'] });
    assert.deepEqual(frozenFiles(f.home), claimedBefore, 'optional parent schema is never backfilled by measurement');
  } finally { f.cleanup(); }
});

test('synthetic approval controls add no workflow issue without a claim and never admit an actual async claim', () => {
  const f = fixture();
  try {
    f.source({ data: { approvalId: 'fixture-approval', decision: 'approve', source: 'approval_resume', synthetic: true } });
    const ordinaryBefore = frozenFiles(f.home);
    assert.deepEqual(readAcceptedTaskWorkflowCandidates(f.home, [accepted]), { candidates: [], issues: [] },
      'the canonical caller retains sole authority to admit a durable approval continuation');
    assert.deepEqual(frozenFiles(f.home), ordinaryBefore);
    f.addDispatch();
    const claimedBefore = frozenFiles(f.home);
    assert.deepEqual(readAcceptedTaskWorkflowCandidates(f.home, [accepted]), { candidates: [],
      issues: ['workflow_candidate_human_source_unavailable:fixture-parent:10'] });
    assert.deepEqual(frozenFiles(f.home), claimedBefore);
  } finally { f.cleanup(); }
});

test('literal plus and Unicode session IDs remain SQL identities while dispatched metadata stays strict', () => {
  const f = fixture();
  const source = { sessionId: 'fixture+owner-雪', sourceUserSeq: 10 };
  try {
    f.source({ session: source.sessionId });
    const ordinaryBefore = frozenFiles(f.home);
    assert.deepEqual(readAcceptedTaskWorkflowCandidates(f.home, [source]), { candidates: [], issues: [] });
    assert.deepEqual(frozenFiles(f.home), ordinaryBefore);
    f.addDispatch({ session: source.sessionId, data: { ...dispatch, runIds: ['unsafe+metadata-雪'] } });
    const claimedBefore = frozenFiles(f.home);
    assert.deepEqual(readAcceptedTaskWorkflowCandidates(f.home, [source]), { candidates: [],
      issues: ['workflow_candidate_dispatch_metadata_unavailable:fixture+owner-雪:10'] });
    assert.deepEqual(frozenFiles(f.home), claimedBefore);
  } finally { f.cleanup(); }
});
