/** Real local bytes and retention; converted input is an inert injected seam. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { AppendEventInput } from '../runtime/harness/eventlog.js';
import type { ToolOutputContext } from '../runtime/harness/tool-output-context.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-local-read-timing-'));
process.env.CLEMENTINE_HOME = home;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(home, 'state'), { recursive: true });
const events = await import('../runtime/harness/eventlog.js');
const { getToolOutputContext, withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { HostLocalReadSuccessResult, InvalidArgumentsPreDispatchResult } = await import('../runtime/harness/attempt-settlement.js');
const { exactToolOutputForInvocation } = await import('../runtime/harness/tool-output-format.js');
const { PAGE_SOURCE_NOTE, executeLocalFileRead, executeLocalFileReadForTool,
  _testOnly_executeLocalFileReadWithDependencies: readWithDependencies } = await import('./computer-tools.js');
type Dependencies = NonNullable<Parameters<typeof readWithDependencies>[4]>;

after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

function context(label: string): ToolOutputContext {
  const session = events.createSession({ kind: 'chat' });
  const source = events.appendEvent({ sessionId: session.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: 'Read the controlled local fixture.' } });
  return { sessionId: session.id, sourceUserSeq: source.seq, callId: `call-${label}`,
    toolName: 'read_file', settlementNonce: randomUUID() };
}
function dependencies(rows: AppendEventInput[], patch: Partial<Dependencies> = {}): Dependencies {
  let clock = 0;
  return { now: () => (clock += 7), emit: row => { rows.push(row); },
    ingest: async () => { throw new Error('unexpected conversion'); }, ...patch };
}
function fixture(name: string, text: string): string {
  const file = path.join(home, name); writeFileSync(file, text); return file;
}
function diagnostic(rows: AppendEventInput[], ctx: ToolOutputContext, file: string) {
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.sessionId, ctx.sessionId);
  assert.equal(row.type, 'turn_phase_timings');
  assert.equal(row.role, 'system');
  const d = row.data!;
  assert.equal(d.sourceUserSeq, ctx.sourceUserSeq);
  assert.equal(d.callId, ctx.callId);
  assert.equal(d.tool, 'read_file');
  assert.equal(d.clock, 'monotonic');
  assert.equal(d.lane, 'local_file_read');
  const durations = d.durationsMs as Record<string, number>;
  assert.ok(Object.values(durations).every(ms => Number.isFinite(ms) && ms >= 0));
  assert.ok(Number.isFinite(d.totalMs) && Number(d.totalMs) >= Object.values(durations).reduce((a, b) => a + b, 0));
  const encoded = JSON.stringify(row);
  assert.ok(!encoded.includes(file));
  assert.ok(!encoded.includes(ctx.settlementNonce!));
  assert.deepEqual(Object.keys(d).sort(), ['version', 'lane', 'clock', 'sourceUserSeq', 'callId', 'tool',
    'readKind', 'outcome', 'durationsMs', 'totalMs'].sort());
  return d;
}

test('plaintext stage diagnostic preserves redacted bytes and exact invocation retention', async () => {
  const file = fixture('text-private-path.txt', 'alpha=A2\napi_key=sk-controlled-secret-xyz\n');
  const expected = await executeLocalFileRead({ path: file, max_chars: null });
  const ctx = context('text'); const rows: AppendEventInput[] = [];
  const result = await withToolOutputContext(ctx, () => readWithDependencies({ path: file, max_chars: null },
    undefined, undefined, undefined, dependencies(rows)));
  assert.equal(result, expected);
  assert.doesNotMatch(String(result), /sk-controlled-secret/);
  assert.equal(events.getToolOutputForInvocation(ctx.sessionId!, ctx.callId!, ctx.settlementNonce!)?.output, expected);
  const d = diagnostic(rows, ctx, file);
  assert.equal(d.readKind, 'text'); assert.equal(d.outcome, 'returned');
  assert.deepEqual(Object.keys(d.durationsMs as object).sort(), ['path_checks', 'file_read', 'redaction', 'format_retain'].sort());
  assert.doesNotMatch(JSON.stringify(rows), /alpha=A2|sk-controlled-secret/);
});

test('HTML retains source note and text; it never enters converted ingestion', async () => {
  const html = '<main>actual source</main>'; const file = fixture('source.htm', html);
  const ctx = context('html'); const rows: AppendEventInput[] = [];
  const result = await withToolOutputContext(ctx, () => readWithDependencies({ path: file, max_chars: null },
    undefined, undefined, undefined, dependencies(rows)));
  assert.equal(result, `${PAGE_SOURCE_NOTE}\n\n${html}`);
  assert.equal(diagnostic(rows, ctx, file).readKind, 'html');
});

test('converted diagnostic separates ingestion and retains exactly its redacted output', async () => {
  const file = fixture('convert.pdf', 'inert converter input');
  const ctx = context('converted'); const rows: AppendEventInput[] = []; let ingestions = 0;
  const result = await withToolOutputContext(ctx, () => readWithDependencies({ path: file, max_chars: null },
    undefined, undefined, undefined, dependencies(rows, { ingest: async input => {
      ingestions++; assert.equal(input.sourcePath, file); assert.equal(input.name, 'convert.pdf');
      await Promise.resolve(); return { name: input.name, markdown: 'converted actual fixture\npassword=fixture-secret' };
    } })));
  assert.equal(ingestions, 1);
  assert.equal(result, 'converted actual fixture\npassword=[REDACTED]');
  assert.equal(events.getToolOutputForInvocation(ctx.sessionId!, ctx.callId!, ctx.settlementNonce!)?.output, result);
  const d = diagnostic(rows, ctx, file); assert.equal(d.readKind, 'converted');
  assert.deepEqual(Object.keys(d.durationsMs as object).sort(), ['path_checks', 'ingest', 'redaction', 'format_retain'].sort());
  assert.doesNotMatch(JSON.stringify(rows), /converted actual fixture|fixture-secret/);
});

test('complete output remains complete with no formatter/retention stage introduced', async () => {
  const text = 'whole-file-line\n'.repeat(900); const file = fixture('complete.txt', text);
  const ctx = context('complete'); const rows: AppendEventInput[] = [];
  const result = await withToolOutputContext(ctx, () => readWithDependencies({ path: file, max_chars: 10 },
    undefined, undefined, { completeOutput: true }, dependencies(rows)));
  assert.equal(result, text);
  assert.equal(events.getToolOutputForInvocation(ctx.sessionId!, ctx.callId!, ctx.settlementNonce!), null);
  assert.ok(!('format_retain' in (diagnostic(rows, ctx, file).durationsMs as object)));
});

test('actual nominal SDK reader still records one diagnostic and redeems full clipped bytes', async () => {
  const raw = 'exact full local bytes\n'.repeat(500); const file = fixture('nominal.txt', raw);
  const ctx = context('nominal');
  const result = await withToolOutputContext(ctx, () => executeLocalFileReadForTool({ path: file, max_chars: 400 }));
  assert.ok(result instanceof HostLocalReadSuccessResult);
  assert.equal(exactToolOutputForInvocation({ sessionId: ctx.sessionId, callId: ctx.callId,
    toolName: 'read_file', settlementNonce: ctx.settlementNonce, compactResult: result.output }), raw);
  const rows = events.listEvents(ctx.sessionId!, { types: ['turn_phase_timings'], sinceSeq: ctx.sourceUserSeq })
    .map(row => ({ sessionId: row.sessionId, turn: row.turn, role: row.role, type: row.type, data: row.data }));
  assert.equal(diagnostic(rows, ctx, file).outcome, 'returned');
});

for (const kind of ['sensitive', 'missing', 'directory', 'ingest_error'] as const) test(`${kind} refusal/error remains unchanged and private`, async () => {
  const file = kind === 'sensitive' ? fixture('.env', 'secret=never-read')
    : kind === 'missing' ? path.join(home, 'absent.txt')
    : kind === 'directory' ? home : fixture('broken.pdf', 'inert input');
  const ctx = context(kind); const rows: AppendEventInput[] = [];
  const result = await withToolOutputContext(ctx, () => readWithDependencies({ path: file, max_chars: null },
    undefined, undefined, { failOnReadError: true }, dependencies(rows, {
      ingest: async input => ({ name: input.name, error: 'fixture conversion failed' }),
    })));
  assert.ok(result instanceof InvalidArgumentsPreDispatchResult);
  const d = diagnostic(rows, ctx, file);
  assert.equal(d.outcome, kind === 'sensitive' ? 'sensitive_refusal' : kind === 'directory' ? 'not_file' : kind);
  assert.ok(!('file_read' in (d.durationsMs as object)));
  assert.ok(!('redaction' in (d.durationsMs as object)));
  assert.ok(!('format_retain' in (d.durationsMs as object)));
  assert.doesNotMatch(JSON.stringify(rows), /never-read|fixture conversion failed/);
});

test('conversion throw identity is preserved while best-effort diagnostic marks the observed stage', async () => {
  const file = fixture('throw.pdf', 'inert input'); const ctx = context('throw'); const rows: AppendEventInput[] = [];
  const error = new Error('exact converter failure');
  await assert.rejects(Promise.resolve(withToolOutputContext(ctx, () => readWithDependencies({ path: file, max_chars: null },
    undefined, undefined, undefined, dependencies(rows, { ingest: async () => { throw error; } })))), (err: unknown) => err === error);
  const d = diagnostic(rows, ctx, file); assert.equal(d.outcome, 'threw');
  assert.ok('ingest' in (d.durationsMs as object));
  assert.doesNotMatch(JSON.stringify(rows), /exact converter failure/);
});

test('diagnostic emission and monotonic clock failures never change successful bytes', async () => {
  const file = fixture('diagnostic-failure.txt', 'unchanged');
  for (const failure of ['emit', 'throw_clock', 'backwards_clock', 'nonfinite_clock'] as const) {
    const ctx = context(failure); const rows: AppendEventInput[] = []; let count = 0;
    const deps = dependencies(rows, failure === 'emit' ? { emit: () => { throw new Error('inert diagnostic failure'); } }
      : { now: () => { count++; if (failure === 'throw_clock') throw new Error('clock failure');
        return failure === 'nonfinite_clock' ? NaN : count === 1 ? 10 : 9; } });
    const result = await withToolOutputContext(ctx, () => readWithDependencies({ path: file, max_chars: null },
      undefined, undefined, undefined, deps));
    assert.equal(result, 'unchanged'); assert.equal(rows.length, 0);
    assert.equal(events.getToolOutputForInvocation(ctx.sessionId!, ctx.callId!, ctx.settlementNonce!)?.output, 'unchanged');
  }
});

test('missing or mismatched exact context never invents attribution', async () => {
  const file = fixture('unbound.txt', 'unchanged'); const ctx = context('unbound');
  const badContexts: ToolOutputContext[] = [
    {}, { ...ctx, sourceUserSeq: 0 }, { ...ctx, sourceUserSeq: 1.5 }, { ...ctx, sourceUserSeq: undefined },
    { ...ctx, toolName: 'other_tool' }, { ...ctx, settlementNonce: undefined }, { ...ctx, sessionId: '' }, { ...ctx, callId: '' },
  ];
  for (const candidate of badContexts) {
    const rows: AppendEventInput[] = [];
    const result = await withToolOutputContext(candidate, () => readWithDependencies({ path: file, max_chars: null },
      undefined, undefined, { completeOutput: true }, dependencies(rows)));
    assert.equal(result, 'unchanged'); assert.equal(rows.length, 0);
  }
  for (const mismatch of ['session', 'source', 'call'] as const) {
    const rows: AppendEventInput[] = [];
    const runtime = { context: { sessionId: mismatch === 'session' ? 'foreign-session' : ctx.sessionId,
      sourceUserSeq: mismatch === 'source' ? ctx.sourceUserSeq! + 1 : ctx.sourceUserSeq } };
    const details = { toolCall: { callId: mismatch === 'call' ? 'foreign-call' : ctx.callId } };
    const result = await withToolOutputContext(ctx, () => readWithDependencies({ path: file, max_chars: null },
      runtime, details, { completeOutput: true }, dependencies(rows)));
    assert.equal(result, 'unchanged'); assert.equal(rows.length, 0);
  }
});

test('legacy sensitive refusal and converted error strings remain the existing public wording', async () => {
  const sensitive = fixture('.env', 'secret=never-read');
  const expected = await executeLocalFileRead({ path: sensitive, max_chars: null });
  const ctx = context('legacy-refusal'); const rows: AppendEventInput[] = [];
  const result = await withToolOutputContext(ctx, () => readWithDependencies({ path: sensitive, max_chars: null },
    undefined, undefined, undefined, dependencies(rows)));
  assert.equal(result, expected);
  assert.equal(diagnostic(rows, ctx, sensitive).outcome, 'sensitive_refusal');
  const converted = fixture('legacy-broken.pdf', 'inert input'); const errorRows: AppendEventInput[] = [];
  const errorResult = await withToolOutputContext(ctx, () => readWithDependencies({ path: converted, max_chars: null },
    undefined, undefined, undefined, dependencies(errorRows, {
      ingest: async input => ({ name: input.name, error: 'inert conversion failure' }),
    })));
  assert.equal(errorResult, 'Could not read legacy-broken.pdf: inert conversion failure');
  assert.equal(diagnostic(errorRows, ctx, converted).outcome, 'ingest_error');
});

test('conversion cannot relabel a timing row by changing its captured context', async () => {
  const file = fixture('relabel.pdf', 'inert input'); const ctx = context('relabel'); const rows: AppendEventInput[] = [];
  const result = await withToolOutputContext(ctx, () => readWithDependencies({ path: file, max_chars: null },
    undefined, undefined, { completeOutput: true }, dependencies(rows, { ingest: async input => {
      getToolOutputContext()!.sourceUserSeq! += 1;
      return { name: input.name, markdown: 'unchanged bytes' };
    } })));
  assert.equal(result, 'unchanged bytes'); assert.equal(rows.length, 0);
});
