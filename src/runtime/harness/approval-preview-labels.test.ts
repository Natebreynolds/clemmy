/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/approval-preview-labels.test.ts
 *
 * Live 2026-09-25: an approval read "users UC0806VCJ"; the record Clem had
 * looked up named the person. Candidates come from the records that carry the
 * exact value; Jev picks (see host-turn-runner.test.ts for the wired pin).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { labelAskedOnce, labelCandidatesFor, producedFromIdentifier, type ApprovalLabelMemo, type SettledCallEvidence } from './approval-preview-labels.js';

test('candidates are the strings of the records that carry the exact id, most repeated first, without URLs', () => {
  const directory = { data: { members: [{
    id: 'U0FIXTURE1', name: 'sam', real_name: 'Sam Rivera', tz: 'America/Los_Angeles',
    profile: { title: 'Recruiter', image: 'https://example.test/sam.png' },
  }, { id: 'U0OTHER', real_name: 'Someone Else' }] } };
  const messages = { messages: { matches: [
    { user: 'U0FIXTURE1', username: 'sam', text: 'see you at 4:15', permalink: 'https://example.test/p/1' },
    { user: 'U0FIXTURE1', username: 'sam', text: 'running late' },
  ] } };
  const candidates = labelCandidatesFor([directory, messages], 'U0FIXTURE1');
  assert.equal(candidates[0], 'sam', 'the name every record agrees on comes first');
  for (const expected of ['Sam Rivera', 'Recruiter', 'see you at 4:15']) assert.ok(candidates.includes(expected), expected);
  assert.ok(!candidates.includes('U0FIXTURE1'), 'the id is not its own name');
  assert.ok(!candidates.includes('Someone Else'), 'another record is not a candidate');
  assert.ok(!candidates.some((text) => text.includes('://')), 'a URL is never a name');
  assert.deepEqual(labelCandidatesFor([directory], 'U0NOWHERE'), []);
});

test('the members of one approval batch ask an identical label question once', async () => {
  // Live 2026-09-28 (source 325147): nine prepared events carried the same
  // identifier beside the same results, and the same question was asked nine
  // times for nine identical answers.
  const memo: ApprovalLabelMemo = new Map();
  const question = { operation: 'Create calendar event', field: 'owner', value: 'U0FIXTURE1', candidates: ['sam', 'Sam Rivera'] };
  let asks = 0;
  const ask = async (): Promise<string | null> => { asks += 1; return 'Sam Rivera'; };
  const answers = await Promise.all(Array.from({ length: 9 }, () => labelAskedOnce(memo, { ...question, candidates: [...question.candidates] }, ask)));
  assert.deepEqual(answers, Array(9).fill('Sam Rivera'));
  assert.equal(asks, 1, 'members asked together share one ask');
  await labelAskedOnce(memo, { ...question, value: 'U0OTHER' }, ask);
  await labelAskedOnce(memo, { ...question, candidates: ['Sam Rivera', 'sam'] }, ask);
  await labelAskedOnce(memo, { ...question, field: 'recipient' }, ask);
  assert.equal(asks, 4, 'a different value, candidate order or field is a different question');
  await labelAskedOnce(undefined, question, ask);
  await labelAskedOnce(new Map(), question, ask);
  assert.equal(asks, 6, 'no memo, or another batch, asks again');
});

test('a label ask that fails answers no name for every member that shared it', async () => {
  const memo: ApprovalLabelMemo = new Map();
  const question = { operation: 'Send message', field: 'recipient', value: 'U0FIXTURE1', candidates: ['sam'] };
  let asks = 0;
  const failing = async (): Promise<string | null> => { asks += 1; throw new Error('router unavailable'); };
  assert.deepEqual(await Promise.all([labelAskedOnce(memo, question, failing), labelAskedOnce(memo, question, failing)]), [null, null]);
  assert.equal(asks, 1);
});

