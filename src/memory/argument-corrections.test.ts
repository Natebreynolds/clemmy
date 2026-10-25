/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/argument-corrections.test.ts
 *
 * LEARNED FROM USE: a read's argument value the tool rejected, and the later
 * call that worked, become one record from the turn's own receipts; the saved
 * memory that held the value shows a "checked by use" note the same day; the
 * nightly self-heal rewrites that memory (checked by the judge) and an undo
 * brings its words back for good.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-argument-corrections-'));
process.env.CLEMENTINE_HOME = home;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(home, 'state'), { recursive: true });

const events = await import('../runtime/harness/eventlog.js');
const { resetMemoryDb } = await import('./db.js');
const { rememberFact, getFact, setFactPinned, presentPolicyText } = await import('./facts.js');
const store = await import('./argument-corrections-store.js');
const { learnArgumentCorrections, rejectionsFromRows, seedArgumentCorrectionsFromRecentTurns, _resetArgumentCorrectionSeedForTests } = await import('./argument-corrections.js');
const { _setUseRewriteModelForTests } = await import('./use-rewrite-draft.js');
const { runMemorySelfHeal, revertMemoryHeal, listProposedMemoryFixes } = await import('./self-heal.js');

const STORE = path.join(home, 'argument-corrections.json');
const ORG = 'ORGID00FIXTURE0001';
const REJECTION = `An error occurred while running the tool. Error: ReviewedCliProcessError: reviewed CLI process nonzero_exit: NamedOrgNotFoundError: Parsing --target-org No authorization information found for ${ORG}.`;

before(() => { store._setArgumentCorrectionStorePathForTests(STORE); });
beforeEach(() => { rmSync(STORE, { force: true }); resetMemoryDb(); _resetArgumentCorrectionSeedForTests(); });
after(() => { _setUseRewriteModelForTests(null); store._setArgumentCorrectionStorePathForTests(null); events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

/** A machine that already seeded: learning folds the turn it is given. */
const saveEmptyStore = () => store.saveArgumentCorrections([]);
const carrier = (args: Record<string, unknown>) => JSON.stringify({ requirement_id: 'cap:live:fixture', name: 'records_query', args_json: JSON.stringify(args) });

/** One turn: the call with the org id fails with the tool's own words; the call without it succeeds. */
function rejectedThenFixedTurn(sessionId: string, extraQuery = 'SELECT Id FROM Account') {
  const source = events.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'count the records' } });
  const seq = source.seq;
  const put = (type: string, data: Record<string, unknown>) => events.appendEvent({ sessionId, turn: 1, role: 'system', type, data: { sourceUserSeq: seq, ...data } });
  put('tool_called', { callId: 'c1', tool: 'work_call', effectiveTool: 'records_query', effect: 'read', accounting: 'top_level',
    arguments: carrier({ query: extraQuery, target_org: ORG }) });
  put('tool_returned', { callId: 'c1', accounting: 'top_level', result: REJECTION });
  put('tool_attempt_settled', { callId: 'c1', tool: 'records_query', kind: 'unknown' });
  put('tool_called', { callId: 'c2', tool: 'work_call', effectiveTool: 'records_query', effect: 'read', accounting: 'top_level',
    arguments: carrier({ query: `${extraQuery} LIMIT 5` }) });
  put('tool_returned', { callId: 'c2', accounting: 'top_level', result: '{"records":[]}' });
  put('tool_attempt_settled', { callId: 'c2', tool: 'records_query', kind: 'succeeded' });
  return seq;
}

