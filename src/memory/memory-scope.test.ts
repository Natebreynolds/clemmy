/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/memory-scope.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-memory-scope-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_EMBEDDINGS = 'off';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const scope = await import('./memory-scope.js');
const facts = await import('./facts.js');
const strategies = await import('./run-strategy-store.js');
const { recordMemoryEpisode } = await import('./temporal-memory.js');
const { regenerateMemoryMd } = await import('./memory-md-builder.js');
const { MEMORY_FILE } = await import('./vault.js');
const { readFileSync } = await import('node:fs');

const SALES = { projectId: 'prj_salesaaaaaaaaa', agentKey: null };
const HIRING = { projectId: 'prj_hiringaaaaaaa', agentKey: null };
const ANALYST = 'analyst@2026-09-01T00:00:00.000Z';
const ANALYST_IN_SALES = { projectId: SALES.projectId, agentKey: ANALYST };
const ANALYST_IN_HIRING = { projectId: HIRING.projectId, agentKey: ANALYST };
const ANALYST_ANYWHERE = { projectId: null, agentKey: ANALYST };

// Sessions stand in for conversations: the binding says which project and
// agent each one works in.
const sessions: Record<string, { projectId: string | null; agentKey: string | null }> = {
  'chat-plain': { projectId: null, agentKey: null },
  'chat-sales': SALES,
  'chat-hiring': HIRING,
  'chat-analyst-sales': ANALYST_IN_SALES,
  'chat-analyst-hiring': ANALYST_IN_HIRING,
  'chat-analyst': ANALYST_ANYWHERE,
};
let ambient: string | null = null;
scope.installMemoryScopeBinding({
  ambientSessionId: () => ambient,
  scopeOfSession: (sessionId) => sessions[sessionId] ?? null,
});
const as = <T>(sessionId: string, run: () => T): T => scope.withSessionMemoryScope(sessionId, run);

