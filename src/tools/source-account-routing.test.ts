import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-source-account-routing-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const eventlog = await import('../runtime/harness/eventlog.js');
const resolution = await import('../runtime/harness/capability-resolution.js');
const registry = await import('../runtime/semantic-boundary/turn-semantic-port-registry.js');
const { configuredBrainSemanticPort, semanticModelRoleForPurpose } = await import('../runtime/semantic-boundary/configured-brain-semantic-port.js');
const routing = await import('./source-account-routing.js');
const provider = await import('./tool-search-provider-sources.js');
const aliases = await import('../memory/account-alias-store.js');
const composio = await import('../integrations/composio/client.js');
const { registerToolSearchTool } = await import('./tool-search-tool.js');
import type { SourceAccountJudgeCall, SourceAccountJudgeResult } from '../runtime/semantic-boundary/turn-semantic-model-port.js';

const SCORPION = 'operator@scorpion.invalid';
const PERSONAL = 'operator@personal.invalid';
const connections = [
  { slug: 'outlook', connectionId: 'fixture-scorpion', status: 'ACTIVE', accountEmail: SCORPION },
  { slug: 'outlook', connectionId: 'fixture-personal', status: 'ACTIVE', accountEmail: PERSONAL },
] as Parameters<typeof routing.resolveSourceAccountRouting>[0]['connections'];
const ORIGINAL = 'As a test, go ahead and put these in my Outlook straps folder for my Scorpion mailbox please just so I can take a look at the formatting';
const nomination = { toolkit: 'outlook', identity: SCORPION, source_quote: 'for my Scorpion mailbox' };
let serial = 0;
function source(text: string, sessionId?: string) {
  const session = sessionId ? eventlog.getSession(sessionId)!
    : eventlog.createSession({ id: `source-account-${++serial}`, kind: 'chat', userId: 'fixture-owner' });
  const event = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text } });
  return { sessionId: session.id, sourceUserSeq: event.seq };
}
function installJudge(decide: (call: SourceAccountJudgeCall) => Partial<SourceAccountJudgeResult> = () => ({})) {
  const calls: SourceAccountJudgeCall[] = [];
  registry.installTurnSemanticModelPort({
    async interpret() { throw new Error('account routing must not compile a hidden work plan'); },
    async judgeAccountSelection(call) {
      calls.push(call);
      return { verdict: call.mode === 'current_source_default' ? 'default_compatible' : 'entailed', proposalDigest: call.proposalDigest, modelIdentity: 'fixture-independent-judge', ...decide(call) };
    },
  });
  return calls;
}
function input(identity: ReturnType<typeof source>) {
  return { ...identity, toolkit: 'outlook', operation: 'OUTLOOK_CREATE_DRAFT', connections, nomination };
}
function persist(identity: ReturnType<typeof source>, text: string, route: Awaited<ReturnType<typeof routing.resolveSourceAccountRouting>>) {
  assert.equal(route.kind, 'resolved');
  if (route.kind !== 'resolved') return;
  resolution.recordAdmissionCapabilityResolution({ ...identity, acceptedInput: text, entries: [{
    intent: 'fixture checked source route', kind: 'composio', identifier: 'OUTLOOK_CREATE_DRAFT',
    status: 'proven', connection: 'active', accountIdentity: route.connection.connectionId,
    effectClass: 'write', sourceAccountRouting: route.evidence,
  }] });
}

function assertCheckedAccountWithoutLivePublication(blockers: Awaited<ReturnType<typeof provider.stageDisclosedPlanningProviderCandidates>>['blockers']) {
  assert.ok(Object.keys(blockers).length > 0);
  for (const blocker of Object.values(blockers)) assert.deepEqual(blocker, {
    code: 'capability_publication_required', choices: [], reason: 'selected_connection_refresh_unavailable',
  }, 'account-only fixtures prove routing, while missing production transport still blocks publication');
}

