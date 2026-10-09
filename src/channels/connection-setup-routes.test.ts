/** Run: node scripts/run-tests-isolated.mjs src/channels/connection-setup-routes.test.ts */
import assert from 'node:assert/strict';
import { randomUUID, webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import express, { type RequestHandler } from 'express';
import type { ComposioToolkitDetail } from '../integrations/composio/client.js';
import type { ConnectionSetupRouteDependencies } from './connection-setup-routes.js';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-connection-routes-'));
process.env.CLEMENTINE_HOME = testHome;

const originalFetch = globalThis.fetch;
const fixtureOrigins = new Set<string>();
let externalRequests = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (!fixtureOrigins.has(url.origin)) {
    externalRequests += 1;
    throw new Error('External network is forbidden in connection route fixtures.');
  }
  return originalFetch(input, init);
};

const eventlog = await import('../runtime/harness/eventlog.js');
const dependencies = await import('../runtime/harness/dependency-request.js');
const setup = await import('../runtime/harness/connection-setup.js');
const mobileSessions = await import('../runtime/mobile-sessions.js');
const { sessionFingerprint } = await import('../runtime/mobile-device-proof.js');
const { createMobileRouter, MOBILE_SESSION_COOKIE } = await import('./mobile-routes.js');
const { registerConnectionSetupRoutes } = await import('./connection-setup-routes.js');

const toolkit = 'fixturecrm';
const capability = 'FIXTURECRM_LIST_RECORDS';
const secret = 'fixture-only-private-value-do-not-echo';

function parkedTask(sessionId: string) {
  eventlog.createSession({ id: sessionId, kind: 'chat', userId: 'fixture-owner' });
  const source = eventlog.appendEvent({
    sessionId, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Read the controlled fixture account.' },
  });
  const dependency = dependencies.parkDependencyRequest({
    sessionId, sourceUserSeq: source.seq, turn: 1, kind: 'connection_missing',
    connectionSubject: {
      kind: 'exact_capability_connection', provider: 'authorized_composio',
      toolkit, capability, capabilityRef: 'cap:resolved:fixturecrm_list_records',
      discoveryQuery: 'Read the controlled fixture account',
      continueOptionId: 'opt-1', continueOptionLabel: 'Continue the controlled fixture task',
    },
  });
  return { sessionId, connectionRequestId: dependency.requestId };
}

function field(name: string, isSecret = false, defaultValue: string | null = null) {
  return { name, label: name, description: null, default: defaultValue, isSecret, required: true };
}

function detail(oauth = false): ComposioToolkitDetail {
  return {
    slug: toolkit, name: 'Fixture CRM', description: null, appUrl: null, authGuideUrl: null,
    managedSchemes: [],
    modes: [{
      mode: oauth ? 'OAUTH2' : 'API_KEY', authHintUrl: null,
      creationFields: oauth ? [field('client_id'), field('client_secret', true), field('redirect_uri', false, 'https://fixture.invalid/callback')] : [],
      initiationFields: oauth ? [] : [field('api_token', true)],
    }],
  };
}

function routeDeps(overrides: Partial<ConnectionSetupRouteDependencies> = {}): ConnectionSetupRouteDependencies {
  return {
    prepareConnection: async () => { throw new Error('Unexpected provider authorization'); },
    getDetail: async () => { throw new Error('Unexpected toolkit metadata request'); },
    setupCredentials: async () => { throw new Error('Unexpected credential setup'); },
    setupOAuthApp: async () => { throw new Error('Unexpected OAuth app setup'); },
    invalidate: () => {},
    verify: (context) => setup.verifyConnectionSetup(context, async () => ({ ok: false, identifier: capability, reason: 'missing_or_changed' })),
    ...overrides,
  };
}