test('the value the tool named is learned with what worked; rewritten content and schema text are not', () => {
  const rows = [
    { seq: 1, type: 'tool_called', data: { callId: 'a', effectiveTool: 'records_query', effect: 'read', arguments: carrier({ query: 'SELECT Id FROM Task WHERE X', target_org: ORG }) } },
    { seq: 2, type: 'tool_returned', data: { callId: 'a', result: REJECTION } },
    { seq: 3, type: 'tool_attempt_settled', data: { callId: 'a', kind: 'unknown' } },
    { seq: 4, type: 'tool_called', data: { callId: 'b', effectiveTool: 'records_query', effect: 'read', arguments: carrier({ query: 'SELECT Id FROM Task WHERE Y' }) } },
    { seq: 5, type: 'tool_attempt_settled', data: { callId: 'b', kind: 'succeeded' } },
  ];
  const { pairs } = rejectionsFromRows(rows);
  assert.deepEqual(pairs.map((pair) => [pair.operation, pair.effect, pair.argument, pair.rejectedValue, pair.fix]),
    [['records_query', 'read', 'target_org', ORG, { kind: 'omit' }]], 'the query text changed too, but it is content, not a rejected value');
  // A validation reply that quotes the whole schema names only its violations.
  const schemaReply = JSON.stringify({ error: 'arg_validation', schema: { properties: { workflow: {}, limit: {} } }, detail: '(root): Unrecognized key: "name"', violations: ['name'] });
  const quiet = rejectionsFromRows([
    { seq: 1, type: 'tool_called', data: { callId: 'a', effectiveTool: 'status_read', effect: 'read', arguments: JSON.stringify({ workflow: 'nightly-digest', limit: 50 }) } },
    { seq: 2, type: 'tool_returned', data: { callId: 'a', result: schemaReply } },
    { seq: 3, type: 'tool_attempt_settled', data: { callId: 'a', kind: 'invalid_arguments' } },
    { seq: 4, type: 'tool_called', data: { callId: 'b', effectiveTool: 'status_read', effect: 'read', arguments: JSON.stringify({}) } },
    { seq: 5, type: 'tool_attempt_settled', data: { callId: 'b', kind: 'succeeded' } },
  ]);
  assert.deepEqual(quiet.pairs, [], 'keys the schema merely lists are not what the tool rejected');
});

test('two turns make a read\'s rejection repairable, and the memory holding the value shows it the same day', async () => {
  const fact = rememberFact({ kind: 'constraint', content: `Always query records through the local CLI (default org, org id ${ORG}).` });
  setFactPinned(fact.id, true);
  const session = events.createSession({ kind: 'chat' });
  await seedArgumentCorrectionsFromRecentTurns();
  learnArgumentCorrections(session.id, rejectedThenFixedTurn(session.id));
  let [entry] = store.loadArgumentCorrections();
  assert.equal(entry?.pairs, 1);
  assert.equal(store.autoRepairable(entry!), false, 'one pair is not enough to act on its own');
  assert.deepEqual(entry?.factIds, [fact.id]);
  assert.match(presentPolicyText(getFact(fact.id)!), /\(Checked by use: records_query rejects target_org="ORGID00FIXTURE0001" .*it works with target_org left out\.\)/);
  learnArgumentCorrections(session.id, rejectedThenFixedTurn(session.id));
  [entry] = store.loadArgumentCorrections();
  assert.equal(entry?.pairs, 2);
  assert.equal(store.autoRepairable(entry!), true);
});

test('a repair the host applied that then failed retires the record from acting on its own', async () => {
  const session = events.createSession({ kind: 'chat' });
  saveEmptyStore();
  learnArgumentCorrections(session.id, rejectedThenFixedTurn(session.id));
  learnArgumentCorrections(session.id, rejectedThenFixedTurn(session.id));
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'again' } });
  const put = (type: string, data: Record<string, unknown>) => events.appendEvent({ sessionId: session.id, turn: 1, role: 'system', type, data: { sourceUserSeq: source.seq, ...data } });
  put('guardrail_tripped', { kind: store.ARGUMENT_CORRECTION_APPLIED, callId: 'r1', operation: 'records_query', argument: 'target_org', rejectedValue: ORG });
  put('tool_called', { callId: 'r1', effectiveTool: 'records_query', effect: 'read', accounting: 'top_level', arguments: carrier({ query: 'SELECT Id FROM Lead' }) });
  put('tool_returned', { callId: 'r1', accounting: 'top_level', result: 'No default org found' });
  put('tool_attempt_settled', { callId: 'r1', tool: 'records_query', kind: 'unknown' });
  learnArgumentCorrections(session.id, source.seq);
  const [entry] = store.loadArgumentCorrections();
  assert.equal(entry?.conflicting, true);
  assert.equal(entry?.repairFailures, 1);
  assert.equal(store.autoRepairable(entry!), false);
});

