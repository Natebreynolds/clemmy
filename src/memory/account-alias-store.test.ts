import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-alias-store-'));

const { rememberAccountAlias, resolveAccountAlias, resetAccountAliasesForTest } = await import('./account-alias-store.js');

function reset() { resetAccountAliasesForTest(); }

test('exact and whole-word match resolve; loose substrings do NOT (findings 5,6,18,19)', () => {
  reset();
  rememberAccountAlias({ toolkit: 'outlook', label: 'scorpion', email: 'nate@scorpion.co', connectionId: 'ca_1' });
  // exact + natural phrasing
  assert.equal(resolveAccountAlias('scorpion', 'outlook')?.email, 'nate@scorpion.co');
  assert.equal(resolveAccountAlias('my scorpion email', 'outlook')?.email, 'nate@scorpion.co');
  // a single letter must NOT match "scorpion" (the request-substring-of-label bug)
  assert.equal(resolveAccountAlias('s', 'outlook'), undefined);
  // an unrelated word that merely contains the label as a substring must NOT match
  rememberAccountAlias({ toolkit: 'outlook', label: 'corp', email: 'me@corp.com', connectionId: 'ca_2' });
  assert.equal(resolveAccountAlias('scorpion', 'outlook')?.email, 'nate@scorpion.co', '"corp" is a substring of "scorpion" but must not steal it');
});

test('multi-word label needs all words; ambiguity returns undefined (gateway then ASKS)', () => {
  reset();
  rememberAccountAlias({ toolkit: 'slack', label: 'work main', email: 'ops@corp.com', connectionId: 'ca_w' });
  assert.equal(resolveAccountAlias('the work main channel', 'slack')?.email, 'ops@corp.com');
  assert.equal(resolveAccountAlias('work', 'slack'), undefined, 'partial label match must not resolve');
  // exact match always wins even when other labels are word-subsets
  rememberAccountAlias({ toolkit: 'slack', label: 'main', email: 'main@corp.com', connectionId: 'ca_m' });
  assert.equal(resolveAccountAlias('work main', 'slack')?.email, 'ops@corp.com', 'exact "work main" label wins over the word-subset "main"');
  // two single-word labels both present, exact-matching neither → ambiguous → undefined
  reset();
  rememberAccountAlias({ toolkit: 'gmail', label: 'work', email: 'w@x.com', connectionId: 'ca_a' });
  rememberAccountAlias({ toolkit: 'gmail', label: 'personal', email: 'p@x.com', connectionId: 'ca_b' });
  assert.equal(resolveAccountAlias('my work and personal accounts', 'gmail'), undefined, 'both labels present → ambiguous → ASK');
  assert.equal(resolveAccountAlias('just work', 'gmail')?.email, 'w@x.com', 'only one label present → resolves');
});

test('re-pointing a label to a new connection with no known email CLEARS the stale email (findings 3,14)', () => {
  reset();
  rememberAccountAlias({ toolkit: 'outlook', label: 'primary', email: 'old@a.com', connectionId: 'ca_old' });
  // user re-points "primary" to a different connection whose email isn't known yet
  const repointed = rememberAccountAlias({ toolkit: 'outlook', label: 'primary', connectionId: 'ca_new' });
  assert.equal(repointed?.connectionId, 'ca_new');
  assert.equal(repointed?.email, undefined, 'stale email must be cleared so it does not route to the old account');
  // resolution now falls back to the new connectionId, not the old mailbox
  assert.equal(resolveAccountAlias('primary', 'outlook')?.connectionId, 'ca_new');
});

test('re-pointing with a NEW known email overwrites cleanly', () => {
  reset();
  rememberAccountAlias({ toolkit: 'outlook', label: 'primary', email: 'old@a.com', connectionId: 'ca_old' });
  const repointed = rememberAccountAlias({ toolkit: 'outlook', label: 'primary', email: 'new@b.com', connectionId: 'ca_new' });
  assert.equal(repointed?.email, 'new@b.com');
  assert.equal(repointed?.connectionId, 'ca_new');
});

test('a ca_ id or non-email is never stored as an email identity', () => {
  reset();
  const r = rememberAccountAlias({ toolkit: 'outlook', label: 'x', email: 'ca_notanemail', connectionId: 'ca_z' });
  assert.equal(r?.email, undefined);
  assert.equal(r?.connectionId, 'ca_z');
});