async function deviceProof(pair: CryptoKeyPair, method: string, requestPath: string, fingerprint: string): Promise<string> {
  const head = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'clem-dpop+jws' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    htm: method, htu: requestPath.split('?')[0], iat: Math.floor(Date.now() / 1000), jti: randomUUID(), sfp: fingerprint,
  })).toString('base64url');
  const signature = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, Buffer.from(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(signature).toString('base64url')}`;
}

async function startHarness(deps: ConnectionSetupRouteDependencies, productionRegistration = false) {
  const stateDir = path.join(testHome, randomUUID());
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const publicKey = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  const session = await mobileSessions.createSession({ devicePublicKeyJwk: publicKey, deviceLabel: 'Connection fixture phone' }, { stateDir });
  const mobile = createMobileRouter({ isAdminAuthorized: () => false, stateDir, pwaDistDir: null });
  const guard = (mobile as express.Router & { requireMobileSession: RequestHandler }).requireMobileSession;
  const router = productionRegistration ? mobile : express.Router();
  if (!productionRegistration) registerConnectionSetupRoutes(router, guard, '/api', { requireContext: true, dependencies: deps });
  const app = express();
  app.use(express.json());
  app.use('/m', router);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fixtureOrigins.add(origin);
  return {
    async request(method: string, requestPath: string, body?: unknown, auth: 'proof' | 'cookie' | 'none' = 'proof') {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (auth !== 'none') headers.cookie = `${MOBILE_SESSION_COOKIE}=${session.token}`;
      if (auth === 'proof') headers['x-clem-device-proof'] = await deviceProof(pair, method, requestPath, sessionFingerprint(session.token));
      return fetch(`${origin}${requestPath}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      fixtureOrigins.delete(origin);
    },
  };
}

function assertNoCredentialEvents(sessionId: string): void {
  const events = eventlog.listEvents(sessionId, { limit: 100 });
  assert.equal(JSON.stringify(events).includes(secret), false, 'private setup values must never enter the conversation event log');
}

beforeEach(() => { eventlog.resetEventLog(); externalRequests = 0; });
afterEach(() => assert.equal(externalRequests, 0, 'provider operations must be injected'));
after(() => {
  eventlog.closeEventLog();
  globalThis.fetch = originalFetch;
  rmSync(testHome, { recursive: true, force: true });
});

test('production mobile registration rejects anonymous requests and cookie-only requests on every setup endpoint', async () => {
  const context = parkedTask('mobile-setup-guard');
  const harness = await startHarness(routeDeps(), true);
  try {
    const requests = [
      ['GET', `/m/api/connection-requests?sessionId=${context.sessionId}`],
      ['POST', `/m/api/connection-requests/${context.connectionRequestId}/verify`],
      ...['authorize', 'setup-credentials', 'oauth-app'].map((action) => ['POST', `/m/api/composio/toolkits/${toolkit}/${action}`]),
    ];
    for (const [method, requestPath] of requests) {
      for (const auth of ['none', 'cookie'] as const) {
        const response = await harness.request(method!, requestPath!, method === 'GET' ? undefined : context, auth);
        assert.equal(response.status, 401, `${method} ${requestPath} ${auth}`);
        const body = await response.json() as { error: string };
        assert.equal(body.error, auth === 'none' ? 'NO_SESSION' : 'BAD_DEVICE_PROOF');
      }
    }
  } finally { await harness.close(); }
});

test('proof-authenticated mobile setup still requires the matching parked task and toolkit before provider calls', async () => {
  const context = parkedTask('mobile-setup-context');
  const another = parkedTask('mobile-setup-another-context');
  let providerCalls = 0;
  const harness = await startHarness(routeDeps({
    prepareConnection: async () => { providerCalls += 1; throw new Error('must not run'); },
    getDetail: async () => { providerCalls += 1; return detail(); },
  }));
  try {
    for (const action of ['authorize', 'setup-credentials', 'oauth-app']) {
      const requestPath = `/m/api/composio/toolkits/${toolkit}/${action}`;
      const missing = await harness.request('POST', requestPath, { credentials: { api_token: secret } });
      assert.equal(missing.status, 400, action);
      const wrongSession = await harness.request('POST', requestPath, { ...context, sessionId: another.sessionId });
      assert.equal(wrongSession.status, 409, action);
      const wrongToolkit = await harness.request('POST', `/m/api/composio/toolkits/unrelated/${action}`, context);
      assert.equal(wrongToolkit.status, 409, action);
    }
    const wrongVerify = await harness.request('POST', `/m/api/connection-requests/${context.connectionRequestId}/verify`, { sessionId: another.sessionId });
    assert.equal(wrongVerify.status, 409);
    assert.equal(providerCalls, 0);
    assertNoCredentialEvents(context.sessionId);
  } finally { await harness.close(); }
});

