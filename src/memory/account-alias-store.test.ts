import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-alias-store-'));

const { rememberAccountAlias, resolveAccountAlias, setAccountLabel, aliasLabelFor, listAccountAliases, resetAccountAliasesForTest } = await import('./account-alias-store.js');

function reset() { resetAccountAliasesForTest(); }

test('exact and whole-word match resolve; loose substrings do NOT (findings 5,6,18,19)', () => {
  reset();
  rememberAccountAlias({ toolkit: 'outlook', label: 'acme', email: 'alex.chen@corp.example', connectionId: 'ca_1' });
  // exact + natural phrasing
  assert.equal(resolveAccountAlias('acme', 'outlook')?.email, 'alex.chen@corp.example');
  assert.equal(resolveAccountAlias('my acme email', 'outlook')?.email, 'alex.chen@corp.example');
  // a single letter must NOT match "acme" (the request-substring-of-label bug)
  assert.equal(resolveAccountAlias('s', 'outlook'), undefined);
  // an unrelated word that merely contains the label as a substring must NOT match
  rememberAccountAlias({ toolkit: 'outlook', label: 'corp', email: 'me@corp.example', connectionId: 'ca_2' });
  assert.equal(resolveAccountAlias('acme', 'outlook')?.email, 'alex.chen@corp.example', '"corp" is a substring of "acme" but must not steal it');
});

test('multi-word label needs all words; ambiguity returns undefined (gateway then ASKS)', () => {
  reset();
  rememberAccountAlias({ toolkit: 'slack', label: 'work main', email: 'ops@corp.example', connectionId: 'ca_w' });
  assert.equal(resolveAccountAlias('the work main channel', 'slack')?.email, 'ops@corp.example');
  assert.equal(resolveAccountAlias('work', 'slack'), undefined, 'partial label match must not resolve');
  // exact match always wins even when other labels are word-subsets
  rememberAccountAlias({ toolkit: 'slack', label: 'main', email: 'main@corp.example', connectionId: 'ca_m' });
  assert.equal(resolveAccountAlias('work main', 'slack')?.email, 'ops@corp.example', 'exact "work main" label wins over the word-subset "main"');
  // two single-word labels both present, exact-matching neither → ambiguous → undefined
  reset();
  rememberAccountAlias({ toolkit: 'gmail', label: 'work', email: 'w@site.example', connectionId: 'ca_a' });
  rememberAccountAlias({ toolkit: 'gmail', label: 'personal', email: 'p@site.example', connectionId: 'ca_b' });
  assert.equal(resolveAccountAlias('my work and personal accounts', 'gmail'), undefined, 'both labels present → ambiguous → ASK');
  assert.equal(resolveAccountAlias('just work', 'gmail')?.email, 'w@site.example', 'only one label present → resolves');
});

test('re-pointing a label to a new connection with no known email CLEARS the stale email (findings 3,14)', () => {
  reset();
  rememberAccountAlias({ toolkit: 'outlook', label: 'primary', email: 'old@alpha.example', connectionId: 'ca_old' });
  // user re-points "primary" to a different connection whose email isn't known yet
  const repointed = rememberAccountAlias({ toolkit: 'outlook', label: 'primary', connectionId: 'ca_new' });
  assert.equal(repointed?.connectionId, 'ca_new');
  assert.equal(repointed?.email, undefined, 'stale email must be cleared so it does not route to the old account');
  // resolution now falls back to the new connectionId, not the old mailbox
  assert.equal(resolveAccountAlias('primary', 'outlook')?.connectionId, 'ca_new');
});

test('re-pointing with a NEW known email overwrites cleanly', () => {
  reset();
  rememberAccountAlias({ toolkit: 'outlook', label: 'primary', email: 'old@alpha.example', connectionId: 'ca_old' });
  const repointed = rememberAccountAlias({ toolkit: 'outlook', label: 'primary', email: 'new@beta.example', connectionId: 'ca_new' });
  assert.equal(repointed?.email, 'new@beta.example');
  assert.equal(repointed?.connectionId, 'ca_new');
});

test('a ca_ id or non-email is never stored as an email identity', () => {
  reset();
  const r = rememberAccountAlias({ toolkit: 'outlook', label: 'x', email: 'ca_notanemail', connectionId: 'ca_z' });
  assert.equal(r?.email, undefined);
  assert.equal(r?.connectionId, 'ca_z');
});

// The desktop-UI entry point: setAccountLabel (one label per account, plus clear).
test('setAccountLabel binds a label to an account and is readable by aliasLabelFor', () => {
  reset();
  setAccountLabel({ toolkit: 'gmail', label: 'Work', email: 'alex.chen@work.example', connectionId: 'ca_w' });
  assert.equal(aliasLabelFor('gmail', 'alex.chen@work.example'), 'work', 'normalized + resolvable by email');
  assert.equal(resolveAccountAlias('work', 'gmail')?.email, 'alex.chen@work.example');
});

test('setAccountLabel renames in place — one account never carries two labels', () => {
  reset();
  setAccountLabel({ toolkit: 'gmail', label: 'work', email: 'alex.chen@work.example', connectionId: 'ca_w' });
  setAccountLabel({ toolkit: 'gmail', label: 'primary', email: 'alex.chen@work.example', connectionId: 'ca_w' });
  const labels = listAccountAliases('gmail').filter((a) => a.email === 'alex.chen@work.example').map((a) => a.label);
  assert.deepEqual(labels, ['primary'], 'the old label is dropped, not left dangling');
  assert.equal(aliasLabelFor('gmail', 'alex.chen@work.example'), 'primary');
});

test('setAccountLabel with an empty label clears the account label', () => {
  reset();
  setAccountLabel({ toolkit: 'gmail', label: 'work', email: 'alex.chen@work.example', connectionId: 'ca_w' });
  const cleared = setAccountLabel({ toolkit: 'gmail', label: '', email: 'alex.chen@work.example', connectionId: 'ca_w' });
  assert.equal(cleared, null);
  assert.equal(aliasLabelFor('gmail', 'alex.chen@work.example'), undefined, 'label removed');
});

test('setAccountLabel binds by connectionId when the email is unknown', () => {
  reset();
  const r = setAccountLabel({ toolkit: 'outlook', label: 'sales', connectionId: 'ca_only' });
  assert.equal(r?.connectionId, 'ca_only');
  assert.equal(aliasLabelFor('outlook', undefined, 'ca_only'), 'sales');
});
