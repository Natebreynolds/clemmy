/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/run-progress.test.ts
 *
 * The live line a watching person actually sees between tool rows.
 *
 * Live 2026-09-12: a healthy 7m32s Plan run and the 33-minute one that circled
 * produced the SAME line — "Still working — 1 result collected." — because it
 * counted returns instead of saying what was accumulating. The owner watched
 * the good run and asked whether she was going in circles, which is the right
 * question to ask of a surface that cannot answer it. Reconstructed from that
 * run's ledger: document read at t+30s, five toolkits bound by t+2:00, then
 * three minutes of silence while the plan was written.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-run-progress-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const events = await import('./eventlog.js');
const { composeRunProgressLine } = await import('./run-progress.js');

after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function turn(text = 'read this doc and plan the research') {
  const session = events.createSession({ kind: 'chat', userId: 'fixture-owner' });
  const source = events.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

function readDoc(id: { sessionId: string; sourceUserSeq: number }) {
  events.appendEvent({
    sessionId: id.sessionId, turn: 1, role: 'system', type: 'read_receipt',
    data: { sourceUserSeq: id.sourceUserSeq, record: { identifier: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT', effectClass: 'read' } },
  });
}

function bind(id: { sessionId: string; sourceUserSeq: number }, toolkit: string, count: number) {
  events.appendEvent({
    sessionId: id.sessionId, turn: 1, role: 'system', type: 'capability_resolution',
    data: {
      sourceUserSeq: id.sourceUserSeq,
      entries: Array.from({ length: count }, (_, i) => ({
        kind: 'composio', identifier: `${toolkit}_OP_${i}`, status: 'proven', connection: 'active',
      })),
    },
  });
}

test('an investigating turn reports what it has assembled, not just that something returned', () => {
  const id = turn();

  // Nothing assembled yet — the caller's fallback still governs. A progress
  // line invented before there is progress is worse than none.
  assert.equal(composeRunProgressLine({ ...id, fallback: 'FALLBACK' }), 'FALLBACK');

  readDoc(id);
  bind(id, 'DATAFORSEO', 9);
  bind(id, 'APIFY', 1);
  bind(id, 'FIRECRAWL', 2);

  const line = composeRunProgressLine({ ...id, fallback: 'FALLBACK' });
  assert.match(line, /1 input read/, 'the document she read counts as progress');
  assert.match(line, /3 toolkits bound/, 'breadth is what shows a plan taking shape');
  assert.match(line, /dataforseo/, 'and WHICH toolkits, so "bound" is checkable rather than a number');
  assert.match(line, /12 operations callable/, 'the honest total across toolkits');
  assert.doesNotMatch(line, /FALLBACK/);
});

test('the line distinguishes a turn that is accumulating from one that is not', () => {
  // The exact confusion from 2026-09-12: two runs, same old line. With the
  // inventory they read differently at the same point in time.
  const circling = turn();
  readDoc(circling);
  bind(circling, 'DATAFORSEO', 9);
  const converging = turn();
  readDoc(converging);
  bind(converging, 'DATAFORSEO', 9);
  bind(converging, 'APIFY', 1);
  bind(converging, 'FIRECRAWL', 2);
  bind(converging, 'GOOGLEDOCS', 7);

  const a = composeRunProgressLine({ ...circling, fallback: '' });
  const b = composeRunProgressLine({ ...converging, fallback: '' });
  assert.notEqual(a, b, 'one toolkit and four must not render identically');
  assert.match(a, /1 toolkit bound/, 'singular reads correctly');
  assert.match(b, /4 toolkits bound/);
});

test('re-proving the same toolkit does not inflate the line', () => {
  // Nine DataForSEO rows are one toolkit of knowledge — the same distinction
  // the steer window and the compaction map both make, so all three agree.
  const id = turn();
  readDoc(id);
  for (let i = 0; i < 5; i += 1) bind(id, 'DATAFORSEO', 3);
  const line = composeRunProgressLine({ ...id, fallback: '' });
  assert.match(line, /1 toolkit bound/, 'repeat proofs of one toolkit stay one toolkit');
  assert.match(line, /3 operations callable/, 'and duplicate operations are not counted twice');
});

test('a broken ledger falls back rather than inventing progress', () => {
  assert.equal(composeRunProgressLine({ sessionId: 'no-such-session', fallback: 'FALLBACK' }), 'FALLBACK');
  assert.equal(composeRunProgressLine({ sessionId: '', fallback: 'FALLBACK' }), 'FALLBACK');
});
