#!/usr/bin/env node
// Smoke test for migrateKeychainToFileVault() in
// apps/desktop/src/credentials-bridge.ts.
//
// We can't actually write to the real macOS Keychain from a smoke test
// (it would prompt the user), so we stub keytar by intercepting Node's
// module-resolution path via a custom `requireFromHere` redirect. We
// run the migration twice — once with a fake Keychain that has some
// entries, once with the marker present — and assert that:
//
//   1. First run moves all non-empty Keychain entries into the file vault.
//   2. The migrated accounts are deleted from the fake Keychain.
//   3. File vault wins on conflict (existing vault entry is preserved).
//   4. The migration marker is written at 0o600.
//   5. Second run is a no-op (marker present).
//
// Run: node scripts/smoke-keychain-migration.mjs

import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Module } from 'node:module';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DESKTOP_DIST = path.join(REPO_ROOT, 'apps', 'desktop', 'dist');

if (!existsSync(path.join(DESKTOP_DIST, 'credentials-bridge.js'))) {
  console.error('✗ apps/desktop/dist not built. Run: cd apps/desktop && npm run build');
  process.exit(2);
}

const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { console.error(`  ✗ ${msg}`); process.exitCode = 1; };

// ─── Fake keytar ───────────────────────────────────────────────────

const fakeKeychain = new Map(); // service+account → password
function fakeKeytarFactory(initialEntries) {
  for (const [acct, pwd] of Object.entries(initialEntries)) {
    fakeKeychain.set(`com.clemmy.desktop.v1:${acct}`, pwd);
  }
  return {
    async getPassword(service, account) {
      return fakeKeychain.get(`${service}:${account}`) ?? null;
    },
    async setPassword(service, account, password) {
      fakeKeychain.set(`${service}:${account}`, password);
    },
    async deletePassword(service, account) {
      return fakeKeychain.delete(`${service}:${account}`);
    },
    async findCredentials(service) {
      const out = [];
      for (const [k, v] of fakeKeychain.entries()) {
        if (k.startsWith(`${service}:`)) {
          out.push({ account: k.slice(service.length + 1), password: v });
        }
      }
      return out;
    },
  };
}

// Intercept require('keytar'). credentials-bridge.ts uses
// createRequire(import.meta.url) to load keytar, so we patch
// Module._resolveFilename + Module._load to redirect 'keytar' to our
// fake.
let fakeKeytar = null;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'keytar' && fakeKeytar) return fakeKeytar;
  return originalLoad.call(this, request, parent, isMain);
};

// ─── Drive the test ────────────────────────────────────────────────

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mig-'));
process.env.HOME = tmpHome;

console.log('Clementine keychain → file vault migration smoke');
console.log(`    HOME=${tmpHome}`);

const stateDir = path.join(tmpHome, '.clementine-next', 'state');
const vaultFile = path.join(stateDir, 'secrets-vault.json');
const markerFile = path.join(stateDir, 'keychain-migrated.json');
const metaFile = path.join(stateDir, 'secrets-meta.json');

