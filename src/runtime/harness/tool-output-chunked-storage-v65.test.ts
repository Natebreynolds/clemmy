/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/tool-output-chunked-storage-v65.test.ts */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-tool-output-v65-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const { registerRecallTools } = await import('../../tools/recall-tools.js');
const { RecallBudget, ToolCallsCounter, withHarnessRunContext } = await import('./brackets.js');
const { HARNESS_SCHEMA_VERSION } = await import('./schema-version.js');

type ToolHandler = (input: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;

function captureHandler(name: string): ToolHandler {
  let handler: ToolHandler | null = null;
  registerRecallTools({
    tool: (candidate: string, _description: string, _schema: unknown, callback: ToolHandler) => {
      if (candidate === name) handler = callback;
    },
  } as never);
  assert.ok(handler, `${name} handler registered`);
  return handler;
}

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('v65 is a contiguous migration with independent canonical and invocation chunk spines', () => {
  assert.ok(HARNESS_SCHEMA_VERSION >= 65);
  const db = new Database(path.join(TEST_HOME, 'migration-v65.db'));
  db.pragma('foreign_keys = ON');
  try {
    eventlog.applyHarnessMigrationsThroughVersionForTests(db, 64);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tool_output_chunks'").get(), undefined);
    eventlog.applyHarnessMigrationsThroughVersionForTests(db, 65);
    for (const table of ['tool_output_chunks', 'tool_output_invocation_chunks', 'tool_search_continuations']) {
      assert.ok(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(table));
    }
    assert.deepEqual(
      (db.prepare('PRAGMA table_info(tool_output_chunks)').all() as Array<{ name: string }>).map((row) => row.name),
      ['session_id', 'call_id', 'chunk_index', 'chunk_bytes', 'content_bytes', 'char_start', 'char_count', 'chunk_sha256'],
    );
    for (const table of ['tool_outputs', 'tool_output_invocations']) {
      const columns = new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
      );
      for (const column of ['inline_sha256', 'inline_bytes', 'inline_chars']) {
        assert.ok(columns.has(column), `v65 ${table} carries ${column}`);
      }
    }
    for (const [sql, params] of [
      [
        `EXPLAIN QUERY PLAN SELECT call_id, created_at FROM tool_outputs
          WHERE session_id = ? ORDER BY created_at DESC, call_id ASC LIMIT ?`,
        ['session', 32],
      ],
      [
        `EXPLAIN QUERY PLAN SELECT call_id, created_at FROM tool_outputs
          WHERE session_id = ?
            AND (created_at < ? OR (created_at = ? AND call_id > ?))
          ORDER BY created_at DESC, call_id ASC LIMIT ?`,
        ['session', '2026-01-01', '2026-01-01', 'call', 32],
      ],
    ] as const) {
      const detail = (db.prepare(sql).all(...params) as Array<{ detail: string }>)
        .map((row) => row.detail).join('\n');
      assert.match(detail, /idx_tool_outputs_session_created_call/);
      assert.doesNotMatch(detail, /TEMP B-TREE/);
    }
    const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{ version: number }>;
    assert.deepEqual(versions.map((row) => row.version), Array.from({ length: 65 }, (_, index) => index + 1));
    assert.equal(db.pragma('foreign_key_check').length, 0);
  } finally {
    db.close();
  }
});

