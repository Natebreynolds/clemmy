/**
 * Run: npx tsx --test src/integrations/cli-catalog/auth-health.test.ts
 *
 * Pins for the CLI auth-health engine. Every probe execution is injected —
 * a live login is one classification bug away from a side effect, so these
 * tests never touch a real binary.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-cli-auth-health-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  classifyProbeOutput,
  stripAnsi,
  _testOnly_setProbeExec,
  _testOnly_setCommandResolver,
  _testOnly_stopCliHealthSweep,
} = await import('./auth-health.js');
const { CLI_CATALOG } = await import('./catalog.js');
const { validateInstallCommand } = await import('../browser-harness.js');

afterEach(() => {
  _testOnly_setProbeExec();
  _testOnly_setCommandResolver();
  _testOnly_stopCliHealthSweep();
});

/** Installed-ness resolves against the REAL PATH before any probe runs, so the
 *  transition tests below would only pass on a machine that happens to have the
 *  CLI installed (green on a dev laptop, red on the Linux release runner).
 *  Stub resolution so they exercise the transition engine hermetically. */
function stubInstalled(): void {
  _testOnly_setCommandResolver((command: string) => ({ skipped: false as const, command, path: process.execPath }));
}

// ─── Catalog contract pins ──────────────────────────────────────────

test('every catalog auth probe is a READ-ONLY status command', () => {
  const mutating = /\b(login|logout|deploy|create|delete|push|publish|init|configure|add|remove|set)\b/i;
  for (const entry of CLI_CATALOG) {
    if (!entry.authProbe) continue;
    assert.ok(entry.authProbe.args.length > 0, `${entry.id}: probe args must be non-empty`);
    const joined = entry.authProbe.args.join(' ');
    // A trailing `status` marks a status SUBCOMMAND of an otherwise-mutating
    // group (codex nests its read under `login`: `codex login status`,
    // verified live as a pure read) — that shape is exactly what this pin
    // wants probes to be.
    const isStatusSubcommand = entry.authProbe.args[entry.authProbe.args.length - 1] === 'status';
    assert.ok(isStatusSubcommand || !mutating.test(joined),
      `${entry.id}: probe "${joined}" carries a mutating verb — probes must be pure status reads`);
  }
});

test('authHeadless entries always carry the login command the job will run', () => {
  for (const entry of CLI_CATALOG) {
    if (entry.authHeadless) {
      assert.ok(entry.authCommand, `${entry.id}: authHeadless without authCommand is unrunnable`);
    }
  }
});

test('every catalog install command still passes the install allowlist', () => {
  for (const entry of CLI_CATALOG) {
    const verdict = validateInstallCommand(entry.installCommand);
    assert.ok(verdict.ok, `${entry.id}: ${entry.installCommand} rejected: ${verdict.ok ? '' : verdict.error}`);
  }
});

// ─── Classifier truth table ─────────────────────────────────────────

const railway = CLI_CATALOG.find((e) => e.id === 'railway')!.authProbe!;
const gcloud = CLI_CATALOG.find((e) => e.id === 'gcloud')!.authProbe!;
const netlify = CLI_CATALOG.find((e) => e.id === 'netlify')!.authProbe!;
const salesforce = CLI_CATALOG.find((e) => e.id === 'salesforce')!;
const salesforceProbe = salesforce.authProbe!;

test('Salesforce CLI has a default-org auth probe and a closed reviewed SOQL read', () => {
  assert.ok(salesforceProbe, 'Salesforce must attest auth, not stay unknown');
  assert.deepEqual(salesforceProbe.args, ['org', 'display', '--json']);
  assert.equal(salesforce.reviewedRead?.operationId, 'salesforce_sf_soql_query');
  assert.deepEqual(salesforce.reviewedRead?.argvPrefix, ['data', 'query', '--json']);
  assert.equal(
    salesforce.reviewedRead?.arguments.some((argument) => argument.kind === 'option' && argument.token === '--query'),
    true,
  );
});