after(() => {
  scope.installMemoryScopeBinding(null);
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('who may see what: the whole table', () => {
  const see = (record: typeof SALES | null, read: scope.MemoryReadScope) => scope.scopeVisible(record, read);
  const clemNowhere = { projectId: null, agentKey: null };
  // For everywhere: seen by everyone.
  for (const read of [clemNowhere, SALES, ANALYST_IN_SALES, ANALYST_ANYWHERE]) assert.equal(see(null, read), true);
  // For a project: seen inside it, by Clem and by its agents; nowhere else.
  assert.equal(see(SALES, SALES), true);
  assert.equal(see(SALES, ANALYST_IN_SALES), true);
  assert.equal(see(SALES, HIRING), false);
  assert.equal(see(SALES, ANALYST_IN_HIRING), false);
  assert.equal(see(SALES, clemNowhere), false);
  assert.equal(see(SALES, ANALYST_ANYWHERE), false);
  // For an agent in a project: that agent there, and Clem there. Never the same agent elsewhere.
  assert.equal(see(ANALYST_IN_SALES, ANALYST_IN_SALES), true);
  assert.equal(see(ANALYST_IN_SALES, SALES), true, 'Clem coordinates the project and sees what its agents learned in it');
  assert.equal(see(ANALYST_IN_SALES, ANALYST_IN_HIRING), false, 'one agent, two projects: nothing crosses');
  assert.equal(see(ANALYST_IN_SALES, ANALYST_ANYWHERE), false);
  assert.equal(see(ANALYST_IN_SALES, { projectId: SALES.projectId, agentKey: 'other@x' }), false);
  assert.equal(see(ANALYST_IN_SALES, clemNowhere), false);
  // For an agent wherever it works: that agent, in any project. Not Clem's ambient view.
  assert.equal(see(ANALYST_ANYWHERE, ANALYST_IN_SALES), true);
  assert.equal(see(ANALYST_ANYWHERE, ANALYST_ANYWHERE), true);
  assert.equal(see(ANALYST_ANYWHERE, SALES), false);
  assert.equal(see(ANALYST_ANYWHERE, clemNowhere), false);
  // Work with no turn behind it sees everything; settling sees exactly one scope.
  assert.equal(see(ANALYST_IN_SALES, 'unrestricted'), true);
  assert.equal(see(null, { ...SALES, exact: true }), false);
  assert.equal(see(SALES, { ...SALES, exact: true }), true);
  assert.equal(see(ANALYST_IN_SALES, { ...SALES, exact: true }), false);
  assert.equal(see(null, { projectId: null, agentKey: null, exact: true }), true);
});

test('an agent replaced under the same name does not inherit what the first one learned', () => {
  const first = scope.agentScopeKey({ id: 'analyst', createdAt: '2026-09-01T00:00:00.000Z' });
  const second = scope.agentScopeKey({ id: 'analyst', createdAt: '2026-09-20T00:00:00.000Z' });
  assert.notEqual(first, second);
  assert.equal(scope.agentIdOfScopeKey(first), 'analyst');
  assert.equal(scope.scopeVisible({ projectId: null, agentKey: first }, { projectId: null, agentKey: second }), false);
});

test('the same sentence learned in two projects is two facts, each seen only where it was learned', () => {
  const inSales = facts.rememberFact({ kind: 'project', content: 'A lead is an open opportunity.', sessionId: 'chat-sales' });
  const inHiring = facts.rememberFact({ kind: 'project', content: 'A lead is the hiring manager.', sessionId: 'chat-hiring' });
  const sameWords = facts.rememberFact({ kind: 'project', content: 'The review is on Monday.', sessionId: 'chat-sales' });
  const sameWordsElsewhere = facts.rememberFact({ kind: 'project', content: 'The review is on Monday.', sessionId: 'chat-hiring' });
  const everywhere = facts.rememberFact({ kind: 'project', content: 'The office is closed on Fridays.', sessionId: 'chat-plain' });
  assert.notEqual(sameWords.id, sameWordsElsewhere.id, 'one sentence, two scopes, two records');
  assert.deepEqual(facts.factScope(inSales.id), SALES);
  assert.deepEqual(facts.factScope(everywhere.id), scope.EVERYWHERE);
  assert.equal(facts.rememberFact({ kind: 'project', content: 'The review is on Monday.', sessionId: 'chat-sales' }).id, sameWords.id, 'said again in the same place, it is the same fact');

  const found = (sessionId: string, query: string) => as(sessionId, () => facts.searchFactsByText(query, 10).map((fact) => fact.content));
  assert.deepEqual(found('chat-sales', 'lead'), ['A lead is an open opportunity.']);
  assert.deepEqual(found('chat-hiring', 'lead'), ['A lead is the hiring manager.']);
  assert.deepEqual(found('chat-plain', 'lead'), [], 'a conversation in no project sees neither');
  assert.deepEqual(found('chat-analyst-sales', 'lead'), ['A lead is an open opportunity.']);
  assert.deepEqual(found('chat-analyst-hiring', 'lead'), ['A lead is the hiring manager.']);
  for (const sessionId of Object.keys(sessions)) assert.deepEqual(found(sessionId, 'office closed Fridays'), ['The office is closed on Fridays.']);
  assert.equal(found('chat-sales', 'review Monday').length, 1);

  // Every way of reading is held to the same rule.
  const ids = (list: Array<{ id: number }>) => list.map((row) => row.id).sort((a, b) => a - b);
  const salesSide = [inSales.id, sameWords.id, everywhere.id].sort((a, b) => a - b);
  assert.deepEqual(as('chat-sales', () => ids(facts.listActiveFacts({ limit: 50 }))), salesSide);
  assert.deepEqual(as('chat-sales', () => ids(facts.listActiveFacts({ limit: 50, ranking: 'stanford', objective: 'lead' }))), salesSide);
  assert.deepEqual(as('chat-sales', () => ids(facts.listAllFacts(50))), salesSide);
  assert.deepEqual(as('chat-sales', () => ids(facts.listRecentlyLearnedFacts({ sinceHours: 1, limit: 50 }))).filter((id) => id === inHiring.id), []);
  assert.equal(as('chat-sales', () => facts.getFact(inHiring.id)), null, 'not by id either');
  assert.equal(as('chat-sales', () => facts.getFactWithEvidence(inHiring.id)), null);
  assert.equal(as('chat-hiring', () => facts.getFact(inHiring.id))?.id, inHiring.id);
  assert.equal(as('chat-plain', () => facts.findActiveFactsByContentPrefix('project', 'A lead is').length), 0);

  // The owner's own Memory screen, and maintenance, see all of it.
  assert.equal(ids(facts.listActiveFacts({ limit: 50 })).length, 5);
  assert.equal(facts.getFact(inHiring.id)?.id, inHiring.id);
});

test('what is true of the owner and what must hold are for everywhere wherever they were said', () => {
  const about = facts.rememberFact({ kind: 'user', content: 'The owner prefers figures before prose.', sessionId: 'chat-analyst-sales' });
  const rule = facts.rememberFact({ kind: 'constraint', content: 'Never send mail to a client on a Sunday.', sessionId: 'chat-sales' });
  assert.deepEqual(facts.factScope(about.id), scope.EVERYWHERE);
  assert.deepEqual(facts.factScope(rule.id), scope.EVERYWHERE);
  assert.ok(as('chat-hiring', () => facts.listConstraints()).some((fact) => fact.id === rule.id));

  // Unless the owner says a rule is for one project: then it holds there only.
  const local = facts.rememberFact({ kind: 'constraint', content: 'In this project, write to the sandbox ledger only.', scope: SALES });
  assert.ok(as('chat-sales', () => facts.listConstraints()).some((fact) => fact.id === local.id));
  assert.ok(as('chat-analyst-sales', () => facts.listPinnedFacts(50)).some((fact) => fact.id === local.id));
  assert.equal(as('chat-hiring', () => facts.listConstraints()).some((fact) => fact.id === local.id), false);
  assert.equal(as('chat-plain', () => facts.listConstraints()).some((fact) => fact.id === local.id), false);
  assert.ok(as('chat-hiring', () => facts.listConstraints()).some((fact) => fact.id === rule.id), 'the rule for everywhere still holds there');
});

test('a correction stays with what it corrects, and the owner can move a fact', () => {
  const learned = facts.rememberFact({ kind: 'reference', content: 'The manifest is at /fixtures/manifest-old.json', sessionId: 'chat-analyst-sales' });
  assert.deepEqual(facts.factScope(learned.id), ANALYST_IN_SALES);
  const corrected = facts.supersedeFact(learned.id, { content: 'The manifest is at /fixtures/manifest-new.json' })!;
  assert.notEqual(corrected.id, learned.id);
  assert.deepEqual(facts.factScope(corrected.id), ANALYST_IN_SALES, 'corrected from anywhere, it is still for the same');
  assert.equal(as('chat-analyst-hiring', () => facts.searchFactsByText('manifest', 5)).length, 0);
  assert.equal(as('chat-sales', () => facts.searchFactsByText('manifest', 5)).length, 1, 'Clem in the project sees what its agent learned');

  const moved = facts.moveFactToScope(corrected.id, null)!;
  assert.equal(moved.id, corrected.id, 'the same fact, with its history');
  assert.deepEqual(facts.factScope(moved.id), scope.EVERYWHERE);
  assert.equal(as('chat-analyst-hiring', () => facts.searchFactsByText('manifest', 5)).length, 1);
  const back = facts.moveFactToScope(moved.id, HIRING)!;
  assert.deepEqual(facts.factScope(back.id), HIRING);
  assert.equal(as('chat-sales', () => facts.searchFactsByText('manifest', 5)).length, 0);
  assert.equal(facts.moveFactToScope(999_999, null), null);

  const exact = facts.factsInExactScope(facts.listActiveFacts({ limit: 100 }), HIRING).map((fact) => fact.id);
  assert.ok(exact.includes(back.id));
  assert.ok(facts.factsInExactScope(facts.listActiveFacts({ limit: 100 }), HIRING).every((fact) => scope.sameScope(facts.factScope(fact.id), HIRING)));
});

test('the standing memory file holds only what is for everywhere', () => {
  facts.rememberFact({ kind: 'project', content: 'Project-only codeword: zephyr-quoin.', sessionId: 'chat-sales' });
  facts.rememberFact({ kind: 'project', content: 'Everywhere codeword: harbor-lantern.', sessionId: 'chat-plain' });
  regenerateMemoryMd();
  const file = readFileSync(MEMORY_FILE, 'utf-8');
  assert.match(file, /harbor-lantern/);
  assert.doesNotMatch(file, /zephyr-quoin/);
  assert.doesNotMatch(file, /open opportunity|hiring manager/);
});

test('an episode and a remembered method are kept where they happened', () => {
  const episode = recordMemoryEpisode({ kind: 'tool_result', sessionId: 'chat-analyst-sales', callId: 'call-1', content: 'Read 12 opportunities from the east ledger.' } as never);
  assert.deepEqual(scope.memoryScopeOf('episode', episode.id), ANALYST_IN_SALES);
  const plain = recordMemoryEpisode({ kind: 'tool_result', sessionId: 'chat-plain', callId: 'call-2', content: 'Read the office calendar.' } as never);
  assert.equal(scope.memoryScopeOf('episode', plain.id), null);
  assert.equal(scope.recordVisible('episode', episode.id, ANALYST_IN_HIRING), false);
  assert.equal(scope.recordVisible('episode', episode.id, SALES), true);
  assert.equal(scope.recordVisible('episode', plain.id, ANALYST_IN_HIRING), true);
});

test('when nothing was ever kept for a scope, reading is exactly what it was', () => {
  const rows = [{ id: 1 }, { id: 2 }];
  assert.deepEqual(scope.visibleInScope('episode', rows, (row) => row.id, 'unrestricted'), rows);
  // An id nobody stamped is for everywhere.
  assert.deepEqual(scope.visibleInScope('fact', [{ id: 987_654 }], (row) => row.id, SALES), [{ id: 987_654 }]);
  ambient = 'chat-sales';
  assert.deepEqual(scope.currentMemoryReadScope(), SALES);
  ambient = 'no-such-session';
  assert.deepEqual(scope.currentMemoryReadScope(), scope.EVERYWHERE, 'a turn whose session cannot be read sees only what is for everywhere');
  ambient = null;
  assert.equal(scope.currentMemoryReadScope(), 'unrestricted');
});
void strategies;

test('what is kept for another project never crowds out what a reader may see', () => {
  const mine = facts.rememberFact({ kind: 'feedback', content: 'Crowding: keep the summary to one page.', scope: null, importance: 3 });
  facts.setFactPinned(mine.id, true);
  for (let index = 0; index < 14; index += 1) {
    const theirs = facts.rememberFact({ kind: 'feedback', content: `Crowding: hiring rule number ${index} about interview panels.`, scope: HIRING, importance: 9 });
    facts.setFactPinned(theirs.id, true);
  }
  const pinnedInPlain = as('chat-plain', () => facts.listPinnedFacts(12));
  assert.ok(pinnedInPlain.some((fact) => fact.id === mine.id), 'fourteen more important rules of another project do not push it out');
  assert.ok(pinnedInPlain.every((fact) => !/hiring rule number/.test(fact.content)));
  assert.ok(pinnedInPlain.length <= 12);
  const recent = as('chat-sales', () => facts.listActiveFacts({ limit: 3 }));
  assert.ok(recent.length > 0 && recent.every((fact) => !/hiring rule number/.test(fact.content)));
  assert.ok(as('chat-plain', () => facts.findActiveFactsByContentPrefix('feedback', 'Crowding:', 1)).length === 1);
});

test('a fact edited where it is kept stays there, and the same sentence learned elsewhere is its own record', () => {
  const inHiring = facts.rememberFact({ kind: 'reference', content: 'Edited: the panel meets on Tuesdays.', scope: HIRING });
  const edited = facts.updateFact(inHiring.id, { content: 'Edited: the panel meets on Wednesdays.' });
  assert.deepEqual(facts.factScope(edited!.id), HIRING);
  const inPlain = as('chat-plain', () => facts.rememberFact({ kind: 'reference', content: 'Edited: the panel meets on Wednesdays.', sessionId: 'chat-plain' }));
  assert.notEqual(inPlain.id, inHiring.id);
  assert.ok(as('chat-plain', () => facts.getFact(inPlain.id)), 'the conversation that learned it can see it');
  assert.equal(as('chat-plain', () => facts.getFact(inHiring.id)), null);
});

test('the evidence of a fact is shown only where the fact is', async () => {
  const { episodesSupportingOnly, linkFactEvidence } = await import('./temporal-memory.js');
  const kept = facts.rememberFact({ kind: 'reference', content: 'Evidence: the vendor is Northwind Freight.', scope: null });
  const episode = recordMemoryEpisode({ kind: 'tool_result', sourceApp: 'Fixture', sessionId: 'chat-plain', title: 'vendor',
    content: 'The vendor is Northwind Freight.' });
  linkFactEvidence({ factId: kept.id, episodeId: episode.id, excerpt: 'The vendor is Northwind Freight.', sourceUri: null });
  assert.deepEqual(episodesSupportingOnly([kept.id]).includes(episode.id), true);
  // Moved into a project: its evidence supports nothing a plain conversation may see.
  assert.ok(facts.moveFactToScope(kept.id, HIRING));
  const hidden = [...scope.scopedRecords('fact').entries()]
    .filter(([, keptFor]) => !scope.scopeVisible(keptFor, { projectId: null, agentKey: null })).map(([id]) => Number(id));
  assert.ok(episodesSupportingOnly(hidden).includes(episode.id));
  // Evidence that also supports a fact the reader may see stays visible.
  const shared = facts.rememberFact({ kind: 'reference', content: 'Evidence: Northwind Freight ships on Fridays.', scope: null });
  linkFactEvidence({ factId: shared.id, episodeId: episode.id, excerpt: 'ships on Fridays', sourceUri: null });
  assert.equal(episodesSupportingOnly(hidden).includes(episode.id), false);
});

test('a rule still applies when what it is kept for cannot be read', () => {
  assert.equal(scope.recordVisible('fact', 987_654_321, { projectId: null, agentKey: null }, 'everything'), true);
  assert.equal(scope.hiddenFromScope('fact', 'unrestricted'), 0);
  assert.ok(scope.hiddenFromScope('fact', { projectId: null, agentKey: null }) >= 14);
});
