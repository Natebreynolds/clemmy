/**
 * Provider-boundary Codex auth tests. Keep this file isolated from the broad
 * codex-model shape suite so CLEMENTINE_HOME is set before auth/config modules
 * load and no host credentials can ever be observed or changed.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-codex-model-auth-'));
const STATE_DIR = path.join(TMP_HOME, 'state');
const AUTH_FILE = path.join(STATE_DIR, 'auth.json');
const DEAD_FILE = path.join(STATE_DIR, 'codex-auth-dead.json');
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;
process.env.AUTH_MODE = 'codex_oauth';
process.env.NODE_ENV = 'test';
process.env.CLEMMY_CODEX_TRANSPARENT_RETRY_DELAY_MS = '0';
mkdirSync(STATE_DIR, { recursive: true });

const { CodexResponsesModel } = await import('./codex-model.js');
const { withModelFallback, __test__: fallbackTest } = await import('./fallback-model.js');
const {
  CODEX_GRANT_PROVENANCE,
  __setRefreshTokenImplForTests,
  getStoredCodexOAuthTokens,
  isCodexAuthDead,
} = await import('../auth-store.js');

const originalFetch = globalThis.fetch;
fallbackTest.setDeadBrainsFileForTests(path.join(STATE_DIR, 'brain-auth-dead.json'));
fallbackTest.setSilentBrainsFileForTests(path.join(STATE_DIR, 'brain-silent-cooldown.json'));

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function accessToken(accountId: string): string {
  return `${base64Url({ alg: 'none' })}.${base64Url({
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.sig`;
}

function writeGrant(grantId: string): string {
  const token = accessToken(`acct-${grantId}`);
  writeFileSync(AUTH_FILE, JSON.stringify({
    source: 'native',
    codexOauth: {
      grantProvenance: CODEX_GRANT_PROVENANCE,
      grantId,
      accessToken: token,
      refreshToken: `refresh-${grantId}`,
      accountId: `acct-${grantId}`,
      lastRefresh: new Date().toISOString(),
    },
  }), 'utf-8');
  return token;
}

function request(): ModelRequest {
  return {
    input: [{ role: 'user', content: 'hello' }],
    tools: [],
    handoffs: [],
    modelSettings: {},
    outputType: 'text',
    tracing: false,
  } as unknown as ModelRequest;
}

function successResponse(text: string): ModelResponse {
  return { output: [{ type: 'message', content: text }], usage: {} } as unknown as ModelResponse;
}

beforeEach(() => {
  rmSync(AUTH_FILE, { force: true });
  rmSync(DEAD_FILE, { force: true });
  rmSync(path.join(STATE_DIR, 'codex-refresh.lock'), { force: true });
  __setRefreshTokenImplForTests(null);
  globalThis.fetch = originalFetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  __setRefreshTokenImplForTests(null);
  fallbackTest.setDeadBrainsFileForTests(null);
  fallbackTest.setSilentBrainsFileForTests(null);
  delete process.env.CLEMMY_CODEX_TRANSPARENT_RETRY_DELAY_MS;
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('explicit terminal model auth is latched before fallback can swallow the Codex error', async () => {
  writeGrant('grant-current');
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { code: 'token_revoked', message: 'token_revoked' } }),
    { status: 401, statusText: 'Unauthorized' },
  );

  const fallback: Model = {
    getResponse: async () => successResponse('fallback survived'),
    getStreamedResponse: async function* () { /* unused */ },
  } as Model;
  const routed = withModelFallback([
    { label: 'codex-terminal-boundary', getModel: () => new CodexResponsesModel('gpt-5.5') },
    { label: 'safe-fallback', getModel: () => fallback },
  ]);

  const result = await routed.getResponse(request());
  assert.deepEqual(result, successResponse('fallback survived'), 'outer fallback still completes the turn');
  assert.equal(isCodexAuthDead(), true, 'provider boundary persisted DEAD before fallback caught the error');
  assert.equal(getStoredCodexOAuthTokens(), null, 'no later Codex request can receive the revoked bearer');
  assert.equal(existsSync(DEAD_FILE), true);
});

test('a late terminal response from an old request cannot latch a replacement grant', async () => {
  writeGrant('grant-old');
  globalThis.fetch = async () => {
    writeGrant('grant-fresh');
    return new Response('invalid_grant: old request was revoked', {
      status: 401,
      statusText: 'Unauthorized',
    });
  };

  await assert.rejects(
    new CodexResponsesModel('gpt-5.5').getResponse(request()),
    /invalid_grant/i,
  );
  assert.equal(isCodexAuthDead(), false, 'generation mismatch rejected the stale latch');
  assert.equal(getStoredCodexOAuthTokens()?.grantId, 'grant-fresh');
  assert.equal(existsSync(DEAD_FILE), false);
});

test('a marker-less model 401 refresh failure stays transient and never latches DEAD', async () => {
  writeGrant('grant-transient-401');
  globalThis.fetch = async () => new Response('Unauthorized', {
    status: 401,
    statusText: 'Unauthorized',
  });
  __setRefreshTokenImplForTests(async () => {
    throw Object.assign(new Error('temporary token endpoint outage'), { status: 503 });
  });

  await assert.rejects(
    new CodexResponsesModel('gpt-5.5').getResponse(request()),
    /401 Unauthorized/i,
  );
  assert.equal(isCodexAuthDead(), false);
  assert.equal(getStoredCodexOAuthTokens()?.grantId, 'grant-transient-401');
  assert.equal(existsSync(DEAD_FILE), false);
});

test('persisted terminal latch records the request-bound generation', async () => {
  writeGrant('grant-recorded');
  globalThis.fetch = async () => new Response('token_revoked', {
    status: 403,
    statusText: 'Forbidden',
  });

  await assert.rejects(new CodexResponsesModel('gpt-5.5').getResponse(request()), /token_revoked/i);
  const persisted = JSON.parse(readFileSync(DEAD_FILE, 'utf-8')) as { grantId?: string };
  assert.equal(persisted.grantId, 'grant-recorded');
});

test('terminal auth inside an HTTP-200 SSE failure is latched before wrappers see it', async () => {
  writeGrant('grant-sse-terminal');
  const sse = 'data: ' + JSON.stringify({
    type: 'response.failed',
    response: {
      id: 'resp_terminal',
      error: { code: 'invalid_grant', message: 'refresh family revoked' },
    },
  }) + '\n\n';
  globalThis.fetch = async () => new Response(sse, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

  await assert.rejects(
    new CodexResponsesModel('gpt-5.5').getResponse(request()),
    /revoked or expired|invalid_grant/i,
  );
  assert.equal(isCodexAuthDead(), true);
  const persisted = JSON.parse(readFileSync(DEAD_FILE, 'utf-8')) as { grantId?: string };
  assert.equal(persisted.grantId, 'grant-sse-terminal');
});
