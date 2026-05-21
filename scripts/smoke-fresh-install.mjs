#!/usr/bin/env node
// Deterministic local reproducer for the desktop fresh-install flow.
//
// Simulates a brand-new computer with no prior Clementine state by
// pointing HOME at a temp directory, then walks through the exact gates
// `apps/desktop/src/main.ts:boot()` uses to decide whether to open the
// setup wizard.
//
//   needsSetup()
//     = !hasCompletedSetup() && !hasAnyUsableCredential()
//
//   hasAnyUsableCredential() reads:
//     1. process.env.OPENAI_API_KEY
//     2. $HOME/.clementine-next/.env
//     3. $HOME/clementine-next/.env
//     4. process.cwd()/.env
//     5. $HOME/.codex/auth.json   (tokens.access_token + refresh_token)
//     6. $HOME/.clementine-next/state/auth.json   (codexOauth)
//     7. $HOME/.clementine-next/state/secrets-vault.json   (any key
//        containing "openai" or "codex" with a non-empty string value)
//
// Run with: node scripts/smoke-fresh-install.mjs
//
// Exits 0 on green smoke. Non-zero with a diagnosis when any gate fires
// unexpectedly for a clean install.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

// ─── Plumbing ──────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DESKTOP_DIST = path.join(REPO_ROOT, 'apps', 'desktop', 'dist');

if (!existsSync(path.join(DESKTOP_DIST, 'setup-state.js'))) {
  console.error('✗ apps/desktop/dist not built. Run: (cd apps/desktop && npm run build)');
  process.exit(2);
}

const palette = process.stdout.isTTY
  ? { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }
  : { red: '', green: '', yellow: '', cyan: '', dim: '', bold: '', reset: '' };

let failures = 0;
function pass(name) { console.log(`  ${palette.green}✓${palette.reset} ${name}`); }
function fail(name, detail) {
  failures++;
  console.log(`  ${palette.red}✗${palette.reset} ${name}`);
  if (detail) console.log(`      ${palette.dim}${detail}${palette.reset}`);
}
function info(line) { console.log(`    ${palette.dim}${line}${palette.reset}`); }
function section(title) { console.log(`\n${palette.bold}→ ${title}${palette.reset}`); }

// ─── Sandbox HOME ──────────────────────────────────────────────────

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-fresh-'));
const tmpCwd = mkdtempSync(path.join(os.tmpdir(), 'clemmy-cwd-'));
const originalHome = process.env.HOME;
const originalUserprofile = process.env.USERPROFILE;
const originalCwd = process.cwd();
const originalOpenai = process.env.OPENAI_API_KEY;

process.env.HOME = tmpHome;
if (process.platform === 'win32') process.env.USERPROFILE = tmpHome;
delete process.env.OPENAI_API_KEY;
process.chdir(tmpCwd);

process.on('exit', () => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  if (originalUserprofile !== undefined) process.env.USERPROFILE = originalUserprofile;
  if (originalOpenai !== undefined) process.env.OPENAI_API_KEY = originalOpenai;
  try { process.chdir(originalCwd); } catch {}
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  try { rmSync(tmpCwd, { recursive: true, force: true }); } catch {}
});

console.log(`${palette.cyan}${palette.bold}Clementine fresh-install smoke test${palette.reset}`);
info(`HOME=${tmpHome}`);
info(`cwd=${tmpCwd}`);
info(`process.env.OPENAI_API_KEY=${process.env.OPENAI_API_KEY ?? '(unset)'}`);

// Import the same compiled modules main.ts uses. dynamic import so HOME
// is already overridden when their top-level `os.homedir()` resolves.
const setupState = await import(pathToFileURL(path.join(DESKTOP_DIST, 'setup-state.js')).href);
const credentialsBridge = await import(pathToFileURL(path.join(DESKTOP_DIST, 'credentials-bridge.js')).href);

// ─── Phase 1: Brand new computer, never run anything ──────────────

section('Phase 1 · pristine HOME (no Clementine, no Codex, no .env)');
{
  const usable = setupState.hasAnyUsableCredential();
  if (usable) fail('hasAnyUsableCredential() === false', 'Returned true on a pristine HOME — one of the credential sources fired a false positive.');
  else pass('hasAnyUsableCredential() === false');

  const completed = setupState.hasCompletedSetup();
  if (completed) fail('hasCompletedSetup() === false', 'Marker file exists on a pristine HOME.');
  else pass('hasCompletedSetup() === false');

  const needs = setupState.needsSetup();
  if (!needs) fail('needsSetup() === true', 'Setup wizard would NOT open — this matches the symptom.');
  else pass('needsSetup() === true');
}

// ─── Phase 2: ensureWebhookSecret on a pristine HOME ──────────────

