import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROUTES = readFileSync(new URL('./console-routes.ts', import.meta.url), 'utf8');

test('console settings expose Jev connect/status without putting Jev in brain pickers', () => {
  assert.match(ROUTES, /jev: await getJevStatus\(\)/);
  assert.match(ROUTES, /app\.get\('\/api\/console\/jev'/);
  assert.match(ROUTES, /app\.post\('\/api\/console\/jev'/);
  assert.match(ROUTES, /connectJevKey\(apiKey\)/);
  assert.doesNotMatch(ROUTES, /brain.*jev-latest|jev-latest.*brain/);
});

test('POST /api/console/jev authorizes before connectJevKey', () => {
  const start = ROUTES.indexOf("app.post('/api/console/jev'");
  assert.ok(start >= 0);
  const chunk = ROUTES.slice(start, start + 500);
  assert.match(chunk, /isAuthorized\(req\)/);
  assert.ok(chunk.indexOf('isAuthorized') < chunk.indexOf('connectJevKey'));
});
