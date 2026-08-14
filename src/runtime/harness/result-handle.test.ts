import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-result-handles-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-result-handles\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const dispatch = await import('./dispatch-ledger.js');
const results = await import('./result-handle.js');
const providerEvidence = await import('./provider-read-evidence.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function accept(label: string) {
  const session = eventlog.createSession({ id: `result-${label}-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `Read every ${label} record.` },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
  };
}

function returnedCall(input: {
  task: ReturnType<typeof accept>;
  logicalToolCallId: string;
  physicalDispatchId: string;
  args: unknown;
  baseArgs?: unknown;
  continuationChainId?: string;
  toolName?: string;
}): results.ResultHandleAuthority {
  const toolName = input.toolName ?? 'alpha_source_list';
  const started = dispatch.beginPhysicalDispatch({
    identity: {
      ...input.task,
      logicalToolCallId: input.logicalToolCallId,
      physicalDispatchId: input.physicalDispatchId,
      ordinal: 0,
    },
    tool: toolName,
    args: input.args,
  });
  assert.equal(started.status, 'inserted', started.status === 'inserted' ? undefined : started.reason);
  if (started.status !== 'inserted') throw new Error('fixture dispatch was not admitted');
  const settled = dispatch.settlePhysicalDispatch({
    identity: started.identity,
    tool: toolName,
    outcome: 'returned',
  });
  assert.equal(settled.status, 'inserted');
  return {
    ...input.task,
    logicalToolCallId: input.logicalToolCallId,
    physicalDispatchId: input.physicalDispatchId,
    ...(input.continuationChainId === undefined
      ? {}
      : { continuationChainId: input.continuationChainId }),
    toolName,
    args: input.args,
    ...(input.baseArgs === undefined ? {} : { baseArgs: input.baseArgs }),
  };
}

test('raw payload is stored once and redeems byte-exact after close and reopen', () => {
  const task = accept('restart');
  const authority = returnedCall({
    task,
    logicalToolCallId: 'logical-restart',
    physicalDispatchId: 'physical-restart',
    args: { query: 'alpha', limit: 2 },
  });
  const payload = {
    successful: true,
    data: { records: [{ id: 'a', value: '🍊' }, { id: 'b', value: 'β' }] },
    meta: { complete: true },
  };
  const first = results.toResultHandle(payload, { authority });
  assert.ok(first.rawLocation);

  const before = eventlog.openEventLog().prepare(`
    SELECT raw_payload_json, raw_payload_sha256, COUNT(*) OVER () AS count
      FROM durable_result_handles WHERE handle_id = ?
  `).get(first.handle) as { raw_payload_json: string; raw_payload_sha256: string; count: number };
  assert.equal(before.count, 1);
  assert.equal(
    before.raw_payload_sha256,
    createHash('sha256').update(before.raw_payload_json).digest('hex'),
    'the stored bytes carry their own integrity digest',
  );

  eventlog.closeEventLog();
  const redeemed = results.redeemRawResult(first.rawLocation!, authority);
  assert.deepEqual(redeemed, { status: 'ok', value: payload });
  const replay = results.toResultHandle(payload, { authority });
  assert.equal(replay.handle, first.handle);
  const count = eventlog.openEventLog().prepare(
    'SELECT COUNT(*) AS count FROM durable_result_handles WHERE handle_id = ?',
  ).get(first.handle) as { count: number };
  assert.equal(count.count, 1, 'replay must not duplicate the one raw payload copy');
});

test('immutable storage rejects ordinary tampering and redemption detects damaged bytes', () => {
  const task = accept('integrity');
  const authority = returnedCall({
    task,
    logicalToolCallId: 'logical-integrity',
    physicalDispatchId: 'physical-integrity',
    args: { query: 'integrity' },
  });
  const handle = results.toResultHandle({ successful: true, records: [{ id: 'sound' }] }, { authority });
  const db = eventlog.openEventLog();
  assert.throws(
    () => db.prepare('UPDATE durable_result_handles SET raw_payload_json = ? WHERE handle_id = ?')
      .run('{"tampered":true}', handle.handle),
    /immutable/,
  );

  // Simulate on-disk damage below the SQL guard to prove redemption does not
  // trust parseable bytes merely because a row exists.
  db.exec('DROP TRIGGER trg_durable_result_identity_immutable');
  try {
    db.prepare('UPDATE durable_result_handles SET raw_payload_json = ? WHERE handle_id = ?')
      .run('{"tampered":true}', handle.handle);
  } finally {
    db.exec(`
      CREATE TRIGGER trg_durable_result_identity_immutable
      BEFORE UPDATE ON durable_result_handles
      BEGIN
        SELECT RAISE(ABORT, 'durable result handles are immutable');
      END;
    `);
  }
  assert.equal(results.redeemRawResult(handle.rawLocation!, authority).status, 'corrupt');
});

test('raw and continuation references reject another task and another logical call', () => {
  const owner = accept('owner');
  const ownerAuthority = returnedCall({
    task: owner,
    logicalToolCallId: 'logical-owner',
    physicalDispatchId: 'physical-owner',
    args: { query: 'alpha' },
  });
  const handle = results.toResultHandle({
    successful: true,
    data: { records: [{ id: 'a' }] },
    next_cursor: 'cursor-secret',
  }, { authority: ownerAuthority });
  assert.ok(handle.rawLocation && handle.continuationRef);

  const otherTask = accept('other-task');
  const otherTaskAuthority = returnedCall({
    task: otherTask,
    logicalToolCallId: 'logical-owner',
    physicalDispatchId: 'physical-other-task',
    args: { query: 'alpha' },
  });
  assert.equal(results.redeemRawResult(handle.rawLocation!, otherTaskAuthority).status, 'forbidden');
  assert.equal(results.redeemContinuation(handle.continuationRef!, otherTaskAuthority).status, 'forbidden');

  const otherCallAuthority = returnedCall({
    task: owner,
    logicalToolCallId: 'logical-other-call',
    physicalDispatchId: 'physical-other-call',
    args: { query: 'alpha' },
  });
  assert.equal(results.redeemRawResult(handle.rawLocation!, otherCallAuthority).status, 'forbidden');
  assert.equal(results.redeemContinuation(handle.continuationRef!, otherCallAuthority).status, 'forbidden');
  assert.equal(results.readRawResult(handle.rawLocation!), undefined, 'a leaked scoped location is not authority');
  assert.equal(results.resolveContinuation(handle.continuationRef!), undefined, 'a leaked cursor ref is not authority');
});

test('opaque cursor bytes survive restart and A-B-A cycles are marked on the base call', () => {
  const task = accept('cursor-cycle');
  const baseArgs = { query: 'alpha', limit: 10 };
  const cursors = ['cursor-A\0opaque', 'cursor-B/+/=', 'cursor-A\0opaque'];
  const handles = cursors.map((cursor, index) => {
    const authority = returnedCall({
      task,
      logicalToolCallId: `logical-page-${index + 1}`,
      physicalDispatchId: `physical-page-${index + 1}`,
      args: index === 0 ? baseArgs : { ...baseArgs, page_token: `input-${index}` },
      baseArgs,
      continuationChainId: 'pagination-chain-alpha',
    });
    const handle = results.toResultHandle({
      successful: true,
      data: { records: [{ id: index }] },
      next_cursor: cursor,
    }, { authority });
    return { authority, handle };
  });
  assert.deepEqual(
    handles.map(({ handle }) => handle.continuationRepeated),
    [false, false, true],
    'the third page revisits A even though B appeared between them',
  );
  eventlog.closeEventLog();
  const last = handles[2];
  assert.deepEqual(
    results.redeemContinuation(last.handle.continuationRef!, last.authority),
    { status: 'ok', value: cursors[2] },
    'cursor bytes remain exact after reopening the event store',
  );
});

test('one logical pagination call cannot silently change its base arguments', () => {
  const task = accept('base-binding');
  const first = returnedCall({
    task,
    logicalToolCallId: 'logical-base-1',
    physicalDispatchId: 'physical-base-1',
    args: { query: 'alpha' },
    baseArgs: { query: 'alpha' },
    continuationChainId: 'base-chain',
  });
  results.toResultHandle({ successful: true, records: [], next_cursor: 'c1' }, { authority: first });
  const second = returnedCall({
    task,
    logicalToolCallId: 'logical-base-2',
    physicalDispatchId: 'physical-base-2',
    args: { query: 'alpha', cursor: 'c1' },
    baseArgs: { query: 'different' },
    continuationChainId: 'base-chain',
  });
  assert.throws(
    () => results.toResultHandle({ successful: true, records: [] }, { authority: second }),
    (error: unknown) => error instanceof results.ResultHandleAuthorityError
      && error.status === 'authority_mismatch',
  );
});

test('projection is UTF-8-byte bounded and malformed or oversized payloads never claim completeness', () => {
  const projection = results.toResultHandle({
    successful: true,
    data: {
      records: Array.from({ length: 50 }, (_, index) => ({
        index,
        unicode: '🟠'.repeat(2_000),
      })),
    },
  });
  assert.ok(
    Buffer.byteLength(JSON.stringify(projection.projectedRecords), 'utf8')
      <= results.RESULT_PROJECTION_MAX_BYTES,
  );

  const task = accept('malformed');
  const circularAuthority = returnedCall({
    task,
    logicalToolCallId: 'logical-circular',
    physicalDispatchId: 'physical-circular',
    args: { query: 'circular' },
  });
  const circular: Record<string, unknown> = {
    successful: true,
    data: { records: [{ id: 'a' }] },
    meta: { complete: true },
  };
  circular.self = circular;
  const malformed = results.toResultHandle(circular, { authority: circularAuthority });
  assert.equal(malformed.completeness, 'unknown');
  assert.equal(malformed.rawLocation, null);
  assert.equal(malformed.continuationRef, null);

  const oversizedAuthority = returnedCall({
    task,
    logicalToolCallId: 'logical-oversized',
    physicalDispatchId: 'physical-oversized',
    args: { query: 'oversized' },
  });
  const oversized = results.toResultHandle({
    successful: true,
    data: { records: [{ id: 'large', blob: 'x'.repeat(results.RESULT_RAW_MAX_BYTES + 1) }] },
    meta: { complete: true },
  }, { authority: oversizedAuthority });
  assert.equal(oversized.completeness, 'unknown');
  assert.equal(oversized.rawLocation, null);
  const rejected = eventlog.openEventLog().prepare(`
    SELECT rejection_reason, raw_payload_json
      FROM durable_result_handles WHERE handle_id = ?
  `).get(oversized.handle) as { rejection_reason: string; raw_payload_json: string | null };
  assert.equal(rejected.rejection_reason, 'oversized');
  assert.equal(rejected.raw_payload_json, null, 'an oversized result is not half-stored');
});

test('a handle cannot bind to a crossing owned by another accepted task', () => {
  const task = accept('scope-mismatch');
  const authority = returnedCall({
    task,
    logicalToolCallId: 'logical-scope',
    physicalDispatchId: 'physical-scope',
    args: { query: 'alpha' },
  });
  const forged: results.ResultHandleAuthority = {
    ...authority,
    acceptedTaskId: `${authority.acceptedTaskId}-forged`,
  };
  assert.throws(
    () => results.toResultHandle({ successful: true, records: [] }, { authority: forged }),
    (error: unknown) => error instanceof results.ResultHandleAuthorityError
      && error.status === 'authority_mismatch',
  );
});

test('collection completeness is structural evidence, never a records-array default', () => {
  assert.equal(results.toResultHandle({
    successful: true,
    records: [{ id: 'unknown-page' }],
  }).completeness, 'unknown');

  const fixtures: Array<{ name: string; payload: unknown; expected: results.ResultCompleteness }> = [
    {
      name: 'snake has-more',
      payload: { successful: true, records: [{ id: 1 }], pagination: { has_more: true } },
      expected: 'partial',
    },
    {
      name: 'camel has-next terminal',
      payload: { successful: true, records: [{ id: 1 }], pageInfo: { hasNext: false } },
      expected: 'complete',
    },
    {
      name: 'total exceeds returned window',
      payload: {
        successful: true,
        records: [{ id: 1 }, { id: 2 }],
        pagination: { total: 5, returned: 2, offset: 0 },
      },
      expected: 'partial',
    },
    {
      name: 'offset reaches total',
      payload: {
        successful: true,
        records: [{ id: 4 }, { id: 5 }],
        pagination: { total: '5', returned: '2', offset: '3' },
      },
      expected: 'complete',
    },
    {
      name: 'page before page-count',
      payload: { successful: true, records: [{ id: 1 }], pagination: { page: 1, page_count: 3 } },
      expected: 'partial',
    },
    {
      name: 'last page',
      payload: { successful: true, records: [{ id: 3 }], pagination: { page: 3, page_count: 3 } },
      expected: 'complete',
    },
    {
      name: 'OData next link',
      payload: {
        successful: true,
        value: [{ id: 1 }],
        '@odata.context': 'https://service.invalid/$metadata#records',
        '@odata.nextLink': 'https://service.invalid/page/2',
      },
      expected: 'partial',
    },
    {
      name: 'OData terminal context without next link',
      payload: {
        successful: true,
        value: [{ id: 1 }],
        '@odata.context': 'https://service.invalid/$metadata#records',
      },
      expected: 'complete',
    },
    {
      name: 'Relay page info',
      payload: {
        successful: true,
        data: { records: [{ id: 1 }], pageInfo: { hasNextPage: true, endCursor: 'opaque' } },
      },
      expected: 'partial',
    },
    {
      name: 'links terminal',
      payload: { successful: true, records: [{ id: 1 }], links: { next: null } },
      expected: 'complete',
    },
    {
      name: 'explicit complete without contradiction',
      payload: { successful: true, records: [{ id: 1 }], meta: { complete: true } },
      expected: 'complete',
    },
    {
      name: 'explicit complete contradicted by continuation',
      payload: {
        successful: true,
        records: [{ id: 1 }],
        meta: { complete: true },
        paging: { hasNext: true },
      },
      expected: 'partial',
    },
  ];

  for (const fixture of fixtures) {
    assert.equal(
      results.toResultHandle(fixture.payload).completeness,
      fixture.expected,
      fixture.name,
    );
  }
});

test('nested structured provider failures contradict an outer successful label', () => {
  for (const payload of [
    { successful: true, wrapper: { transport: { isError: true } } },
    { successful: true, wrapper: { transport: { error: true } } },
    { successful: true, wrapper: { transport: { status: '503' } } },
    { successful: true, wrapper: { transport: { httpCode: 429 } } },
    { successful: true, wrapper: { transport: { status_code: '50000' } } },
  ]) {
    assert.equal(providerEvidence.providerEnvelopeHasContradiction(payload), true, JSON.stringify(payload));
  }
  assert.equal(providerEvidence.providerEnvelopeHasContradiction({
    successful: true,
    wrapper: { transport: { isError: false, error: false, status: '200' } },
  }), false);
  assert.equal(providerEvidence.providerEnvelopeHasContradiction({
    successful: true,
    records: [{ id: 'business-record', status: 503 }],
  }), false, 'business record fields are content, not provider envelope status');
});

test('neutral provider error sentinels stay aligned with the shared envelope verdict', () => {
  for (const error of [null, false, '', [], {}, 'none', 'ok', 'success']) {
    const payload = {
      successful: true,
      error,
      result: { totalSize: 1, done: true, records: [{ Id: '001-a' }] },
    };
    assert.equal(
      providerEvidence.inspectProviderEnvelope(payload).verdict,
      'clean',
      JSON.stringify(error),
    );
    const facts = results.deriveResultHandleFactsFromRaw(payload);
    assert.equal(facts.success, true, JSON.stringify(error));
    assert.equal(facts.completeness, 'complete', JSON.stringify(error));
  }
});

test('raw fact derivation treats string and nested HTTP failure statuses as failed', () => {
  const rootStatus = results.deriveResultHandleFactsFromRaw({
    successful: true,
    records: [],
    status: '500',
  });
  assert.equal(rootStatus.success, false);
  assert.equal(rootStatus.statusCode, 500);

  const nestedStatus = results.deriveResultHandleFactsFromRaw({
    successful: true,
    wrapper: { transport: { http_status: '503' } },
    records: [],
  });
  assert.equal(nestedStatus.success, false);
  assert.equal(nestedStatus.statusCode, 503);
});

test('a returned business entity may truthfully have a failed domain status', () => {
  const payload = {
    successful: true,
    data: { id: 'task-1', status: 'failed', name: 'Nightly import' },
  };
  assert.equal(providerEvidence.providerEnvelopeHasContradiction(payload), false);
  const facts = results.deriveResultHandleFactsFromRaw(payload);
  assert.equal(facts.success, true);
  assert.equal(facts.statusCode, null);
});

// Provider SDK payloads carry undefined properties and non-plain-prototype
// objects; shape-policing rejected the WHOLE result as 'unserializable' —
// a healthy 194KB Apify payload was discarded, the model was told its paid
// calls could not be stored, and a scheduled workflow died silently (live
// 2026-08-11, scorpion-facebook-trends). Canonicalization is stringify's job.
test('SDK-shaped payloads (undefined props, class instances) persist and redeem', () => {
  class SdkEnvelope { constructor(readonly page: string, readonly likes: number) {} }
  class EphemeralSdkMetadata {
    toJSON(): undefined { return undefined; }
  }
  const task = accept('sdk shapes');
  const authority = returnedCall({
    task,
    logicalToolCallId: 'logical-sdk-shape',
    physicalDispatchId: 'physical-sdk-shape',
    args: { query: 'scorpion facebook' },
  });
  const payload = {
    successful: true,
    logId: 'sdk-shape-log',
    data: {
      items: [
        { id: 'post-1', text: 'trend', missing: undefined, envelope: new SdkEnvelope('scorpion.co', 42) },
      ],
    },
    // The live Composio/Apify wrapper has SDK-only metadata that is visible
    // on the provider object but not part of its retained JSON bytes. Facts
    // must be frozen from those bytes or settlement redemption disagrees.
    meta: new EphemeralSdkMetadata(),
  };
  const handle = results.toResultHandle(payload, { authority });
  assert.ok(handle.rawLocation, 'the payload is stored, not rejected');
  const row = eventlog.openEventLog().prepare(
    `SELECT rejection_reason, raw_payload_json, envelope_meta_json
       FROM durable_result_handles WHERE handle_id = ?`,
  ).get(handle.handle) as {
    rejection_reason: string | null;
    raw_payload_json: string | null;
    envelope_meta_json: string | null;
  };
  assert.equal(row.rejection_reason, null);
  const stored = JSON.parse(row.raw_payload_json!);
  assert.equal(stored.data.items[0].envelope.page, 'scorpion.co', 'class instances flatten to their data');
  assert.ok(!('missing' in stored.data.items[0]), 'undefined properties drop, never poison');
  assert.ok(!('meta' in stored), 'SDK-only metadata is absent from the authoritative retained bytes');
  assert.deepEqual(
    JSON.parse(row.envelope_meta_json!),
    { successful: true, logId: 'sdk-shape-log' },
    'the frozen projection is derived from the exact retained bytes',
  );
  assert.deepEqual(
    results.redeemRawResult(handle.rawLocation!, authority),
    { status: 'ok', value: stored },
    'the retained SDK-shaped result redeems to its one canonical JSON value',
  );
});
