import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertWindowsPrivateFilesystem } from './windows-private-filesystem.js';
import { createCredentialFilePolicy, CredentialStoragePrivacyError } from './credential-private-filesystem.js';

const WINDOWS = process.platform === 'win32';
const source = (relative: string): string => new URL(relative, import.meta.url).href;
const POLICY = source('./credential-private-filesystem.ts');
const ACL = source('./windows-private-filesystem.ts');
const FILE = source('./secrets/file-store.ts');
const COMPOSITE = source('./secrets/composite-store.ts');
const CLAUDE = source('./claude-oauth.ts');
const AUTH = source('./auth-store.ts');
const BRIDGE = source('../../apps/desktop/src/credentials-bridge.ts');
const CODEX = source('../../apps/desktop/src/codex-oauth.ts');
const GRANT = source('../../apps/desktop/src/auth-grant.ts');
const ENV = source('./secrets/env-store.ts');

function fixture(run: (root: string) => void): void {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'clem-private-ntfs-test-')));
  try {
    if (WINDOWS) {
      const receipt = assertWindowsPrivateFilesystem(root, lstatSync(root, { bigint: true }), 'directory', true);
      assert.equal(receipt.backend, 'native', 'Windows qualification requires the compiled canonical probe, not Add-Type fallback');
    }
    run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function runChild(root: string, program: string): { elapsedMs: number } {
  const env = { ...process.env, CLEMENTINE_HOME: root, CLEMMY_TEST_ISOLATED_HOME: '1', CLEMMY_TEST_NO_KEYCHAIN: '1' };
  for (const key of Object.keys(env)) {
    if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|OAUTH_TOKEN|WEBHOOK_SECRET)$/i.test(key)) delete (env as NodeJS.ProcessEnv)[key];
  }
  const started = performance.now();
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import os from 'node:os'; import path from 'node:path';
    import {existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync,linkSync,symlinkSync} from 'node:fs';
    import {register} from 'node:module';
    const root=${JSON.stringify(root)}; const profile=path.join(root,'synthetic profile'); os.homedir=()=>profile;
    const acl=await import(${JSON.stringify(ACL)}); const policy=await import(${JSON.stringify(POLICY)});
    const mkdirPrivate=(directory)=>{ if(!existsSync(directory)){mkdirSync(directory,{recursive:true}); if(process.platform==='win32')acl.assertWindowsPrivateFilesystem(directory,lstatSync(directory,{bigint:true}),'directory',true);} };
    mkdirPrivate(profile); mkdirPrivate(path.join(profile,'.codex')); mkdirPrivate(path.join(profile,'.claude'));
    // No network or default-browser call is possible in this offline caller
    // fixture. Storage still uses the exact canonical native policy on Windows.
    globalThis.fetch=()=>{throw new Error('network forbidden in credential fixture');};
    register('data:text/javascript,'+encodeURIComponent("export async function resolve(s,c,n){if(s==='electron')return {url:'data:text/javascript,export const shell={openExternal(){throw new Error(\\\"browser forbidden\\\")}}',shortCircuit:true};return n(s,c);} "));
    ${program}
    console.log('controlled-credential-fixture-ok');
  `], { env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4096, windowsHide: true });
  assert.equal(result.status, 0, `controlled credential fixture must finish: ${result.stderr}`);
  assert.equal(result.stdout.trim(), 'controlled-credential-fixture-ok');
  return { elapsedMs: performance.now() - started };
}

test('Windows inherited-private credential admission preserves ACL/bytes while strict stores still refuse', { skip: !WINDOWS }, t => fixture(root => {
  const target = path.join(root, "legacy inherited & ' café 日本語.json"); const bytes = '{"synthetic":"retained"}\n';
  writeFileSync(target, bytes); const before = lstatSync(target, { bigint: true });
  assert.throws(() => assertWindowsPrivateFilesystem(target, before, 'file'), /could not be verified/);
  const started = performance.now();
  const receipt = assertWindowsPrivateFilesystem(target, before, 'file', false, { allowInheritedPrivate: true });
  assert.equal(receipt.backend, 'native'); assert.equal(receipt.policy, 'credential-inherited-private-v1');
  assert.equal(createCredentialFilePolicy().readCredentialFileSync(target), bytes);
  const after = lstatSync(target, { bigint: true });
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs); assert.equal(after.ctimeNs, before.ctimeNs);
  assert.throws(() => assertWindowsPrivateFilesystem(target, after, 'file'), /could not be verified/, 'read-only credential admission did not protect or rewrite the legacy DACL');
  t.diagnostic(`compiled native inherited-private read ${Math.ceil(performance.now() - started)} ms`);
}));

test('owned vault, Claude and Codex callers save/read across a fresh process without losing sibling grants', t => fixture(root => {
  const written = runChild(root, `
    const file=await import(${JSON.stringify(FILE)}); const claude=await import(${JSON.stringify(CLAUDE)});
    const auth=await import(${JSON.stringify(AUTH)}); const bridge=await import(${JSON.stringify(BRIDGE)}); const desktop=await import(${JSON.stringify(CODEX)});
    const vault=new file.FileSecretBackend(); await vault.set('openai_api_key','synthetic-vault');
    assert.equal(await vault.get('openai_api_key'),'synthetic-vault');
    assert.equal((await bridge.setCredential('browserbase_api_key','synthetic-browserbase')).status,'connected');
    claude.saveClaudeTokens({accessToken:'sk-ant-oat01-synthetic-owned',refreshToken:'synthetic-claude-refresh',expiresAt:Date.now()+3600000});
    assert.equal(claude.getStoredClaudeTokens()?.refreshToken,'synthetic-claude-refresh');
    auth.saveXaiOAuthTokens({accessToken:'synthetic-xai',refreshToken:'synthetic-xai-refresh'});
    const xaiBefore=auth.getStoredXaiOAuthTokens();
    desktop.persistCodexOAuthTokens({accessToken:'synthetic-codex',refreshToken:'synthetic-codex-refresh',accountId:'synthetic-account'});
    assert.equal(auth.getStoredCodexOAuthTokens()?.accountId,'synthetic-account');
    if(process.platform==='win32')assert.deepEqual(auth.getStoredXaiOAuthTokens(),xaiBefore);
    const grant=await import(${JSON.stringify(GRANT)}); assert.equal(grant.hasPersistedCodexGrant(),true);
    if(process.platform==='win32') {
      const external=path.join(profile,'.codex','auth.json'); policy.writeCredentialFileSync(external,'{invalid external CLI JSON');
      assert.equal(auth.getCodexBootstrapAvailability().accountId,'synthetic-account','owned-grant status must not inspect an unused external CLI source');
      assert.equal(auth.getAuthStatus().codexAccountId,'synthetic-account');
      assert.throws(()=>auth.importCodexCliAuth(external),policy.CredentialStoragePrivacyError,'explicit import still refuses the same invalid source');
    }
  `);
  const restarted = runChild(root, `
    const file=await import(${JSON.stringify(FILE)}); const claude=await import(${JSON.stringify(CLAUDE)}); const auth=await import(${JSON.stringify(AUTH)});
    const vault=new file.FileSecretBackend(); assert.equal(await vault.get('openai_api_key'),'synthetic-vault');
    assert.equal(await vault.get('browserbase_api_key'),'synthetic-browserbase');
    assert.equal(claude.getStoredClaudeTokens()?.refreshToken,'synthetic-claude-refresh');
    assert.equal(auth.getStoredCodexOAuthTokens()?.refreshToken,'synthetic-codex-refresh');
    if(process.platform==='win32')assert.equal(auth.getStoredXaiOAuthTokens()?.refreshToken,'synthetic-xai-refresh');
  `);
  t.diagnostic(`controlled caller save/read ${Math.ceil(written.elapsedMs)} ms; fresh-process read ${Math.ceil(restarted.elapsedMs)} ms; ${WINDOWS ? 'native Windows ACL' : 'POSIX regression only'}`);
}));

test('Windows unsafe or malformed present credentials cannot select environment/CLI decoys or mode commitment', { skip: !WINDOWS }, t => fixture(root => {
  const receipt = runChild(root, `
    const file=await import(${JSON.stringify(FILE)}); const composite=await import(${JSON.stringify(COMPOSITE)});
    const claude=await import(${JSON.stringify(CLAUDE)}); const auth=await import(${JSON.stringify(AUTH)}); const bridge=await import(${JSON.stringify(BRIDGE)});
    const desktop=await import(${JSON.stringify(CODEX)}); const grant=await import(${JSON.stringify(GRANT)});
    const vaultFile=path.join(root,'state','secrets-vault.json'), authFile=path.join(root,'state','auth.json'), claudeFile=path.join(root,'state','claude-auth.json');
    const vault=new file.FileSecretBackend(); await vault.set('browserbase_api_key','synthetic-unrelated');
    process.env.OPENAI_API_KEY='synthetic-env-decoy'; const store=new composite.CompositeSecretStore();
    assert.equal((await store.get('openai_api_key')).value,'synthetic-env-decoy','a missing unrelated entry in a valid private vault still permits normal fallback');
    policy.writeCredentialFileSync(vaultFile,'{bad synthetic private JSON');
    const malformed=readFileSync(vaultFile,'utf8'); const failed=await store.get('openai_api_key');
    assert.equal(failed.status,'unreadable'); assert.equal(failed.value,undefined); assert.equal(readFileSync(vaultFile,'utf8'),malformed);
    await assert.rejects(()=>bridge.ensureWebhookSecret(),error=>error?.name==='CredentialStoragePrivacyError');
    await assert.rejects(()=>vault.set('openai_api_key','replacement'),policy.CredentialStoragePrivacyError);
    policy.writeCredentialFileSync(authFile,JSON.stringify({codexOauth:'synthetic-invalid-section'}));
    policy.writeCredentialFileSync(path.join(profile,'.codex','auth.json'),JSON.stringify({tokens:{access_token:'synthetic-cli-decoy',refresh_token:'synthetic-cli-refresh'}}));
    assert.throws(()=>auth.getStoredCodexOAuthTokens(),policy.CredentialStoragePrivacyError);
    assert.throws(()=>grant.hasPersistedCodexGrant(),error=>error?.name==='CredentialStoragePrivacyError');
    await assert.rejects(()=>desktop.importUsableCodexOAuthTokens(),error=>error?.name==='CredentialStoragePrivacyError');
    assert.throws(()=>desktop.persistCodexOAuthTokens({accessToken:'replacement',refreshToken:'replacement'}),error=>error?.name==='CredentialStoragePrivacyError');
    policy.writeCredentialFileSync(claudeFile,JSON.stringify({accessToken:23}));
    claude.__test__.setRawCredentialReaderForTests(()=>JSON.stringify({accessToken:'sk-ant-oat01-cli-decoy'}));
    assert.throws(()=>claude.getStoredClaudeTokens(),policy.CredentialStoragePrivacyError);
    const alias=path.join(root,'state','auth-alias'); linkSync(authFile,alias);
    assert.throws(()=>auth.getStoredCodexOAuthTokens(),policy.CredentialStoragePrivacyError);
  `);
  t.diagnostic(`native Windows refusal/caller fixture ${Math.ceil(receipt.elapsedMs)} ms; no provider or browser dispatch`);
}));

test('Windows later ACL broadening refuses retained bytes without repairing or selecting a source', { skip: !WINDOWS }, t => fixture(root => {
  const target = path.join(root, 'private.json'); const policy = createCredentialFilePolicy(); policy.writeCredentialFileSync(target, '{"synthetic":"private"}');
  const original = readFileSync(target);
  const script = String.raw`$ErrorActionPreference='Stop'; [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false,$true); $p=[Console]::In.ReadToEnd(); $a=Get-Acl -LiteralPath $p; $r=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[System.Security.AccessControl.FileSystemRights]::ReadAndExecute,[System.Security.AccessControl.AccessControlType]::Allow); $a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a`;
  const result = spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { input: target, encoding: 'utf8', timeout: 10_000, maxBuffer: 4096, windowsHide: true });
  assert.equal(result.status, 0, 'synthetic broadening utility must finish');
  const started = performance.now(); assert.throws(() => policy.readCredentialFileSync(target), CredentialStoragePrivacyError);
  assert.throws(() => policy.writeCredentialFileSync(target, '{}'), CredentialStoragePrivacyError);
  assert.deepEqual(readFileSync(target), original); t.diagnostic(`compiled native broadened-ACL refusal ${Math.ceil(performance.now() - started)} ms`);
}));

test('Windows consulted unsafe .env source refuses instead of selecting the next source, and absent public .env is allowed', { skip: !WINDOWS }, t => fixture(root => {
  const receipt = runChild(root, `
    const env=await import(${JSON.stringify(ENV)}); const bridge=await import(${JSON.stringify(BRIDGE)});
    const homeEnv=path.join(root,'.env'); policy.writeCredentialFileSync(homeEnv,JSON.stringify({synthetic:'safe placeholder'}));
    // The shared read policy accepts exact text; only credential writers/wallets
    // enforce JSON. This fixture writes text under an already private ACL.
    writeFileSync(homeEnv,'OPENAI_API_KEY=synthetic-private-env\\nWEBHOOK_SECRET=synthetic-private-webhook\\n');
    const {spawnSync}=await import('node:child_process');
    const script="$ErrorActionPreference='Stop'; [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false,$true); $p=[Console]::In.ReadToEnd(); $a=Get-Acl -LiteralPath $p; $r=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[System.Security.AccessControl.FileSystemRights]::ReadAndExecute,[System.Security.AccessControl.AccessControlType]::Allow); $a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a";
    const weakened=spawnSync(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{input:homeEnv,encoding:'utf8',timeout:10000,maxBuffer:4096,windowsHide:true});
    assert.equal(weakened.status,0);
    const backend=new env.EnvSecretBackend(); await assert.rejects(()=>backend.get('openai_api_key'),policy.CredentialStoragePrivacyError);
    await assert.rejects(()=>bridge.ensureWebhookSecret(),error=>error?.name==='CredentialStoragePrivacyError');
    await assert.rejects(()=>import(${JSON.stringify(source('../config.ts'))}+'?private-env-negative'),policy.CredentialStoragePrivacyError);
    assert.equal(readFileSync(homeEnv,'utf8'),'OPENAI_API_KEY=synthetic-private-env\\nWEBHOOK_SECRET=synthetic-private-webhook\\n');
  `);
  t.diagnostic(`compiled native consulted .env refusal ${Math.ceil(receipt.elapsedMs)} ms`);
}));