test('v65 rejects a preexisting lookalike instead of stamping it as durable authority', () => {
  const db = new Database(path.join(TEST_HOME, 'migration-v65-lookalike.db'));
  db.pragma('foreign_keys = ON');
  try {
    eventlog.applyHarnessMigrationsThroughVersionForTests(db, 64);
    db.exec('CREATE TABLE tool_output_chunks (payload TEXT)');
    assert.throws(
      () => eventlog.applyHarnessMigrationsThroughVersionForTests(db, 65),
      /refuses preexisting unsanctioned table tool_output_chunks/,
    );
    assert.equal(
      (db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version,
      64,
    );
  } finally {
    db.close();
  }
});

test('v64 inline outputs retain exact recall manifests after the v65 upgrade', () => {
  const db = new Database(path.join(TEST_HOME, 'migration-v64-output-continuity.db'));
  db.pragma('foreign_keys = ON');
  try {
    eventlog.applyHarnessMigrationsThroughVersionForTests(db, 64);
    const createdAt = '2026-08-25T00:00:00.000Z';
    const canonical = 'legacy canonical Σ output';
    const invocation = 'legacy exact invocation output';
    db.prepare(
      `INSERT INTO sessions (id, kind, created_at, updated_at, status)
       VALUES (?, 'chat', ?, ?, 'active')`,
    ).run('legacy-output-session', createdAt, createdAt);
    db.prepare(
      `INSERT INTO tool_outputs
         (session_id, call_id, tool, output_full, content_bytes, truncated_at_write, created_at)
       VALUES (?, ?, 'legacy_read', ?, ?, 0, ?)`,
    ).run(
      'legacy-output-session',
      'legacy-call',
      canonical,
      Buffer.byteLength(canonical, 'utf8'),
      createdAt,
    );
    db.prepare(
      `INSERT INTO tool_output_invocations
         (session_id, call_id, invocation_nonce, tool, output_full,
          content_bytes, truncated_at_write, created_at)
       VALUES (?, ?, ?, 'legacy_read', ?, ?, 0, ?)`,
    ).run(
      'legacy-output-session',
      'legacy-call',
      'legacy-nonce',
      invocation,
      Buffer.byteLength(invocation, 'utf8'),
      createdAt,
    );

    eventlog.applyHarnessMigrationsThroughVersionForTests(db, 65);
    for (const [table, output] of [
      ['tool_outputs', canonical],
      ['tool_output_invocations', invocation],
    ] as const) {
      const row = db.prepare(
        `SELECT output_sha256, output_chars, inline_sha256, inline_bytes,
                inline_chars, chunk_count
           FROM ${table} WHERE session_id = ? AND call_id = ?`,
      ).get('legacy-output-session', 'legacy-call') as {
        output_sha256: string | null;
        output_chars: number | null;
        inline_sha256: string | null;
        inline_bytes: number | null;
        inline_chars: number | null;
        chunk_count: number;
      };
      const digest = createHash('sha256').update(output, 'utf8').digest('hex');
      assert.deepEqual(row, {
        output_sha256: digest,
        output_chars: output.length,
        inline_sha256: digest,
        inline_bytes: Buffer.byteLength(output, 'utf8'),
        inline_chars: output.length,
        chunk_count: 0,
      }, `${table} receives a complete whole + inline manifest`);
    }
  } finally {
    db.close();
  }
});

test('16,000,000 and 16,000,001-byte outputs round-trip losslessly instead of crossing a tail cliff', () => {
  eventlog.resetEventLog();
  const session = eventlog.createSession({ kind: 'chat' });
  const atBoundary = `${'A'.repeat(eventlog.TOOL_OUTPUT_MAX_BYTES - 1)}Z`;
  const pastBoundary = `${'B'.repeat(eventlog.TOOL_OUTPUT_MAX_BYTES)}Z`;

  eventlog.writeToolOutput({ sessionId: session.id, callId: 'at-boundary', output: atBoundary });
  eventlog.writeToolOutput({ sessionId: session.id, callId: 'past-boundary', output: pastBoundary });

  assert.deepEqual(eventlog.getToolOutput(session.id, 'at-boundary'), {
    output: atBoundary,
    contentBytes: eventlog.TOOL_OUTPUT_MAX_BYTES,
    truncatedAtWrite: false,
    tool: null,
    createdAt: eventlog.getToolOutput(session.id, 'at-boundary')!.createdAt,
  });
  const restored = eventlog.getToolOutput(session.id, 'past-boundary');
  assert.ok(restored);
  assert.equal(restored.output, pastBoundary);
  assert.equal(restored.output.at(-1), 'Z');
  assert.equal(restored.contentBytes, eventlog.TOOL_OUTPUT_MAX_BYTES + 1);
  assert.equal(restored.truncatedAtWrite, false);

  const db = eventlog.openEventLog();
  assert.equal((db.prepare('SELECT chunk_count AS n FROM tool_outputs WHERE session_id=? AND call_id=?').get(session.id, 'at-boundary') as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT chunk_count AS n FROM tool_outputs WHERE session_id=? AND call_id=?').get(session.id, 'past-boundary') as { n: number }).n, 1);

  eventlog.writeToolOutput({ sessionId: session.id, callId: 'past-boundary', output: 'short hook preview' });
  assert.equal(eventlog.getToolOutput(session.id, 'past-boundary')?.output, pastBoundary, 'a later compact hook cannot delete the winning chunks');
  const equalLengthReplacement = `${'C'.repeat(eventlog.TOOL_OUTPUT_MAX_BYTES)}Q`;
  eventlog.writeToolOutput({ sessionId: session.id, callId: 'past-boundary', output: equalLengthReplacement });
  assert.equal(eventlog.getToolOutput(session.id, 'past-boundary')?.output, equalLengthReplacement, 'equal-length canonical replacement updates its exact chunks atomically');
});

test('all readers and exact invocation replay reach a >16MB tail after store reopen; corruption is incomplete, never success', async () => {
  eventlog.resetEventLog();
  const session = eventlog.createSession({ kind: 'chat' });
  const tailSentinel = 'LOSSLESS_TAIL_SENTINEL_16000001';
  const records = [
    { id: 0, padding: 'x'.repeat(eventlog.TOOL_OUTPUT_MAX_BYTES) },
    { id: 1, sentinel: tailSentinel },
  ];
  const payload = JSON.stringify(records);
  assert.ok(Buffer.byteLength(payload, 'utf8') > eventlog.TOOL_OUTPUT_MAX_BYTES);
  eventlog.writeToolOutput({
    sessionId: session.id,
    callId: 'chunked-json',
    invocationNonce: 'nonce-chunked-json',
    tool: 'provider_list',
    output: payload,
  });

  eventlog.closeEventLog();
  const canonical = eventlog.getToolOutput(session.id, 'chunked-json');
  const exact = eventlog.getToolOutputForInvocation(session.id, 'chunked-json', 'nonce-chunked-json');
  assert.equal(canonical?.output, payload);
  assert.equal(exact?.output, payload);
  assert.equal(canonical?.truncatedAtWrite, false);
  assert.equal(exact?.truncatedAtWrite, false);
  assert.equal(eventlog.listToolOutputInvocations(session.id, 'chunked-json')[0]?.output, payload);
  const recentPreview = eventlog.recentToolOutputs(session.id, { limit: 1 })[0]?.output ?? '';
  const searchPreview = eventlog.searchToolOutputs(session.id, [tailSentinel], { limit: 1 })[0]?.output ?? '';
  assert.match(recentPreview, new RegExp(tailSentinel));
  assert.match(searchPreview, new RegExp(tailSentinel));
  assert.ok(recentPreview.length <= 10_100 && searchPreview.length <= 10_100,
    'retrieval candidates are byte-bounded previews; authority readers reopen exact bytes separately');

  const recall = captureHandler('recall_tool_result');
  const recalled = await withHarnessRunContext(
    { sessionId: session.id, counter: new ToolCallsCounter(5), recallBudget: new RecallBudget(5, 100_000) },
    () => recall({ call_id: 'chunked-json', offset: payload.length - 100, max_chars: 100 }),
  );
  assert.match(recalled.content[0]!.text, new RegExp(tailSentinel));
  assert.doesNotMatch(recalled.content[0]!.text, /tail-truncated|durable output cap/);
  const ranged = eventlog.getToolOutputSlice(session.id, 'chunked-json', payload.length - 100, 100);
  assert.equal(ranged?.output, payload.slice(-100));
  assert.equal(ranged?.totalChars, payload.length);
  assert.equal(ranged?.truncatedAtWrite, false);

  const query = captureHandler('tool_output_query');
  const queried = await withHarnessRunContext(
    { sessionId: session.id, counter: new ToolCallsCounter(5), recallBudget: new RecallBudget(5, 100_000) },
    () => query({ call_id: 'chunked-json', offset: 1, limit: 1, fields: ['id', 'sentinel'] }),
  );
  assert.match(queried.content[0]!.text, new RegExp(tailSentinel));

  // A missing chunk is detected through count/hash/byte verification. Readers
  // may expose the inline preview, but it is marked incomplete and cannot be
  // consumed as successful evidence.
  eventlog.openEventLog().prepare(
    'DELETE FROM tool_output_chunks WHERE session_id=? AND call_id=? AND chunk_index=0',
  ).run(session.id, 'chunked-json');
  const corrupt = eventlog.getToolOutput(session.id, 'chunked-json');
  assert.ok(corrupt);
  assert.equal(corrupt.truncatedAtWrite, true);
  assert.doesNotMatch(corrupt.output, new RegExp(tailSentinel));
  assert.deepEqual(eventlog.searchToolOutputs(session.id, [tailSentinel], { limit: 1 }), []);
  assert.deepEqual(eventlog.recentToolOutputs(session.id, { limit: 1 }), []);
  const corruptRecall = await withHarnessRunContext(
    { sessionId: session.id, counter: new ToolCallsCounter(5), recallBudget: new RecallBudget(5, 100_000) },
    () => recall({ call_id: 'chunked-json' }),
  );
  assert.match(corruptRecall.content[0]!.text, /^ERROR:.*incomplete/);
  assert.doesNotMatch(corruptRecall.content[0]!.text, /"id":0/);
  const corruptQuery = await withHarnessRunContext(
    { sessionId: session.id, counter: new ToolCallsCounter(5), recallBudget: new RecallBudget(5, 100_000) },
    () => query({ call_id: 'chunked-json', offset: 1, limit: 1 }),
  );
  assert.match(corruptQuery.content[0]!.text, /^ERROR:.*incomplete/);

  eventlog.openEventLog().prepare(
    `DELETE FROM tool_output_invocation_chunks
      WHERE session_id=? AND call_id=? AND invocation_nonce=? AND chunk_index=0`,
  ).run(session.id, 'chunked-json', 'nonce-chunked-json');
  assert.equal(
    eventlog.getToolOutputForInvocation(session.id, 'chunked-json', 'nonce-chunked-json')?.truncatedAtWrite,
    true,
  );
  assert.equal(eventlog.resolveToolOutputForAuthority(session.id, 'chunked-json').status, 'failed');
});

test('UTF-8 code points spanning the former cap survive byte-identically', () => {
  eventlog.resetEventLog();
  const session = eventlog.createSession({ kind: 'chat' });
  const payload = `${'u'.repeat(eventlog.TOOL_OUTPUT_MAX_BYTES - 1)}🙂TAIL`;
  eventlog.writeToolOutput({ sessionId: session.id, callId: 'unicode-boundary', output: payload });
  eventlog.closeEventLog();
  const restored = eventlog.getToolOutput(session.id, 'unicode-boundary');
  assert.equal(restored?.output, payload);
  assert.equal(restored?.contentBytes, Buffer.byteLength(payload, 'utf8'));
  assert.equal(restored?.truncatedAtWrite, false);
  const emojiOffset = payload.indexOf('🙂');
  const slice = eventlog.getToolOutputSlice(session.id, 'unicode-boundary', emojiOffset, 6);
  assert.equal(slice?.output, '🙂TAIL');
  assert.equal(slice?.end - slice!.start, '🙂TAIL'.length);
});

test('range recall verifies the inline segment and every intersecting chunk without loading unrelated payload bytes', () => {
  eventlog.resetEventLog();
  const session = eventlog.createSession({ kind: 'chat' });
  const callId = 'range-integrity';
  const output = `${'I'.repeat(eventlog.TOOL_OUTPUT_MAX_BYTES)}CHUNK-TAIL`;
  eventlog.writeToolOutput({ sessionId: session.id, callId, output });
  const db = eventlog.openEventLog();

  db.prepare(
    `UPDATE tool_outputs SET output_full = ? WHERE session_id = ? AND call_id = ?`,
  ).run(`${'X'.repeat(eventlog.TOOL_OUTPUT_MAX_BYTES)}`, session.id, callId);
  assert.equal(
    eventlog.getToolOutputSlice(session.id, callId, 0, 32)?.truncatedAtWrite,
    true,
    'same-length inline mutation is not returned as a verified page',
  );

  eventlog.writeToolOutput({ sessionId: session.id, callId, output });
  db.prepare(
    `UPDATE tool_output_chunks SET chunk_bytes = ?
      WHERE session_id = ? AND call_id = ? AND chunk_index = 0`,
  ).run(Buffer.from('BROKN-TAIL', 'utf8'), session.id, callId);
  const database = db as unknown as { prepare(sql: string): any };
  const originalPrepare = database.prepare.bind(db);
  database.prepare = ((sql: string) => {
    if (/SELECT\s+output_full\s+FROM tool_outputs/i.test(sql)) {
      throw new Error('tail slice loaded the unrelated inline payload');
    }
    return originalPrepare(sql);
  }) as typeof database.prepare;
  try {
    assert.equal(
      eventlog.getToolOutputSlice(session.id, callId, eventlog.TOOL_OUTPUT_MAX_BYTES, 16)?.truncatedAtWrite,
      true,
      'same-length requested-chunk mutation is not returned as a verified page',
    );
  } finally {
    database.prepare = originalPrepare;
  }
});

test('search streams boundary-spanning terms and stops before an older corrupt row at limit', () => {
  eventlog.resetEventLog();
  const session = eventlog.createSession({ kind: 'chat' });
  const older = `${'o'.repeat(eventlog.TOOL_OUTPUT_MAX_BYTES)}older`;
  eventlog.writeToolOutput({ sessionId: session.id, callId: 'z-older-corrupt', output: older });
  const inlineBoundary = `${'a'.repeat(eventlog.TOOL_OUTPUT_MAX_BYTES - 2)}XYZa`;
  eventlog.writeToolOutput({ sessionId: session.id, callId: 'a-inline-boundary', output: inlineBoundary });
  const chunkBoundary = `${'b'.repeat(eventlog.TOOL_OUTPUT_MAX_BYTES + 4_000_000 - 2)}XYZb`;
  eventlog.writeToolOutput({ sessionId: session.id, callId: 'b-chunk-boundary', output: chunkBoundary });
  const contextualSigmaBoundary = `${'c'.repeat(eventlog.TOOL_OUTPUT_MAX_BYTES - 3)}AΣBtail`;
  eventlog.writeToolOutput({ sessionId: session.id, callId: 'c-contextual-sigma', output: contextualSigmaBoundary });
  const db = eventlog.openEventLog();
  db.prepare(
    `UPDATE tool_outputs SET created_at = ? WHERE session_id = ? AND call_id = ?`,
  ).run('2026-01-01T00:00:00.000Z', session.id, 'z-older-corrupt');
  db.prepare(
    `UPDATE tool_outputs SET created_at = ? WHERE session_id = ? AND call_id = ?`,
  ).run('2026-01-02T00:00:00.000Z', session.id, 'a-inline-boundary');
  db.prepare(
    `UPDATE tool_outputs SET created_at = ? WHERE session_id = ? AND call_id = ?`,
  ).run('2026-01-03T00:00:00.000Z', session.id, 'b-chunk-boundary');
  db.prepare(
    `UPDATE tool_output_chunks SET chunk_sha256 = ?
      WHERE session_id = ? AND call_id = ? AND chunk_index = 0`,
  ).run('0'.repeat(64), session.id, 'z-older-corrupt');

  const database = db as unknown as { prepare(sql: string): any };
  const originalPrepare = database.prepare.bind(db);
  database.prepare = ((sql: string) => {
    const statement = originalPrepare(sql);
    if (!sql.includes('FROM tool_output_chunks')) return statement;
    return new Proxy(statement, {
      get(target, property, receiver) {
        if (property !== 'iterate') {
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (...args: unknown[]) => {
          if (args[1] === 'z-older-corrupt') throw new Error('older corrupt row was touched');
          return target.iterate(...args);
        };
      },
    });
  }) as typeof database.prepare;
  try {
    assert.equal(eventlog.searchToolOutputs(session.id, ['XYZ'], { limit: 1 })[0]?.callId, 'b-chunk-boundary');
  } finally {
    database.prepare = originalPrepare;
  }
  assert.deepEqual(
    eventlog.searchToolOutputs(session.id, ['XYZ'], { limit: 2 }).map((row) => row.callId),
    ['b-chunk-boundary', 'a-inline-boundary'],
  );
  assert.deepEqual(
    eventlog.searchToolOutputs(session.id, ['AΣB'], { limit: 1 }).map((row) => row.callId),
    ['c-contextual-sigma'],
    'case folding matches whole-string semantics across an inline/chunk boundary',
  );
});

test('authority counts reused invocation ids before consulting large/corrupt chunks', () => {
  eventlog.resetEventLog();
  const session = eventlog.createSession({ kind: 'chat' });
  const output = `${'x'.repeat(eventlog.TOOL_OUTPUT_MAX_BYTES)}tail`;
  eventlog.writeToolOutput({ sessionId: session.id, callId: 'reused-large', invocationNonce: 'nonce-a', output });
  eventlog.writeToolOutput({ sessionId: session.id, callId: 'reused-large', invocationNonce: 'nonce-b', output });
  const db = eventlog.openEventLog();
  const database = db as unknown as { prepare(sql: string): any };
  const originalPrepare = database.prepare.bind(db);
  database.prepare = ((sql: string) => {
    if (sql.includes('FROM tool_output_invocation_chunks')) {
      throw new Error('ambiguous authority hydrated invocation chunks');
    }
    return originalPrepare(sql);
  }) as typeof database.prepare;
  try {
    assert.deepEqual(eventlog.resolveToolOutputForAuthority(session.id, 'reused-large'), {
      status: 'ambiguous',
      invocationCount: 2,
    });
  } finally {
    database.prepare = originalPrepare;
  }
});

test('automatic grounding authority verifies huge exact spines while retaining only bounded excerpts', () => {
  eventlog.resetEventLog();
  const session = eventlog.createSession({ kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Use the verified large source records.' },
  });
  const add = (callId: string, corrupt = false): void => {
    const called = eventlog.appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'tool',
      type: 'tool_called',
      data: { callId, tool: 'provider_list', effect: 'read', sourceUserSeq: source.seq },
    });
    eventlog.writeToolOutput({
      sessionId: session.id,
      callId,
      invocationNonce: `nonce-${callId}`,
      tool: 'provider_list',
      output: `${callId}:${'p'.repeat(eventlog.TOOL_OUTPUT_MAX_BYTES)}:${callId}@example.com:TAIL`,
    });
    eventlog.appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'tool',
      type: 'tool_returned',
      parentEventId: called.id,
      data: { callId, tool: 'provider_list', effect: 'read', sourceUserSeq: source.seq, ok: true },
    });
    if (corrupt) {
      eventlog.openEventLog().prepare(
        `UPDATE tool_output_invocation_chunks SET chunk_bytes = ?
          WHERE session_id = ? AND call_id = ? AND invocation_nonce = ? AND chunk_index = 0`,
      ).run(Buffer.from('corrupt', 'utf8'), session.id, callId, `nonce-${callId}`);
    }
  };
  add('large-a');
  add('large-b');
  add('large-corrupt', true);

  const excerpts = eventlog.resolveToolOutputExcerptsForAuthority(
    session.id,
    [{ callId: 'large-a' }, { callId: 'large-b' }, { callId: 'large-corrupt' }],
    { readOrComputeOnly: true, excerptChars: 5_000 },
  );
  assert.deepEqual(excerpts.map((row) => row.callId), ['large-a', 'large-b']);
  assert.ok(excerpts.every((row) => row.excerpted && row.output.length <= 5_000));
  assert.ok(excerpts.every((row) => row.contentBytes > eventlog.TOOL_OUTPUT_MAX_BYTES));

  const matches = eventlog.resolveToolOutputTermMatchesForAuthority(
    session.id,
    [{ callId: 'large-a' }, { callId: 'large-b' }, { callId: 'large-corrupt' }],
    ['large-a@example.com', 'large-b@example.com', 'large-corrupt@example.com'],
    { readOrComputeOnly: true },
  );
  assert.deepEqual(matches.map((row) => [row.callId, row.matchedTerms]), [
    ['large-a', ['large-a@example.com']],
    ['large-b', ['large-b@example.com']],
  ], 'middle/tail identifiers survive bounded projection while a corrupt tail invalidates the whole source');
  eventlog.openEventLog().prepare(
    `UPDATE tool_output_invocations SET output_sha256 = NULL
      WHERE session_id = ? AND call_id = ? AND invocation_nonce = ?`,
  ).run(session.id, 'large-a', 'nonce-large-a');
  assert.deepEqual(eventlog.resolveToolOutputExcerptsForAuthority(
    session.id,
    [{ callId: 'large-a' }],
    { readOrComputeOnly: true },
  ), [], 'a chunked spine without its whole-output hash anchor has no authority');
});

