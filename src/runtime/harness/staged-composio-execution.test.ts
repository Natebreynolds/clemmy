import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-staged-composio-execution-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_AUTHORITY_SEAL_KEY = '8'.repeat(64);
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-staged-orchestrator\n', 'utf8');

const eventlog = await import('./eventlog.js');
const composio = await import('../../integrations/composio/client.js');
const staged = await import('./staged-transfer-authority.js');
const execution = await import('./staged-composio-execution.js');
const fixtures = await import('./staged-transfer-production-fixture.js');

test.after(() => {
  composio.__test__.setConnectedAccountsLoader(null);
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function installProvider(input: {
  label: string;
  businessResult: unknown;
  counts: { presign: number; put: number; business: number };
}) {
  composio.__test__.setComposioApiKeyOverride('test-api-key');
  composio.__test__.setComposioClient({
    getClient: () => ({
      withOptions: (options: unknown) => ({
        files: {
          createPresignedURL: async () => {
            assert.deepEqual(options, { maxRetries: 0 });
            input.counts.presign += 1;
            return {
              key: `staged/private/${input.label}.txt`,
              new_presigned_url: `https://storage.example/private/${input.label}.txt?token=orchestrator-secret`,
              metadata: { storage_backend: 's3' },
            };
          },
        },
        tools: {
          execute: async () => {
            assert.deepEqual(options, { maxRetries: 0 });
            input.counts.business += 1;
            return input.businessResult;
          },
        },
      }),
    }),
  });
}

test('one prepared saga runs each body once, projects safely, and replays from receipts without provider I/O', async () => {
  const uploadDirectory = path.join(TMP_HOME, 'uploads');
  mkdirSync(uploadDirectory, { recursive: true });
  const sourcePath = path.join(uploadDirectory, 'orchestrated.txt');
  const sourceBytes = Buffer.from('one exact orchestrated upload\n', 'utf8');
  writeFileSync(sourcePath, sourceBytes, { mode: 0o600 });
  const fixture = await fixtures.createProductionStagedBusinessFixture('orchestrated', {
    uploadSourcePath: sourcePath,
    startFirstStage: false,
  });
  const db = eventlog.openEventLog();
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS count FROM staged_transfer_stage_authorities WHERE plan_id = ?
  `).get(fixture.preparedPlan.planId) as { count: number }).count, 0);
  assert.equal((db.prepare(`
    SELECT COUNT(*) AS count FROM physical_dispatches WHERE session_id = ?
  `).get(fixture.session.id) as { count: number }).count, 0);

  const counts = { presign: 0, put: 0, business: 0 };
  installProvider({
    label: 'orchestrated',
    counts,
    businessResult: { successful: true, error: null, data: { id: 'drive-file-1' } },
  });
  const originalFetch = globalThis.fetch;
  let uploaded = Buffer.alloc(0);
  try {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      counts.put += 1;
      assert.equal(String(url).includes('orchestrator-secret'), true);
      assert.equal(init?.method, 'PUT');
      assert.equal(init?.redirect, 'error');
      const chunks: Buffer[] = [];
      for await (const chunk of init?.body as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      uploaded = Buffer.concat(chunks);
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const result = await execution.executePreparedStagedComposioPlan({
      planAuthority: fixture.preparedPlan.authority,
      parentDispatchLease: fixture.callLease,
      outputSchema: fixture.outputSchema,
    });
    assert.deepEqual(result, {
      status: 'returned',
      value: { successful: true, error: null, data: { id: 'drive-file-1' } },
    });
    assert.deepEqual(uploaded, sourceBytes);
    assert.deepEqual(counts, { presign: 1, put: 1, business: 1 });

    const replay = await execution.executePreparedStagedComposioPlan({
      planAuthority: fixture.preparedPlan.authority,
      parentDispatchLease: fixture.callLease,
      outputSchema: fixture.outputSchema,
    });
    assert.deepEqual(replay, result);
    assert.deepEqual(counts, { presign: 1, put: 1, business: 1 }, 'receipt replay enters no body');

    eventlog.closeEventLog();
    eventlog.openEventLog();
    const reopened = staged.reopenStagedTransferPlanAuthority({
      sessionId: fixture.session.id,
      sourceUserSeq: fixture.source.seq,
      parentLogicalToolCallId: fixture.logicalToolCallId,
    });
    assert.equal(reopened.status, 'ok', JSON.stringify(reopened));
    if (reopened.status !== 'ok') throw new Error('staged plan did not reopen');
    const afterReopen = await execution.executePreparedStagedComposioPlan({
      planAuthority: reopened.authority,
      parentDispatchLease: fixture.callLease,
      outputSchema: fixture.outputSchema,
    });
    assert.deepEqual(afterReopen, result);
    assert.deepEqual(counts, { presign: 1, put: 1, business: 1 }, 'restart replay enters no body');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const durable = JSON.stringify([
    ...eventlog.openEventLog().prepare(`SELECT * FROM staged_transfer_plans WHERE plan_id = ?`)
      .all(fixture.preparedPlan.planId),
    ...eventlog.openEventLog().prepare(`SELECT * FROM staged_transfer_stages WHERE plan_id = ?`)
      .all(fixture.preparedPlan.planId),
    ...eventlog.openEventLog().prepare(`SELECT * FROM staged_transfer_stage_receipts WHERE plan_id = ?`)
      .all(fixture.preparedPlan.planId),
    ...eventlog.openEventLog().prepare(`SELECT data_json FROM events WHERE session_id = ?`)
      .all(fixture.session.id),
  ]);
  assert.equal(durable.includes(sourcePath), false);
  assert.equal(durable.includes('orchestrator-secret'), false);
  assert.equal(durable.includes('staged/private/orchestrated.txt'), false);
  assert.equal((eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS count
      FROM staged_transfer_stage_receipts
     WHERE plan_id = ? AND terminal_state = 'returned'
  `).get(fixture.preparedPlan.planId) as { count: number }).count, 4);
});

