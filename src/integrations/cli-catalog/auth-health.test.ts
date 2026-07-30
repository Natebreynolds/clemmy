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

test('exit 0 with output classifies ok and captures the username', () => {
  const verdict = classifyProbeOutput(railway, {
    exitCode: 0,
    output: 'Logged in as nathan@example.com 👋',
    timedOut: false,
  });
  assert.equal(verdict.authStatus, 'ok');
  assert.equal(verdict.username, 'nathan@example.com');
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
  const colored = `[32mName: [39m Nathan Reynolds\n[32mEmail: [39mnathan@example.com`;
  assert.equal(stripAnsi(colored).includes(''), false);
  const verdict = classifyProbeOutput(netlify, { exitCode: 0, output: colored, timedOut: false });
  assert.equal(verdict.authStatus, 'ok');
  assert.equal(verdict.username, 'nathan@example.com');
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

    output = 'Logged in as nathan@example.com 👋';
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