test('parent and chunks are read from one WAL snapshot during an equal-length replacement', () => {
  eventlog.resetEventLog();
  const session = eventlog.createSession({ kind: 'chat' });
  const oldOutput = `${'A'.repeat(eventlog.TOOL_OUTPUT_MAX_BYTES)}OLD`;
  const newOutput = `${'B'.repeat(eventlog.TOOL_OUTPUT_MAX_BYTES)}NEW`;
  eventlog.writeToolOutput({ sessionId: session.id, callId: 'snapshot-race', output: oldOutput });
  const db = eventlog.openEventLog();
  const writer = new Database(eventlog.HARNESS_DB_PATH);
  writer.pragma('journal_mode = WAL');
  writer.pragma('foreign_keys = ON');
  const newInline = newOutput.slice(0, eventlog.TOOL_OUTPUT_MAX_BYTES);
  const newChunkText = newOutput.slice(eventlog.TOOL_OUTPUT_MAX_BYTES);
  const newChunk = Buffer.from(newChunkText, 'utf8');
  const replace = writer.transaction(() => {
    writer.prepare(
      `UPDATE tool_outputs SET output_full=?, content_bytes=?, output_sha256=?,
              chunk_count=1, output_chars=?, inline_sha256=?, inline_bytes=?,
              inline_chars=?, created_at=?
        WHERE session_id=? AND call_id=?`,
    ).run(
      newInline,
      Buffer.byteLength(newOutput, 'utf8'),
      createHash('sha256').update(newOutput, 'utf8').digest('hex'),
      newOutput.length,
      createHash('sha256').update(newInline, 'utf8').digest('hex'),
      Buffer.byteLength(newInline, 'utf8'),
      newInline.length,
      '2026-02-02T00:00:00.000Z',
      session.id,
      'snapshot-race',
    );
    writer.prepare('DELETE FROM tool_output_chunks WHERE session_id=? AND call_id=?')
      .run(session.id, 'snapshot-race');
    writer.prepare(
      `INSERT INTO tool_output_chunks
         (session_id, call_id, chunk_index, chunk_bytes, content_bytes,
          char_start, char_count, chunk_sha256)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?)`,
    ).run(
      session.id,
      'snapshot-race',
      newChunk,
      newChunk.length,
      newInline.length,
      newChunkText.length,
      createHash('sha256').update(newChunk).digest('hex'),
    );
  });
  const database = db as unknown as { prepare(sql: string): any };
  const originalPrepare = database.prepare.bind(db);
  let injected = false;
  database.prepare = ((sql: string) => {
    const statement = originalPrepare(sql);
    if (injected || !sql.includes('FROM tool_outputs') || !sql.includes('output_full')) return statement;
    return new Proxy(statement, {
      get(target, property, receiver) {
        if (property !== 'get') {
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (...args: unknown[]) => {
          const row = target.get(...args);
          injected = true;
          replace();
          return row;
        };
      },
    });
  }) as typeof database.prepare;
  try {
    const duringReplacement = eventlog.getToolOutput(session.id, 'snapshot-race');
    assert.equal(duringReplacement?.truncatedAtWrite, false);
    assert.equal(duringReplacement?.output, oldOutput);
  } finally {
    database.prepare = originalPrepare;
    writer.close();
  }
  assert.equal(eventlog.getToolOutput(session.id, 'snapshot-race')?.output, newOutput);
});