test('an ambiguous upload is held after one PUT and cannot be replayed by orchestration', async () => {
  const uploadDirectory = path.join(TMP_HOME, 'uploads');
  mkdirSync(uploadDirectory, { recursive: true });
  const sourcePath = path.join(uploadDirectory, 'ambiguous.txt');
  writeFileSync(sourcePath, 'ambiguous upload bytes\n', { mode: 0o600 });
  const fixture = await fixtures.createProductionStagedBusinessFixture('orchestrated-ambiguous', {
    uploadSourcePath: sourcePath,
    startFirstStage: false,
  });
  const counts = { presign: 0, put: 0, business: 0 };
  installProvider({
    label: 'orchestrated-ambiguous',
    counts,
    businessResult: { successful: true, error: null, data: { id: 'must-not-run' } },
  });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      counts.put += 1;
      return new Response('uncertain object-store outcome', { status: 503 });
    }) as typeof fetch;
    const result = await execution.executePreparedStagedComposioPlan({
      planAuthority: fixture.preparedPlan.authority,
      parentDispatchLease: fixture.callLease,
      outputSchema: fixture.outputSchema,
    });
    assert.equal(result.status, 'held', JSON.stringify(result));
    assert.deepEqual(counts, { presign: 1, put: 1, business: 0 });

    const replay = await execution.executePreparedStagedComposioPlan({
      planAuthority: fixture.preparedPlan.authority,
      parentDispatchLease: fixture.callLease,
      outputSchema: fixture.outputSchema,
    });
    assert.equal(replay.status, 'held', JSON.stringify(replay));
    assert.deepEqual(counts, { presign: 1, put: 1, business: 0 }, 'ambiguous PUT is never replayed');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(eventlog.openEventLog().prepare(`
    SELECT physical.state, receipt.terminal_state
      FROM staged_transfer_stage_receipts receipt
      JOIN physical_dispatches physical
        ON physical.session_id = receipt.session_id
       AND physical.source_user_seq = receipt.source_user_seq
       AND physical.physical_dispatch_id = receipt.physical_dispatch_id
     WHERE receipt.plan_id = ? AND receipt.stage_ordinal = 3
  `).get(fixture.preparedPlan.planId), { state: 'unknown', terminal_state: 'unknown' });
});

