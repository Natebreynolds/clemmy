/**
 * Run: node scripts/run-tests-isolated.mjs src/projects/session-files.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { parse, type DefaultTreeAdapterTypes as Html } from 'parse5';

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
      const answer = { status: 200, body: undefined as any, headers: {} as Record<string, string> };
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
    return { status: 404, body: { error: 'NO_ROUTE' }, headers: {} as Record<string, string> };
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
  assert.deepEqual(files.listSessionFiles(root).map(file => file.name).sort(), ['branch-note.md', 'worker-note.csv']);
});

test('project results include exact conversations and their recorded workers, never sibling projects or guessed names', () => {
  const origin = chat({ projectId: 'project-results-a' });
  const sibling = chat({ channelId: origin, projectId: 'project-results-b' });
  const worker = events.createSession({ id: 'result-worker', kind: 'agent',
    metadata: { source: 'delegated_worker', workerScope: true, parentSessionId: origin } }).id;
  const nested = events.createSession({ id: 'result-worker-nested', kind: 'agent',
    metadata: { source: 'delegated_worker', workerScope: true, parentSessionId: worker } }).id;
  const unrelated = chat();
  for (const [parent, child] of [[origin, worker], [worker, nested], [nested, worker]]) {
    events.appendEvent({ sessionId: parent!, turn: 0, role: 'system', type: 'worker_started', data: { childSessionId: child } });
  }
  events.appendEvent({ sessionId: origin, turn: 0, role: 'assistant', type: 'worker_started', data: { childSessionId: unrelated } });
  for (const session of [origin, sibling, worker, nested, unrelated]) {
    saved(write(`project-results/${session}/report.html`, `<p>${session}</p>`), session);
  }
  const result = files.deliveredGroupsForSessionQuery(50, origin);
  assert.ok(result.ok);
  assert.deepEqual(result.groups.map(group => group.sessionId).sort(), [origin, worker, nested].sort());
  assert.ok(result.groups.every(group => group.conversationSessionId === origin));
  for (const artifact of result.groups.flatMap(group => group.artifacts)) {
    const ref = artifact.fileRef;
    assert.ok(ref);
    assert.equal(artifact.conversationSessionId, origin);
    const opened = files.readSessionFile(ref.sessionId, ref.name, ref.folder, ref.fileId);
    assert.ok(opened.ok);
    assert.equal(opened.view.text, `<p>${ref.sessionId}</p>`);
  }
  const empty = files.deliveredGroupsForSessionQuery(50, 'no-recorded-project-conversation');
  assert.deepEqual(empty, { ok: true, groups: [] });
});

test('delivered scope rejects unbounded, malformed or explicitly empty queries without global fallback', () => {
  for (const invalid of ['', 'a,,b', ['a', 'b'], { id: 'a' }, 'a'.repeat(161), 'a'.repeat(8001), 'a\u0000b',
    Array.from({ length: 51 }, (_, i) => `scope-${i}`).join(',')]) {
    assert.deepEqual(files.deliveredGroupsForSessionQuery(50, invalid), { ok: false, error: 'invalid_session_ids' });
  }
});

test('source links require a known conversation or unambiguous recorded worker ancestry', () => {
  const origin = chat(); const other = chat();
  const legacy = events.createSession({ id: 'legacy-result-worker', kind: 'agent' }).id;
  const ambiguous = events.createSession({ id: 'ambiguous-result-worker', kind: 'agent' }).id;
  const orphan = 'durable-result-owner-without-session-history';
  for (const [parent, child] of [[origin, legacy], [origin, ambiguous], [other, ambiguous]]) {
    events.appendEvent({ sessionId: parent!, turn: 0, role: 'system', type: 'worker_started', data: { childSessionId: child } });
  }
  for (const session of [legacy, ambiguous, orphan]) saved(write(`source-links/${session}/brief.pdf`, '%PDF-1.7\n'), session);
  const result = files.deliveredGroupsForSessionQuery(50, [legacy, ambiguous, orphan].join(','));
  assert.ok(result.ok);
  for (const group of result.groups) {
    assert.equal(group.conversationSessionId, group.sessionId === legacy ? origin : null);
    assert.ok(group.artifacts[0]?.fileRef, 'durable file access does not require surviving session telemetry');
    assert.equal(group.artifacts[0]?.conversationSessionId, group.conversationSessionId);
  }
});

test('large text is cut for the panel, binary text is a file, pictures come as pictures', async () => {
  const session = chat();
  saved(write('big/log/run.log', 'x'.repeat(files.LARGEST_SHOWN_TEXT_BYTES + 10)), session);
  const big = files.readSessionFile(session, 'run.log', 'log');
  assert.ok(big.ok);
  assert.equal(big.view.truncated, true);
  assert.equal(big.view.text?.length, files.LARGEST_SHOWN_TEXT_BYTES);
  saved(write('big/html/long.html', '<p>' + 'x'.repeat(files.LARGEST_SHOWN_TEXT_BYTES)), session);
  const html = files.readSessionFile(session, 'long.html', 'html');
  assert.ok(html.ok);
  assert.equal(html.view.kind, 'html');
  assert.equal(html.view.truncated, true);
  assert.equal(html.view.text?.length, files.LARGEST_SHOWN_TEXT_BYTES);
  saved(write('bin/data/blob.txt', Buffer.from([0x41, 0x00, 0x42])), session);
  const blob = files.readSessionFile(session, 'blob.txt', 'data');
  assert.ok(blob.ok);
  assert.equal(blob.view.kind, 'other');
  assert.equal(blob.view.text, undefined);
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  saved(write('img/shots/hero.png', png), session);
  const desk = surface('console');
  const htmlPreview = await desk('get', `/s/${session}/file/content?name=long.html&folder=html`);
  assert.equal(htmlPreview.body.toString(), html.view.previewHtml, 'inline HTML follows the same bounded preview as metadata');
  const htmlDownload = await desk('get', `/s/${session}/file/content?name=long.html&folder=html&download=1`);
  assert.equal(htmlDownload.body.length, files.LARGEST_SHOWN_TEXT_BYTES + 3, 'download still includes the original HTML beyond the preview boundary');
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

test('the file list exposes every saved artifact with an id, including duplicate names, without embedding content', async () => {
  const session = chat(); const other = chat();
  const first = write('list/first/same/draft.html', '<h1>First</h1>');
  const second = write('list/second/same/draft.html', '<h1>Second</h1>');
  saved(first, session); saved(second, session);
  saved(write('list/private/theirs.pdf', '%PDF-1.7'), other);
  saved(write('list/hidden/.env', 'SECRET=hidden'), session);
  const removed = write('list/gone/deleted.txt'); saved(removed, session); rmSync(removed);
  const desk = surface('console');
  const answer = await desk('get', `/s/harness:${session}/files`);
  assert.equal(answer.status, 200);
  assert.equal(answer.headers['cache-control'], 'no-store');
  assert.equal(answer.body.files.length, 2);
  const listed = answer.body.files as import('./session-files.js').SessionFileView[];
  assert.equal(new Set(listed.map(file => file.fileId)).size, 2);
  for (const file of listed) {
    assert.match(file.fileId, /^sf_[a-f0-9]{64}$/);
    assert.equal(file.name, 'draft.html');
    assert.equal(file.folder, 'same');
    assert.equal(file.kind, 'html');
    assert.equal(file.text, undefined);
    const opened = await desk('get', `/s/${session}/file?fileId=${file.fileId}`);
    assert.equal(opened.status, 200);
    assert.equal(opened.body.file.fileId, file.fileId);
    assert.ok(['<h1>First</h1>', '<h1>Second</h1>'].includes(opened.body.file.text));
  }
  assert.equal((await desk('get', `/s/${session}/file?name=draft.html&folder=same`)).status, 404, 'old ambiguous cards still fail closed');
  assert.equal((await desk('get', `/s/${session}/file?fileId=${listed[0]!.fileId}&name=wrong.html`)).status, 404);
  assert.equal((await desk('get', `/s/${session}/file?fileId=unknown&name=draft.html&folder=same`)).status, 404);
  assert.equal((await desk('get', `/s/${other}/file/content?fileId=${listed[0]!.fileId}`)).status, 404, 'ids never expand conversation scope');
  const phone = await surface('phone')('get', `/s/${session}/files`);
  assert.ok(phone.body.files.every((file: { openable: boolean }) => !file.openable));
});

test('HTML previews are static, PDF bytes remain intact, and downloads have safe filenames on both surfaces', async () => {
  const session = chat();
  const html = '<!doctype html><script>fetch("/api/console/settings")</script><h1>Email draft</h1>';
  const pdf = Buffer.from('%PDF-1.7\n\x00\xff\n%%EOF', 'latin1');
  saved(write('preview/out/email.html', html), session);
  saved(write('preview/out/brief.pdf', pdf), session);
  saved(write('preview/out/résumé "final".zip', Buffer.from([0x50, 0x4b, 0x03, 0x04])), session);
  for (const origin of ['console', 'phone'] as const) {
    const get = surface(origin);
    const info = await get('get', `/s/${session}/file?name=email.html&folder=out`);
    assert.equal(info.body.file.kind, 'html');
    assert.equal(info.body.file.text, html);
    assert.equal(typeof info.body.file.previewHtml, 'string');
    assert.doesNotMatch(info.body.file.previewHtml, /<script/i);
    const email = await get('get', `/s/${session}/file/content?fileId=${info.body.file.fileId}`);
    assert.equal(email.status, 200);
    assert.equal(email.body.toString(), info.body.file.previewHtml);
    assert.equal(email.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(email.headers['x-content-type-options'], 'nosniff');
    assert.equal(email.headers['cache-control'], 'no-store');
    assert.match(email.headers['content-security-policy']!, /^sandbox;/);
    assert.match(email.headers['content-security-policy']!, /script-src 'none'/);
    assert.match(email.headers['content-security-policy']!, /connect-src 'none'/);
    assert.doesNotMatch(email.headers['content-security-policy']!, /allow-scripts|allow-same-origin/);
    const original = await get('get', `/s/${session}/file/content?fileId=${info.body.file.fileId}&download=1`);
    assert.equal(original.body.toString(), html, 'download retains the original document including its source');
    assert.match(original.headers['content-disposition']!, /^attachment;/);
    const document = await get('get', `/s/${session}/file?name=brief.pdf&folder=out`);
    assert.equal(document.body.file.kind, 'pdf');
    assert.equal(document.body.file.text, undefined);
    assert.equal(document.body.file.previewHtml, undefined);
    const content = await get('get', `/s/${session}/file/content?name=brief.pdf&folder=out`);
    assert.deepEqual(content.body, pdf);
    assert.equal(content.headers['content-type'], 'application/pdf');
    assert.match(content.headers['content-disposition']!, /^inline;/);
    const download = await get('get', `/s/${session}/file/content?name=brief.pdf&folder=out&download=1`);
    assert.match(download.headers['content-disposition']!, /^attachment;/);
    const archive = await get('get', `/s/${session}/file/content?name=${encodeURIComponent('résumé "final".zip')}&folder=out`);
    assert.equal(archive.headers['content-type'], 'application/octet-stream');
    assert.match(archive.headers['content-disposition']!, /^attachment; filename="r_sum_ _final_\.zip";/);
    assert.match(archive.headers['content-disposition']!, /filename\*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22\.zip/);
  }
});

test('malicious HTML navigation is removed from both preview surfaces while source and download remain original', async () => {
  const session = chat();
  const html = `<!doctype html><html><head>
    <META HTTP-EQUIV="r&#101;fresh" CONTENT="0;url=https://example.invalid/auto">
    <base href="https://example.invalid/" target="_top"><link rel="prefetch" href="https://example.invalid/prefetch">
    <style>table { border: 1px solid red }</style></head><body onload="location='https://example.invalid/script'">
    <h1>Email draft</h1><table><tr><td>Keep this layout</td></tr></table>
    <a href="https://example.invalid/click" target="_blank" ping="https://example.invalid/ping">Read more</a>
    <map name="m"><area href="mailto:example@example.invalid" shape="rect" coords="0,0,10,10"></map>
    <svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="https://example.invalid/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><text>SVG link</text><set attributeName="href" to="https://example.invalid/restore"/><animate attributeName="href" values="https://example.invalid/animate"/></a><circle id="dot" r="4"/><use href="#dot"/></svg>
    <math href="https://example.invalid/math"><mtext href="https://example.invalid/math-text">Math link</mtext></math>
    <noscript><meta http-equiv="refresh" content="0;url=https://example.invalid/noscript"></noscript>
    <template><meta http-equiv="refresh" content="0;url=https://example.invalid/template"><a href="https://example.invalid/template-link">Template link</a></template>
    <form action="https://example.invalid/submit"><button formaction="https://example.invalid/button">Send</button></form>
    <script>location='https://example.invalid/script'</script><iframe src="https://example.invalid/frame"></iframe>
    <img src="data:image/png;base64,iVBORw0KGgo=" alt="Inline logo">
  </body></html>`;
  saved(write('safe-preview/out/navigation.html', html), session);
  const assertInert = (source: string) => {
    // Reparse serialized output as both a script-disabled and ordinary parser
    // would. This covers noscript and foreign/template-content boundaries.
    for (const scriptingEnabled of [false, true]) {
      const pending: Html.Node[] = [parse(source, { scriptingEnabled })];
      while (pending.length) {
        const node = pending.pop()!;
        if ('tagName' in node) {
          assert.ok(!['meta', 'base', 'link', 'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'animate', 'set'].includes(node.tagName.toLowerCase()), node.tagName);
          for (const attr of node.attrs) {
            assert.ok(!attr.name.startsWith('on') && !['action', 'formaction', 'target', 'formtarget', 'ping', 'download', 'srcdoc'].includes(attr.name), attr.name);
            if (node.tagName !== 'use') assert.notEqual(attr.name, 'href', 'HTML, SVG and MathML links cannot navigate');
          }
        }
        if ('childNodes' in node) pending.push(...node.childNodes);
        if ('content' in node) pending.push((node as Html.Template).content);
      }
    }
    assert.match(source, /Keep this layout/);
    assert.match(source, /<table>/);
    assert.match(source, /<style>table \{ border: 1px solid red \}<\/style>/);
    assert.match(source, /data:image\/png;base64,iVBORw0KGgo=/);
    assert.match(source, /<circle id="dot" r="4">/);
    assert.match(source, /<use href="#dot">/);
    assert.equal(files.sessionFileHtmlPreview(source), source, 'sanitation remains stable when the serialized document is parsed again');
  };
  for (const origin of ['console', 'phone'] as const) {
    const get = surface(origin);
    const info = await get('get', `/s/${session}/file?name=navigation.html&folder=out`);
    assert.equal(info.status, 200);
    assert.equal(info.body.file.text, html);
    assertInert(info.body.file.previewHtml);
    const preview = await get('get', `/s/${session}/file/content?fileId=${info.body.file.fileId}`);
    assert.equal(preview.body.toString(), info.body.file.previewHtml);
    assertInert(preview.body.toString());
    assert.match(preview.headers['content-security-policy']!, /^sandbox;/);
    const download = await get('get', `/s/${session}/file/content?fileId=${info.body.file.fileId}&download=1`);
    assert.equal(download.body.toString(), html);
  }
});

test('binary content remains bounded and uses the same lineage and sensitive-path guards', async () => {
  const session = chat(); const other = chat();
  const enormous = write('content/capped/large.pdf', '');
  truncateSync(enormous, files.LARGEST_SESSION_FILE_CONTENT_BYTES + 1);
  saved(enormous, session);
  saved(write('content/unrelated/theirs.pdf', '%PDF-1.7'), other);
  saved(write('content/secret/.env', 'TOKEN=hidden'), session);
  saved(write('content/binary/disguised.html', Buffer.from([0, 0x3c, 0x68, 0x31])), session);
  saved(write('content/empty/empty.pdf', ''), session);
  const linked = path.join(WORK, 'content/linked.pdf');
  symlinkSync(write('content/target/credentials.json', '{"secret":true}'), linked);
  saved(linked, session);
  const get = surface('console');
  const large = await get('get', `/s/${session}/file/content?name=large.pdf&folder=capped`);
  assert.equal(large.status, 413);
  assert.equal(large.body.error, 'FILE_TOO_LARGE');
  assert.equal(large.body.maxBytes, files.LARGEST_SESSION_FILE_CONTENT_BYTES);
  const empty = await get('get', `/s/${session}/file/content?name=empty.pdf&folder=empty`);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.length, 0);
  for (const query of ['name=theirs.pdf&folder=unrelated', 'name=.env&folder=secret', 'name=linked.pdf&folder=content', 'fileId=../target/credentials.json', 'name=../large.pdf']) {
    const blocked = await get('get', `/s/${session}/file/content?${query}`);
    assert.equal(blocked.status, 404, query);
    assert.equal(blocked.body.error, 'FILE_NOT_FOUND');
  }
  const binary = await get('get', `/s/${session}/file/content?name=disguised.html&folder=binary`);
  assert.equal(binary.headers['content-type'], 'application/octet-stream');
  assert.match(binary.headers['content-disposition']!, /^attachment;/);
  const listed = files.listSessionFiles(session);
  assert.ok(!listed.some(file => ['.env', 'linked.pdf', 'theirs.pdf'].includes(file.name)));
});