test.beforeEach(() => {
  registry.installTurnSemanticModelPort(null);
  aliases.rememberAccountAlias({ toolkit: 'outlook', label: 'Scorpion', email: SCORPION, connectionId: 'fixture-scorpion' });
});
test.after(() => {
  registry.installTurnSemanticModelPort(null);
  composio.__test__.setConnectedAccountsLoader(null);
  composio.__test__.setComposioApiKeyOverride(null);
  composio.resetComposioClient();
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('original phone wording resolves through typed source evidence, without phrase grammar or a user question', async () => {
  const identity = source(ORIGINAL);
  const calls = installJudge();
  assert.equal(provider.connectedAccountExplicitlySelectedInCurrentText({ text: ORIGINAL, choices: [SCORPION, PERSONAL] }), undefined);
  const selected = await routing.resolveSourceAccountRouting(input(identity));
  assert.equal(selected.kind, 'resolved');
  if (selected.kind !== 'resolved') return;
  assert.equal(selected.connection.connectionId, 'fixture-scorpion');
  assert.equal(selected.evidence.sourceUserSeq, identity.sourceUserSeq);
  assert.equal(calls[0]?.acceptedText, ORIGINAL);
  assert.equal(calls[0]?.sourceQuote, nomination.source_quote);
  assert.equal(calls[0]?.accountLabel?.toLowerCase(), 'scorpion');
  assert.equal(calls[0]?.establishedSource, null);
  assert.equal('effect' in selected.evidence, false, 'routing evidence does not grant an effect');
  await routing.resolveSourceAccountRouting({ ...input(identity), operation: 'OUTLOOK_LIST_MAIL_FOLDERS' });
  assert.equal(calls.length, 1, 'many operations share one exact account judgment');
  await routing.resolveSourceAccountRouting({ ...input(identity), connections: connections.map(c => ({ ...c, connectionId: `${c.connectionId}-reauth` })) });
  assert.equal(calls.length, 2, 'changed live connection revision is independently checked');
});

test('invented source evidence, absent accounts, and another principal never reach the judge', async () => {
  const identity = source(ORIGINAL);
  const other = source(ORIGINAL);
  const calls = installJudge();
  for (const request of [
    { ...input(identity), nomination: { ...nomination, source_quote: 'using my Scorpion email' } },
    { ...input(identity), nomination: { ...nomination, identity: 'absent@elsewhere.invalid' } },
    { ...input(identity), sessionId: other.sessionId },
  ]) assert.equal((await routing.resolveSourceAccountRouting(request)).kind, 'account_selection_required');
  assert.equal(calls.length, 0);
  assert.equal((await routing.resolveSourceAccountRouting({ ...input(identity), toolkit: 'salesforce' })).kind, 'account_selection_required',
    'an Outlook nomination grants no route to another toolkit');
});

test('semantic conflicts, uncertainty, unavailable judge, and mismatched subject digest cannot select a route', async () => {
  const cases = [
    { text: `Send a draft to ${SCORPION}.`, quote: SCORPION, verdict: 'conflict' as const },
    { text: 'Alex said use my Scorpion mailbox.', quote: 'my Scorpion mailbox', verdict: 'conflict' as const },
    { text: 'Use Alex\'s Scorpion mailbox.', quote: 'Scorpion mailbox', verdict: 'conflict' as const },
    { text: 'Do not use my Scorpion mailbox.', quote: 'my Scorpion mailbox', verdict: 'conflict' as const },
    { text: 'Put these in an Outlook mailbox.', quote: 'an Outlook mailbox', verdict: 'uncertain' as const },
  ];
  for (const fixture of cases) {
    const identity = source(fixture.text);
    const calls = installJudge(call => {
      assert.equal(call.acceptedText, fixture.text, 'the independent judge sees the whole source, not only a misleading quote');
      return { verdict: fixture.verdict };
    });
    assert.equal((await routing.resolveSourceAccountRouting({ ...input(identity), nomination: { ...nomination, source_quote: fixture.quote } })).kind, 'account_selection_required');
    assert.equal(calls.length, 1);
  }
  const identity = source(ORIGINAL);
  installJudge(() => ({ proposalDigest: '0'.repeat(64) }));
  assert.equal((await routing.resolveSourceAccountRouting(input(identity))).kind, 'account_selection_required');
  registry.installTurnSemanticModelPort(null);
  assert.equal((await routing.resolveSourceAccountRouting(input(identity))).kind, 'account_selection_required');
});

test('newest checked route is scoped to its conversation and rechecks followup continuity', async () => {
  const first = source(ORIGINAL);
  const calls = installJudge(call => ({ verdict: call.acceptedText === 'Start an unrelated task.' ? 'uncertain' : 'entailed' }));
  persist(first, ORIGINAL, await routing.resolveSourceAccountRouting(input(first)));
  const nextText = 'Put the next drafts in my personal mailbox.';
  const next = source(nextText, first.sessionId);
  persist(next, nextText, await routing.resolveSourceAccountRouting({ ...input(next), nomination: {
    toolkit: 'outlook', identity: PERSONAL, source_quote: 'my personal mailbox',
  } }));
  const followup = source('Add one more draft there please.', first.sessionId);
  const continued = await routing.resolveSourceAccountRouting({ ...input(followup), nomination: null });
  assert.equal(continued.kind, 'resolved');
  if (continued.kind !== 'resolved') return;
  assert.equal(continued.connection.connectionId, 'fixture-personal');
  assert.equal(calls.at(-1)?.establishedSource?.acceptedText, nextText, 'newest selection wins, not oldest or an accumulated ambiguous set');
  const unrelated = source('Start an unrelated task.', first.sessionId);
  assert.equal((await routing.resolveSourceAccountRouting({ ...input(unrelated), nomination: null })).kind, 'account_selection_required');
  const anotherConversation = source('Add one more draft there please.');
  assert.equal((await routing.resolveSourceAccountRouting({ ...input(anotherConversation), nomination: null })).kind, 'account_selection_required');
  assert.equal((await routing.resolveSourceAccountRouting({ ...input(followup), nomination: null, connections: connections.slice(0, 1) })).kind, 'account_selection_required',
    'a removed established account never falls back to the remaining account');
});

test('the actual readback nomination retains the same checked account and stages on the first search', async () => {
  const saveText = 'Save those exact three drafts in the Outlook Drafts folder for my Scorpion mailbox.';
  const readQuote = 'Read back those three exact saved drafts using their returned IDs.';
  const readText = `${readQuote} Return their subjects and bodies as JSON, plus whether each is a draft and its To/Cc/Bcc fields. Do not create, edit, or send anything.`;
  const first = source(saveText);
  const calls = installJudge(call => ({ verdict: call.acceptedText === readText
    ? (call.establishedSource?.previouslyChecked === true && call.establishedSource.acceptedText === saveText ? 'entailed' : 'uncertain')
    : 'entailed' }));
  persist(first, saveText, await routing.resolveSourceAccountRouting({ ...input(first), nomination: { ...nomination, source_quote: saveText } }));
  const read = source(readText, first.sessionId);
  const readNomination = { ...nomination, source_quote: readQuote };
  composio.__test__.setComposioApiKeyOverride('fixture-account-routing');
  composio.__test__.setConnectedAccountsLoader(async () => connections.map(c => ({
    id: c.connectionId, status: c.status, user_id: 'fixture-owner', toolkit: { slug: c.slug }, data: { user_info: { email: c.accountEmail } },
  })) as never);
  const candidates = ['OUTLOOK_GET_MESSAGE', 'OUTLOOK_GET_MAIL_FOLDER_MESSAGE'].map(name => ({
    name, sourceKind: 'authorized_composio' as const, carrier: 'work_call' as const,
    schema: { type: 'object', properties: { message_id: { type: 'string' } } }, summary: 'Read an exact saved message',
  }));
  const staged = await provider.stageDisclosedPlanningProviderCandidates({ ...read, candidates, accountSelection: readNomination });
  assertCheckedAccountWithoutLivePublication(staged.blockers);
  const proven = resolution.provenCapabilityEntriesForTurn(read);
  assert.equal(proven.length, 2);
  for (const entry of proven) {
    assert.equal(entry.accountIdentity, 'fixture-scorpion');
    assert.equal(entry.sourceAccountRouting?.sourceUserSeq, first.sourceUserSeq);
    assert.equal(entry.sourceAccountRouting?.sourceQuote, saveText, 'the durable account fact retains its actual explicit origin');
    assert.equal(entry.sourceAccountRouting?.checkedForSourceUserSeq, read.sourceUserSeq);
  }
  assert.equal(calls.at(-1)?.sourceQuote, readQuote, 'the exact current continuation quote still reaches review');
  assert.equal(calls.at(-1)?.establishedSource?.sourceQuote, saveText);
  assert.equal(calls.at(-1)?.establishedSource?.previouslyChecked, true);
  await provider.stageDisclosedPlanningProviderCandidates({ ...read, candidates, accountSelection: readNomination });
  assert.equal(calls.length, 2, 'one initial selection plus one cached current continuity review, independent of operation count/retries');
});

test('same-identity current nominations still check corrections, exact quotes, and different-account overrides', async () => {
  const readQuote = 'Read back those three exact saved drafts using their returned IDs.';
  const first = source(ORIGINAL);
  const calls = installJudge(call => ({ verdict: call.interveningAcceptedSources.some(prior => prior.acceptedText === 'Actually use my personal mailbox.')
    ? 'conflict' : 'entailed' }));
  persist(first, ORIGINAL, await routing.resolveSourceAccountRouting(input(first)));
  const correction = source('Actually use my personal mailbox.', first.sessionId);
  const read = source(readQuote, first.sessionId);
  const currentNomination = { ...nomination, source_quote: readQuote };
  assert.equal((await routing.resolveSourceAccountRouting({ ...input(read), nomination: currentNomination })).kind, 'account_selection_required');
  assert.equal(calls.at(-1)?.establishedSource?.previouslyChecked, true);
  assert.equal(calls.at(-1)?.interveningAcceptedSources.at(-1)?.sourceUserSeq, correction.sourceUserSeq);
  const beforeInvalid = calls.length;
  assert.equal((await routing.resolveSourceAccountRouting({ ...input(read), nomination: { ...currentNomination, source_quote: `${readQuote} invented` } })).kind, 'account_selection_required');
  assert.equal(calls.length, beforeInvalid, 'a prior checked route cannot repair a fabricated current quote');

  const fresh = source(ORIGINAL);
  const overrides = installJudge(call => ({ verdict: call.acceptedText === readQuote && !call.establishedSource ? 'uncertain' : 'entailed' }));
  persist(fresh, ORIGINAL, await routing.resolveSourceAccountRouting(input(fresh)));
  const followup = source(readQuote, fresh.sessionId);
  assert.equal((await routing.resolveSourceAccountRouting({ ...input(followup), nomination: { ...currentNomination, identity: PERSONAL } })).kind, 'account_selection_required');
  assert.equal(overrides.at(-1)?.establishedSource, null, 'another identity cannot borrow the Scorpion selection');
  const switchText = 'Read those drafts in my personal mailbox instead.';
  const switched = source(switchText, fresh.sessionId);
  assert.equal((await routing.resolveSourceAccountRouting({ ...input(switched), nomination: { toolkit: 'outlook', identity: PERSONAL, source_quote: 'my personal mailbox' } })).kind, 'resolved');
  assert.equal(overrides.at(-1)?.establishedSource, null, 'an explicit different-account override is independently checked');
  const ungrounded = source(readQuote);
  assert.equal((await routing.resolveSourceAccountRouting({ ...input(ungrounded), nomination: currentNomination })).kind, 'account_selection_required');
  assert.equal(overrides.at(-1)?.establishedSource, null, 'a referential quote alone still cannot invent an account choice');
});

test('conflicting checked identities in the newest receipt block instead of entering compatibility routing', async () => {
  const text = 'Create one draft in my Scorpion mailbox and one in my personal mailbox.';
  const identity = source(text);
  const calls = installJudge();
  const scorpion = await routing.resolveSourceAccountRouting({ ...input(identity), nomination: { ...nomination, source_quote: 'my Scorpion mailbox' } });
  const personal = await routing.resolveSourceAccountRouting({ ...input(identity), nomination: { toolkit: 'outlook', identity: PERSONAL, source_quote: 'my personal mailbox' } });
  assert.equal(scorpion.kind, 'resolved');
  assert.equal(personal.kind, 'resolved');
  if (scorpion.kind !== 'resolved' || personal.kind !== 'resolved') return;
  resolution.recordAdmissionCapabilityResolution({ ...identity, acceptedInput: text, entries: [scorpion, personal].map((route, index) => ({
    intent: 'fixture conflicting routes', kind: 'composio', identifier: index ? 'OUTLOOK_LIST_MAIL_FOLDERS' : 'OUTLOOK_CREATE_DRAFT',
    status: 'proven', connection: 'active', accountIdentity: route.connection.connectionId, effectClass: 'write', sourceAccountRouting: route.evidence,
  })) });
  const retry = source('Save another draft there.', identity.sessionId);
  assert.equal((await routing.resolveSourceAccountRouting({ ...input(retry), nomination: null })).kind, 'account_selection_required');
  assert.equal(calls.length, 2, 'neither an older route nor compatibility parsing resolves a conflicting checked source');
});

test('unchecked intervening account corrections block both retained routing and historical nomination', async () => {
  const first = source(ORIGINAL);
  const calls = installJudge(call => ({
    verdict: call.interveningAcceptedSources.some(item => item.acceptedText === 'Actually use my personal mailbox.') ? 'conflict' : 'entailed',
  }));
  persist(first, ORIGINAL, await routing.resolveSourceAccountRouting(input(first)));
  const correction = source('Actually use my personal mailbox.', first.sessionId);
  const retry = source('Save them now.', first.sessionId);
  for (const nomination of [null, input(first).nomination]) {
    assert.equal((await routing.resolveSourceAccountRouting({ ...input(retry), nomination })).kind, 'account_selection_required');
    assert.deepEqual(calls.at(-1)?.interveningAcceptedSources, [{
      sourceUserSeq: correction.sourceUserSeq, acceptedText: 'Actually use my personal mailbox.',
    }], 'a correction reaches the judge even though that turn never ran discovery');
  }
});

test('same-conversation branch routing includes intervening accepted sources and excludes another principal', async () => {
  const { selectSessionForAcceptedSource } = await import('../runtime/harness/accepted-source-session-branch.js');
  const conversationId = `routing-phone-${++serial}`;
  const parent = eventlog.createSession({ id: conversationId, kind: 'chat', channel: 'mobile', userId: 'fixture-owner',
    metadata: { source: 'mobile', channelId: conversationId, userId: 'fixture-owner' } });
  const first = source(ORIGINAL, parent.id);
  const calls = installJudge();
  persist(first, ORIGINAL, await routing.resolveSourceAccountRouting(input(first)));
  const correction = source('Please keep those drafts unchanged.', parent.id);
  eventlog.updateSession(parent.id, { status: 'failed' });
  const child = selectSessionForAcceptedSource({ kind: 'ordinary', entrySessionId: parent.id, durableSourceId: `routing-retry-${serial}`,
    continuity: { provider: 'mobile', scopeId: null, conversationId, audienceId: 'fixture-owner' } });
  assert.equal(child.disposition, 'branched');
  const retry = source('Save them now.', child.sessionId);
  const selected = await routing.resolveSourceAccountRouting({ ...input(retry), nomination: null });
  assert.equal(selected.kind, 'resolved');
  if (selected.kind === 'resolved') assert.equal(selected.evidence.sourceSessionId, parent.id);
  assert.deepEqual(calls.at(-1)?.interveningAcceptedSources, [{ sourceUserSeq: correction.sourceUserSeq, acceptedText: 'Please keep those drafts unchanged.' }]);
  assert.equal(calls.at(-1)?.establishedSource?.previouslyChecked, true);
  assert.equal((await routing.resolveSourceAccountRouting(input(retry))).kind, 'resolved', 'the exact historical quote can be independently nominated after a branch');
  assert.equal(calls.at(-1)?.establishedSource?.previouslyChecked, false);
  eventlog.openEventLog().prepare('UPDATE sessions SET user_id = ? WHERE id = ?').run('another-principal', child.sessionId);
  assert.equal((await routing.resolveSourceAccountRouting(input(retry))).kind, 'account_selection_required');
});

test('oversized continuity fails closed instead of hiding an intervening correction', async () => {
  for (const variant of ['count', 'bytes'] as const) {
    const first = source(ORIGINAL);
    const calls = installJudge();
    persist(first, ORIGINAL, await routing.resolveSourceAccountRouting(input(first)));
    if (variant === 'count') {
      source('Actually use my personal mailbox.', first.sessionId);
      for (let index = 0; index < 32; index += 1) source(`Revision ${index}.`, first.sessionId);
    } else source('Actually use my personal mailbox. ' + 'context '.repeat(3_100), first.sessionId);
    const retry = source('Save them now.', first.sessionId);
    for (const nomination of [null, input(first).nomination]) {
      assert.equal((await routing.resolveSourceAccountRouting({ ...input(retry), nomination })).kind, 'account_selection_required');
    }
    assert.equal(calls.length, 1, 'no judge sees a truncated context range');
  }
});

test('production staging requires checked default compatibility for a sole mailbox, never legacy identity hints', async () => {
  aliases.resetAccountAliasesForTest();
  composio.__test__.setComposioApiKeyOverride('fixture-account-routing');
  composio.__test__.setConnectedAccountsLoader(async () => connections.slice(0, 1).map(c => ({
    id: c.connectionId, status: c.status, user_id: 'fixture-owner', toolkit: { slug: c.slug },
    data: { user_info: { email: c.accountEmail } },
  })) as never);
  const candidates = ['OUTLOOK_CREATE_DRAFT', 'OUTLOOK_LIST_MAIL_FOLDERS'].map(name => ({
    name, sourceKind: 'authorized_composio' as const, carrier: 'work_call' as const,
    schema: { type: 'object', properties: {} }, summary: 'Fixture account-scoped operation',
  }));
  const fixtures = [
    { text: 'Create these drafts using my missing@example.invalid Outlook account.', verdict: 'conflict' },
    { text: 'Create these drafts in my unavailable studio mailbox.', verdict: 'conflict' },
    { text: `Create these drafts in ${SCORPION}.`, verdict: 'uncertain' },
    { text: `Do not use ${SCORPION} for these drafts.`, verdict: 'conflict' },
    { text: 'Create these drafts in Alex’s mailbox.', verdict: 'conflict' },
    { text: 'Draft the email using my outbound email skill in Outlook.', verdict: 'default_compatible' },
    { text: 'Draft the email to recipient@example.invalid using my outbound email skill in Outlook.', verdict: 'default_compatible' },
    { text: 'Draft a note quoting Alex: “My account is other@example.invalid.”', verdict: 'default_compatible' },
  ] as const;
  for (const fixture of fixtures) {
    const identity = source(fixture.text);
    const calls = installJudge(call => {
      assert.equal(call.mode, 'current_source_default');
      assert.equal(call.acceptedText, fixture.text);
      assert.equal(call.sourceQuote, null);
      assert.equal(call.establishedSource, null);
      assert.equal(call.accountIdentity, SCORPION);
      return { verdict: fixture.verdict };
    });
    const staged = await provider.stageDisclosedPlanningProviderCandidates({ ...identity, candidates, accountSelection: null });
    const proven = resolution.provenCapabilityEntriesForTurn(identity);
    if (fixture.verdict === 'default_compatible') {
      assertCheckedAccountWithoutLivePublication(staged.blockers);
      assert.equal(proven.length, 2);
      for (const entry of proven) {
        assert.equal(entry.accountIdentity, 'fixture-scorpion');
        assert.equal(entry.sourceAccountRouting?.version, 2);
        assert.equal(entry.sourceAccountRouting?.sourceQuote, null);
        assert.equal(entry.sourceAccountRouting?.sourceUserSeq, identity.sourceUserSeq);
      }
    } else {
      assert.equal(Object.keys(staged.blockers).length, 2);
      assert.equal(proven.length, 0, 'an unresolved operating account cannot publish a proven selected-account operation');
    }
    await provider.stageDisclosedPlanningProviderCandidates({ ...identity, candidates, accountSelection: null });
    assert.equal(calls.length, 1, 'all operations and same-source retries share one verdict');
  }
  registry.installTurnSemanticModelPort(null);
  const unavailable = source('Draft a note in Outlook.');
  const blocked = await provider.stageDisclosedPlanningProviderCandidates({ ...unavailable, candidates });
  assert.equal(blocked.blockers.OUTLOOK_CREATE_DRAFT?.reason, 'review_unavailable');
  assert.equal(resolution.provenCapabilityEntriesForTurn(unavailable).length, 0);
});

test('default judgments are source/principal/connection scoped and use a distinct verdict from explicit selection', async () => {
  const identity = source('Draft a note using my outbound email skill.');
  const calls = installJudge();
  const request = { ...input(identity), nomination: null, connections: connections.slice(0, 1) };
  assert.equal((await routing.resolveSourceAccountRouting(request)).kind, 'resolved');
  await routing.resolveSourceAccountRouting({ ...request, operation: 'OUTLOOK_LIST_MAIL_FOLDERS' });
  assert.equal(calls.length, 1);
  const changed = source('Draft a second note using my outbound email skill.', identity.sessionId);
  await routing.resolveSourceAccountRouting({ ...request, ...changed });
  assert.equal(calls.length, 2);
  eventlog.openEventLog().prepare('UPDATE sessions SET user_id = ? WHERE id = ?').run('another-principal', identity.sessionId);
  await routing.resolveSourceAccountRouting({ ...request, ...changed });
  assert.equal(calls.length, 3);
  await routing.resolveSourceAccountRouting({ ...request, ...changed, connections: [
    ...request.connections, { ...request.connections[0]!, connectionId: 'fixture-reauth' },
  ] });
  assert.equal(calls.length, 4, 'duplicate re-auths remain one identity but change the checked live revision');
  installJudge(() => ({ verdict: 'entailed' }));
  assert.equal((await routing.resolveSourceAccountRouting(request)).kind, 'account_selection_required', 'selection entailment cannot stand in for checked no preference');
  installJudge(() => ({ verdict: 'default_compatible' }));
  assert.equal((await routing.resolveSourceAccountRouting(input(source(ORIGINAL)))).kind, 'account_selection_required', 'no preference cannot stand in for an explicit selection');
});

test('defaults do not inherit, and earlier account constraints survive no-tool continuations', async () => {
  const firstText = 'Draft a note using my outbound email skill.';
  const first = source(firstText);
  const calls = installJudge(call => ({ verdict: call.acceptedText.includes('missing@example.invalid')
    || call.interveningAcceptedSources.some(prior => prior.acceptedText.includes('missing@example.invalid'))
    ? 'conflict' : 'default_compatible' }));
  const request = { ...input(first), nomination: null, connections: connections.slice(0, 1) };
  persist(first, firstText, await routing.resolveSourceAccountRouting(request));
  const continuation = source('Create another note.', first.sessionId);
  assert.equal((await routing.resolveSourceAccountRouting({ ...request, ...continuation })).kind, 'resolved');
  assert.equal(calls.length, 2);
  assert.equal(calls.at(-1)?.mode, 'current_source_default');
  assert.equal(calls.at(-1)?.establishedSource, null, 'a default never becomes a selected-account fact');
  const correction = source('Actually use missing@example.invalid for these notes.', first.sessionId);
  assert.equal((await routing.resolveSourceAccountRouting({ ...request, ...correction })).kind, 'account_selection_required');
  const retry = source('Save them now.', first.sessionId);
  assert.equal((await routing.resolveSourceAccountRouting({ ...request, ...retry })).kind, 'account_selection_required');
  assert.equal(calls.at(-1)?.interveningAcceptedSources.at(-1)?.sourceUserSeq, correction.sourceUserSeq);

  const noTool = source('Prepare these drafts for my missing@example.invalid account.');
  const save = source('Save them now.', noTool.sessionId);
  assert.equal((await routing.resolveSourceAccountRouting({ ...request, ...save })).kind, 'account_selection_required');
  assert.deepEqual(calls.at(-1)?.interveningAcceptedSources, [{ sourceUserSeq: noTool.sourceUserSeq, acceptedText: 'Prepare these drafts for my missing@example.invalid account.' }]);
});

test('a valid newer default receipt blocks older explicit inheritance; malformed defaults cannot suppress a valid route', async () => {
  for (const malformed of [false, 'principal', 'digest', 'source'] as const) {
    const first = source(ORIGINAL);
    const calls = installJudge();
    const explicit = await routing.resolveSourceAccountRouting(input(first));
    persist(first, ORIGINAL, explicit);
    assert.equal(explicit.kind, 'resolved');
    if (explicit.kind !== 'resolved') return;
    const newText = 'Start unrelated work: draft a new note with my outbound email skill.';
    const newer = source(newText, first.sessionId);
    // Fixture the durable result of a checked default. Its source, principal,
    // and digest must validate before it can act as a noninheritance boundary.
    const sourceDigest = createHash('sha256').update(newText).digest('hex');
    const evidence = {
      ...explicit.evidence, version: 2 as const, selectionKind: 'current_source_default' as const,
      sourceQuote: null, sourceUserSeq: newer.sourceUserSeq, sourceDigest,
      checkedForSourceUserSeq: newer.sourceUserSeq, checkedForSourceDigest: sourceDigest,
      connectionRevision: 'a'.repeat(64),
      ...(malformed === 'principal' ? { principalId: 'different-principal' } : {}),
      ...(malformed === 'digest' ? { sourceDigest: '0'.repeat(64) } : {}),
      ...(malformed === 'source' ? { sourceUserSeq: first.sourceUserSeq } : {}),
    };
    persist(newer, newText, { kind: 'resolved', connection: connections[0]!, evidence });
    const next = source('Create another note.', first.sessionId);
    assert.equal((await routing.resolveSourceAccountRouting({ ...input(next), nomination: null, connections: connections.slice(0, 1) })).kind, 'resolved');
    assert.equal(calls.at(-1)?.mode, malformed ? 'explicit_selection' : 'current_source_default');
    assert.equal(calls.at(-1)?.establishedSource?.acceptedText ?? null, malformed ? ORIGINAL : null);
    if (!malformed) {
      const correction = source('Use my missing@example.invalid account instead.', first.sessionId);
      installJudge(() => ({ verdict: 'conflict' }));
      assert.equal((await routing.resolveSourceAccountRouting({ ...input(correction), nomination: null, connections: connections.slice(0, 1) })).kind, 'account_selection_required');
    }
  }
});

test('oversized default context fails closed without dropping an old account constraint', async () => {
  const first = source('Use my missing@example.invalid account.');
  for (let index = 0; index < 32; index += 1) source(`Revision ${index}`, first.sessionId);
  const retry = source('Save them now.', first.sessionId);
  const calls = installJudge();
  assert.equal((await routing.resolveSourceAccountRouting({ ...input(retry), nomination: null, connections: connections.slice(0, 1) })).kind, 'account_selection_required');
  assert.equal(calls.length, 0);
});

test('real discovery staging consumes the typed nomination and publishes exact account proof', async () => {
  composio.__test__.setComposioApiKeyOverride('fixture-account-routing');
  composio.__test__.setConnectedAccountsLoader(async () => connections.map(c => ({
    id: c.connectionId, status: c.status, user_id: 'fixture-owner', toolkit: { slug: c.slug },
    data: { user_info: { email: c.accountEmail } },
  })) as never);
  const identity = source(ORIGINAL);
  installJudge();
  const candidate = {
    name: 'OUTLOOK_CREATE_DRAFT', sourceKind: 'authorized_composio' as const, carrier: 'work_call' as const,
    schema: { type: 'object', properties: { subject: { type: 'string' } } }, summary: 'Create an unsent draft',
  };
  const initially = await provider.stageDisclosedPlanningProviderCandidates({ ...identity, candidates: [candidate] });
  assert.equal(initially.blockers.OUTLOOK_CREATE_DRAFT?.choices.length, 2);
  const staged = await provider.stageDisclosedPlanningProviderCandidates({ ...identity, candidates: [candidate], accountSelection: nomination });
  assertCheckedAccountWithoutLivePublication(staged.blockers);
  const proven = resolution.provenCapabilityEntriesForTurn(identity).find(entry => entry.identifier === candidate.name);
  assert.equal(proven?.accountIdentity, 'fixture-scorpion');
  assert.equal(proven?.sourceAccountRouting?.sourceQuote, nomination.source_quote);
});

test('a later proven discovery clears the earlier account blocker and preserves review unavailability', () => {
  const identity = source(ORIGINAL);
  const returned = (results: unknown[]) => eventlog.appendEvent({ sessionId: identity.sessionId, turn: 1, role: 'tool',
    type: 'tool_returned', data: { sourceUserSeq: identity.sourceUserSeq, tool: 'tool_search', result: JSON.stringify({ results }) } });
  returned([{ name: 'OUTLOOK_CREATE_DRAFT', planningRefStatus: 'account_selection_required', accountChoices: [SCORPION, PERSONAL], accountSelectionReason: 'review_unavailable' }]);
  assert.deepEqual(provider.thisTurnSearchAccountSelectionBlockers(identity), [{ name: 'OUTLOOK_CREATE_DRAFT', choices: [SCORPION, PERSONAL], reason: 'review_unavailable' }]);
  returned([{ name: 'OUTLOOK_CREATE_DRAFT', capabilityRef: 'composio:OUTLOOK_CREATE_DRAFT' }]);
  assert.deepEqual(provider.thisTurnSearchAccountSelectionBlockers(identity), []);
});

test('bounded account review returns its host blocker, then reuses the same completed judgment', async () => {
  composio.__test__.setComposioApiKeyOverride('fixture-account-routing');
  composio.__test__.setConnectedAccountsLoader(async () => connections.map(c => ({
    id: c.connectionId, status: c.status, user_id: 'fixture-owner', toolkit: { slug: c.slug }, data: { user_info: { email: c.accountEmail } },
  })) as never);
  const identity = source(ORIGINAL);
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  registry.installTurnSemanticModelPort({ async interpret() { throw new Error('no hidden plan'); }, async judgeAccountSelection(call) {
    calls += 1;
    await ready;
    return { verdict: 'entailed', proposalDigest: call.proposalDigest, modelIdentity: 'fixture-delayed-judge' };
  } });
  const candidates = [{ name: 'OUTLOOK_CREATE_DRAFT', sourceKind: 'authorized_composio' as const, carrier: 'work_call' as const,
    schema: { type: 'object', properties: { subject: { type: 'string' } } }, summary: 'Create an unsent draft' }];
  const blocked = await provider.stageDisclosedPlanningProviderCandidates({ ...identity, candidates, accountSelection: nomination, deadlineAt: Date.now() + 1_000 });
  assert.equal(blocked.blockers.OUTLOOK_CREATE_DRAFT?.reason, 'review_unavailable');
  assert.equal(resolution.provenCapabilityEntriesForTurn(identity).length, 0);
  release();
  const recovered = await provider.stageDisclosedPlanningProviderCandidates({ ...identity, candidates, accountSelection: nomination });
  assertCheckedAccountWithoutLivePublication(recovered.blockers);
  assert.equal(calls, 1, 'a retry consumes the cached verdict rather than starting another model review');
});

test('tool_search passes nomination through its real disclosure callback and exposes actionable account recovery', async () => {
  let handler: (input: unknown) => Promise<unknown>;
  let observed: unknown;
  registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, callback: typeof handler) { handler = callback; } } as never, {
    allowedNames: new Set(), dispatchCarrier: 'work_call',
    candidateSources: [{ kind: 'authorized_composio', async search() { return [{
      name: 'OUTLOOK_CREATE_DRAFT', summary: 'Create an unsent draft', score: 1,
      carrier: 'work_call', schema: { type: 'object', properties: {} },
    }]; } }],
    async discloseForPlanning(_candidates, control) {
      observed = control?.accountSelection;
      return { version: 1, refs: {}, blockers: { OUTLOOK_CREATE_DRAFT: { code: 'account_selection_required', choices: [SCORPION, PERSONAL] } } };
    },
  });
  const response = await handler!({ query: 'Outlook create draft', account_selection: nomination, role_key: null, cursor: null });
  assert.deepEqual(observed, nomination);
  assert.match(JSON.stringify(response), /accountSelectionNextStep/);
  assert.match(JSON.stringify(response), /source_quote/);
});

