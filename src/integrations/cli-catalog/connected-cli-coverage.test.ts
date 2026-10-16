/**
 * Run: npx tsx --test src/integrations/cli-catalog/connected-cli-coverage.test.ts
 *
 * Connected roster entries remain discovery candidates. Only exact fresh
 * health can confirm a sign-in observation; no candidate proves an operation.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-cli-coverage-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { CLI_CATALOG } = await import('./catalog.js');
const { connectedCliCandidates, connectedCliCandidatesForApp, connectedCliCoveringApp,
  connectedCliRunnerText, usableConnectedClis, CLI_AUTH_OBSERVATION_MAX_AGE_MS } = await import('./connected-cli-coverage.js');
const { runsLocalCommandLines } = await import('../../tools/tool-registry.js');
const { catalogEntries, rankCatalogEntriesLexically } = await import('../../agents/tool-catalog.js');

const NOW = Date.now();
function writeHealth(entries: Record<string, Record<string, unknown>>): void {
  writeFileSync(path.join(TMP_HOME, 'state', 'cli-auth-health.json'), JSON.stringify({
    version: 'v1',
    entries: Object.fromEntries(Object.entries(entries).map(([id, row]) => [id, {
      id, installed: true, checkedAt: new Date(NOW - 1_000).toISOString(), binaryPath: process.execPath, ...row,
    }])),
  }));
}

function writeRoster(extra: Record<string, unknown> = {}): void {
  const entries = Object.fromEntries(['github', 'railway'].map(id => {
    const entry = CLI_CATALOG.find(item => item.id === id)!;
    return [id, { id, command: entry.command, vendor: entry.vendor, name: entry.name,
      installedAt: new Date(NOW - 10_000).toISOString(), authDocsUrl: entry.authDocsUrl }];
  }));
  writeFileSync(path.join(TMP_HOME, 'state', 'connected-clis.json'), JSON.stringify({ version: 'v1', entries: { ...entries, ...extra } }));
}
beforeEach(() => { writeRoster(); writeHealth({}); });
after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

test('fresh exact health confirms authentication only, with explicit unverified intended account and operation', () => {
  writeHealth({
    github: { command: 'gh', authStatus: 'ok', username: 'owner-fixture' },
    railway: { command: 'railway', authStatus: 'ok', username: 'owner@fixture.test' },
  });
  const [github] = connectedCliCandidatesForApp('GitHub', NOW);
  assert.equal(github?.authentication.state, 'confirmed');
  assert.equal(github?.authentication.reason, 'fresh_authentication');
  assert.deepEqual(github?.account, { state: 'observed', label: 'owner-fixture' });
  assert.equal(github?.intendedAccount, 'unverified');
  assert.equal(github?.operationReadiness, 'unverified');
  assert.equal(github?.matchAmbiguous, false);
  assert.equal(connectedCliCoveringApp('github', NOW)?.command, 'gh');
  assert.equal(connectedCliCoveringApp('GitHub', NOW)?.command, 'gh');
  assert.equal(connectedCliCoveringApp('gh', NOW)?.command, 'gh');
  assert.equal(connectedCliCoveringApp('railway', NOW)?.command, 'railway');
  assert.equal(connectedCliCoveringApp('gitlab', NOW), null);
  // Search aliases are not identities: a generic tag never covers an app.
  assert.deepEqual(connectedCliCandidatesForApp('deploy', NOW), []);
  assert.deepEqual(connectedCliCandidatesForApp('git-hub', NOW), [], 'similar punctuation is not an identity');
});

test('signed-out and uninstalled CLIs remain visible without being usable authentication observations', () => {
  writeHealth({
    github: { command: 'gh', authStatus: 'signed_out' },
    railway: { command: 'railway', authStatus: 'unknown', installed: false, binaryPath: undefined },
  });
  const candidates = connectedCliCandidates(NOW);
  assert.deepEqual(candidates.map(cli => cli.id), ['github', 'railway']);
  assert.equal(candidates[0]!.authentication.state, 'signed_out');
  assert.equal(candidates[1]!.authentication.state, 'unavailable');
  assert.equal(candidates[1]!.authentication.reason, 'not_installed');
  assert.equal(connectedCliCoveringApp('github', NOW), null);
  assert.deepEqual(usableConnectedClis(NOW), []);
  const text = connectedCliRunnerText();
  assert.match(text, /signed out at the last check/);
  assert.match(text, /not found at the last check/);
  assert.doesNotMatch(text, /ready to run here|sign in again|must log in/i);
});

test('unknown and unchecked candidates remain visible and vendor search still finds the command runner', () => {
  writeHealth({ railway: { command: 'railway', authStatus: 'unknown' } });
  const candidates = connectedCliCandidates(NOW);
  assert.equal(candidates[0]!.authentication.reason, 'not_checked');
  assert.equal(candidates[1]!.authentication.reason, 'authentication_unknown');
  assert.ok(candidates.every(cli => cli.account.state === 'unverified'));
  assert.deepEqual(usableConnectedClis(NOW), []);
  const text = connectedCliRunnerText();
  assert.match(text, /`gh` \(GitHub CLI, GitHub\)/);
  assert.match(text, /`railway` \(Railway CLI, Railway\)/);
  assert.match(text, /not checked yet|sign-in has not been confirmed/);
  assert.doesNotMatch(text, /ready to run here/);
  const entries = catalogEntries().map((entry) => ({
    ...entry,
    oneLiner: runsLocalCommandLines(entry.name) ? `${entry.oneLiner}\n${text}` : entry.oneLiner,
  }));
  const runner = entries.find((entry) => runsLocalCommandLines(entry.name));
  assert.ok(runner, 'the registry declares one local command runner');
  const ranked = rankCatalogEntriesLexically('Find the website repository on GitHub and its Railway deployment', entries);
  assert.equal(ranked.sort((a, b) => b.score - a.score)[0]?.name, runner!.name);
});

test('successful sign-in without an account label does not invent one or imply intended-account readiness', () => {
  writeHealth({ railway: { command: 'railway', authStatus: 'ok' } });
  const candidate = connectedCliCandidatesForApp('railway', NOW)[0]!;
  assert.equal(candidate.authentication.state, 'confirmed', 'a public CLI need not manufacture a username');
  assert.deepEqual(candidate.account, { state: 'unverified' });
  assert.equal(candidate.signedInAs, undefined);
  assert.equal(candidate.intendedAccount, 'unverified');
  assert.equal(candidate.operationReadiness, 'unverified');
  assert.match(connectedCliRunnerText(), /account unverified/);
});

const invalidObservations: Array<[string, Record<string, unknown>, string]> = [
  ['expired', { checkedAt: new Date(NOW - CLI_AUTH_OBSERVATION_MAX_AGE_MS - 1).toISOString() }, 'observation_expired'],
  ['future', { checkedAt: new Date(NOW + 24 * 60 * 60_000).toISOString() }, 'future_timestamp'],
  ['malformed time', { checkedAt: 'not-a-time' }, 'invalid_timestamp'],
  ['missing time', { checkedAt: undefined }, 'invalid_timestamp'],
  ['noncanonical time', { checkedAt: String(NOW) }, 'invalid_timestamp'],
  ['wrong id', { id: 'other-cli' }, 'health_identity_mismatch'],
  ['wrong command', { command: 'other-command' }, 'health_identity_mismatch'],
  ['missing executable', { binaryPath: undefined }, 'missing_executable_identity'],
  ['relative executable', { binaryPath: 'gh' }, 'missing_executable_identity'],
  ['stale', { staleSince: new Date(NOW - 2_000).toISOString() }, 'probe_incomplete'],
  ['malformed stale marker', { staleSince: '' }, 'probe_incomplete'],
  ['failed refresh', { lastProbeError: { timedOut: true, exitCode: null, stderrHead: 'private diagnostic' } }, 'probe_incomplete'],
  ['contradictory issue', { issue: 'credential_store_unavailable' }, 'authentication_error'],
];
for (const [name, patch, reason] of invalidObservations) {
  test(`${name} health remains a discoverable candidate without authentication or account proof`, () => {
    writeHealth({ github: { command: 'gh', authStatus: 'ok', username: 'old-account', ...patch } });
    const candidate = connectedCliCandidatesForApp('github', NOW)[0]!;
    assert.equal(candidate.authentication.state, 'unverified');
    assert.equal(candidate.authentication.reason, reason);
    assert.deepEqual(candidate.account, { state: 'unverified' });
    assert.equal(candidate.signedInAs, undefined);
    assert.equal(connectedCliCoveringApp('github', NOW), null);
    assert.doesNotMatch(connectedCliRunnerText(), /old-account|private diagnostic|ready to run here/);
  });
}

test('confirmation freshness uses a documented sweep horizon, not the short request memo', () => {
  assert.equal(CLI_AUTH_OBSERVATION_MAX_AGE_MS, 30 * 60_000);
  writeHealth({ github: { command: 'gh', authStatus: 'ok', checkedAt: new Date(NOW - 5 * 60_000).toISOString() } });
  assert.equal(connectedCliCandidatesForApp('github', NOW)[0]!.authentication.state, 'confirmed');
});

test('multiple exact vendor matches retain their states and ambiguity rather than selecting the first', () => {
  writeRoster({ custom: { id: 'custom', command: 'custom-gh', vendor: 'GitHub', name: 'Another GitHub CLI', installedAt: new Date(NOW).toISOString() } });
  writeHealth({ github: { command: 'gh', authStatus: 'ok', username: 'first-account' } });
  const matches = connectedCliCandidatesForApp('GitHub', NOW);
  assert.equal(matches.length, 2);
  assert.ok(matches.every(cli => cli.matchAmbiguous));
  assert.equal(matches[0]!.authentication.state, 'confirmed');
  assert.equal(matches[1]!.authentication.state, 'unverified');
  assert.equal(connectedCliCoveringApp('GitHub', NOW), null);
  assert.equal(connectedCliCandidatesForApp('custom-gh', NOW)[0]!.matchAmbiguous, false);
  assert.match(connectedCliRunnerText(), /custom-gh/);
});

test('malformed persisted health does not erase connected discovery candidates', () => {
  writeFileSync(path.join(TMP_HOME, 'state', 'cli-auth-health.json'), '{broken JSON');
  assert.equal(connectedCliCandidates(NOW).length, 2);
  assert.ok(connectedCliCandidates(NOW).every(cli => cli.authentication.state === 'unverified'));
  assert.deepEqual(usableConnectedClis(NOW), []);
});

test('malformed display values use safe catalog or identity fallbacks without breaking discovery', () => {
  writeRoster({
    github: { id: 'github', command: 'gh', name: { toString: null }, vendor: [] },
    custom: { id: 'custom', command: 'custom-cli', name: 42, vendor: { toString: null } },
    bounded: { id: 'bounded', command: 'bounded-cli', name: `\u0000${'N'.repeat(300)}`, vendor: '\u007f   ' },
  });
  writeHealth({ github: { command: 'gh', authStatus: 'ok' } });
  const github = connectedCliCandidatesForApp('github', NOW)[0]!;
  assert.equal(github.name, 'GitHub CLI');
  assert.equal(github.vendor, 'GitHub');
  assert.equal(github.authentication.state, 'confirmed', 'display fallback does not change exact id/command binding');
  const custom = connectedCliCandidatesForApp('custom', NOW)[0]!;
  assert.equal(custom.name, 'custom-cli');
  assert.equal(custom.vendor, 'custom');
  assert.equal(custom.authentication.state, 'unverified');
  const bounded = connectedCliCandidatesForApp('bounded', NOW)[0]!;
  assert.equal(bounded.name, 'N'.repeat(256));
  assert.equal(bounded.vendor, 'bounded');
  let text = '';
  assert.doesNotThrow(() => { text = connectedCliRunnerText(); });
  assert.ok(text.includes('`gh` (GitHub CLI, GitHub)'));
  assert.ok(text.includes('`custom-cli` (custom-cli, custom)'));
  assert.doesNotMatch(text, /\[object Object\]|undefined|[\u0000-\u0008\u000b-\u001f\u007f]/);
});

test('invalid roster identities cannot acquire authentication or erase valid sibling discovery', () => {
  const invalidRows = [
    { id: '', command: 'invalid-cli' },
    { id: '   ', command: 'invalid-cli' },
    { id: 'x'.repeat(161), command: 'invalid-cli' },
    { id: 'bad\nidentity', command: 'invalid-cli' },
    { id: 'blank-command', command: '' },
    { id: 'padded-command', command: ' gh ' },
    { id: 'long-command', command: 'x'.repeat(1_025) },
    { id: 'control-command', command: 'gh\u007f' },
  ];
  writeRoster(Object.fromEntries(invalidRows.map((row, index) => [`invalid-${index}`, row])));
  writeHealth(Object.fromEntries(invalidRows.map(row => [row.id, {
    command: row.command, authStatus: 'ok', username: 'not-an-account-proof',
  }])));
  assert.deepEqual(connectedCliCandidates(NOW).map(cli => cli.id), ['github', 'railway']);
  assert.deepEqual(usableConnectedClis(NOW), []);
  assert.doesNotMatch(connectedCliRunnerText(), /not-an-account-proof|invalid-cli/);

  // A malformed roster command must not be normalized into health authority.
  writeRoster({ github: { id: 'github', command: ' gh ', name: 'GitHub CLI', vendor: 'GitHub' } });
  writeHealth({ github: { command: 'gh', authStatus: 'ok', username: 'different-command-account' } });
  assert.deepEqual(connectedCliCandidatesForApp('github', NOW), []);
  assert.deepEqual(connectedCliCandidates(NOW).map(cli => cli.id), ['railway']);
});

test('corrupt roster containers and rows cannot render or invent candidates', () => {
  for (const entries of [[], 'not an entry map', 42, null]) {
    writeFileSync(path.join(TMP_HOME, 'state', 'connected-clis.json'), JSON.stringify({ version: 'v1', entries }));
    assert.deepEqual(connectedCliCandidates(NOW), []);
    assert.equal(connectedCliRunnerText(), '');
  }
  writeRoster({ nullRow: null, stringRow: 'not a row', arrayRow: [] });
  assert.deepEqual(connectedCliCandidates(NOW).map(cli => cli.id), ['github', 'railway']);
  assert.doesNotThrow(() => connectedCliRunnerText());
});

test('no connected CLI leaves the runner unchanged', () => {
  writeFileSync(path.join(TMP_HOME, 'state', 'connected-clis.json'), JSON.stringify({ version: 'v1', entries: {} }));
  assert.equal(connectedCliRunnerText(), '');
  assert.equal(connectedCliCoveringApp('github'), null);
});
