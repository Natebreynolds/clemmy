/**
 * Run: node scripts/run-tests-isolated.mjs src/projects/session-files.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-session-files-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(HOME, 'state'), { recursive: true });

const files = await import('./session-files.js');
const routes = await import('./project-routes.js');
const projects = await import('./project-record.js');
const { recordDeliverable } = await import('../memory/deliverable-index.js');
const events = await import('../runtime/harness/eventlog.js');

const WORK = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'clem-session-files-work-')));
after(() => {
  routes._setPageOpenerForTests(null);
  projects._closeProjectStoreForTests();
  events.closeEventLog();
  for (const dir of [HOME, WORK]) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

let serial = 0;
function write(relative: string, content: string | Buffer = '# Draft\n\nHello.'): string {
  const file = path.join(WORK, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}
function chat(metadata: Record<string, unknown> = {}): string {
  return events.createSession({ id: `files-chat-${++serial}`, kind: 'chat', metadata }).id;
}
const saved = (file: string, sessionId: string) => recordDeliverable({ kind: 'file', target: file, sessionId, lane: 'local' });

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
      const answer = { status: 200, body: undefined as any };
      const res = {
        headersSent: false,
        status(code: number) { answer.status = code; return res; },
        setHeader() { return res; },
        json(value: unknown) { answer.body = value; res.headersSent = true; return res; },
        send(value: unknown) { answer.body = value; res.headersSent = true; return res; },
      };
      await route.handler({ params, query: Object.fromEntries(new URLSearchParams(search)), body: {}, socket: { remoteAddress: options.from ?? '127.0.0.1' } }, res);
      return answer;
    }
    return { status: 404, body: { error: 'NO_ROUTE' } };
  };
}

test('a card opens the file its own conversation saved, in a project folder or anywhere it wrote', async () => {
  const session = chat();
  const draft = write('proposal/client-brief/outreach-draft.md', '# Outreach\n\n- Gift idea\n');
  saved(draft, session);
  const found = files.readSessionFile(session, 'outreach-draft.md', 'client-brief');
  assert.ok(found.ok);
  assert.equal(found.file, draft);
  assert.equal(found.view.kind, 'markdown');
  assert.equal(found.view.text, '# Outreach\n\n- Gift idea\n');
  assert.equal(found.view.openable, true);
  assert.equal(found.view.folder, 'client-brief');
  const desk = surface('console');
  const answer = await desk('get', `/s/harness:${session}/file?name=outreach-draft.md&folder=client-brief`);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.file.text, '# Outreach\n\n- Gift idea\n');
  const phone = await surface('phone')('get', `/s/${session}/file?name=outreach-draft.md&folder=client-brief`);
  assert.equal(phone.body.file.openable, false, 'the phone reads it but cannot open it on the Mac');
});

test('another conversation\'s file, an unrecorded file, a sensitive file and an ambiguous name are never shown', async () => {
  const mine = chat(); const theirs = chat();
  saved(write('other/notes/plan.md'), theirs);
  assert.equal(files.fileSavedBySession(mine, 'plan.md', 'notes'), null, 'another conversation wrote it');
  write('loose/unrecorded.md');
  assert.equal(files.fileSavedBySession(mine, 'unrecorded.md', 'loose'), null, 'nothing recorded writing it');
  saved(write('keys/.env', 'TOKEN=x'), mine);
  assert.equal(files.fileSavedBySession(mine, '.env', 'keys'), null, 'sensitive by the security rules');
  saved(write('a/same/report.md'), mine);
  saved(write('b/same/report.md'), mine);
  assert.equal(files.fileSavedBySession(mine, 'report.md', 'same'), null, 'two files answer to the card');
  assert.equal(files.fileSavedBySession(mine, '../a/same/report.md', 'same'), null, 'a name is never a path');
  const answer = await surface('console')('get', `/s/${mine}/file?name=plan.md&folder=notes`);
  assert.equal(answer.status, 404);
  assert.equal(answer.body.error, 'FILE_NOT_FOUND');
});

test('a recorded file that is a link to another file is never shown', () => {
  const session = chat();
  const secret = write('secrets/credentials.json', '{"secret":1}');
  const link = path.join(WORK, 'drafts/innocent.md');
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(secret, link);
  saved(link, session);
  assert.equal(files.fileSavedBySession(session, 'innocent.md', 'drafts'), null);
});

test('files saved in a branch of the conversation and by its workers are its own', () => {
  const root = chat();
  const branch = chat({ channelId: root });
  const worker = chat();
  events.appendEvent({ sessionId: branch, turn: 0, role: 'system', type: 'worker_started', data: { childSessionId: worker } });
  saved(write('branch/out/branch-note.md'), branch);
  saved(write('worker/out/worker-note.csv', 'a,b\n1,2\n'), worker);
  assert.ok(files.fileSavedBySession(root, 'branch-note.md', 'out'));
  const sheet = files.readSessionFile(root, 'worker-note.csv', 'out');
  assert.ok(sheet.ok);
  assert.equal(sheet.view.kind, 'text');
  assert.ok(files.fileSavedBySession(branch, 'worker-note.csv', 'out'), 'a branch reaches its root\'s workers too');
});

test('large text is cut for the panel, binary text is a file, pictures come as pictures', async () => {
  const session = chat();
  saved(write('big/log/run.log', 'x'.repeat(files.LARGEST_SHOWN_TEXT_BYTES + 10)), session);
  const big = files.readSessionFile(session, 'run.log', 'log');
  assert.ok(big.ok);
  assert.equal(big.view.truncated, true);
  assert.equal(big.view.text?.length, files.LARGEST_SHOWN_TEXT_BYTES);
  saved(write('bin/data/blob.txt', Buffer.from([0x41, 0x00, 0x42])), session);
  const blob = files.readSessionFile(session, 'blob.txt', 'data');
  assert.ok(blob.ok);
  assert.equal(blob.view.kind, 'other');
  assert.equal(blob.view.text, undefined);
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  saved(write('img/shots/hero.png', png), session);
  const desk = surface('console');
  const image = await desk('get', `/s/${session}/file/image?name=hero.png&folder=shots`);
  assert.equal(image.status, 200);
  assert.equal(image.body.mimeType, 'image/png');
  assert.equal(Buffer.from(image.body.image, 'base64').toString('hex'), '89504e470d0a1a0a');
  const notImage = await desk('get', `/s/${session}/file/image?name=run.log&folder=log`);
  assert.equal(notImage.status, 415);
});

test('only the desktop on this machine opens a file, and never a script', async () => {
  const session = chat();
  saved(write('open/docs/brief.md'), session);
  saved(write('open/tools/run.command', '#!/bin/sh\necho hi\n'), session);
  const opened: string[] = [];
  routes._setPageOpenerForTests((file) => { opened.push(file); return { ok: true }; });
  const desk = surface('console');
  assert.equal((await desk('post', `/s/${session}/file/open?name=brief.md&folder=docs`, { from: '10.0.0.5' })).status, 403);
  assert.equal((await desk('post', `/s/${session}/file/open?name=run.command&folder=tools`)).status, 415);
  const ok = await desk('post', `/s/${session}/file/open?name=brief.md&folder=docs`);
  assert.equal(ok.status, 200);
  assert.deepEqual(opened, [path.join(WORK, 'open/docs/brief.md')]);
  assert.equal((await surface('phone')('post', `/s/${session}/file/open?name=brief.md&folder=docs`)).status, 404, 'the phone has no open route');
});
