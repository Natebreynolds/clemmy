import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOptionalChannel, CHANNEL_RETRY_BASE_MS, CHANNEL_RETRY_MAX_MS } from './optional-channel.js';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 2026-09-10: the observed crash. Discord's gateway handshake timed out, the
// awaited rejection unwound out of onReady, and process.exit(1) killed a daemon
// that was already bound and serving. The whole point of this helper is that
// this error can no longer reject.
function handshakeTimeout(): Error {
  const err = new Error('Opening handshake has timed out');
  err.stack = `Error: Opening handshake has timed out
    at ClientRequest.<anonymous> (/Applications/Clementine.app/Contents/Resources/daemon/node_modules/ws/lib/websocket.js:890:7)
    at ClientRequest.emit (node:events:509:28)
    at TLSSocket.emitRequestTimeout (node:_http_client:948:9)`;
  return err;
}

test('a channel that fails its handshake does NOT reject — the daemon stays up', async () => {
  await assert.doesNotReject(async () => {
    await startOptionalChannel(
      'Discord',
      'Discord chat stays offline',
      () => Promise.reject(handshakeTimeout()),
      { schedule: () => {}, maxAttempts: 1 },
    );
  });
});

test('a NON-transport failure is also survivable — a bound daemon is worth more than a channel', async () => {
  await assert.doesNotReject(async () => {
    await startOptionalChannel(
      'Slack',
      'Slack chat stays offline',
      () => Promise.reject(new TypeError('invalid token shape')),
      { schedule: () => {}, maxAttempts: 1 },
    );
  });
});

test('a failed start is retried, and a later success ends the retry chain', async () => {
  let attempts = 0;
  const delays: number[] = [];
  // The retry is fire-and-forget in production, so a pin must drain the chain
  // explicitly — awaiting only the first call proves nothing about the retries.
  const pending: Array<Promise<void>> = [];
  await startOptionalChannel(
    'Discord',
    'Discord chat stays offline',
    () => {
      attempts += 1;
      // Fail twice, then connect — the ordinary flaky-network shape.
      return attempts < 3 ? Promise.reject(handshakeTimeout()) : Promise.resolve();
    },
    {
      schedule: (run, delayMs) => { delays.push(delayMs); pending.push(run()); },
    },
  );
  while (pending.length > 0) await pending.shift();
  assert.equal(attempts, 3, 'the channel must keep trying until it connects');
  assert.deepEqual(delays, [CHANNEL_RETRY_BASE_MS, CHANNEL_RETRY_BASE_MS * 2], 'backoff must double');
});

test('backoff is capped so a long outage never schedules an absurd delay', async () => {
  const delays: number[] = [];
  const pending: Array<Promise<void>> = [];
  await startOptionalChannel(
    'Discord',
    'Discord chat stays offline',
    () => Promise.reject(handshakeTimeout()),
    {
      schedule: (run, delayMs) => { delays.push(delayMs); pending.push(run()); },
      maxAttempts: 12,
    },
  );
  while (pending.length > 0) await pending.shift();
  assert.equal(Math.max(...delays), CHANNEL_RETRY_MAX_MS);
  assert.ok(delays.every((d) => d <= CHANNEL_RETRY_MAX_MS));
});

test('a healthy channel starts exactly once and schedules nothing', async () => {
  let attempts = 0;
  let scheduled = 0;
  await startOptionalChannel(
    'Discord',
    'Discord chat stays offline',
    () => { attempts += 1; return Promise.resolve(); },
    { schedule: () => { scheduled += 1; } },
  );
  assert.equal(attempts, 1);
  assert.equal(scheduled, 0);
});

// ── The connection pin ──────────────────────────────────────────────────────
// The reason this defect shipped: `isSurvivableSocketError` was correct and
// fully green in crash-guards.test.ts, but it was wired to only two of the three
// doors an error can leave startup through. A predicate test proves nothing
// about which call sites use it. These assert the WIRING.
test('every onReady routes Discord and Slack through the degrading start, and the bind stays fatal', () => {
  const source = readFileSync(path.join(PKG_DIR, 'src', 'index.ts'), 'utf8');
  const readyBlocks = [...source.matchAll(/onReady: async \(\) => \{([\s\S]*?)\n(\s*)\},/g)].map((m) => m[1]);
  assert.ok(readyBlocks.length >= 2, `expected both daemon entrypoints to have an onReady, found ${readyBlocks.length}`);
  for (const block of readyBlocks) {
    assert.doesNotMatch(block, /await startDiscordBot\(/,
      'a bare awaited Discord login inside onReady fails the daemon readiness boundary on a third-party flake');
    assert.doesNotMatch(block, /await startSlackBot\(/,
      'a bare awaited Slack socket-mode start inside onReady fails the readiness boundary on a third-party flake');
    assert.match(block, /startOptionalChannel\('Discord'/);
    assert.match(block, /startOptionalChannel\('Slack'/);
    // The bind must STAY fatal: a daemon that cannot open its own door must not
    // be reported healthy. Only the outbound legs degrade.
    assert.match(block, /await startWebhookServer\(assistant\)/,
      'the listener bind must remain a fatal readiness gate');
    assert.doesNotMatch(block, /startOptionalChannel\('Webhook'/,
      'the webhook bind must never be downgraded to an optional channel');
  }
});

test('the startup catch consults the same survivability predicate as the crash guards', () => {
  const source = readFileSync(path.join(PKG_DIR, 'src', 'index.ts'), 'utf8');
  const tail = source.slice(source.indexOf('main().catch('));
  assert.match(tail, /isSurvivableSocketError\(err\)/,
    'an error AWAITED inside main() reaches neither uncaughtException nor unhandledRejection — it lands here, and this was the unguarded third door');
  assert.match(tail, /process\.exit\(1\)/, 'a real bug must still exit');
});

test('the disposable transcription prune is never a boot gate', () => {
  const source = readFileSync(path.join(PKG_DIR, 'src', 'index.ts'), 'utf8');
  const calls = [...source.matchAll(/await prepareLocalTranscriptionRuntime\(\);/g)];
  assert.ok(calls.length >= 3, `expected every daemon entry to prune, found ${calls.length}`);
  for (const call of calls) {
    // Walk back to the nearest enclosing statement and require a try.
    const before = source.slice(Math.max(0, call.index! - 400), call.index!);
    assert.match(before, /try\s*\{\s*$/,
      'a stale-artifact prune must not be able to stop the daemon from booting');
  }
});
