/**
 * Run: npx tsx --test src/dashboard/console-plugin-routes.test.ts
 *
 * Functional smoke for the plugin cartridge console routes: GET list serves
 * the CARTRIDGE shape (the legacy JS-tool route moved to /custom-tools),
 * preview accepts raw archive bytes AND {url}, install consumes a previewed
 * upload token, expired/unknown tokens 404, and lifecycle actions work.
 * Offline (URL test uses a local http server), deterministic, temp home.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-plugin-routes-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { registerConsoleRoutes } = await import('./console-routes.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

function buildClemplug(id: string): string {
  const src = mkdtempSync(path.join(os.tmpdir(), 'clemplug-fixture-'));
  writeFileSync(path.join(src, 'plugin.json'), JSON.stringify({ id, name: 'Route Pack', version: '1.0.0' }));
  mkdirSync(path.join(src, 'skills', 'route-skill'), { recursive: true });
  writeFileSync(path.join(src, 'skills', 'route-skill', 'SKILL.md'), '---\nname: route-skill\ndescription: test\n---\n\nBody.');
  mkdirSync(path.join(src, 'memory'), { recursive: true });
  writeFileSync(path.join(src, 'memory', 'fact.md'), '---\nname: route-fact\ntype: reference\ndescription: routes remember this\n---\n');
  const archive = path.join(src, '..', `${path.basename(src)}.clemplug`);
  execFileSync('tar', ['-czf', archive, '-C', src, '.'], { stdio: 'pipe' });
  return archive;
}

async function boot(authorized = { v: true }) {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => authorized.v, {} as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const s = createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

interface PreviewBody {
  uploadToken: string;
  manifest: { id: string };
  contents: { skills: string[]; workflows: string[]; mcpServers: string[]; memoryFiles: string[] };
  consent: string[];
}
interface CatalogBody {
  items: Array<{
    id: string;
    name: string;
    installed: boolean;
    enabled?: boolean;
    contents?: { skills: number; workflows: number; mcpServers: number; memoryFiles: number };
  }>;
  sources: string[];
  warnings: string[];
}

test('cartridge routes: list shape, preview (bytes + url), install by token, lifecycle', async () => {
  const h = await boot();
  try {
    // GET serves the CARTRIDGE shape — the legacy JS-tool route no longer shadows it.
    const list = await (await fetch(`${h.url}/api/console/plugins`)).json() as { plugins: unknown[]; pluginsDir?: string };
    assert.deepEqual(list, { plugins: [] }, 'cartridge ledger shape, no legacy pluginsDir field');

    // Catalog discovery is first-class: a user can find a plugin without
    // already knowing a .clemplug URL.
    const catalog = await (await fetch(`${h.url}/api/console/plugins/catalog`)).json() as CatalogBody;
    const starter = catalog.items.find((p) => p.id === 'clementine.coach-starter-pack');
    assert.ok(starter, 'built-in starter pack is discoverable');
    assert.equal(starter!.installed, false);
    assert.deepEqual(starter!.contents, { skills: 2, workflows: 2, mcpServers: 1, memoryFiles: 3 });

    // Preview from raw bytes.
    const archive = buildClemplug('route.pack');
    const bytes = readFileSync(archive);
    const previewRes = await fetch(`${h.url}/api/console/plugins/preview?name=route.clemplug`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes,
    });
    assert.equal(previewRes.status, 200);
    const preview = await previewRes.json() as PreviewBody;
    assert.equal(preview.manifest.id, 'route.pack');
    assert.deepEqual(preview.contents.skills, ['route-skill']);
    assert.equal(preview.contents.memoryFiles.length, 1);
    assert.ok(preview.uploadToken.length >= 16);

    // Unknown token → 404, nothing installed.
    const bad = await fetch(`${h.url}/api/console/plugins/install`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadToken: 'nope' }),
    });
    assert.equal(bad.status, 404);

    // Install consumes the previewed token.
    const installRes = await fetch(`${h.url}/api/console/plugins/install`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadToken: preview.uploadToken }),
    });
    assert.equal(installRes.status, 200);
    const installed = await installRes.json() as { ok: boolean; plugin: { artifacts: Array<{ kind: string }>; memory?: { newFacts: number } } };
    assert.equal(installed.ok, true);
    assert.deepEqual(installed.plugin.artifacts.map((a) => a.kind).sort(), ['memory', 'skill']);
    assert.equal(installed.plugin.memory?.newFacts, 1);

    // Token is single-use: replay 404s.
    const replay = await fetch(`${h.url}/api/console/plugins/install`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadToken: preview.uploadToken }),
    });
    assert.equal(replay.status, 404);

    // Lifecycle actions still work.
    const disable = await fetch(`${h.url}/api/console/plugins/route.pack/disable`, { method: 'POST' });
    assert.equal((await disable.json() as { plugin: { enabled: boolean } }).plugin.enabled, false);
    const un = await fetch(`${h.url}/api/console/plugins/route.pack/uninstall`, { method: 'POST' });
    assert.equal((await un.json() as { ok: boolean }).ok, true);
    assert.deepEqual(await (await fetch(`${h.url}/api/console/plugins`)).json(), { plugins: [] });

    // Preview from URL: serve the archive over local http (loopback http is allowed).
    const fileServer: Server = await new Promise((resolve) => {
      const s = createServer((_req, resFile) => {
        resFile.setHeader('content-type', 'application/gzip');
        resFile.end(readFileSync(archive));
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const filePort = (fileServer.address() as AddressInfo).port;
      const urlPreview = await fetch(`${h.url}/api/console/plugins/preview`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: `http://127.0.0.1:${filePort}/route.clemplug` }),
      });
      assert.equal(urlPreview.status, 200);
      const urlBody = await urlPreview.json() as PreviewBody;
      assert.equal(urlBody.manifest.id, 'route.pack');
      assert.ok(urlBody.uploadToken);
    } finally {
      await new Promise<void>((r) => fileServer.close(() => r()));
    }

    // Preview/install directly from a catalog item, same consent/token path.
    const catalogPreviewRes = await fetch(`${h.url}/api/console/plugins/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catalogId: 'clementine.coach-starter-pack' }),
    });
    assert.equal(catalogPreviewRes.status, 200);
    const catalogPreview = await catalogPreviewRes.json() as PreviewBody;
    assert.equal(catalogPreview.manifest.id, 'clementine.coach-starter-pack');
    assert.equal(catalogPreview.contents.skills.length, 2);
    assert.equal(catalogPreview.contents.workflows.length, 2);
    const catalogInstall = await fetch(`${h.url}/api/console/plugins/install`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadToken: catalogPreview.uploadToken }),
    });
    assert.equal(catalogInstall.status, 200);
    const catalogAfterInstall = await (await fetch(`${h.url}/api/console/plugins/catalog`)).json() as CatalogBody;
    assert.equal(catalogAfterInstall.items.find((p) => p.id === 'clementine.coach-starter-pack')?.installed, true);
    const catalogUn = await fetch(`${h.url}/api/console/plugins/clementine.coach-starter-pack/uninstall`, { method: 'POST' });
    assert.equal((await catalogUn.json() as { ok: boolean }).ok, true);

    // Auth gate.
    const authorizedOff = { v: false };
    const h2 = await boot(authorizedOff);
    try {
      assert.equal((await fetch(`${h2.url}/api/console/plugins/preview`, { method: 'POST', body: Buffer.from('x') })).status, 401);
      assert.equal((await fetch(`${h2.url}/api/console/plugins/catalog`)).status, 401);
    } finally { await h2.close(); }
  } finally {
    await h.close();
  }
});
