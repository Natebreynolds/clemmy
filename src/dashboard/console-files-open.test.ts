import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-file-open-route-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.MARKITDOWN_WARM = 'off';
const { registerConsoleRoutes } = await import('./console-routes.js');
const { VAULT_DIR } = await import('../memory/vault.js');
mkdirSync(VAULT_DIR, { recursive: true });
const file = path.join(VAULT_DIR, 'report café 日本語 & notes.docx');
writeFileSync(file, 'synthetic office fixture');
test.after(() => rmSync(home, { recursive: true, force: true }));
const headers = { authorization: 'Bearer file-open-fixture' };

async function withRoute(launch: (target: string) => Promise<void>, fn: (url: string) => Promise<void>, platform: NodeJS.Platform = 'win32'): Promise<void> {
  const app = express();
  registerConsoleRoutes(app, req => req.get('authorization') === headers.authorization, {} as never, {
    serveLegacyAtRoot: false, fileOpenRuntime: { platform, launchWindowsDefaultApp: launch },
  });
  const server = await new Promise<Server>(resolve => {
    const instance = createServer(app); instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
const open = (base: string, target = file, authorized = true) => fetch(`${base}/api/console/files/open?${new URLSearchParams({ path: target })}`,
  { method: 'POST', headers: authorized ? headers : {} });

test('Windows file open keeps authorization and the exact vault boundary before dispatch', async () => {
  const dispatched: string[] = [];
  await withRoute(async target => { dispatched.push(target); }, async base => {
    assert.equal((await open(base, file, false)).status, 401);
    assert.equal((await fetch(`${base}/api/console/files/open`, { method: 'POST', headers })).status, 400);
    assert.equal((await open(base, path.join(home, 'outside.docx'))).status, 403);
    assert.equal((await open(base, path.join(VAULT_DIR, 'missing.docx'))).status, 404);
    assert.deepEqual(dispatched, []);
    const success = await open(base);
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), { ok: true });
    assert.deepEqual(dispatched, [file], 'literal Unicode, spaces and metacharacters reach dispatch unchanged');
  });
});

test('Windows file open only reports success after the awaited dispatch receipt', async () => {
  let release!: () => void;
  const receipt = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const dispatchEntered = new Promise<void>(resolve => { entered = resolve; });
  await withRoute(async () => { entered(); await receipt; }, async base => {
    let responded = false;
    const pending = open(base).then(response => { responded = true; return response; });
    await dispatchEntered;
    assert.equal(responded, false);
    release();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

test('Windows launch failure is an actionable public failure without private exception data or hollow success', async () => {
  await withRoute(async () => { throw new Error('private-token=synthetic; private target=' + file); }, async base => {
    const response = await open(base);
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.ok, undefined);
    assert.match(body.error, /did not confirm.*Check whether a window opened before retrying/);
    assert.equal(JSON.stringify(body).includes(file), false);
    assert.equal(JSON.stringify(body).includes('private-token'), false);
    const preview = await (await fetch(`${base}/api/console/files/preview?${new URLSearchParams({ path: file })}`, { headers })).json();
    assert.equal(preview.previewable, false);
    assert.match(preview.reason, /Open in default app/);
    assert.doesNotMatch(preview.reason, /Finder/);
  });
});

test('unsupported platforms retain an honest file-manager fallback without dispatch', async () => {
  await withRoute(async () => { assert.fail('unsupported host must not dispatch'); }, async base => {
    const response = await open(base);
    assert.equal(response.status, 501);
    assert.match((await response.json()).error, /open the file manually in your file manager/);
  }, 'freebsd');
});
