import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  clarifyThenDecline,
  declineReplyIsTruthful,
} from './scenarios/clarify-then-decline.js';
import type { DaemonHandle } from './types.js';

test('decline truth check accepts varied conversational wording without grading style', () => {
  assert.equal(declineReplyIsTruthful('Understood — I won’t create it.'), true);
  assert.equal(declineReplyIsTruthful('All right — anything else?'), true);
  assert.equal(declineReplyIsTruthful('No problem. The cancellation note will not be created.'), true);
});

test('decline truth check rejects empty replies and affirmative completion claims', () => {
  assert.equal(declineReplyIsTruthful('I created the cancellation note.'), false);
  assert.equal(declineReplyIsTruthful('The note has been saved.'), false);
  assert.equal(declineReplyIsTruthful(''), false);
});

test('scenario bootstraps synchronously, then proves the exact durable decline structurally', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'clemmy-proof-decline-scenario-'));
  mkdirSync(path.join(home, 'state'), { recursive: true });
  const db = new Database(path.join(home, 'state', 'harness.db'));
  db.exec(`
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      data_json TEXT NOT NULL
    )
  `);
  let bootstrapCalls = 0;
  let continuationCalls = 0;
  let sessionId = '';
  const append = (type: string, data: Record<string, unknown>): void => {
    db.prepare('INSERT INTO events (session_id, type, data_json) VALUES (?, ?, ?)')
      .run(sessionId, type, JSON.stringify(data));
  };

  const daemon = {
    home,
    port: 0,
    secret: 'test',
    baseUrl: 'http://127.0.0.1:0',
    chat: async (message: string, requestedSessionId: string) => {
      bootstrapCalls += 1;
      sessionId = requestedSessionId;
      assert.match(message, /natural voice/i);
      append('awaiting_user_input', {
        question: 'Want me to make that note now?',
        options: ['Yes, create it', 'No, leave it alone'],
        purpose: 'clarification',
      });
      return {
        text: 'Want me to make that note now?',
        sessionId,
        wallMs: 10,
        httpStatus: 200,
      };
    },
    acceptedChat: async (message: string, requestedSessionId: string) => {
      continuationCalls += 1;
      assert.equal(bootstrapCalls, 1, 'the session must exist before durable continuation ingress');
      assert.equal(message, 'No.');
      assert.equal(requestedSessionId, sessionId);
      append('turn_memory_primer', {
        queryPreview: 'No.',
        skippedReason: 'declined_continuation',
        hitCount: 0,
        injected: false,
      });
      append('agent_context_packet', {
        semanticEnrichmentSkippedReason: 'declined_continuation',
      });
      append('tool_policy_resolved', {
        outputCount: 0,
        allowedCount: 0,
        shortCircuitReason: 'declined_continuation',
        semanticAcquisitionSkipped: true,
        schemaWarmSkipped: true,
        advertisedSchemaCount: 0,
        catalogCount: 0,
      });
      append('mcp_tool_scope', {
        reason: 'declined continuation',
        allowAll: false,
        allowedServerSlugs: [],
        maxTools: 0,
      });
      return {
        text: 'All right — anything else?',
        sessionId,
        sourceUserSeq: 2,
        wallMs: 5,
        httpStatus: 202,
      };
    },
    approve: async () => 200,
    request: async () => ({ status: 200, json: {} }),
    log: () => '',
    markLog: () => undefined,
    restart: async () => undefined,
    stop: async () => ({
      retainedHome: false,
      forensicLog: { status: 'not-requested' as const },
      cleanup: { intent: 'remove' as const, status: 'succeeded' as const, homeExists: false },
    }),
  } satisfies DaemonHandle;

  try {
    const outcome = await clarifyThenDecline.run(daemon);
    assert.equal(bootstrapCalls, 1);
    assert.equal(continuationCalls, 1);
    assert.deepEqual(
      outcome.checks.filter((check) => !check.pass),
      [],
      'the structural scenario fixture should satisfy every scenario-owned check',
    );
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
