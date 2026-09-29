/**
 * Run: node scripts/run-tests-isolated.mjs src/projects/local-pages.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { deflateSync } from 'node:zlib';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-local-pages-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const projects = await import('./project-record.js');
const local = await import('./local-projects.js');
const pages = await import('./local-pages.js');
const views = await import('./project-views.js');
const routes = await import('./project-routes.js');
const { recordDeliverable } = await import('../memory/deliverable-index.js');
const { closeEventLog } = await import('../runtime/harness/eventlog.js');

after(() => {
  local._setLocalProjectsForTests(null);
  routes._setPageRendererForTests(null);
  routes._setPageOpenerForTests(null);
  projects._closeProjectStoreForTests();
  closeEventLog();
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

const WORK = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'clem-local-pages-work-')));
after(() => { try { rmSync(WORK, { recursive: true, force: true }); } catch { /* best effort */ } });
function write(relative: string, content = '<!doctype html><title>x</title>'): string {
  const file = path.join(WORK, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return file;
}
const made = (file: string, at: string, sessionId: string | null = null) =>
  recordDeliverable({ kind: 'file', target: file, sessionId, lane: 'local', at });

const audits = path.join(WORK, 'audits');
const auditsOld = path.join(WORK, 'audits-old');
local._setLocalProjectsForTests(() => [
  { name: 'audits', path: audits, type: 'node', description: '', git: false },
  { name: 'audits-old', path: auditsOld, type: 'node', description: '', git: false },
]);

function project(name: string): string {
  const saved = projects.createProject({ name, createdFrom: 'console' });
  assert.ok(saved.ok);
  return saved.project.id;
}
function link(projectId: string, folder: string): string {
  const saved = projects.saveResource(projectId, { kind: 'folder', label: path.basename(folder), ref: folder });
  assert.ok(saved.ok, JSON.stringify(saved));
  return saved.resource.id;
}

type Handler = (req: any, res: any) => void | Promise<void>;
function surface(origin: 'console' | 'phone') {
  const table: Array<{ method: string; keys: string[]; pattern: RegExp; handler: Handler }> = [];
  routes.registerProjectRecordRoutes({
    add: (method, routePath, handler) => {
      const keys: string[] = [];
      const pattern = new RegExp(`^${routePath.replace(/:([A-Za-z]+)/g, (_m, key) => { keys.push(key); return '([^/]+)'; })}$`);
      table.push({ method, keys, pattern, handler });
    },
    projects: '/p', tasks: '/t', sessions: '/s', agents: '/a', memory: '/m', origin,
    surfaceName: origin === 'phone' ? 'the phone' : 'the desktop',
  });
  return async (method: 'get' | 'post', url: string, options: { from?: string } = {}) => {
    const [pathname, search = ''] = url.split('?');
    for (const route of table) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(pathname!);
      if (!match) continue;
      const params = Object.fromEntries(route.keys.map((key, index) => [key, decodeURIComponent(match[index + 1]!)]));
      const answer = { status: 200, headers: {} as Record<string, string>, body: undefined as any };
      const res = {
        headersSent: false,
        status(code: number) { answer.status = code; return res; },
        setHeader(name: string, value: string) { answer.headers[name.toLowerCase()] = value; return res; },
        json(value: unknown) { answer.body = value; res.headersSent = true; return res; },
        send(value: unknown) { answer.body = value; res.headersSent = true; return res; },
      };
      await route.handler({ params, query: Object.fromEntries(new URLSearchParams(search)), body: {}, socket: { remoteAddress: options.from ?? '127.0.0.1' } }, res);
      return answer;
    }
    return { status: 404, headers: {}, body: { error: 'NO_ROUTE' } };
  };
}

