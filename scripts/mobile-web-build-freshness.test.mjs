import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const smoke = readFileSync(new URL('./smoke-mobile-pwa.mjs', import.meta.url), 'utf8');
const devUp = readFileSync(new URL('./dev-up.sh', import.meta.url), 'utf8');

test('mobile PWA smoke always rebuilds instead of trusting an existing dist', () => {
  assert.doesNotMatch(smoke, /if \(!existsSync\(path\.join\(PWA_DIST, 'index\.html'\)\)\)/);
  const buildAt = smoke.indexOf("spawnSync('npm', ['run', 'build']");
  const serveAt = smoke.indexOf('const child = spawn(');
  assert.ok(buildAt >= 0, 'smoke does not rebuild mobile-web');
  assert.ok(serveAt > buildAt, 'smoke starts the daemon before rebuilding mobile-web');
  assert.match(smoke, /build failed or did not emit dist\/index\.html/);
});

test('dev-up rebuilds and freshness-checks mobile dist before starting source daemon', () => {
  const buildAt = devUp.indexOf('npm run build:mobile-web');
  const freshnessAt = devUp.indexOf('MOBILE_WEB_INDEX_MTIME');
  const serveAt = devUp.indexOf('node --import tsx src/index.ts daemon start');
  assert.ok(buildAt >= 0, 'dev-up does not rebuild mobile-web');
  assert.ok(freshnessAt > buildAt, 'dev-up does not assert the emitted index freshness');
  assert.ok(serveAt > freshnessAt, 'dev-up can serve before mobile dist is fresh');
});
