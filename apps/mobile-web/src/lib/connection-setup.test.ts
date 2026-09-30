import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connectionFormBody, connectionFormFields, continueVerifiedConnection, createConnectionSetupApi,
  matchingConnectionRequest, safeConnectionUrl, type ConnectionForm, type ConnectionRequest,
} from './connection-setup.js';
import type { api } from './api.js';

const pending: ConnectionRequest = {
  requestId: 'dep-42', sessionId: 'thread/one', sourceUserSeq: 42, toolkit: 'work_mail',
  capability: 'WORK_MAIL_READ', continueLabel: 'Continue with work mail', awaitingSignIn: false,
  clientRequestId: 'connection-stable-42',
};
const options = ['Not now', pending.continueLabel];

test('only the exact host question in this conversation makes setup available', () => {
  assert.equal(matchingConnectionRequest(pending, pending.sessionId, options), pending);
  assert.equal(matchingConnectionRequest(null, pending.sessionId, options), null);
  assert.equal(matchingConnectionRequest(pending, 'another thread', options), null);
  assert.equal(matchingConnectionRequest(pending, pending.sessionId, ['continue with work mail']), null);
  assert.equal(matchingConnectionRequest(pending, pending.sessionId, [pending.continueLabel + ' ']), null);
  assert.equal(matchingConnectionRequest({ ...pending, clientRequestId: '' }, pending.sessionId, options), null);
});

test('a verified connection resumes with only the exact label and host-issued identities', async () => {
  const calls: unknown[][] = [];
  assert.equal(await continueVerifiedConnection(pending, { request: pending, ready: true }, options, async (...args) => { calls.push(args); }), true);
  assert.deepEqual(calls, [[pending.continueLabel, { connectionRequestId: pending.requestId, clientRequestId: pending.clientRequestId }]]);
});

test('not-ready, missing, retired and mismatched requests never resume a task', async () => {
  let calls = 0;
  const resume = async () => { calls++; };
  assert.equal(await continueVerifiedConnection(pending, { request: pending, ready: false }, options, resume), false);
  assert.equal(await continueVerifiedConnection(pending, { request: null, ready: true }, options, resume), false);
  assert.equal(await continueVerifiedConnection(pending, { request: pending, ready: true }, [], resume), false);
  for (const patch of [
    { requestId: 'new-request' }, { sessionId: 'other-thread' }, { sourceUserSeq: 43 },
    { toolkit: 'other-app' }, { capability: 'OTHER_READ' }, { clientRequestId: 'new-key' },
    { continueLabel: 'Different answer' },
  ]) {
    const changed = { ...pending, ...patch };
    assert.equal(await continueVerifiedConnection(pending, { request: changed, ready: true }, [...options, changed.continueLabel], resume), false);
  }
  assert.equal(calls, 0);
});

test('failed continuation remains retryable with the same host key', async () => {
  const keys: string[] = [];
  const result = { request: pending, ready: true };
  await assert.rejects(continueVerifiedConnection(pending, result, options, async (_text, context) => {
    keys.push(context.clientRequestId);
    throw new Error('Could not send');
  }), /Could not send/);
  await continueVerifiedConnection(pending, result, options, async (_text, context) => { keys.push(context.clientRequestId); });
  assert.deepEqual(keys, [pending.clientRequestId, pending.clientRequestId]);
});

test('browser links allow normal web URLs and reject executable or embedded-credential links', () => {
  assert.equal(safeConnectionUrl('https://accounts.example.com/sign-in?state=abc'), 'https://accounts.example.com/sign-in?state=abc');
  assert.equal(safeConnectionUrl('http://localhost:9000/auth'), 'http://localhost:9000/auth');
  for (const url of ['javascript:alert(1)', 'data:text/html,sign in', 'file:///secret', 'https://name:secret@example.com', '/relative', '', null]) {
    assert.equal(safeConnectionUrl(url), null);
  }
});

