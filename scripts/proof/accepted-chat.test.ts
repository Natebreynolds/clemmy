/**
 * Run: npx tsx --test scripts/proof/accepted-chat.test.ts
 *
 * The asynchronous desktop ingress returns only a 202 acceptance receipt.
 * Proof completion must come from the exact accepted source's typed terminal,
 * never from a nearby tool result or an unrelated/legacy completion row.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import { requestAcceptedHarnessChat } from './provision.js';
import {
  presentationEventForOutcome,
  type TurnOutcome,
} from '../../src/runtime/harness/turn-outcome.js';

test('accepted proof chat waits for the exact typed terminal behind its 202 receipt', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-accepted-chat-'));
  mkdirSync(path.join(home, 'state'), { recursive: true });
  const db = new Database(path.join(home, 'state', 'harness.db'));
  db.exec(`
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      turn INTEGER NOT NULL,
      role TEXT NOT NULL,
      type TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  const sessionId = 'proof-accepted-chat-session';
  const reply = 'Exact typed continuation result.';
  let observedPath = '';
  let observedAuthorization = '';
  let observedBody: Record<string, unknown> = {};
  let insertedSourceSeq = 0;
  let settleInsertion!: () => void;
  let rejectInsertion!: (error: unknown) => void;
  const insertion = new Promise<void>((resolve, reject) => {
    settleInsertion = resolve;
    rejectInsertion = reject;
  });

  const server = createServer((request, response) => {
    void (async () => {
      observedPath = request.url ?? '';
      observedAuthorization = request.headers.authorization ?? '';
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      observedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const clientRequestId = String(observedBody.clientRequestId ?? '');
      const runId = 'desktop:proof-accepted-chat-run';
      const attemptId = 'attempt-proof-accepted-chat';
      const accepted = db.prepare(`
        INSERT INTO events (session_id, turn, role, type, data_json, created_at)
        VALUES (?, ?, 'user', 'user_input_received', ?, ?)
      `).run(sessionId, 2, JSON.stringify({
        text: 'Continue.',
        displayText: 'Continue.',
        requestId: clientRequestId,
        clientRequestId,
        runId,
        attemptId,
      }), new Date().toISOString());
      insertedSourceSeq = Number(accepted.lastInsertRowid);

      // Nearby text-bearing rows are deliberately not completion authority.
      db.prepare(`
        INSERT INTO events (session_id, turn, role, type, data_json, created_at)
        VALUES (?, ?, 'tool', 'tool_returned', ?, ?)
      `).run(sessionId, 2, JSON.stringify({ output: 'Wrong inferred tool text.' }), new Date().toISOString());
      db.prepare(`
        INSERT INTO events (session_id, turn, role, type, data_json, created_at)
        VALUES (?, ?, 'assistant', 'conversation_completed', ?, ?)
      `).run(sessionId, 1, JSON.stringify({
        reply: 'Wrong legacy completion.',
        sourceUserSeq: insertedSourceSeq + 100,
      }), new Date().toISOString());

      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        sessionId,
        status: 'started',
        clientRequestId,
        runId,
      }));

      setTimeout(() => {
        try {
          const identity = {
            sessionId,
            turn: 2,
            sourceUserSeq: insertedSourceSeq,
            attemptId,
            runId,
          };
          const outcome: TurnOutcome = {
            version: 2,
            id: `turn:${insertedSourceSeq}`,
            identity,
            status: 'done',
            resumable: false,
            presentation: { kind: 'answer', text: reply },
          };
          const presentation = presentationEventForOutcome(outcome);
          db.prepare(`
            INSERT INTO events (session_id, turn, role, type, data_json, created_at)
            VALUES (?, ?, 'assistant', 'conversation_completed', ?, ?)
          `).run(sessionId, 2, JSON.stringify({
            logicalTerminalVersion: 1,
            terminalKey: `turn:${insertedSourceSeq}`,
            sourceUserSeq: insertedSourceSeq,
            attemptId,
            runId,
            presentation,
            turnOutcome: outcome,
          }), new Date().toISOString());
          settleInsertion();
        } catch (error) {
          rejectInsertion(error);
        }
      }, 40);
    })().catch((error) => {
      rejectInsertion(error);
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const result = await requestAcceptedHarnessChat({
      home,
      baseUrl: `http://127.0.0.1:${address.port}`,
      headers: { authorization: 'Bearer proof-secret', 'content-type': 'application/json' },
      message: 'Continue.',
      sessionId,
      timeoutMs: 2_000,
    });
    await insertion;

    assert.equal(observedPath, '/api/harness/chat');
    assert.equal(observedAuthorization, 'Bearer proof-secret');
    assert.equal(observedBody.input, 'Continue.');
    assert.equal(observedBody.sessionId, sessionId);
    assert.match(String(observedBody.clientRequestId), /^proof-[a-f0-9]{32}$/);
    assert.equal(result.httpStatus, 202);
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.sourceUserSeq, insertedSourceSeq);
    assert.equal(result.text, reply);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