// Live 2026-09-28: an approval showed only the id of a conversation that an
// earlier call had opened for one person. The record carrying that id named
// nobody; the person was named in another result. The first repair joined the
// two by operation name. The relation is the call itself, whatever it is called.
const person: SettledCallEvidence = { operation: 'chatscope__find_person', accountId: 'work', args: { email: 'sam@example.test' },
  result: { data: { ok: true, person: { id: 'P123', fullName: 'Sam Rivera', profile: { email: 'sam@example.test' } } } } };
const opened: SettledCallEvidence = { operation: 'chatscope__open_thread', accountId: 'work', args: { people: 'P123' },
  result: { data: { ok: true, thread: { id: 'T456' }, alreadyOpen: true } } };
const made = (evidence: SettledCallEvidence[], accountId = 'work', value = 'T456') => producedFromIdentifier({ accountId, value, evidence });

test('a returned value is traced to the one identifier the call was given, whatever the operation is called', () => {
  assert.equal(made([person, opened]), 'P123');
  // Another kind of thing entirely: a share link made for one folder.
  const share: SettledCallEvidence = { operation: 'vaultscope__create_link', accountId: 'work', args: { target: { folder: 'fld_heron_22' }, expires: true },
    result: { link: { token: 'lnk_9c1e77' } } };
  assert.equal(made([share], 'work', 'lnk_9c1e77'), 'fld_heron_22', 'a flag beside the identifier is a setting, not something the value was made from');
  assert.deepEqual(labelCandidatesFor([person.result, opened.result], 'P123').includes('Sam Rivera'), true,
    'naming the identifier is the ordinary question over the ordinary records');
});

test('an inexact relation names nothing', () => {
  assert.equal(made([person]), undefined, 'no call returned the value');
  assert.equal(made([person, opened], 'personal'), undefined, 'another account');
  assert.equal(made([person, { ...opened, accountId: 'personal' }]), undefined, 'the call ran on another account');
  assert.equal(made([person, opened], 'work', 'Tother'), undefined, 'another value');
  assert.equal(made([person, { ...opened, args: { thread: 'T456' } }]), undefined, 'the value was passed in, not returned');
  assert.equal(made([person, { ...opened, args: { people: 'P123', workspace: 'W777' } }]), undefined, 'two identifiers: which one it was made from is not known');
  assert.equal(made([person, opened, { ...opened, args: { people: 'P999' } }]), undefined, 'two calls returned it for different identifiers');
  assert.equal(made([person, { ...opened, result: { data: { ok: false, error: 'not_allowed', thread: { id: 'T456' } } } }]), undefined,
    'the provider reported a failure');
  assert.equal(made([person, { ...opened, args: { people: 'P123 P999' } }]), undefined, 'a list in one argument is not one identifier');
  assert.equal(producedFromIdentifier({ accountId: '', value: 'T456', evidence: [opened] }), undefined, 'no account, no relation');
});

test('several identifiers in one token are one argument that no record carries, so nothing is named', () => {
  const group = { ...opened, args: { people: 'P123,P999' } };
  const source = made([person, group]);
  assert.equal(source, 'P123,P999');
  assert.deepEqual(labelCandidatesFor([person.result, group.result], source!), [], 'a group is never given one person\'s name');
});

test('a provider id over a hundred characters is still an id the card can name', async () => {
  const { identifierValue } = await import('./approval-preview-labels.js');
  const graphAttachmentId = `AAMkADExOGRmNmY1LWQ1MmEtNGUwMi05MTk0LTA4MmY5NTg2NTgxYQBGAAAAAAD-yrYzWhDuRp3B0nXllfXnBwCM9mY4rqw1TrpigdngpBZ0AAAAAAEPAACM9mY4rqw1TrpigdngpBZ0AAJN54yLAAABEgAQAOJsWtE0jXFHv0564sc55yo=`;
  assert.ok(graphAttachmentId.length > 170);
  assert.equal(identifierValue(graphAttachmentId), true);
  const listing = { value: [{ id: graphAttachmentId, name: 'team-legal-q4-slide7.png', contentType: 'image/png', size: 176893 }] };
  assert.ok(labelCandidatesFor([listing], graphAttachmentId).includes('team-legal-q4-slide7.png'));
  assert.equal(identifierValue('two words'), false, 'prose is never an id');
});