/** A PNG of one colour or of two, each row stored under the asked filter. */
function png(width: number, height: number, filter: 0 | 1 | 2 | 3 | 4, colourAt: (x: number, y: number) => [number, number, number]): Buffer {
  const channels = 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  let above = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const line = Buffer.alloc(stride);
    for (let x = 0; x < width; x += 1) line.set(colourAt(x, y), x * channels);
    raw[y * (stride + 1)] = filter;
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? line[index - channels]! : 0;
      const up = above[index]!;
      const upLeft = index >= channels ? above[index - channels]! : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const a = Math.abs(estimate - left), b = Math.abs(estimate - up), c = Math.abs(estimate - upLeft);
        predicted = a <= b && a <= c ? left : b <= c ? up : upLeft;
      }
      raw[y * (stride + 1) + 1 + index] = (line[index]! - predicted) & 0xff;
    }
    above = line;
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii');
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('a page is one the work recorded writing, inside a folder the owner linked', () => {
  const id = project('Pages Listed');
  link(id, audits);
  const brief = write('audits/harbor-brief/index.html');
  const second = write('audits/second-brief/index.html');
  made(brief, '2026-09-29T10:00:00.000Z', 'sess-one');
  made(second, '2026-09-29T11:00:00.000Z');
  // None of these is a page of this project.
  made(write('audits/harbor-brief/research/data.json', '{}'), '2026-09-29T12:00:00.000Z');
  made(write('audits/.claude/context/template.html'), '2026-09-29T12:01:00.000Z');
  made(write('audits-old/old-brief/index.html'), '2026-09-29T12:02:00.000Z');
  made(write('elsewhere/index.html'), '2026-09-29T12:03:00.000Z');
  write('audits/not-recorded/index.html');
  made(path.join(audits, 'gone/index.html'), '2026-09-29T12:04:00.000Z');
  const outside = write('secret-notes/plan.html');
  symlinkSync(outside, path.join(audits, 'harbor-brief', 'linked-out.html'));
  made(path.join(audits, 'harbor-brief', 'linked-out.html'), '2026-09-29T12:05:00.000Z');

  const listed = pages.pagesMadeInProject(id);
  assert.deepEqual(listed.map((page) => [page.name, page.folder, page.relativePath, page.localProject.name, page.sessionId]), [
    ['index.html', 'second-brief', 'second-brief/index.html', 'audits', null],
    ['index.html', 'harbor-brief', 'harbor-brief/index.html', 'audits', 'sess-one'],
  ]);
  assert.match(listed[0]!.id, /^pg_[a-f0-9]{24}$/);
  assert.notEqual(listed[0]!.id, listed[1]!.id);
  assert.deepEqual(views.projectOverview(id)!.pages, listed, 'the project overview carries the same list');
  assert.deepEqual(pages.pagesMadeInProject(project('Pages Of Nothing')), [], 'a project with no linked folder has no pages');
  assert.deepEqual(pages.pagesMadeInProject('prj_does_not_exist'), []);
});

test('a page is found again each time it is read', () => {
  const id = project('Pages Read');
  const resource = link(id, audits);
  const file = write('audits/read-brief/index.html', '<!doctype html><h1>Read</h1>');
  made(file, '2026-09-29T13:00:00.000Z');
  const page = pages.pagesMadeInProject(id).find((row) => row.folder === 'read-brief')!;
  const read = pages.pageOfProject(id, page.id);
  assert.ok(read.ok);
  assert.equal(pages.readPageDocument(read.file), '<!doctype html><h1>Read</h1>');
  assert.deepEqual(pages.pageOfProject(id, 'pg_000000000000000000000000'), { ok: false, reason: 'not_found' });
  assert.deepEqual(pages.pageOfProject(project('Pages Of Another'), page.id), { ok: false, reason: 'not_found' }, 'another project cannot read it by its id');

  const large = write('audits/large-brief/index.html', 'x'.repeat(pages.LARGEST_PAGE_BYTES + 1));
  made(large, '2026-09-29T13:01:00.000Z');
  const largePage = pages.pagesMadeInProject(id).find((row) => row.folder === 'large-brief')!;
  const tooLarge = pages.pageOfProject(id, largePage.id);
  assert.equal(tooLarge.ok, false);
  assert.equal(!tooLarge.ok && tooLarge.reason, 'too_large');

  assert.equal(projects.removeResource(id, resource), true);
  assert.deepEqual(pages.pagesMadeInProject(id), [], 'unlinking the folder unlists its pages');
  assert.deepEqual(pages.pageOfProject(id, page.id), { ok: false, reason: 'not_found' });
});

test('a framed page has no origin and can call nothing', () => {
  const policy = pages.localPageContentPolicy();
  const directive = (name: string) => policy.split('; ').find((part) => part.startsWith(`${name} `) || part === name) ?? '';
  assert.equal(directive('sandbox'), 'sandbox allow-scripts', 'no same-origin, forms, popups or navigation');
  assert.equal(directive('default-src'), "default-src 'none'");
  assert.equal(directive('connect-src'), "connect-src 'none'");
  assert.equal(directive('form-action'), "form-action 'none'");
  assert.equal(directive('frame-src'), "frame-src 'none'");
  assert.equal(directive('frame-ancestors'), "frame-ancestors 'self'");
  assert.equal(directive('base-uri'), "base-uri 'none'");
  assert.equal(directive('script-src'), "script-src 'unsafe-inline' https:", 'its own scripts and public libraries');
  const sources = policy.split('; ').filter((part) => !part.startsWith('frame-ancestors ')).join('; ');
  assert.ok(!/http:|'self'|\*/.test(sources), 'nothing on this machine and nothing unencrypted is named as a source');
});

