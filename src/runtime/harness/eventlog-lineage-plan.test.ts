/**
 * Following one call's lineage is served by the tool-lifecycle index.
 *
 * `idx_events_tool_lifecycle_call` is a partial index over
 * `type IN ('tool_called','tool_returned')`. SQLite uses a partial index only
 * when it can prove the query's WHERE clause implies the index's, so the
 * lineage lookup must state that predicate itself; `type = 'tool_called'` alone
 * falls back to the session/type index and reads every tool call the session
 * ever made.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/eventlog-lineage-plan.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-lineage-plan-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'lineage-plan\n', 'utf8');

const eventlog = await import('./eventlog.js');
after(() => { eventlog.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });

test('the lineage lookup of one call id is planned on the tool-lifecycle call index', () => {
  eventlog.resetEventLog();
  const db = eventlog.openEventLog();
  const captured: string[] = [];
  const prepare = db.prepare.bind(db);
  (db as { prepare: typeof db.prepare }).prepare = ((source: string) => {
    captured.push(source);
    return prepare(source);
  }) as typeof db.prepare;
  let rows: ReturnType<typeof eventlog.listToolCalledEventsForCallId>;
  try {
    const s = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'lineage-plan' });
    eventlog.appendEvent({ sessionId: s.id, turn: 1, role: 'agent', type: 'tool_called', data: {
      callId: 'toolu_lineage_plan', tool: 'recall_tool_result', arguments: '{"call_id":"toolu_source"}',
    } });
    eventlog.appendEvent({ sessionId: s.id, turn: 1, role: 'agent', type: 'tool_returned', data: {
      callId: 'toolu_lineage_plan', tool: 'recall_tool_result',
    } });
    captured.length = 0;
    rows = eventlog.listToolCalledEventsForCallId(s.id, 'toolu_lineage_plan');
  } finally {
    (db as { prepare: typeof db.prepare }).prepare = prepare;
  }
  assert.deepEqual(rows.map((row) => row.type), ['tool_called'], 'only the call rows are returned');
  const lineageSql = captured.find((source) => /json_extract\(data_json, '\$\.callId'\)/.test(source));
  assert.ok(lineageSql, `the lineage lookup prepared its statement: ${captured.join(' | ')}`);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${lineageSql}`)
    .all('planner-session', 'planner-call') as Array<{ detail?: string }>;
  const details = plan.map((row) => row.detail ?? '').join(' | ');
  assert.ok(
    plan.some((row) => row.detail?.includes('idx_events_tool_lifecycle_call') && row.detail.includes('<expr>=?')),
    `lineage lookup must use its call-id index: ${details}`,
  );
});