test('authorization and verification use only the server-returned account, preserving the original request', async () => {
  const context = parkedTask('mobile-setup-authorize');
  let invalidations = 0;
  const harness = await startHarness(routeDeps({
    prepareConnection: async (slug, _deps, details) => {
      assert.equal(slug, toolkit);
      assert.deepEqual(details, { tenant: 'fixture-tenant' });
      return { kind: 'authorization', redirectUrl: 'https://fixture.invalid/sign-in', connectionId: 'ca_server_fixture' };
    },
    invalidate: () => { invalidations += 1; },
    verify: (bound) => setup.verifyConnectionSetup(bound, async (selections) => {
      assert.deepEqual(selections, [{ identifier: capability, connectionId: 'ca_server_fixture' }]);
      return { ok: true };
    }),
  }));
  try {
    const beforeResponse = await harness.request('GET', `/m/api/connection-requests?sessionId=${context.sessionId}`);
    assert.equal(beforeResponse.status, 200);
    assert.equal(beforeResponse.headers.get('cache-control'), 'no-store');
    const before = await beforeResponse.json() as { request: { requestId: string; clientRequestId: string } };
    const response = await harness.request('POST', `/m/api/composio/toolkits/${toolkit}/authorize`, {
      ...context, details: { tenant: 'fixture-tenant', ignored: 7 }, connectionId: 'ca_browser_invented',
    });
    assert.equal(response.status, 200);
    const authorized = await response.json() as { connectionId: string };
    assert.equal(authorized.connectionId, 'ca_server_fixture');
    const verify = await harness.request('POST', `/m/api/connection-requests/${context.connectionRequestId}/verify`, { sessionId: context.sessionId });
    assert.equal(verify.status, 200);
    const verified = await verify.json() as { ready: boolean; request: { requestId: string; clientRequestId: string } };
    assert.equal(verified.ready, true);
    assert.equal(verified.request.requestId, before.request.requestId);
    assert.equal(verified.request.clientRequestId, before.request.clientRequestId);
    assert.ok(dependencies.currentConnectionDependency(context.sessionId), 'provider readiness must not satisfy the capability dependency');
    assert.equal(invalidations, 1);
  } finally { await harness.close(); }
});

test('credential setup validates metadata fields and persists only the returned account, never private inputs', async () => {
  const context = parkedTask('mobile-setup-credentials');
  let submitted = 0;
  const harness = await startHarness(routeDeps({
    getDetail: async () => detail(),
    setupCredentials: async (slug, scheme, credentials) => {
      submitted += 1;
      assert.equal(slug, toolkit);
      assert.equal(scheme, 'API_KEY');
      assert.deepEqual(credentials, { api_token: secret });
      return { ok: true, authConfigId: 'ac_fixture', connectionId: 'ca_credentials_fixture' };
    },
  }));
  try {
    const requestPath = `/m/api/composio/toolkits/${toolkit}/setup-credentials`;
    const missing = await harness.request('POST', requestPath, { ...context, credentials: { unknown: secret } });
    assert.equal(missing.status, 400);
    assert.equal(submitted, 0);
    const saved = await harness.request('POST', requestPath, {
      ...context, authScheme: 'API_KEY', connectionId: 'ca_browser_invented', credentials: { api_token: secret, unknown: 'discarded' },
    });
    assert.equal(saved.status, 200);
    const body = await saved.json();
    assert.deepEqual(body, { ok: true, authConfigId: 'ac_fixture', connectionId: 'ca_credentials_fixture' });
    await setup.verifyConnectionSetup(context, async (selections) => {
      assert.deepEqual(selections, [{ identifier: capability, connectionId: 'ca_credentials_fixture' }]);
      return { ok: true };
    });
    assert.equal(submitted, 1);
    assertNoCredentialEvents(context.sessionId);
  } finally { await harness.close(); }
});