test('the nightly self-heal rewrites the misleading memory in place, and an undo restores it for good', async () => {
  const original = `Always query records through the local CLI (default org, org id ${ORG}).`;
  const fact = rememberFact({ kind: 'constraint', content: original });
  setFactPinned(fact.id, true);
  const session = events.createSession({ kind: 'chat' });
  saveEmptyStore();
  learnArgumentCorrections(session.id, rejectedThenFixedTurn(session.id));
  learnArgumentCorrections(session.id, rejectedThenFixedTurn(session.id));
  const rewritten = `Always query records through the local CLI. The default org's id is ${ORG}; it is not a target_org value, so leave target_org out to use the default org.`;
  let drafts = 0;
  _setUseRewriteModelForTests(async (request) => {
    drafts += 1;
    const asked = JSON.parse(request) as { memory: string; argument: string; rejected_value: string };
    assert.equal(asked.memory, original);
    assert.equal(asked.argument, 'target_org');
    assert.equal(asked.rejected_value, ORG);
    return JSON.stringify({ rewrite: rewritten });
  });
  const judged: string[] = [];
  const outcome = await runMemorySelfHeal({ judge: async (fix) => { judged.push(fix.kind); return { verdict: 'approve', reason: 'keeps the rule' }; } });
  assert.ok(judged.includes('rewrite_fact_from_use'), 'the rewrite is checked by the judge before it is applied');
  const result = outcome.results.find((entry) => entry.kind === 'rewrite_fact_from_use');
  assert.equal(result?.ok, true, JSON.stringify(outcome));
  const after = getFact(fact.id)!;
  assert.equal(after.content, rewritten);
  assert.equal(after.pinned, true, 'the rule stays pinned: the same row is rewritten');
  assert.doesNotMatch(presentPolicyText(after), /Checked by use/, 'the note stops once the memory says it itself');
  const reverted = revertMemoryHeal(result!.auditId!);
  assert.equal(reverted.ok, true, reverted.message);
  assert.equal(getFact(fact.id)!.content, original, 'undo brings the owner\'s words back');
  assert.match(presentPolicyText(getFact(fact.id)!), /Checked by use/, 'and the same-day note with them');
  assert.equal(listProposedMemoryFixes().find((fix) => fix.kind === 'rewrite_fact_from_use')?.status, 'reverted');
  await runMemorySelfHeal({ judge: async () => ({ verdict: 'approve' }) });
  assert.equal(drafts, 1, 'an undone rewrite is never drafted again');
  assert.equal(getFact(fact.id)!.content, original);
});

test('a machine\'s first learning reads its recent turns once, so what they prove is not waited for again', async () => {
  const session = events.createSession({ kind: 'chat' });
  rejectedThenFixedTurn(session.id);
  rejectedThenFixedTurn(session.id);
  rmSync(STORE, { force: true });
  assert.ok(await seedArgumentCorrectionsFromRecentTurns() >= 2);
  const entry = store.loadArgumentCorrections().find((candidate) => candidate.rejectedValue === ORG);
  assert.ok(entry && entry.pairs >= 2 && store.autoRepairable(entry), JSON.stringify(entry));
  assert.equal(await seedArgumentCorrectionsFromRecentTurns(), 0, 'it runs once: the store now exists');
});

test('a first read that finds nothing writes nothing, and later turns still learn', async () => {
  const session = events.createSession({ kind: 'chat' });
  // A window with no turns in it (earlier tests' turns are in the shared log).
  const empty = new Date(Date.now() + 365 * 86_400_000);
  assert.equal(await seedArgumentCorrectionsFromRecentTurns(14, empty), 0);
  assert.equal(existsSync(STORE), false, 'a fresh home gains no file from an empty read');
  assert.equal(await seedArgumentCorrectionsFromRecentTurns(), 0, 'and does not read again in this process');
  learnArgumentCorrections(session.id, rejectedThenFixedTurn(session.id));
  assert.equal(store.loadArgumentCorrections()[0]?.pairs, 1, 'the next real rejection is learned');
});
