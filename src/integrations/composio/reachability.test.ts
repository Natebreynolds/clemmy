import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-composio-reachability-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const reachability = await import('./reachability.js');
const client = await import('./client.js');

after(() => {
  client.__test__.setConnectedAccountsLoader(null);
  client.__test__.setComposioApiKeyOverride(null);
  rmSync(TEST_HOME, { recursive: true, force: true });
});

/** The shape Node's fetch rejects with: a TypeError whose cause carries the code. */
function fetchFailed(code: string): Error {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ${code}`), { code }) });
}

test('a network failure is named by its own code, in plain words', () => {
  assert.match(reachability.composioReachabilityProblem(fetchFailed('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'))!, /certificate isn’t trusted/);
  assert.match(reachability.composioReachabilityProblem(fetchFailed('SELF_SIGNED_CERT_IN_CHAIN'))!, /certificate isn’t trusted/);
  assert.match(reachability.composioReachabilityProblem(fetchFailed('ENOTFOUND'))!, /address couldn’t be found/);
  assert.match(reachability.composioReachabilityProblem(fetchFailed('UND_ERR_CONNECT_TIMEOUT'))!, /didn’t answer in time/);
  assert.match(reachability.composioReachabilityProblem(fetchFailed('ECONNRESET'))!, /refused or dropped/);
  assert.match(reachability.composioReachabilityProblem(new TypeError('fetch failed'))!, /network request to Composio failed/);
  const sdkTimeout = Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });
  assert.match(reachability.composioReachabilityProblem(sdkTimeout)!, /didn’t answer in time/);
  assert.equal(reachability.composioReachabilityProblem(new Error('Toolkit not found')), null,
    'a provider answer is not a reachability problem');
});

test('a recorded reason keeps its codes, and reads back as the same plain words', () => {
  const detail = reachability.composioErrorDetail(fetchFailed('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'));
  assert.match(detail, /^fetch failed \(.*UNABLE_TO_GET_ISSUER_CERT_LOCALLY/);
  assert.match(reachability.composioReadProblem(detail), /certificate isn’t trusted/);
  assert.match(reachability.composioReadProblem('connected-account listing deadline exceeded'), /didn’t answer in time/);
  assert.match(reachability.composioReadProblem('raw connected-account listing returned HTTP 401'), /rejected the saved API key/);
  assert.match(reachability.composioReadProblem('raw connected-account listing returned an invalid payload'), /didn’t return the list/);
});

test('a bounded read answers at its deadline instead of waiting on the provider', async () => {
  const never = new Promise<string>(() => { /* a dead network never answers */ });
  const started = Date.now();
  await assert.rejects(reachability.withComposioDeadline(never, 50), /did not answer within/);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(await reachability.withComposioDeadline(Promise.resolve('ok'), 50), 'ok');
});

test('a failed connected-account listing is a named problem, never "no apps", until a listing succeeds', async () => {
  client.__test__.setComposioApiKeyOverride('test-composio-key');
  client.__test__.setConnectedAccountsLoader(async () => { throw fetchFailed('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'); });
  assert.deepEqual(await client.listConnectedToolkits(), []);
  assert.match(client.composioConnectionsProblem()!, /certificate isn’t trusted/);

  client.__test__.setConnectedAccountsLoader(async () => []);
  assert.deepEqual(await client.listConnectedToolkits(), []);
  assert.equal(client.composioConnectionsProblem(), null, 'a genuine empty listing clears the problem');
});

test('a reply that arrived while this process was held is read, not called unanswered', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => { res.end('{"items":[]}'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const blockFor = (ms: number) => { const until = Date.now() + ms; while (Date.now() < until) { /* held */ } };
  try {
    // The main thread is held past the deadline before the reply can be read.
    const graced = reachability.withComposioDeadline(fetch(`http://127.0.0.1:${port}/`).then((res) => res.json()), 100, { graceMs: 2_000 });
    blockFor(1_300);
    assert.deepEqual(await graced, { items: [] }, 'the waiting reply is read within the grace period');

    // A deadline that fires on time still answers at its deadline.
    const never = new Promise<never>(() => { /* the provider never answers */ });
    const started = Date.now();
    await assert.rejects(reachability.withComposioDeadline(never, 100, { graceMs: 2_000 }), /did not answer within/);
    assert.ok(Date.now() - started < 1_000, 'an on-time deadline grants no grace');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
