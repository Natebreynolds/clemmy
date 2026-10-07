import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

function runFixture(configuredHome: boolean, configuredEnv: boolean): void {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-credential-bridge-test-'));
  try {
    const selected = path.join(root, 'selected home & 文件');
    const profile = path.join(root, 'synthetic profile');
    const cwd = path.join(root, 'synthetic cwd');
    const source = new URL('./credentials-bridge.ts', import.meta.url).href;
    const program = `
      import assert from 'node:assert/strict';
      import os from 'node:os';
      import path from 'node:path';
      import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      const profile=${JSON.stringify(profile)}, selected=${JSON.stringify(selected)}, cwd=${JSON.stringify(cwd)};
      // Mock only this child's OS lookup. The real OS profile and HOME env
      // remain untouched; every candidate read/write path is a synthetic fixture.
      os.homedir=()=>profile;
      mkdirSync(path.join(profile,'.clementine-next'),{recursive:true});
      mkdirSync(selected,{recursive:true}); mkdirSync(cwd,{recursive:true}); process.chdir(cwd);
      const profileEnv=path.join(profile,'.clementine-next','.env');
      writeFileSync(profileEnv,'WEBHOOK_SECRET=synthetic-profile-secret\\n');
      writeFileSync(path.join(cwd,'.env'),'WEBHOOK_SECRET=synthetic-cwd-secret\\n');
      ${configuredEnv ? "writeFileSync(path.join(selected,'.env'),'WEBHOOK_SECRET=synthetic-selected-secret\\n');" : ''}
      const bridge=await import(${JSON.stringify(source)});
      const target=${configuredHome ? 'selected' : "path.join(profile,'.clementine-next')"};
      const secret=await bridge.ensureWebhookSecret();
      ${configuredHome ? (configuredEnv
        ? "assert.equal(secret,'synthetic-selected-secret');"
        : "assert.notEqual(secret,'synthetic-profile-secret'); assert.notEqual(secret,'synthetic-cwd-secret'); assert.ok(secret.length>=24);")
        : "assert.equal(secret,'synthetic-profile-secret');"}
      const metadata=await bridge.setCredential('openai_api_key','synthetic-api-key');
      assert.equal(metadata.status,'connected'); assert.equal(metadata.source,'file');
      const vault=JSON.parse(readFileSync(path.join(target,'state','secrets-vault.json'),'utf8'));
      assert.equal(vault.entries.openai_api_key,'synthetic-api-key');
      const rows=await bridge.listCredentialRows();
      assert.equal(rows.find(r=>r.name==='openai_api_key')?.status,'connected');
      const migration=await bridge.migrateKeychainToFileVault();
      assert.equal(migration.skippedReason,'fresh_install');
      assert.ok(existsSync(path.join(target,'state','keychain-migrated.json')));
      ${configuredHome ? "assert.equal(existsSync(path.join(profile,'.clementine-next','state')),false);" : "assert.equal(existsSync(path.join(selected,'state')),false);"}
      assert.equal(readFileSync(profileEnv,'utf8'),'WEBHOOK_SECRET=synthetic-profile-secret\\n');
      console.log('owned-credential-home-ok');
    `;
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|OAUTH_TOKEN|WEBHOOK_SECRET)$/i.test(key)) delete env[key];
    }
    if (configuredHome) env.CLEMENTINE_HOME = selected; else delete env.CLEMENTINE_HOME;
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', program], {
      env, encoding: 'utf8', timeout: 30_000, maxBuffer: 4096,
    });
    assert.equal(result.status, 0, `synthetic fixture must complete: ${result.stderr}`);
    assert.equal(result.stdout.trim(), 'owned-credential-home-ok');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('configured home owns generated secret, credential readback and migration marker without touching profile state', () => {
  runFixture(true, false);
});

test('configured home env is selected without borrowing profile or cwd secrets', () => {
  runFixture(true, true);
});

test('ordinary profile-home default and read-only env fallback retain their behavior', () => {
  runFixture(false, false);
});