test('the end of a page is a part that shows one colour, under any row filter', () => {
  for (const filter of [0, 1, 2, 3, 4] as const) {
    assert.equal(pages.pageImageIsBlank(png(7, 5, filter, () => [10, 20, 30])), true, `one colour, filter ${filter}`);
    assert.equal(pages.pageImageIsBlank(png(7, 5, filter, (x, y) => (x === 6 && y === 4 ? [10, 20, 31] : [10, 20, 30]))), false, `one pixel differs, filter ${filter}`);
    assert.equal(pages.pageImageIsBlank(png(7, 5, filter, (x) => (x === 0 ? [0, 0, 0] : [255, 255, 255]))), false, `a first column differs, filter ${filter}`);
  }
  assert.equal(pages.pageImageIsBlank(Buffer.from('not an image')), false);
  assert.equal(pages.pageImageIsBlank(Buffer.alloc(0)), false);
});

test('both surfaces list pages and get them rendered; only the desktop is given the document or opens it', async () => {
  const desktop = surface('console');
  const phone = surface('phone');
  const id = project('Pages Served');
  link(id, path.join(WORK, 'served'));
  const file = write('served/served-brief/index.html', '<!doctype html><script>fetch("/api")</script><h1>Served</h1>');
  made(file, '2026-09-29T14:00:00.000Z');
  const asked: unknown[] = [];
  routes._setPageRendererForTests(async (input) => {
    asked.push(input);
    const blank = (input.offsetY ?? 0) >= 4000;
    return { ok: true, png: png(4, 4, 0, (x) => (blank || x > 0 ? [250, 250, 250] : [0, 0, 0])), width: input.width ?? 1440, height: input.height ?? 1100, offsetY: input.offsetY ?? 0 };
  });
  const opened: string[] = [];
  routes._setPageOpenerForTests((target) => { opened.push(target); return { ok: true }; });

  const listed = await phone('get', `/p/${id}/pages`);
  assert.deepEqual([listed.status, listed.body.pages.map((page: any) => page.folder)], [200, ['served-brief']]);
  assert.deepEqual((await desktop('get', `/p/${id}/pages`)).body.pages, listed.body.pages);
  assert.equal((await desktop('get', '/p/prj_does_not_exist/pages')).status, 404);
  const pageId = listed.body.pages[0].id as string;

  const top = await phone('get', `/p/${id}/pages/${pageId}/image?width=390&height=1600&offset=0`);
  assert.deepEqual([top.status, top.body.mimeType, top.body.width, top.body.height, top.body.offsetY, top.body.end], [200, 'image/png', 390, 1600, 0, false]);
  assert.ok(Buffer.from(top.body.image, 'base64').subarray(0, 4).equals(Buffer.from('89504e47', 'hex')));
  assert.equal(top.headers['cache-control'], 'no-store');
  const past = await phone('get', `/p/${id}/pages/${pageId}/image?width=390&height=1600&offset=4800`);
  assert.equal(past.body.end, true, 'a part below the page says it is the end');
  const clamped = await desktop('get', `/p/${id}/pages/${pageId}/image?width=99999&height=1&offset=-5`);
  assert.deepEqual([clamped.body.width, clamped.body.height, clamped.body.offsetY], [2000, 480, 0]);
  assert.deepEqual(asked.map((input: any) => input.file), [realpathSync(file), realpathSync(file), realpathSync(file)], 'the file rendered is the one found from the project');
  assert.equal((await phone('get', `/p/${id}/pages/pg_000000000000000000000000/image`)).status, 404);
  routes._setPageRendererForTests(async () => ({ ok: false, reason: 'no browser' }));
  const failed = await phone('get', `/p/${id}/pages/${pageId}/image`);
  assert.deepEqual([failed.status, failed.body.error, failed.body.message], [503, 'PAGE_NOT_RENDERED', 'no browser']);

  const document = await desktop('get', `/p/${id}/pages/${pageId}/document`);
  assert.equal(document.status, 200);
  assert.equal(document.body, '<!doctype html><script>fetch("/api")</script><h1>Served</h1>', 'the document is sent as it is on disk');
  assert.equal(document.headers['content-security-policy'], pages.localPageContentPolicy());
  assert.equal(document.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(document.headers['x-content-type-options'], 'nosniff');
  assert.equal((await desktop('get', `/p/${id}/pages/${pageId}/document`, { from: '192.0.2.10' })).status, 403, 'only this machine is answered');
  assert.equal((await phone('get', `/p/${id}/pages/${pageId}/document`)).status, 404, 'the phone is never sent a document to run');

  const open = await desktop('post', `/p/${id}/pages/${pageId}/open`);
  assert.deepEqual([open.status, open.body.ok, opened], [200, true, [realpathSync(file)]]);
  assert.equal((await desktop('post', `/p/${id}/pages/${pageId}/open`, { from: '192.0.2.10' })).status, 403);
  assert.equal((await phone('post', `/p/${id}/pages/${pageId}/open`)).status, 404, 'a phone cannot open a window on the Mac');
  assert.equal((await desktop('post', `/p/${id}/pages/pg_000000000000000000000000/open`)).status, 404);
  assert.equal(opened.length, 1);
});
