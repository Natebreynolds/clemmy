import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filePreviewHtml, sessionFilePath, sessionFileProblem } from './session-files';
import { apiBlob, getSessionFingerprint, setSessionFingerprint, type ApiError } from './api';
import { connectionDoor } from './native-bridge';

test('same-name files stay bound to their recorded identity on preview and download', () => {
  const file = { fileId: 'sf-unique', name: 'Draft & report.pdf', folder: 'Quarter 4' };
  const url = new URL(sessionFilePath('chat/a', file, true, true), 'http://example.test');
  assert.equal(url.pathname, '/m/api/chat/sessions/chat%2Fa/file/content');
  assert.equal(url.searchParams.get('fileId'), file.fileId);
  assert.equal(url.searchParams.get('name'), file.name);
  assert.equal(url.searchParams.get('folder'), file.folder);
  assert.equal(url.searchParams.get('download'), '1');
});

test('download reads retain the binary bytes, session cookie and rotated proof identity', async (t) => {
  setSessionFingerprint('before');
  const bytes = Uint8Array.from([37, 80, 68, 70, 45, 0, 255]);
  t.mock.method(globalThis, 'fetch', async (_path: unknown, init?: RequestInit) => {
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(new Headers(init?.headers).get('accept'), '*/*');
    return new Response(bytes, { headers: { 'content-type': 'application/pdf', 'x-clem-session-fp': 'rotated' } });
  });
  const blob = await apiBlob('/m/api/chat/sessions/s/file/content?fileId=one');
  assert.equal(blob.type, 'application/pdf');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  assert.equal(getSessionFingerprint(), 'rotated');
  setSessionFingerprint(null);
});

test('a rejected binary request preserves the typed error instead of downloading JSON', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: 'FILE_TOO_LARGE', maxBytes: 25_000_000 }), { status: 413, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(apiBlob('/m/api/chat/sessions/s/file/content'), (error: ApiError) => {
    assert.equal(error.status, 413);
    assert.deepEqual(error.body, { error: 'FILE_TOO_LARGE', maxBytes: 25_000_000 });
    assert.match(sessionFileProblem(error), /too large/);
    return true;
  });
});

test('a binary proof rejection checks the live session and recovers its rotated identity', async (t) => {
  setSessionFingerprint('expired');
  t.mock.method(globalThis, 'fetch', async (path: string, init?: RequestInit) => {
    if (path === '/m/auth/status') {
      assert.equal(init?.cache, 'no-store');
      assert.equal(init?.credentials, 'include');
      return new Response(JSON.stringify({ authenticated: true, sessionFingerprint: 'healed' }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'proof_rejected' }), { status: 401 });
  });
  await assert.rejects(apiBlob('/m/api/chat/sessions/s/file/content'), (error: ApiError) => error.status === 401);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getSessionFingerprint(), 'healed');
  setSessionFingerprint(null);
});

test('closing an in-flight preview does not mark the computer offline', async (t) => {
  const controller = new AbortController();
  const before = connectionDoor();
  t.mock.method(globalThis, 'fetch', async () => {
    controller.abort();
    throw new DOMException('Aborted', 'AbortError');
  });
  await assert.rejects(apiBlob('/m/api/chat/sessions/s/file/content', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(connectionDoor(), before);
});

test('HTML preview policy precedes the document and refuses active or remote resources', () => {
  const html = '<!doctype html><html><head><script>parent.fetch("/m/api/settings")</script></head><body>Draft</body></html>';
  const preview = filePreviewHtml(html);
  assert.ok(preview.indexOf('Content-Security-Policy') < preview.indexOf('<script>'));
  assert.match(preview, /default-src 'none'/);
  assert.match(preview, /form-action 'none'/);
  assert.match(preview, /style-src 'unsafe-inline'/);
  assert.doesNotMatch(preview.slice(0, preview.indexOf('<!doctype')), /allow-scripts|https:/);
});
