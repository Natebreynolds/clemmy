/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/browser-backend.test.ts
 *
 * One browser per machine: a set-up cloud browser is the browser, and local
 * Chrome is the fallback only while none is set up. Discovery, the local tool
 * lookup and the local browser itself all follow the same rule.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-browser-backend-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { browserBackendOffered } = await import('./browser-backend.js');
const { browserbaseStoreFile, browserbaseProjectSetUp } = await import('../integrations/browserbase-setup.js');
const { catalogEntries } = await import('../agents/tool-catalog.js');
const { TOOL_REGISTRY } = await import('./tool-registry.js');
const { observeReviewedLocalTool } = await import('../runtime/harness/reviewed-local-tool-transport.js');
const { executeBrowserOperation, browserOperationProvesNoMutation } = await import('../integrations/browser-operation.js');

after(() => rmSync(home, { recursive: true, force: true }));

const file = browserbaseStoreFile();
function setUpCloud(projectId = '00000000-0000-4000-8000-000000000001'): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, revision: 1, resources: [],
    policy: { projectId, idleSeconds: 300, sessionTimeoutSeconds: 1800 } }));
}
const names = () => new Set(catalogEntries().map((entry) => entry.name));
const backendTools = (backend: 'local' | 'cloud') => TOOL_REGISTRY
  .filter((tool) => tool.browserBackend === backend).map((tool) => tool.name);

test('every browser-driving tool declares its backend', () => {
  assert.ok(backendTools('local').includes('browser_open'));
  assert.ok(backendTools('local').includes('browser_harness_run'));
  assert.ok(backendTools('cloud').includes('cloud_browser_start'));
  assert.equal(TOOL_REGISTRY.find((tool) => tool.name === 'browser_skill_list')?.browserBackend, undefined,
    'a saved playbook is not tied to one browser');
});

test('with no cloud browser set up, local Chrome is the browser', () => {
  rmSync(file, { force: true });
  assert.equal(browserbaseProjectSetUp(), false);
  const offered = names();
  for (const name of backendTools('local')) assert.ok(offered.has(name), `${name} offered`);
  for (const name of backendTools('cloud')) assert.ok(!offered.has(name), `${name} hidden`);
  assert.ok(observeReviewedLocalTool('browser_open'));
  assert.equal(observeReviewedLocalTool('cloud_browser_start'), null);
});

test('with a cloud browser set up, only the cloud browser is offered or runnable', async () => {
  setUpCloud();
  try {
    assert.equal(browserBackendOffered('cloud'), true);
    assert.equal(browserBackendOffered('local'), false);
    assert.equal(browserBackendOffered(undefined), true);
    const offered = names();
    for (const name of backendTools('cloud')) assert.ok(offered.has(name), `${name} offered`);
    for (const name of backendTools('local')) assert.ok(!offered.has(name), `${name} hidden`);
    assert.ok(offered.has('browser_skill_list'));
    assert.ok(observeReviewedLocalTool('cloud_browser_start'));
    assert.equal(observeReviewedLocalTool('browser_open'), null, 'a remembered local name cannot run');

    let started = false;
    const result = await executeBrowserOperation('browser_open', {}, {
      runner: async () => { started = true; return { code: 0, stdout: '', stderr: '' }; },
    });
    assert.equal(started, false, 'local Chrome is never started');
    assert.equal(result.ok, false);
    assert.equal(browserOperationProvesNoMutation(result), true);
    assert.equal((result.receipt as { effect: string }).effect, 'none');
    assert.match(String(result.error), /cloud_browser_start/);
  } finally {
    rmSync(file, { force: true });
  }
});

test('a store without a valid project leaves local Chrome as the browser', () => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, revision: 0, resources: [], policy: null }));
  try {
    assert.equal(browserBackendOffered('local'), true);
    setUpCloud('not-a-project');
    assert.equal(browserBackendOffered('local'), true);
  } finally {
    rmSync(file, { force: true });
  }
});