test('a business download runs one GET and projects only its content-addressed artifact handle', async () => {
  const fixture = await fixtures.createProductionStagedBusinessFixture('orchestrated-download', {
    startFirstStage: false,
  });
  const signedUrl = 'https://storage.example/private/result.txt?token=download-secret';
  const downloadedBytes = Buffer.from('exact downloaded provider bytes\n', 'utf8');
  const sha256 = createHash('sha256').update(downloadedBytes).digest('hex');
  const counts = { presign: 0, put: 0, business: 0 };
  installProvider({
    label: 'orchestrated-download',
    counts,
    businessResult: {
      successful: true,
      error: null,
      data: {
        id: 'drive-file-with-download',
        file: { s3url: signedUrl, mimetype: 'text/plain' },
      },
    },
  });
  const originalFetch = globalThis.fetch;
  let getCount = 0;
  try {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      getCount += 1;
      assert.equal(String(url), signedUrl);
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'error');
      return new Response(downloadedBytes, { status: 200 });
    }) as typeof fetch;
    const result = await execution.executePreparedStagedComposioPlan({
      planAuthority: fixture.preparedPlan.authority,
      parentDispatchLease: fixture.callLease,
      outputSchema: fixture.outputSchema,
    });
    assert.deepEqual(result, {
      status: 'returned',
      value: {
        successful: true,
        error: null,
        data: {
          id: 'drive-file-with-download',
          file: {
            file_downloaded: true,
            artifact_handle: `staged-file:${sha256}`,
            sha256,
            byte_count: downloadedBytes.byteLength,
            mimetype: 'text/plain',
          },
        },
      },
    });
    assert.equal(getCount, 1);
    assert.deepEqual(counts, { presign: 0, put: 0, business: 1 });
    assert.equal(JSON.stringify(result).includes(signedUrl), false);
    assert.equal(JSON.stringify(result).includes(TMP_HOME), false);

    const replay = await execution.executePreparedStagedComposioPlan({
      planAuthority: fixture.preparedPlan.authority,
      parentDispatchLease: fixture.callLease,
      outputSchema: fixture.outputSchema,
    });
    assert.deepEqual(replay, result);
    assert.equal(getCount, 1, 'download receipt replay enters no second GET');
    assert.equal(counts.business, 1, 'business receipt replay enters no second POST');
  } finally {
    globalThis.fetch = originalFetch;
  }
  const durable = JSON.stringify([
    ...eventlog.openEventLog().prepare(`SELECT * FROM staged_transfer_stages WHERE plan_id = ?`)
      .all(fixture.preparedPlan.planId),
    ...eventlog.openEventLog().prepare(`SELECT * FROM staged_transfer_stage_receipts WHERE plan_id = ?`)
      .all(fixture.preparedPlan.planId),
    ...eventlog.openEventLog().prepare(`SELECT data_json FROM events WHERE session_id = ?`)
      .all(fixture.session.id),
  ]);
  assert.equal(durable.includes(signedUrl), false);
  assert.equal(durable.includes(TMP_HOME), false);
  assert.equal((eventlog.openEventLog().prepare(`
    SELECT COUNT(*) AS count FROM staged_transfer_stage_receipts
     WHERE plan_id = ? AND terminal_state = 'returned'
  `).get(fixture.preparedPlan.planId) as { count: number }).count, 3);
});

test('a safe download retry gets a fresh attempt and never replays the business POST', async () => {
  const fixture = await fixtures.createProductionStagedBusinessFixture('orchestrated-download-retry', {
    startFirstStage: false,
  });
  const signedUrl = 'https://storage.example/private/retry.txt?token=download-retry-secret';
  const downloadedBytes = Buffer.from('download succeeds only on its next visible attempt\n', 'utf8');
  const counts = { presign: 0, put: 0, business: 0 };
  installProvider({
    label: 'orchestrated-download-retry',
    counts,
    businessResult: {
      successful: true,
      error: null,
      data: { id: 'retry-file', file: { s3url: signedUrl, mimetype: 'text/plain' } },
    },
  });
  const originalFetch = globalThis.fetch;
  let getCount = 0;
  try {
    globalThis.fetch = (async () => {
      getCount += 1;
      return getCount === 1
        ? new Response('temporary read failure', { status: 503 })
        : new Response(downloadedBytes, { status: 200 });
    }) as typeof fetch;
    const first = await execution.executePreparedStagedComposioPlan({
      planAuthority: fixture.preparedPlan.authority,
      parentDispatchLease: fixture.callLease,
      outputSchema: fixture.outputSchema,
    });
    assert.equal(first.status, 'provider_failed', JSON.stringify(first));
    assert.equal(getCount, 1);
    assert.equal(counts.business, 1);

    const second = await execution.executePreparedStagedComposioPlan({
      planAuthority: fixture.preparedPlan.authority,
      parentDispatchLease: fixture.callLease,
      outputSchema: fixture.outputSchema,
    });
    assert.equal(second.status, 'returned', JSON.stringify(second));
    assert.equal(getCount, 2, 'safe read retry is one new body with a new physical identity');
    assert.equal(counts.business, 1, 'business return is recovered rather than replayed');
  } finally {
    globalThis.fetch = originalFetch;
  }
  const attempts = eventlog.openEventLog().prepare(`
    SELECT attempt.attempt_ordinal, attempt.retry_of_stage_authority_id,
           physical.state, receipt.terminal_state
      FROM staged_transfer_stage_authorities attempt
      JOIN staged_transfer_stages stage ON stage.stage_id = attempt.stage_id
      JOIN physical_dispatches physical
        ON physical.session_id = attempt.session_id
       AND physical.source_user_seq = attempt.source_user_seq
       AND physical.physical_dispatch_id = attempt.physical_dispatch_id
      JOIN staged_transfer_stage_receipts receipt
        ON receipt.stage_authority_id = attempt.stage_authority_id
     WHERE attempt.plan_id = ? AND stage.stage_kind = 'download_transfer'
     ORDER BY attempt.attempt_ordinal
  `).all(fixture.preparedPlan.planId) as Array<Record<string, unknown>>;
  assert.deepEqual(attempts.map((row) => ({
    attempt_ordinal: row.attempt_ordinal,
    has_retry_of: row.retry_of_stage_authority_id !== null,
    state: row.state,
    terminal_state: row.terminal_state,
  })), [
    { attempt_ordinal: 1, has_retry_of: false, state: 'threw', terminal_state: 'threw' },
    { attempt_ordinal: 2, has_retry_of: true, state: 'returned', terminal_state: 'returned' },
  ]);
  assert.notEqual(
    (eventlog.openEventLog().prepare(`
      SELECT physical_dispatch_id FROM staged_transfer_stage_authorities
       WHERE plan_id = ? AND stage_ordinal = 2 AND attempt_ordinal = 1
    `).get(fixture.preparedPlan.planId) as { physical_dispatch_id: string }).physical_dispatch_id,
    (eventlog.openEventLog().prepare(`
      SELECT physical_dispatch_id FROM staged_transfer_stage_authorities
       WHERE plan_id = ? AND stage_ordinal = 2 AND attempt_ordinal = 2
    `).get(fixture.preparedPlan.planId) as { physical_dispatch_id: string }).physical_dispatch_id,
  );
});

