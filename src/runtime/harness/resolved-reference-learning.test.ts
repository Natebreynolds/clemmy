/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/resolved-reference-learning.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-resolved-reference-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const {
  deriveResolvedReferences, learnResolvedReferencesForAcceptedTask, resolvedReferenceContent, resolvedReferenceLead,
} = await import('./resolved-reference-learning.js');
const { createSession, appendEvent, closeEventLog } = await import('./eventlog.js');
const { listActiveFacts, findActiveFactsByContentPrefix } = await import('../../memory/facts.js');
type SettledCall = Parameters<typeof deriveResolvedReferences>[0]['calls'][number];
type ConfirmName = Parameters<typeof deriveResolvedReferences>[0]['confirmName'];

after(() => {
  closeEventLog();
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** A naming check that picks the person-like or place-like name a record
 * offers, the way the router does, and records what it was asked. */
function confirming(pick: (candidates: string[]) => string | null, asked: Array<{ value: string; candidates: string[] }> = []): ConfirmName {
  return async (question) => {
    asked.push({ value: question.value, candidates: question.candidates });
    return pick(question.candidates);
  };
}
const first = (...names: string[]) => (candidates: string[]) => names.find((name) => candidates.includes(name)) ?? null;

// Three different kinds of thing, none of them known to the code: a person
// reached by an address, a board reached by an id, a folder reached by a key.
const directory: SettledCall = { tool: 'peoplescope__find', callId: 'read-people', mutating: false, args: { query: 'Dana Whitlock' },
  result: { data: { people: [
    { id: 'U0DANA01', profile: { displayName: 'Dana Whitlock', title: 'Operations lead' }, contact: 'dana.whitlock@harborline.example' },
    { id: 'U0OTHER2', profile: { displayName: 'Rafi Okonkwo' }, contact: 'rafi@harborline.example' },
  ] } } };
const boards: SettledCall = { tool: 'boardscope__list_boards', callId: 'read-boards', mutating: false, args: {},
  result: { boards: [{ key: 'brd_7f3a91', title: 'Quarterly Roadmap', owner: 'U0OTHER2' }, { key: 'brd_2c10de', title: 'Hiring' }] } };

test('what a request named is kept with the exact value an accepted call used, whatever kind of thing it is', async () => {
  const asked: Array<{ value: string; candidates: string[] }> = [];
  const request = 'Add a card to the quarterly roadmap for dana whitlock about the pier inspection.';
  const write: SettledCall = { tool: 'boardscope__create_card', callId: 'write-card', mutating: true,
    args: { board: 'brd_7f3a91', assignee: { contact: 'dana.whitlock@harborline.example' }, title: 'Pier inspection', due: '2026-10-06' },
    result: { id: 'card_991', board: 'brd_7f3a91' } };
  const resolved = await deriveResolvedReferences({ request, calls: [directory, boards, write],
    confirmName: confirming(first('Dana Whitlock', 'Quarterly Roadmap'), asked) });
  assert.deepEqual(resolved.map((row) => [row.named, row.value, row.operation, row.argument, row.effect, row.foundIn.tool]), [
    ['Quarterly Roadmap', 'brd_7f3a91', 'boardscope__create_card', 'board', 'change', 'boardscope__list_boards'],
    ['Dana Whitlock', 'dana.whitlock@harborline.example', 'boardscope__create_card', 'assignee.contact', 'change', 'peoplescope__find'],
  ], 'the request wrote both names in lower case; the record\'s own form is kept');
  assert.ok(!asked.some((question) => question.value === 'Pier inspection' || question.value === '2026-10-06'),
    'a title is prose and a date is a quantity; neither is asked about');
});

test('a value the request stated was given, not resolved', async () => {
  const write: SettledCall = { tool: 'boardscope__create_card', callId: 'w', mutating: true, args: { board: 'brd_7f3a91' }, result: {} };
  const resolved = await deriveResolvedReferences({ request: 'Add a card to board brd_7f3a91 (Quarterly Roadmap).',
    calls: [boards, write], confirmName: confirming(first('Quarterly Roadmap')) });
  assert.deepEqual(resolved, []);
});

test('sharing a record is not naming: a title beside an owner is kept only if the naming check says so', async () => {
  // The request mentions the board's title. The board's record also carries
  // an owner id the call used. The title is not that owner's name.
  const write: SettledCall = { tool: 'peoplescope__notify', callId: 'w', mutating: true, args: { user: 'U0OTHER2' }, result: { ok: true } };
  const request = 'Tell whoever owns the Quarterly Roadmap that the draft is ready.';
  const unsure = await deriveResolvedReferences({ request, calls: [boards, write], confirmName: confirming(() => null) });
  assert.deepEqual(unsure, [], 'without a sure name nothing is kept');
  const other = await deriveResolvedReferences({ request, calls: [boards, directory, write],
    confirmName: confirming(first('Rafi Okonkwo')) });
  assert.deepEqual(other, [], 'the name the check is sure of was never used by the request');
});

test('when the naming check cannot be reached nothing is learned', async () => {
  const write: SettledCall = { tool: 'boardscope__create_card', callId: 'w', mutating: true, args: { board: 'brd_7f3a91' }, result: {} };
  const resolved = await deriveResolvedReferences({ request: 'Add a card to the Quarterly Roadmap.', calls: [boards, write],
    confirmName: async () => { throw new Error('router unavailable'); } });
  assert.deepEqual(resolved, []);
});

test('a value is asked about once however many calls used it, and a read is kept as a read', async () => {
  const asked: Array<{ value: string; candidates: string[] }> = [];
  const read = (id: string): SettledCall => ({ tool: 'boardscope__list_cards', callId: id, mutating: false, args: { board: 'brd_7f3a91', page: '2' }, result: { cards: [] } });
  const resolved = await deriveResolvedReferences({ request: 'What is on the Quarterly Roadmap?', calls: [boards, read('r1'), read('r2')],
    confirmName: confirming(first('Quarterly Roadmap'), asked) });
  assert.equal(asked.length, 1);
  assert.deepEqual(resolved.map((row) => [row.argument, row.effect]), [['board', 'read']], 'the same argument of the same operation is one resolution');
});

test('an argument that holds a document as text is read as that document, and a secret is never kept', async () => {
  const vault: SettledCall = { tool: 'vaultscope__list', callId: 'read-vault', mutating: false, args: {},
    result: { folders: [{ name: 'Heron Archive', key: 'fld_heron_22', token: 'sk-live-0123456789abcdef0123456789abcdef' }] } };
  const write: SettledCall = { tool: 'vaultscope__file', callId: 'w', mutating: true,
    args: { arguments: JSON.stringify({ destination: [{ folder: 'fld_heron_22' }], auth: 'sk-live-0123456789abcdef0123456789abcdef' }) }, result: {} };
  const asked: Array<{ value: string; candidates: string[] }> = [];
  const resolved = await deriveResolvedReferences({ request: 'File this under the heron archive.', calls: [vault, write],
    confirmName: confirming(first('Heron Archive'), asked) });
  assert.deepEqual(resolved.map((row) => [row.named, row.value, row.argument]), [['Heron Archive', 'fld_heron_22', 'arguments.destination[].folder']]);
  assert.ok(!asked.some((question) => question.value.startsWith('sk-')), 'a secret is not even asked about');
});

test('a name inside another word is not the name', async () => {
  const places: SettledCall = { tool: 'mapscope__find', callId: 'r', mutating: false, args: {}, result: { places: [{ label: 'Art', ref: 'plc_art_1' }] } };
  const write: SettledCall = { tool: 'mapscope__pin', callId: 'w', mutating: true, args: { place: 'plc_art_1' }, result: {} };
  const resolved = await deriveResolvedReferences({ request: 'Pin the start of the party route.', calls: [places, write],
    confirmName: confirming(first('Art')) });
  assert.deepEqual(resolved, [], '"Art" appears only inside "start" and "party"');
});

test('a later resolution of the same name and argument replaces the earlier one and keeps it in history', async () => {
  const lead = resolvedReferenceLead({ named: 'Dana Whitlock', operation: 'boardscope__create_card', argument: 'assignee.contact' });
  const base = { named: 'Dana Whitlock', operation: 'boardscope__create_card', argument: 'assignee.contact',
    effect: 'change' as const, callId: 'w', foundIn: { tool: 'peoplescope__find', callId: 'r' } };
  const { rememberFact, supersedeFact } = await import('../../memory/facts.js');
  const earlier = rememberFact({ kind: 'reference', content: resolvedReferenceContent({ ...base, value: 'dana@oldfirm.example' }) });
  assert.deepEqual(findActiveFactsByContentPrefix('reference', lead).map((fact) => fact.id), [earlier.id]);
  const replaced = supersedeFact(earlier.id, { content: resolvedReferenceContent({ ...base, value: 'dana.whitlock@harborline.example' }) })!;
  const active = findActiveFactsByContentPrefix('reference', lead);
  assert.deepEqual(active.map((fact) => fact.id), [replaced.id], 'one current value for one name and argument');
  assert.match(active[0]!.content, /dana\.whitlock@harborline\.example/);
  assert.doesNotMatch(active[0]!.content, /oldfirm/);
  assert.deepEqual(findActiveFactsByContentPrefix('reference', 'When a request names "dana%'), [], 'the lead is matched literally, never as a pattern');
  assert.deepEqual(findActiveFactsByContentPrefix('reference', lead.toUpperCase()).map((fact) => fact.id), [replaced.id], 'and without regard to case');
});

test('a finished request with nothing on a receipt teaches no resolution', async () => {
  const session = createSession({ id: 'resolved-none', kind: 'chat' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Add a card to the Quarterly Roadmap for Dana Whitlock.' } });
  const before = listActiveFacts({ limit: 50, kind: 'reference' }).length;
  const kept = await learnResolvedReferencesForAcceptedTask({ sessionId: session.id, sourceUserSeq: source.seq },
    { confirmName: confirming(first('Dana Whitlock')) });
  assert.deepEqual(kept, { learned: 0, superseded: 0, references: [] });
  assert.equal(listActiveFacts({ limit: 50, kind: 'reference' }).length, before);
});

test('resolutions are read from the settled calls of the request itself and kept in memory with their source', async () => {
  const shadow = await import('../graph/turn-graph-shadow.js');
  const dispatch = await import('./dispatch-ledger.js');
  const identities = await import('./attempt-identity.js');
  const outcomes = await import('./attempt-outcome.js');
  const store = await import('./logical-call-settlement-store.js');
  const { settledCallsForSource } = await import('./resolved-reference-learning.js');
  const session = createSession({ id: 'resolved-settled', kind: 'chat' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Put the pier inspection on the Quarterly Roadmap and assign it to Dana Whitlock.' } });
  assert.ok(shadow.recordTurnGraphShadow({ identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 } }));
  const task = { sessionId: session.id, sourceUserSeq: source.seq, acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq) };
  const settle = (id: string, tool: string, mutating: boolean, args: Record<string, unknown>, payload: unknown) => {
    const started = dispatch.beginPhysicalDispatch({ identity: { ...task, logicalToolCallId: id, physicalDispatchId: `${id}:1`, ordinal: 0 }, tool, args });
    assert.equal(started.status, 'inserted', JSON.stringify(started));
    if (started.status !== 'inserted') return;
    assert.equal(dispatch.settlePhysicalDispatch({ identity: started.identity, tool, outcome: 'returned' }).status, 'inserted');
    assert.equal(store.commitLogicalCallSettlement({
      identity: { ...task, logicalToolCallId: id }, contract: { toolName: tool, args },
      execution: { kind: 'provider_execution' }, result: { payload },
      outcome: outcomes.classifyAttemptOutcome({ envelopeSuccessful: true }),
      recovery: { businessCall: true, mutating }, observer: { lane: 'byo', turn: 1 },
    }).status, 'committed');
  };
  settle('r-people', directory.tool, false, directory.args as Record<string, unknown>, directory.result);
  settle('r-boards', boards.tool, false, boards.args as Record<string, unknown>, boards.result);
  settle('w-card', 'boardscope__create_card', true,
    { board: 'brd_7f3a91', assignee: { contact: 'dana.whitlock@harborline.example' }, title: 'Pier inspection' }, { id: 'card_991' });
  const calls = settledCallsForSource({ sessionId: session.id, sourceUserSeq: source.seq });
  assert.deepEqual(calls.map((call) => [call.tool, call.mutating]), [
    ['peoplescope__find', false], ['boardscope__list_boards', false], ['boardscope__create_card', true]]);
  assert.deepEqual(calls[2]!.args, { board: 'brd_7f3a91', assignee: { contact: 'dana.whitlock@harborline.example' }, title: 'Pier inspection' },
    'the arguments are the ones the call was admitted with');

  const kept = await learnResolvedReferencesForAcceptedTask({ sessionId: session.id, sourceUserSeq: source.seq },
    { confirmName: confirming(first('Dana Whitlock', 'Quarterly Roadmap')) });
  assert.equal(kept.learned, 2);
  assert.equal(kept.superseded, 0, 'the value is the one already on file: nothing is replaced');
  const facts = listActiveFacts({ limit: 50, kind: 'reference' }).map((fact) => fact.content);
  assert.ok(facts.some((content) => content.startsWith('When a request names "Quarterly Roadmap", boardscope__create_card takes board = brd_7f3a91 ')), facts.join('\n'));
  assert.ok(facts.some((content) => /names "Dana Whitlock", boardscope__create_card takes assignee\.contact = dana\.whitlock@harborline\.example \(used in a change the provider accepted; found in a peoplescope__find result\)/.test(content)), facts.join('\n'));
  const person = findActiveFactsByContentPrefix('reference', 'When a request names "Dana Whitlock", boardscope__create_card takes assignee.contact = ')[0]!;
  assert.equal(person.derivedFrom?.callId, 'w-card', 'the memory points at the accepted call');
  assert.equal(person.derivedFrom?.sessionId, session.id);
  assert.match(person.content, /Check it still holds before relying on it/);

  // Learned again from the same request: one memory, not two.
  await learnResolvedReferencesForAcceptedTask({ sessionId: session.id, sourceUserSeq: source.seq },
    { confirmName: confirming(first('Dana Whitlock', 'Quarterly Roadmap')) });
  assert.equal(findActiveFactsByContentPrefix('reference', 'When a request names "Dana Whitlock", boardscope__create_card takes assignee.contact = ').length, 1);
});
