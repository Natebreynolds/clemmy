/**
 * Run: npx tsx --test src/memory/account-scoped-recall.test.ts
 * Account/matter scoped recall (2026-07-21): the memory-audit gap that most
 * threatens the "trusted employee" bar — a fact learned in Client A's context
 * must NOT surface while acting for Client B. Reuses the merge path's proven
 * entity-anchor conflict logic; down-scopes ONLY on a clear cross-client
 * conflict, never touches general/shared knowledge.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractAnchors } from './memory-merge.js';
import {
  accountScopeExcludesFromRecall,
  activeContextHasAccountScope,
} from './recall-memory.js';

afterEach(() => { delete process.env.CLEMMY_ACCOUNT_SCOPED_RECALL; });

const anchors = (text: string) => extractAnchors({ content: text });

test('the core leak: acting for Client B, a Client A fact is excluded', () => {
  const active = anchors('client: Beta LLC — draft the renewal email');
  assert.equal(activeContextHasAccountScope(active), true);
  assert.equal(
    accountScopeExcludesFromRecall(active, 'client: Acme Corp prefers morning calls and a 10% discount'),
    true,
    'Acme fact must NOT surface while working Beta — the cross-client leak',
  );
});

test('same client is kept; general (anchor-less) knowledge is always kept', () => {
  const active = anchors('client: Acme Corp — follow up');
  assert.equal(accountScopeExcludesFromRecall(active, 'client: Acme Corp signed the SOW on Tuesday'), false, 'same client stays');
  assert.equal(accountScopeExcludesFromRecall(active, 'Standing preference: always use bullet points'), false, 'general knowledge stays');
  assert.equal(accountScopeExcludesFromRecall(active, 'The user is in the Pacific timezone'), false, 'identity/general facts stay');
});

test('a general request (no client anchor) scopes NOTHING — byte-identical recall', () => {
  const active = anchors('summarize my week and draft a plan');
  assert.equal(activeContextHasAccountScope(active), false);
  assert.equal(accountScopeExcludesFromRecall(active, 'client: Acme Corp prefers morning calls'), false, 'no active client → no scoping');
  assert.equal(accountScopeExcludesFromRecall(active, 'client: Beta LLC net 30'), false);
});

test('domain-level conflict is caught (email domains distinguish clients)', () => {
  const active = anchors('reply to the thread with amy@acme.com');
  assert.equal(accountScopeExcludesFromRecall(active, 'note from bo@beta.com: they want a refund'), true, 'different email domain = different client');
  assert.equal(accountScopeExcludesFromRecall(active, 'cy@acme.com is the billing contact'), false, 'same domain stays');
});

test('kill-switch off restores unscoped recall', () => {
  process.env.CLEMMY_ACCOUNT_SCOPED_RECALL = 'off';
  const active = anchors('client: Beta LLC');
  assert.equal(accountScopeExcludesFromRecall(active, 'client: Acme Corp prefers mornings'), false, 'kill-switch disables scoping');
});

test('fail-open: junk input never throws and never excludes', () => {
  const active = anchors('client: Acme Corp');
  assert.equal(accountScopeExcludesFromRecall(active, ''), false);
  assert.equal(accountScopeExcludesFromRecall(active, '\u0000\u0001 garbage'), false);
});

test('a memory that shares the request\'s domain stays even when a competitor is spelled differently (live 2026-09-26)', () => {
  // The finished comparison named the request's own domain plus the
  // competitors; the request wrote "Grand Canyon Law", the memory "Grand
  // Canyon Law Group". One name mismatch must not outvote the shared domain.
  const active = anchors('keyword and backlink comparison of tobinlawoffice.com against Mesa competitors Grand Canyon Law and Arizona Criminal Defense Lawyer');
  assert.equal(activeContextHasAccountScope(active), true);
  const memory = 'Completed answer: comparison of tobinlawoffice.com against Grand Canyon Law Group (grandcanyon.law) and Arizona Criminal Defense Lawyer (arizonacriminaldefenselawyer.com).';
  assert.equal(accountScopeExcludesFromRecall(active, memory), false, 'same client: the domain is shared');
  // Client names that contain each other are one client, not two.
  const byName = anchors('client: Grand Canyon Law — draft the renewal');
  assert.equal(accountScopeExcludesFromRecall(byName, 'client: Grand Canyon Law Group signed the SOW'), false, 'a longer spelling of the same client stays');
  // A genuinely different client with no shared anchor is still excluded.
  assert.equal(accountScopeExcludesFromRecall(byName, 'client: Beta LLC prefers morning calls'), true, 'a different client is still excluded');
  assert.equal(accountScopeExcludesFromRecall(active, 'client: Beta LLC (beta.com) prefers morning calls'), true, 'different domain and different name: excluded');
});