test('Salesforce default-org display JSON classifies ok even when another org would be inactive in org list', () => {
  const verdict = classifyProbeOutput(salesforceProbe, {
    exitCode: 0,
    output: JSON.stringify({
      status: 0,
      result: {
        username: 'sales.user@example.com',
        connectedStatus: 'Connected',
        alias: 'default',
        id: '00D000000000001',
      },
    }, null, 2),
    timedOut: false,
  });
  assert.equal(verdict.authStatus, 'ok');
  assert.equal(verdict.username, 'sales.user@example.com');
});

test('Salesforce org-list JSON with one inactive sibling is not the auth probe — display-only signed-out stays honest', () => {
  const listPoison = JSON.stringify({
    result: {
      nonScratchOrgs: [
        { username: 'ok@example.com', connectedStatus: 'Connected', isDefaultUsername: true },
        { username: 'dead@example.com', connectedStatus: 'Unable to refresh session due to: inactive user', isDefaultUsername: false },
      ],
    },
  });
  const listVerdict = classifyProbeOutput(salesforceProbe, {
    exitCode: 0,
    output: listPoison,
    timedOut: false,
  });
  assert.equal(listVerdict.authStatus, 'signed_out',
    'org list is the wrong probe: an inactive sibling would poison Connected default. The catalog must use org display.');
  const displayVerdict = classifyProbeOutput(salesforceProbe, {
    exitCode: 0,
    output: '{"status":0,"result":{"username":"ok@example.com","connectedStatus":"Connected"}}',
    timedOut: false,
  });
  assert.equal(displayVerdict.authStatus, 'ok');
});

test('Salesforce no-default-org output classifies signed_out', () => {
  const verdict = classifyProbeOutput(salesforceProbe, {
    exitCode: 1,
    output: 'Error (NoDefaultOrgFoundError): No default org found. Use "sf org login web" or set a default.',
    timedOut: false,
  });
  assert.equal(verdict.authStatus, 'signed_out');
});

test('exit 0 with output classifies ok and captures the username', () => {
  const verdict = classifyProbeOutput(railway, {
    exitCode: 0,
    output: 'Logged in as cli.user@example.com 👋',
    timedOut: false,
  });
  assert.equal(verdict.authStatus, 'ok');
  assert.equal(verdict.username, 'cli.user@example.com');
});

test('the signed-out pattern outranks the exit code — gcloud reports signed-out with exit 0', () => {
  // Verified live: `gcloud auth list --filter=status:ACTIVE` prints `[]`
  // and exits 0 when no account is active. Exit-code-only classification
  // would call this "ok" forever.
  const verdict = classifyProbeOutput(gcloud, { exitCode: 0, output: '[]\n', timedOut: false });
  assert.equal(verdict.authStatus, 'signed_out');
});

test('gcloud with an active account is ok and captures the account', () => {
  const verdict = classifyProbeOutput(gcloud, {
    exitCode: 0,
    output: '[\n  {\n    "account": "team@example.com",\n    "status": "ACTIVE"\n  }\n]\n',
    timedOut: false,
  });
  assert.equal(verdict.authStatus, 'ok');
  assert.equal(verdict.username, 'team@example.com');
});

test('ANSI-colored output is stripped before matching — netlify colors its status block', () => {
  const colored = `[32mName: [39m Test User\n[32mEmail: [39mcli.user@example.com`;
  assert.equal(stripAnsi(colored).includes(''), false);
  const verdict = classifyProbeOutput(netlify, { exitCode: 0, output: colored, timedOut: false });
  assert.equal(verdict.authStatus, 'ok');
  assert.equal(verdict.username, 'cli.user@example.com');
});

test('signed-out text classifies signed_out even on non-zero exit', () => {
  const verdict = classifyProbeOutput(railway, {
    exitCode: 1,
    output: 'Unauthorized. Please login with `railway login`',
    timedOut: false,
  });
  assert.equal(verdict.authStatus, 'signed_out');
});

test('a timed-out or silently-failing probe is error, never ok and never signed_out', () => {
  assert.equal(classifyProbeOutput(railway, { exitCode: null, output: '', timedOut: true }).authStatus, 'error');
  assert.equal(classifyProbeOutput(railway, { exitCode: 1, output: 'connect ETIMEDOUT', timedOut: false }).authStatus, 'error');
  assert.equal(classifyProbeOutput(railway, { exitCode: 0, output: '', timedOut: false }).authStatus, 'error');
});

