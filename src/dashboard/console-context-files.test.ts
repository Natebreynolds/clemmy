/**
 * Route-level regression coverage for the console's two-part context files and
 * session-backed working-memory projection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-console-context-files-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.NODE_ENV = 'test';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { resetMemoryDb } = await import('../memory/db.js');
const { appendEvent, createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');
const { refreshWorkingMemoryForSession } = await import('../memory/working-memory.js');
const {
  IDENTITY_FILE,
  MEMORY_AUTO_SECTION_MARKER,
  MEMORY_FILE,
  WORKING_MEMORY_FILE,
  splitCuratedMemory,
} = await import('../memory/vault.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

interface ContextFilePayload {
  key: string;
  content: string;
  exists: boolean;
  empty: boolean;
  sessionLabel?: string;
}

async function boot() {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => true, {} as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const instance = createServer(app);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function seedTwoPartContext(): void {
  resetMemoryDb();
  resetEventLog();
  mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
  writeFileSync(MEMORY_FILE, [
    '# Memory',
    '',
    'MEMORY-CURATED-ORIGINAL stays visible.',
    '',
    MEMORY_AUTO_SECTION_MARKER,
    '',
    '## Learned facts',
    '- MEMORY-AUTO-SENTINEL stays generated.',
    '',
  ].join('\n'));
  writeFileSync(IDENTITY_FILE, [
    '# Identity',
    '',
    'IDENTITY-CURATED-ORIGINAL stays visible.',
    '',
    MEMORY_AUTO_SECTION_MARKER,
    '',
    '## Working with',
    '- IDENTITY-AUTO-SENTINEL stays generated.',
    '',
  ].join('\n'));

  // The harness intentionally writes per-session memory only. The console must
  // still report the resolved card as existing when the legacy global file is absent.
  if (existsSync(WORKING_MEMORY_FILE)) unlinkSync(WORKING_MEMORY_FILE);
  const sessionId = 'console-context-session-backed-wm';
  createSession({ id: sessionId, kind: 'chat', channel: 'desktop', title: 'Session-backed memory' });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Keep WORKING-MEMORY-SESSION-SENTINEL in short-term context.' },
  });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reply: 'WORKING-MEMORY-SESSION-SENTINEL is retained.' },
  });
  refreshWorkingMemoryForSession(sessionId, 'desktop');
  assert.equal(existsSync(WORKING_MEMORY_FILE), false, 'fixture must exercise session-only working memory');
}

function fileByKey(files: ContextFilePayload[], key: string): ContextFilePayload {
  const file = files.find((candidate) => candidate.key === key);
  assert.ok(file, `missing context file ${key}`);
  return file;
}

test('GET /api/console/context returns curated two-part files and treats session working memory as existing', async () => {
  seedTwoPartContext();
  const harness = await boot();
  try {
    const response = await fetch(`${harness.url}/api/console/context`);
    assert.equal(response.status, 200);
    const body = await response.json() as { files: ContextFilePayload[] };

    const memory = fileByKey(body.files, 'memory');
    assert.equal(memory.exists, true);
    assert.match(memory.content, /MEMORY-CURATED-ORIGINAL/);
    assert.doesNotMatch(memory.content, /AUTO-GENERATED|MEMORY-AUTO-SENTINEL/);

    const identity = fileByKey(body.files, 'identity');
    assert.equal(identity.exists, true);
    assert.match(identity.content, /IDENTITY-CURATED-ORIGINAL/);
    assert.doesNotMatch(identity.content, /AUTO-GENERATED|IDENTITY-AUTO-SENTINEL/);

    const workingMemory = fileByKey(body.files, 'working_memory');
    assert.equal(workingMemory.exists, true, 'a resolved per-session file is an existing context source');
    assert.equal(workingMemory.empty, false);
    assert.equal(workingMemory.sessionLabel, 'Session-backed memory');
    assert.match(workingMemory.content, /WORKING-MEMORY-SESSION-SENTINEL/);
  } finally {
    await harness.close();
  }
});

test('PATCH /api/console/context/files/:key preserves MEMORY and IDENTITY generated sections', async () => {
  seedTwoPartContext();
  const originalMemoryAuto = splitCuratedMemory(readFileSync(MEMORY_FILE, 'utf-8')).autoSection;
  const originalIdentityAuto = splitCuratedMemory(readFileSync(IDENTITY_FILE, 'utf-8')).autoSection;
  const harness = await boot();
  try {
    const edits = [
      { key: 'memory', content: '# Memory\n\nMEMORY-CURATED-EDITED is the new note.' },
      { key: 'identity', content: '# Identity\n\nIDENTITY-CURATED-EDITED is the new self-description.' },
    ] as const;

    for (const edit of edits) {
      const response = await fetch(`${harness.url}/api/console/context/files/${edit.key}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: edit.content }),
      });
      assert.equal(response.status, 200, `${edit.key} patch failed`);
      const body = await response.json() as { file: ContextFilePayload };
      assert.equal(body.file.content, edit.content);
      assert.doesNotMatch(body.file.content, /AUTO-GENERATED|AUTO-SENTINEL/);
    }

    const memorySplit = splitCuratedMemory(readFileSync(MEMORY_FILE, 'utf-8'));
    assert.equal(memorySplit.curated, edits[0].content);
    assert.equal(memorySplit.autoSection, originalMemoryAuto, 'MEMORY generated projection round-trips unchanged');
    assert.match(memorySplit.autoSection, /MEMORY-AUTO-SENTINEL/);

    const identitySplit = splitCuratedMemory(readFileSync(IDENTITY_FILE, 'utf-8'));
    assert.equal(identitySplit.curated, edits[1].content);
    assert.equal(identitySplit.autoSection, originalIdentityAuto, 'IDENTITY generated projection round-trips unchanged');
    assert.match(identitySplit.autoSection, /IDENTITY-AUTO-SENTINEL/);
  } finally {
    await harness.close();
  }
});