test('configured account review uses the existing independent judge role and a closed output contract', async () => {
  assert.equal(semanticModelRoleForPurpose('turn_semantics_account_selection'), 'judge');
  const port = configuredBrainSemanticPort(async request => {
    assert.equal(request.schemaName, 'SourceAccountJudgeV1');
    assert.match(request.system, /Recipient\/attendee/);
    assert.match(request.system, /never approval or permission/);
    assert.match(request.system, /default_compatible only/);
    assert.match(request.system, /short continuation does not erase earlier constraints/);
    const body = JSON.parse(request.user);
    assert.ok(['explicit_selection', 'current_source_default'].includes(body.mode));
    return { raw: { verdict: body.mode === 'current_source_default' ? 'default_compatible' : 'entailed', proposalDigest: body.proposalDigest }, modelIdentity: 'fixture-configured-judge', inputTokens: 1, outputTokens: 1, latencyMs: 1 };
  });
  registry.installTurnSemanticModelPort(port);
  assert.equal((await routing.resolveSourceAccountRouting(input(source(ORIGINAL)))).kind, 'resolved');
  assert.equal((await routing.resolveSourceAccountRouting({ ...input(source('Draft a note using my outbound email skill.')), nomination: null, connections: connections.slice(0, 1) })).kind, 'resolved');
});