// ─── Transition events through the real engine ──────────────────────

test('signed_out→ok fires the recovered event exactly once; ok→ok never fires', async () => {
  const { getCliHealth, onCliAuthRecovered, invalidateCliHealth } = await import('./auth-health.js');
  stubInstalled();
  const { recordConnectedCli, findCatalogEntry } = await import('./catalog.js');
  recordConnectedCli(findCatalogEntry('railway')!);

  const recovered: string[] = [];
  const unsubscribe = onCliAuthRecovered((h) => recovered.push(h.id));
  try {
    let output = 'Unauthorized. Please login with `railway login`';
    _testOnly_setProbeExec(async () => ({ exitCode: output.startsWith('Unauthorized') ? 1 : 0, output, timedOut: false }));

    await getCliHealth('railway', { force: true });
    assert.equal(recovered.length, 0, 'entering signed_out is not a recovery');

    output = 'Logged in as cli.user@example.com 👋';
    invalidateCliHealth('railway');
    await getCliHealth('railway', { force: true });
    assert.deepEqual(recovered, ['railway'], 'the signed_out→ok edge fires exactly once');

    invalidateCliHealth('railway');
    await getCliHealth('railway', { force: true });
    assert.deepEqual(recovered, ['railway'], 'ok→ok does not re-fire');
  } finally {
    unsubscribe();
  }
});

test('the 45s memo prevents repeat probes inside the TTL; force busts it', async () => {
  const { getCliHealth, invalidateCliHealth } = await import('./auth-health.js');
  stubInstalled();
  invalidateCliHealth();
  let probes = 0;
  _testOnly_setProbeExec(async () => {
    probes += 1;
    return { exitCode: 0, output: 'Logged in as memo@example.com', timedOut: false };
  });

  await getCliHealth('railway', { force: true });
  const after = probes;
  await getCliHealth('railway');
  await getCliHealth('railway');
  assert.equal(probes, after, 'repeat reads inside the TTL never spawn');
  await getCliHealth('railway', { force: true });
  assert.equal(probes, after + 1, 'force re-probes');
});

// ─── Transient probe failures keep the last verdict ─────────────────
// Live evidence: the owner's CLI answered its probe in 1.5s with exit 0 from
// the daemon's exact spawn shape, yet the cache said authStatus 'error' from
// one earlier transient — and every surface rendered that as "re-auth". A
// probe that produced no verdict must not overwrite one that did.

test('previous ok + non-zero exit without the signed-out pattern keeps ok and marks it stale', async () => {
  const { getCliHealth, invalidateCliHealth, readPersistedHealth, cliHealthStaleNote } = await import('./auth-health.js');
  stubInstalled();
  invalidateCliHealth('railway');
  _testOnly_setProbeExec(async () => ({ exitCode: 0, output: 'Logged in as keep@example.com', timedOut: false }));
  const good = await getCliHealth('railway', { force: true });
  assert.equal(good.authStatus, 'ok');
  assert.equal(good.staleSince, undefined);

  invalidateCliHealth('railway');
  _testOnly_setProbeExec(async () => ({
    exitCode: 1,
    output: '',
    stderr: '\u001B[31mError: connect ETIMEDOUT api.example.test:443\u001B[39m',
    timedOut: false,
  }));
  const kept = await getCliHealth('railway', { force: true });
  assert.equal(kept.authStatus, 'ok', 'an unexplained non-zero exit is not a sign-out');
  assert.equal(kept.username, 'keep@example.com');
  assert.equal(kept.staleSince, good.checkedAt, 'staleSince is the time of the verdict being kept');
  assert.deepEqual(kept.lastProbeError, {
    exitCode: 1,
    timedOut: false,
    stderrHead: 'Error: connect ETIMEDOUT api.example.test:443',
  });
  assert.equal(readPersistedHealth().railway?.authStatus, 'ok', 'the persisted cache keeps the verdict too');
  assert.equal(readPersistedHealth().railway?.staleSince, good.checkedAt);
  assert.match(cliHealthStaleNote(kept, Date.parse(kept.checkedAt) + 3 * 3_600_000) ?? '', /^checked 3h ago, last probe failed \(exit 1\)$/);

  // A second transient keeps the ORIGINAL staleSince (age keeps growing), and
  // the memo serves the settled record, not the raw probe.
  invalidateCliHealth('railway');
  const keptAgain = await getCliHealth('railway', { force: true });
  assert.equal(keptAgain.authStatus, 'ok');
  assert.equal(keptAgain.staleSince, good.checkedAt);
  assert.equal((await getCliHealth('railway')).authStatus, 'ok');

  // The next real verdict clears the stale marker.
  invalidateCliHealth('railway');
  _testOnly_setProbeExec(async () => ({ exitCode: 0, output: 'Logged in as keep@example.com', timedOut: false }));
  const fresh = await getCliHealth('railway', { force: true });
  assert.equal(fresh.authStatus, 'ok');
  assert.equal(fresh.staleSince, undefined);
  assert.equal(fresh.lastProbeError, undefined);
  assert.equal(cliHealthStaleNote(fresh), null);
});

