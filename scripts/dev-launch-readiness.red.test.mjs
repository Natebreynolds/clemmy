import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const devUp = readFileSync(new URL('./dev-up.sh', import.meta.url), 'utf8');
const devDown = readFileSync(new URL('./dev-down.sh', import.meta.url), 'utf8');
const routes = readFileSync(new URL('../src/dashboard/console-routes.ts', import.meta.url), 'utf8');

test('dev launch verifies a fast build endpoint and requires Discord when requested', () => {
  assert.match(devUp, /\/api\/console\/build-info/);
  assert.doesNotMatch(devUp, /\/api\/console\/health/);
  assert.match(devUp, /Discord did not report ready[\s\S]{0,200}exit 1/);
  assert.ok(devUp.lastIndexOf('DEV_LAUNCH_VERIFIED=true') > devUp.indexOf('Discord did not report ready'));
  assert.match(routes, /getBuildInfo\(\)/);
});

test('dev lifecycle never kills an unverified process by a broad argv or port match', () => {
  for (const script of [devUp, devDown]) {
    assert.doesNotMatch(script, /pkill -f "src\/index\.ts daemon --foreground"/);
    assert.doesNotMatch(script, /kill \$STALE_PIDS/);
  }
});

test('dev launch bounds the installed-app quit and treats a zombie daemon as stopped', () => {
  assert.match(devUp, /quit_installed_app_bounded/);
  assert.match(devUp, /osascript[\s\S]{0,800}kill -9 "\$quit_pid"/);
  assert.match(devUp, /owned_state=.*ps -p "\$owned_pid" -o state=/);
  assert.match(devUp, /case "\$owned_state" in ""\|Z\*\) break/);
});
