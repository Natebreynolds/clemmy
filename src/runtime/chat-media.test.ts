/** Run: node scripts/run-tests-isolated.mjs src/runtime/chat-media.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, utimesSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatMediaFile, imageBlocksOf, storeToolMedia, sweepChatMedia } from './chat-media.js';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

test('a tool\'s pictures are kept for the chat under the tool\'s call, bounded, from bare or wrapped content', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-chat-media-'));
  const content = [{ type: 'text', text: 'the window' }, { type: 'image', data: png, mimeType: 'image/png' }, { type: 'image', data: png, mimeType: 'image/jpeg' }, { type: 'image', data: png, mimeType: 'image/png' }];
  assert.equal(imageBlocksOf(content).length, 3);
  assert.equal(imageBlocksOf({ content }).length, 3);
  assert.equal(imageBlocksOf('just text').length, 0);
  assert.equal(imageBlocksOf(JSON.stringify(content)).length, 3, 'a picture inside JSON text the tool adapter produced still counts');
  assert.equal(imageBlocksOf(JSON.stringify({ content })).length, 3);
  assert.equal(imageBlocksOf('[not json "image"').length, 0);
  const refs = storeToolMedia('sess-1', 'call:7', { content }, { root });
  assert.deepEqual(refs.map((r) => [r.id, r.path, r.mimeType]), [
    ['call-7-1.png', '/api/console/chat-media/sess-1/call-7-1.png', 'image/png'],
    ['call-7-2.jpg', '/api/console/chat-media/sess-1/call-7-2.jpg', 'image/jpeg'],
  ], 'two per call at most, named by the call');
  assert.equal(readFileSync(chatMediaFile('sess-1', 'call-7-1.png', root)!).length, 16);
  assert.equal(chatMediaFile('../etc', 'passwd', root), null, 'unsafe names never resolve');
  assert.equal(chatMediaFile('sess-1', '.hidden', root), null);
  assert.deepEqual(storeToolMedia('sess-1', 'c8', 'no pictures here', { root }), []);
  const [colon] = storeToolMedia('console:run-4c3b60f2-f61', 'call-1', [{ type: 'image', data: png, mimeType: 'image/png' }], { root });
  assert.equal(colon.path, '/api/console/chat-media/console-run-4c3b60f2-f61/call-1-1.png', 'a chat id with a colon still gets a folder, and the served path finds it');
  assert.ok(chatMediaFile('console-run-4c3b60f2-f61', 'call-1-1.png', root));
});

test('pictures older than a week are swept, and an emptied chat folder goes with them', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-chat-media-'));
  const [ref] = storeToolMedia('sess-2', 'c1', [{ type: 'image', data: png, mimeType: 'image/png' }], { root });
  const file = chatMediaFile('sess-2', ref.id, root)!;
  const old = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(file, old, old);
  storeToolMedia('sess-3', 'c1', [{ type: 'image', data: png, mimeType: 'image/png' }], { root });
  assert.equal(sweepChatMedia({ root, force: true }), 1);
  assert.ok(!existsSync(file));
  assert.ok(!existsSync(path.dirname(file)), 'the emptied chat folder is gone');
  assert.ok(chatMediaFile('sess-3', 'c1-1.png', root), 'a fresh picture stays');
});