test('the signed-out pattern still flips a kept ok to signed_out and fires the signed-out event once', async () => {
  const { getCliHealth, invalidateCliHealth, onCliSignedOut } = await import('./auth-health.js');
  stubInstalled();
  const signedOut: string[] = [];
  const unsubscribe = onCliSignedOut((h) => signedOut.push(h.id));
  try {
    invalidateCliHealth('railway');
    _testOnly_setProbeExec(async () => ({ exitCode: 1, output: '', stderr: 'boom', timedOut: false }));
    assert.equal((await getCliHealth('railway', { force: true })).authStatus, 'ok', 'transient first: still ok');
    assert.deepEqual(signedOut, []);

    invalidateCliHealth('railway');
    _testOnly_setProbeExec(async () => ({
      exitCode: 1,
      output: 'Unauthorized. Please login with `railway login`',
      timedOut: false,
    }));
    const out = await getCliHealth('railway', { force: true });
    assert.equal(out.authStatus, 'signed_out');
    assert.equal(out.staleSince, undefined);
    assert.equal(out.lastProbeError, undefined);
    assert.deepEqual(signedOut, ['railway']);

    // A transient AFTER signed_out keeps signed_out (no verdict = no change)
    // and does not re-fire the event.
    invalidateCliHealth('railway');
    _testOnly_setProbeExec(async () => ({ exitCode: null, output: '', timedOut: true }));
    const stillOut = await getCliHealth('railway', { force: true });
    assert.equal(stillOut.authStatus, 'signed_out');
    assert.equal(stillOut.staleSince, out.checkedAt);
    assert.deepEqual(signedOut, ['railway']);
  } finally {
    unsubscribe();
  }
});

test('a timeout with no previous verdict is unknown, never error', async () => {
  const { getCliHealth, invalidateCliHealth, readPersistedHealth, cliHealthStaleNote } = await import('./auth-health.js');
  stubInstalled();
  assert.equal(readPersistedHealth().gcloud, undefined, 'fixture: gcloud has never been probed in this home');
  invalidateCliHealth('gcloud');
  _testOnly_setProbeExec(async () => ({ exitCode: null, output: '', timedOut: true }));
  const first = await getCliHealth('gcloud', { force: true });
  assert.equal(first.authStatus, 'unknown');
  assert.notEqual(first.authStatus, 'error');
  assert.equal(first.staleSince, undefined, 'nothing was kept, so nothing is stale');
  assert.deepEqual(first.lastProbeError, { exitCode: null, timedOut: true, stderrHead: '' });
  assert.match(cliHealthStaleNote(first, Date.parse(first.checkedAt)) ?? '', /^checked just now, last probe failed \(timed out\)$/);
  assert.equal(readPersistedHealth().gcloud?.authStatus, 'unknown');
});

test('classifyProbeOutput is unchanged: the pure classifier still says error for a no-verdict probe', () => {
  // The truth table above is the oracle for classification; the transient
  // handling lives in commit, where the previous verdict is known.
  assert.equal(classifyProbeOutput(railway, { exitCode: 1, output: 'connect ETIMEDOUT', timedOut: false }).authStatus, 'error');
});