section('Phase 2 · ensureWebhookSecret() then re-check needsSetup');
{
  const secret = await credentialsBridge.ensureWebhookSecret();
  if (!secret || secret.length < 8) fail('ensureWebhookSecret returned a value', `got: ${JSON.stringify(secret)}`);
  else pass(`ensureWebhookSecret() returned a ${secret.length}-char token`);

  const vaultPath = path.join(tmpHome, '.clementine-next', 'state', 'secrets-vault.json');
  if (!existsSync(vaultPath)) fail('secrets-vault.json created');
  else pass('secrets-vault.json created');

  // CRITICAL: writing webhook_secret to the vault MUST NOT trip hasAnyUsableCredential.
  // hasAnyUsableCredential() iterates vault entries looking for keys
  // containing "openai" or "codex". webhook_secret should not match.
  const stillNeedsSetup = setupState.needsSetup();
  if (!stillNeedsSetup) fail('needsSetup() still true after webhook_secret write', 'A spurious credential write is tripping the wizard gate.');
  else pass('needsSetup() still true after webhook_secret write');
}

// ─── Phase 3: simulate wizard finishing on OpenAI track ───────────

section('Phase 3 · wizard completes on OpenAI track');
{
  await credentialsBridge.setCredential('openai_api_key', 'sk-test-fake-123');
  const usable = setupState.hasAnyUsableCredential();
  if (!usable) fail('hasAnyUsableCredential() === true after openai_api_key write');
  else pass('hasAnyUsableCredential() === true after openai_api_key write');

  const stillNeedsMarker = setupState.needsSetup();
  if (!stillNeedsMarker) fail('needsSetup() remains true until marker is written');
  else pass('needsSetup() remains true until marker is written');

  setupState.writeSetupComplete({
    configured: { auth: 'openai', discord: false, composio: false, workspaceCount: 0, profileSet: false },
  });

  const needs = setupState.needsSetup();
  if (needs) fail('needsSetup() === false after marker written');
  else pass('needsSetup() === false after marker written');
}

// ─── Phase 4: false-positive probes (the reason wizard might skip) ─

section('Phase 4 · false-positive probes for hasAnyUsableCredential()');

async function probe(name, setup) {
  const probeHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-probe-'));
  const probeCwd = mkdtempSync(path.join(os.tmpdir(), 'clemmy-cwd-probe-'));
  const savedHome = process.env.HOME;
  const savedCwd = process.cwd();
  process.env.HOME = probeHome;
  process.chdir(probeCwd);
  try {
    await setup({ home: probeHome, cwd: probeCwd });
    // Re-import the modules so their cached `os.homedir()` snapshot is fresh.
    // setup-state captures HOME at module-load time, so we use a cache-busting query.
    const url = pathToFileURL(path.join(DESKTOP_DIST, 'setup-state.js')).href + `?probe=${name}`;
    const reloaded = await import(url);
    return reloaded.hasAnyUsableCredential();
  } finally {
    process.env.HOME = savedHome;
    process.chdir(savedCwd);
    try { rmSync(probeHome, { recursive: true, force: true }); } catch {}
    try { rmSync(probeCwd, { recursive: true, force: true }); } catch {}
  }
}

const probes = [
  {
    name: 'codex CLI signed in (Codex CLI auth.json exists)',
    setup: async ({ home }) => {
      const codexDir = path.join(home, '.codex');
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({
        tokens: { access_token: 'fake', refresh_token: 'fake' },
      }));
    },
    expected: true,
    note: 'Codex CLI auth can be reused by the wizard, but it must not skip setup without setup-complete.json.',
  },
  {
    name: 'launched from a directory containing a .env with OPENAI_API_KEY',
    setup: async ({ cwd }) => {
      writeFileSync(path.join(cwd, '.env'), 'OPENAI_API_KEY=sk-from-cwd\n');
    },
    expected: true,
    note: 'process.cwd()/.env can be reused, but it must not skip setup without setup-complete.json.',
  },
  {
    name: '~/clementine-next/.env present (dev clone on machine)',
    setup: async ({ home }) => {
      mkdirSync(path.join(home, 'clementine-next'), { recursive: true });
      writeFileSync(path.join(home, 'clementine-next', '.env'), 'OPENAI_API_KEY=sk-from-clone\n');
    },
    expected: true,
    note: 'A dev clone .env can be reused, but it must not skip setup without setup-complete.json.',
  },
  {
    name: 'pristine HOME, no env, no codex, no .env files',
    setup: async () => { /* truly nothing */ },
    expected: false,
    note: 'Baseline — wizard MUST open for this case. If this fires true, the gate logic itself is broken.',
  },
];

for (const p of probes) {
  const got = await probe(p.name, p.setup);
  const ok = got === p.expected;
  if (ok) pass(`${p.name} → hasAnyUsableCredential() === ${got}`);
  else fail(`${p.name} → expected ${p.expected}, got ${got}`, p.note);
  if (got && p.expected) info(`note: ${p.note}`);
}

// ─── Summary ──────────────────────────────────────────────────────

console.log();
if (failures === 0) {
  console.log(`${palette.green}${palette.bold}✓ all gates behave correctly for a pristine fresh install${palette.reset}`);
  console.log(`${palette.dim}  ↳ Next: verify the wizard actually opens by launching the app with HOME pointed at an empty temp dir.${palette.reset}`);
  process.exit(0);
} else {
  console.log(`${palette.red}${palette.bold}✗ ${failures} gate(s) misbehaving — the wizard would skip when it shouldn't${palette.reset}`);
  process.exit(1);
}