let exitCode = 0;
try {
  // Pre-seed: vault already has openai_api_key (conflict test).
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(vaultFile, JSON.stringify({
    version: 'v1',
    entries: { openai_api_key: 'sk-already-in-vault-DO-NOT-OVERWRITE' },
  }, null, 2), { mode: 0o600 });

  // Pre-seed fake keychain with mixed entries.
  fakeKeytar = fakeKeytarFactory({
    openai_api_key: 'sk-from-keychain-should-LOSE',
    discord_bot_token: 'discord-bot-12345',
    recall_api_key: 'recall-67890',
    codex_oauth_access_token: 'codex-access-abc',
    codex_oauth_refresh_token: 'codex-refresh-xyz',
  });

  console.log('\n→ Phase 1 · first migration run');
  const bridge = await import(path.join(DESKTOP_DIST, 'credentials-bridge.js'));
  const result1 = await bridge.migrateKeychainToFileVault();

  if (result1.ran) ok('migration ran on first call');
  else fail(`first call did not run: ${result1.skippedReason}`);

  const migrated = new Set(result1.migrated);
  const expectedMoved = ['discord_bot_token', 'recall_api_key', 'codex_oauth_access_token', 'codex_oauth_refresh_token'];
  for (const acct of expectedMoved) {
    if (migrated.has(acct)) ok(`migrated ${acct}`);
    else fail(`expected to migrate ${acct} but it was not in result.migrated`);
  }
  if (result1.alreadyInVault.includes('openai_api_key')) ok('openai_api_key correctly identified as already-in-vault');
  else fail('openai_api_key should have been classified as already-in-vault');

  // File vault state.
  const vault = JSON.parse(readFileSync(vaultFile, 'utf-8'));
  if (vault.entries.openai_api_key === 'sk-already-in-vault-DO-NOT-OVERWRITE') ok('existing vault openai_api_key preserved (no overwrite)');
  else fail(`vault openai_api_key was overwritten: ${vault.entries.openai_api_key}`);
  if (vault.entries.discord_bot_token === 'discord-bot-12345') ok('discord_bot_token landed in vault');
  else fail('discord_bot_token missing from vault');
  if (vault.entries.codex_oauth_refresh_token === 'codex-refresh-xyz') ok('codex_oauth_refresh_token landed in vault');
  else fail('codex_oauth_refresh_token missing from vault');

  // Keychain delete-after-migrate.
  if (!fakeKeychain.has('com.clemmy.desktop.v1:discord_bot_token')) ok('discord_bot_token deleted from keychain post-migrate');
  else fail('discord_bot_token still in keychain after migrate');
  if (fakeKeychain.has('com.clemmy.desktop.v1:openai_api_key')) ok('openai_api_key left in keychain (vault-wins case)');
  else fail('openai_api_key was deleted from keychain even though vault won');

  // Meta entries.
  if (existsSync(metaFile)) {
    const meta = JSON.parse(readFileSync(metaFile, 'utf-8'));
    const d = meta.entries?.discord_bot_token;
    if (d?.source === 'file' && d?.status === 'connected') ok('meta updated for discord_bot_token (source=file, status=connected)');
    else fail(`meta for discord_bot_token wrong: ${JSON.stringify(d)}`);
  } else {
    fail('secrets-meta.json was not written');
  }

  // Marker.
  if (existsSync(markerFile)) {
    const mode = statSync(markerFile).mode & 0o777;
    if (mode === 0o600) ok(`migration marker written at mode 0o600 (got ${mode.toString(8)})`);
    else fail(`marker mode is ${mode.toString(8)}, expected 600`);
    const m = JSON.parse(readFileSync(markerFile, 'utf-8'));
    if (m.result === 'completed') ok('marker payload result=completed');
    else fail(`marker payload result=${m.result}`);
  } else {
    fail('migration marker not written');
  }

  console.log('\n→ Phase 2 · second run is a no-op');
  const result2 = await bridge.migrateKeychainToFileVault();
  if (!result2.ran && result2.skippedReason === 'already_migrated') ok('second run skipped via marker');
  else fail(`second run did not skip: ran=${result2.ran}, reason=${result2.skippedReason}`);

  console.log('\n→ Phase 3 · empty-keychain case writes marker too');
  // Reset state in the same HOME — delete marker so migration retries,
  // empty the fake keychain. Module-level paths stay valid because we
  // haven't changed HOME.
  rmSync(markerFile, { force: true });
  fakeKeychain.clear();
  const result3 = await bridge.migrateKeychainToFileVault();
  if (result3.ran && result3.skippedReason === 'no_entries') ok('empty keychain → ran but skippedReason=no_entries');
  else if (result3.ran && result3.migrated.length === 0) ok('empty keychain → ran with zero migrations');
  else fail(`empty keychain case unexpected: ${JSON.stringify(result3)}`);

  if (existsSync(markerFile)) ok('marker written even when keychain was empty');
  else fail('marker not written for empty-keychain case');

  if (process.exitCode === 1) {
    console.error('\n✗ keychain migration smoke FAILED');
    exitCode = 1;
  } else {
    console.log('\n✓ keychain migration smoke green');
    exitCode = 0;
  }
} catch (err) {
  console.error('\n✗ smoke threw:', err);
  exitCode = 1;
} finally {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  process.exit(exitCode);
}
