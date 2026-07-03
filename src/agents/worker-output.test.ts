/**
 * Run: npx tsx --test src/agents/worker-output.test.ts
 *
 * FIX 1.3 — normalizeWorkerOutput turns a run_worker result into a
 * deterministic ERROR:/PARTIAL:/verbatim envelope so the orchestrator can
 * classify done vs failed in code. Pure function; must never throw and must
 * never lose a worker's real output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkerOutput } from './worker-output.js';

test('passes ERROR:-prefixed output through verbatim', () => {
  const out = 'ERROR: no email on file for this contact';
  assert.equal(normalizeWorkerOutput(out), out);
});

test('passes PARTIAL:-prefixed output through verbatim', () => {
  const out = 'PARTIAL: got SERP data but keyword volume API 500d';
  assert.equal(normalizeWorkerOutput(out), out);
});

test('passes a clean success body through unchanged', () => {
  const out = 'Researched Acme LLP: domain authority 38, top keyword "acme law" pos 4.';
  assert.equal(normalizeWorkerOutput(out), out);
});

test('empty output → ERROR: (a worker that produced nothing is a FAILED item, not a hollow done)', () => {
  const r = normalizeWorkerOutput('');
  assert.match(r, /^ERROR:/);
  assert.match(r, /did not complete/i);
  assert.equal(normalizeWorkerOutput('   \n  ').startsWith('ERROR:'), true);
});

test('the SDK generic tool-error string (turn-cap / internal error) → ERROR:', () => {
  // This is what defaultToolErrorFunction returns when a worker run throws
  // (MaxTurnsExceeded from FIX 1.2, or any internal tool error).
  const generic = 'An error occurred while running the tool. Please try again. Error: Max turns (8) exceeded';
  const r = normalizeWorkerOutput(generic);
  assert.match(r, /^ERROR:/);
  assert.match(r, /turn cap|errored internally/i);
});

test('extracts from an SDK result object (finalOutput) and classifies it', () => {
  assert.equal(
    normalizeWorkerOutput({ finalOutput: 'Done: created record rec123' }),
    'Done: created record rec123',
  );
  assert.match(normalizeWorkerOutput({ finalOutput: 'ERROR: bad slug' }), /^ERROR: bad slug/);
  assert.match(normalizeWorkerOutput({ finalOutput: '' }), /^ERROR:/);
});

test('MALFORMED JSON where structure was expected passes through VERBATIM (there is no schema at this layer — the worker text IS the answer)', () => {
  // A worker asked for JSON that returns broken JSON has still produced text.
  // normalizeWorkerOutput must NOT replace it (that would lose the worker's real
  // output); the ledger counts it done because it IS text. The layer that cares
  // about JSON validity is the parent that parses it, not this envelope.
  const broken = '{"item": "Acme LLP", "authority": 38,';
  assert.equal(normalizeWorkerOutput(broken), broken, 'raw text handed back unchanged, no silent replacement');
  // The run_worker handler ok-gate would mark this ok (not ERROR-prefixed).
  assert.equal(/^\s*ERROR:/i.test(normalizeWorkerOutput(broken)), false);

  // Non-JSON free text is likewise passed through — only empty / generic-apology
  // / already-ERROR strings are reclassified.
  const prose = 'Acme has a thin backlink profile; recommend 3 guest posts.';
  assert.equal(normalizeWorkerOutput(prose), prose);
});

test('cross-lane cap: normalizeWorkerOutput("") is the EXACT envelope runCrossProviderWorker returns on MaxTurnsExceeded (ledger marks it failed)', () => {
  // sub-agents.runCrossProviderWorker catches MaxTurnsExceededError and returns
  // { text: normalizeWorkerOutput('') }. Pin that this yields a failed envelope
  // the handler ok-gate rejects — cross-provider lane parity with the Claude lane.
  const capEnvelope = normalizeWorkerOutput('');
  assert.match(capEnvelope, /^ERROR:/);
  assert.match(capEnvelope, /turn cap|errored internally|did not complete/i);
  assert.equal(/^\s*ERROR:/i.test(capEnvelope), true, 'the handler ok-gate marks the cross-lane cap FAILED');
});

test('a worker that returns the SDK generic apology is reclassified as ERROR, never surfaced as a hollow success', () => {
  const apology = 'An error occurred while running the tool. Please try again.';
  const r = normalizeWorkerOutput(apology);
  assert.match(r, /^ERROR:/, 'a generic apology is a FAILED item, not a done one');
});

test('never throws on malformed input — falls back to a string', () => {
  assert.doesNotThrow(() => normalizeWorkerOutput(undefined));
  assert.doesNotThrow(() => normalizeWorkerOutput(null));
  assert.doesNotThrow(() => normalizeWorkerOutput(42));
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.doesNotThrow(() => normalizeWorkerOutput(circular));
  // undefined/null have no usable text → treated as a non-completing worker.
  assert.match(normalizeWorkerOutput(undefined), /^ERROR:/);
});
