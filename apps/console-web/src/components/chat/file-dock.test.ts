/**
 * A file Clem saved opens beside the conversation, like the browser: the
 * conversation stays open and usable, and the card itself is the way in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileSizeWords, sameSessionFile, sessionFilePath } from '../../lib/session-files';

const DOCK = readFileSync(new URL('./FileDock.tsx', import.meta.url), 'utf8');
const RECEIPT = readFileSync(new URL('./TurnReceipt.tsx', import.meta.url), 'utf8');
const CHAT = readFileSync(new URL('../../screens/Chat.tsx', import.meta.url), 'utf8');
const THREAD = readFileSync(new URL('../../features/conversations/chat/ConversationThread.tsx', import.meta.url), 'utf8');

test('the card asks for the file by name and folder, never by a path', () => {
  const ref = { sessionId: 'sess-desktop-1', name: 'outreach draft.md', folder: 'client-brief' };
  assert.equal(sessionFilePath(ref), '/api/console/sessions/sess-desktop-1/file?name=outreach+draft.md&folder=client-brief');
  assert.equal(sessionFilePath(ref, 'open'), '/api/console/sessions/sess-desktop-1/file/open?name=outreach+draft.md&folder=client-brief');
  assert.ok(sameSessionFile(ref, { ...ref }));
  assert.equal(sameSessionFile(ref, { ...ref, folder: 'other' }), false);
  assert.equal(fileSizeWords(512), '512 bytes');
  assert.equal(fileSizeWords(2048), '2 KB');
  assert.equal(fileSizeWords(3 * 1024 * 1024), '3.0 MB');
});

test('the panel docks beside the conversation, never over it', () => {
  assert.match(DOCK, /className="file-dock-conversation">\{children\}<\/div>/);
  assert.match(DOCK, /<aside\s+className="file-dock-panel"/);
  assert.doesNotMatch(DOCK, /aria-modal|role="dialog"|fixed inset-0/, 'a modal would take the conversation away');
  for (const screen of [CHAT, THREAD]) assert.match(screen, /<FileDockWorkspace conversationId=/);
});

test('in a conversation the whole card opens the file or page in the dock', () => {
  assert.match(RECEIPT, /const dock = useFileDock\(\);/);
  assert.match(RECEIPT, /dock\.open\(page \? \{ kind: 'page'[^}]*\} : \{ kind: 'file', ref: fileRef! \}\)/);
  assert.match(RECEIPT, /aria-pressed=\{showing\}/);
});

test('markdown is typeset by the shared escaping renderer; other text stays text', () => {
  assert.match(DOCK, /renderMarkdown\(file\.text, \{ workspaceLinks: false \}\)/);
  assert.match(DOCK, /<pre className="whitespace-pre-wrap/);
});