test('developer-app setup keeps the metadata callback and validated credentials before starting authorization', async () => {
  const context = parkedTask('mobile-setup-oauth-app');
  const calls: string[] = [];
  const harness = await startHarness(routeDeps({
    getDetail: async () => detail(true),
    setupOAuthApp: async (slug, scheme, credentials, callback) => {
      calls.push('setup');
      assert.equal(slug, toolkit);
      assert.equal(scheme, 'OAUTH2');
      assert.deepEqual(credentials, { client_id: 'fixture-client', client_secret: secret });
      assert.equal(callback, 'https://fixture.invalid/callback');
      return { ok: true, authConfigId: 'ac_oauth_fixture' };
    },
    prepareConnection: async () => {
      calls.push('authorize');
      return { kind: 'authorization', redirectUrl: 'https://fixture.invalid/sign-in', connectionId: 'ca_oauth_fixture' };
    },
  }));
  try {
    const response = await harness.request('POST', `/m/api/composio/toolkits/${toolkit}/oauth-app`, {
      ...context, authScheme: 'OAUTH2', credentials: {
        client_id: 'fixture-client', client_secret: secret, redirect_uri: 'https://untrusted.invalid/callback', extra: 'discarded',
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ['setup', 'authorize']);
    await setup.verifyConnectionSetup(context, async (selections) => {
      assert.deepEqual(selections, [{ identifier: capability, connectionId: 'ca_oauth_fixture' }]);
      return { ok: true };
    });
    assertNoCredentialEvents(context.sessionId);
  } finally { await harness.close(); }
});

test('provider failures cannot echo submitted credentials or mark the task ready', async () => {
  const context = parkedTask('mobile-setup-provider-failure');
  const fail = async () => { throw new Error(`Provider echoed ${secret}`); };
  const harness = await startHarness(routeDeps({ prepareConnection: fail, verify: fail }));
  try {
    const failed = await harness.request('POST', `/m/api/composio/toolkits/${toolkit}/authorize`, { ...context, details: { token: secret } });
    assert.equal(failed.status, 500);
    assert.equal((await failed.text()).includes(secret), false);
    const unverified = await harness.request('POST', `/m/api/connection-requests/${context.connectionRequestId}/verify`, { sessionId: context.sessionId });
    assert.equal(unverified.status, 503);
    assert.equal((await unverified.text()).includes(secret), false);
    assert.ok(dependencies.currentConnectionDependency(context.sessionId));
    assertNoCredentialEvents(context.sessionId);
  } finally { await harness.close(); }
});

test('a connect that cannot reach Composio says why in plain words, never with provider text', async () => {
  const context = parkedTask('mobile-setup-unreachable');
  const unreachable = async (): Promise<never> => {
    throw new TypeError(`fetch failed ${secret}`, { cause: Object.assign(new Error('self-signed'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }) });
  };
  const harness = await startHarness(routeDeps({ prepareConnection: unreachable }));
  try {
    const failed = await harness.request('POST', `/m/api/composio/toolkits/${toolkit}/authorize`, { ...context, details: { token: secret } });
    assert.equal(failed.status, 503);
    const body = await failed.text();
    assert.match(body, /Couldn’t reach Composio from this computer: this network’s security certificate isn’t trusted/);
    assert.equal(body.includes(secret), false);
    assert.ok(dependencies.currentConnectionDependency(context.sessionId), 'the task stays parked on the connection');
    assertNoCredentialEvents(context.sessionId);
  } finally { await harness.close(); }
});

test('a newer source during metadata loading prevents a contextual credential mutation', async () => {
  const context = parkedTask('mobile-setup-metadata-race');
  let markStarted!: () => void;
  let release!: (value: ComposioToolkitDetail) => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const metadata = new Promise<ComposioToolkitDetail>((resolve) => { release = resolve; });
  let mutations = 0;
  const harness = await startHarness(routeDeps({
    getDetail: async () => { markStarted(); return metadata; },
    setupCredentials: async () => { mutations += 1; return { ok: true, authConfigId: 'ac_stale', connectionId: 'ca_stale' }; },
  }));
  try {
    const pending = harness.request('POST', `/m/api/composio/toolkits/${toolkit}/setup-credentials`, { ...context, credentials: { api_token: secret } });
    await started;
    eventlog.appendEvent({ sessionId: context.sessionId, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'Do a different task now.' } });
    release(detail());
    const response = await pending;
    assert.equal(response.status, 409);
    assert.equal(mutations, 0);
    assert.equal(setup.readConnectionSetup(context.sessionId), null);
    assertNoCredentialEvents(context.sessionId);
  } finally { await harness.close(); }
});