test('provider-returned private presign and download origins are refused before fetch', async () => {
  const uploadDirectory = path.join(TMP_HOME, 'uploads');
  mkdirSync(uploadDirectory, { recursive: true });
  const sourcePath = path.join(uploadDirectory, 'private-origin.txt');
  writeFileSync(sourcePath, 'must never reach a private origin\n', { mode: 0o600 });
  const upload = await fixtures.createProductionStagedBusinessFixture('private-presign-origin', {
    uploadSourcePath: sourcePath,
    startFirstStage: false,
  });
  composio.__test__.setComposioApiKeyOverride('test-api-key');
  let presignCount = 0;
  let businessCount = 0;
  composio.__test__.setComposioClient({
    getClient: () => ({
      withOptions: () => ({
        files: {
          createPresignedURL: async () => {
            presignCount += 1;
            return {
              key: 'private-origin.txt',
              new_presigned_url: 'https://169.254.169.254/latest/meta-data',
              metadata: { storage_backend: 's3' },
            };
          },
        },
        tools: { execute: async () => { businessCount += 1; return { successful: true, data: {} }; } },
      }),
    }),
  });
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new Error('private origin must be refused before fetch');
    }) as typeof fetch;
    const uploadResult = await execution.executePreparedStagedComposioPlan({
      planAuthority: upload.preparedPlan.authority,
      parentDispatchLease: upload.callLease,
      outputSchema: upload.outputSchema,
    });
    assert.equal(uploadResult.status, 'provider_failed', JSON.stringify(uploadResult));
    assert.equal(presignCount, 1);
    assert.equal(fetchCount, 0);
    assert.equal(businessCount, 0);

    const download = await fixtures.createProductionStagedBusinessFixture('private-download-origin', {
      startFirstStage: false,
    });
    composio.__test__.setComposioClient({
      getClient: () => ({
        withOptions: () => ({
          tools: {
            execute: async () => {
              businessCount += 1;
              return {
                successful: true,
                error: null,
                data: {
                  id: 'private-download',
                  file: { s3url: 'https://127.0.0.1/private', mimetype: 'text/plain' },
                },
              };
            },
          },
        }),
      }),
    });
    const downloadResult = await execution.executePreparedStagedComposioPlan({
      planAuthority: download.preparedPlan.authority,
      parentDispatchLease: download.callLease,
      outputSchema: download.outputSchema,
    });
    assert.equal(downloadResult.status, 'provider_failed', JSON.stringify(downloadResult));
    assert.equal(fetchCount, 0, 'private provider download never reaches global fetch');
    assert.equal(businessCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