const credentialForm: ConnectionForm = {
  kind: 'credentials', setup: { name: 'Work mail', fields: [], authScheme: 'API_KEY' },
};
const detailsForm: ConnectionForm = {
  kind: 'details', setup: { name: 'Work mail', fields: [{ name: 'domain', label: 'Domain', required: true }], authScheme: 'OAUTH2' },
};
const oauthForm: ConnectionForm = {
  kind: 'oauth_app', app: {
    name: 'Work mail', authScheme: 'OAUTH2', callbackUrl: 'https://callback.example.com/oauth',
    fields: [
      { name: 'client_id', label: 'Client ID' }, { name: 'client_secret', label: 'Client secret', isSecret: true },
      { name: 'redirect_uri', label: 'Redirect address' }, { name: 'scopes', label: 'Scopes', required: false },
    ], accountFields: [{ name: 'domain', label: 'Domain' }],
  },
};

test('forms preserve desktop schema semantics without copying extra values into credentials', () => {
  assert.equal(connectionFormFields(credentialForm).accountFields[0].name, 'generic_api_key');
  assert.deepEqual(connectionFormFields({ kind: 'details', setup: { ...detailsForm.setup, fields: [] } }).accountFields, []);
  assert.deepEqual(connectionFormBody(credentialForm, { generic_api_key: ' secret ', injected: 'ignored' }), {
    credentials: { generic_api_key: 'secret' }, authScheme: 'API_KEY',
  });
  assert.deepEqual(connectionFormBody(detailsForm, { domain: ' work ', injected: 'ignored' }), { details: { domain: 'work' } });
  assert.deepEqual(connectionFormBody(oauthForm, {
    client_id: ' id ', client_secret: 'secret', scopes: '', domain: 'work', redirect_uri: 'injected',
  }), { credentials: { client_id: 'id', client_secret: 'secret' }, details: { domain: 'work' }, authScheme: 'OAUTH2' });
});

test('mobile setup calls proof-aware bridge endpoints and never supplies a connection id', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const request: typeof api = async <T>(path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return { ok: true, connectionId: 'server-returned-only' } as T;
  };
  const setup = createConnectionSetupApi(request);
  await setup.load(pending.sessionId);
  await setup.authorize(pending);
  await setup.submit(pending, credentialForm, { generic_api_key: 'secret' });
  await setup.submit(pending, detailsForm, { domain: 'work' });
  await setup.submit(pending, oauthForm, { client_id: 'id', client_secret: 'secret', domain: 'work' });
  await setup.verify(pending);
  assert.deepEqual(calls.map((call) => call.path), [
    '/m/api/connection-requests?sessionId=thread%2Fone',
    '/m/api/composio/toolkits/work_mail/authorize',
    '/m/api/composio/toolkits/work_mail/setup-credentials',
    '/m/api/composio/toolkits/work_mail/authorize',
    '/m/api/composio/toolkits/work_mail/oauth-app',
    '/m/api/connection-requests/dep-42/verify',
  ]);
  for (const call of calls) assert.equal(call.init?.cache, 'no-store');
  const bodies = calls.slice(1).map((call) => JSON.parse(String(call.init?.body)));
  assert.deepEqual(bodies[0], { connectionRequestId: pending.requestId, sessionId: pending.sessionId });
  assert.deepEqual(bodies[1], { credentials: { generic_api_key: 'secret' }, authScheme: 'API_KEY', ...bodies[0] });
  assert.deepEqual(bodies[4], { sessionId: pending.sessionId });
  assert.equal(JSON.stringify(bodies).includes('connectionId'), false);
  assert.equal(JSON.stringify(bodies).includes('server-returned-only'), false);
});

test('transport and verification errors propagate rather than reporting ready', async () => {
  const setup = createConnectionSetupApi(async () => { throw new Error('Connection provider is unavailable'); });
  await assert.rejects(setup.load(pending.sessionId), /unavailable/);
  await assert.rejects(setup.authorize(pending), /unavailable/);
  await assert.rejects(setup.verify(pending), /unavailable/);
});
