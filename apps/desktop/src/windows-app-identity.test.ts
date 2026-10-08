import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Windows shows a toast only for the identity the installer's Start-menu
// shortcut registered (electron-builder build.appId). An installed Windows
// beta never set it, and every notification failed with "Settings prevent
// the notification type from being delivered" (2026-10-08).
test('the Windows notification identity is set at startup and is the installer appId', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { build?: { appId?: string } };
  const id = /const WINDOWS_APP_USER_MODEL_ID = '([^']+)';/.exec(main)?.[1];
  assert.ok(pkg.build?.appId);
  assert.equal(id, pkg.build.appId);
  assert.match(main, /if \(process\.platform === 'win32'\) app\.setAppUserModelId\(WINDOWS_APP_USER_MODEL_ID\);/);
  assert.ok(main.indexOf('app.setAppUserModelId(') < main.indexOf("app.on('ready'"), 'set before the app is ready');
});
