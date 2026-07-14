import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'clementine-custom-home-test-'));
const userHome = path.join(sandbox, 'user-home');
const customHome = path.join(sandbox, 'isolated-clementine');
const defaultHome = path.join(userHome, '.clementine-next');
const previousHome = process.env.HOME;
const previousClementineHome = process.env.CLEMENTINE_HOME;

process.env.HOME = userHome;
process.env.CLEMENTINE_HOME = customHome;

const paths = await import('./clementine-paths.js');
const setupBridge = await import('./setup-bridge.js');
const setupState = await import('./setup-state.js');
const credentials = await import('./credentials-bridge.js');
const codexStore = await import('./codex-oauth-store.js');
const { LocalMeetingRecorder } = await import('./local-meeting-recorder.js');

after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousClementineHome === undefined) delete process.env.CLEMENTINE_HOME;
  else process.env.CLEMENTINE_HOME = previousClementineHome;
  rmSync(sandbox, { recursive: true, force: true });
});

test('desktop setup writes every state surface under CLEMENTINE_HOME', async () => {
  assert.equal(paths.CLEMENTINE_HOME_DIR, customHome);
  assert.equal(paths.CLEMENTINE_STATE_DIR, path.join(customHome, 'state'));
  assert.equal(paths.CLEMENTINE_DESKTOP_LOG_DIR, path.join(customHome, 'logs', 'desktop'));

  setupBridge.setHomeEnv({ AUTH_MODE: 'codex_oauth' });
  setupBridge.addWorkspaceDir(path.join(sandbox, 'workspace'));
  setupBridge.saveUserProfile({ displayName: 'Custom Home User' });
  await credentials.setCredential('openai_api_key', 'sk-custom-home-test');
  const webhookSecret = await credentials.ensureWebhookSecret();
  setupState.writeSetupComplete({
    configured: {
      auth: 'codex',
      discord: false,
      composio: false,
      workspaceCount: 1,
      profileSet: true,
    },
  });

  const authPaths = codexStore.resolveClementineCodexAuthPaths();
  await codexStore.persistClementineOwnedCodexOAuthTokens(authPaths.authFile, authPaths.authDeadFile, {
    grantId: 'grant-custom-home',
    accessToken: 'access-custom-home',
    refreshToken: 'refresh-custom-home',
    lastRefresh: '2026-07-14T12:00:00.000Z',
  });

  const envText = readFileSync(path.join(customHome, '.env'), 'utf-8');
  assert.match(envText, /^AUTH_MODE=codex_oauth$/m);
  assert.match(envText, /^WORKSPACE_DIRS=/m);
  assert.equal(existsSync(path.join(customHome, 'state', 'user-profile.json')), true);
  assert.equal(existsSync(path.join(customHome, 'state', 'setup-complete.json')), true);
  assert.equal(existsSync(path.join(customHome, 'state', 'secrets-vault.json')), true);
  assert.equal(existsSync(path.join(customHome, 'state', 'auth.json')), true);
  assert.ok(webhookSecret.length >= 8);

  const recorder = new LocalMeetingRecorder();
  assert.equal(
    recorder.rootDir,
    path.join(customHome, 'state', 'meeting-capture', 'local-audio'),
  );

  assert.equal(existsSync(defaultHome), false, 'default ~/.clementine-next tree remains untouched');
});
