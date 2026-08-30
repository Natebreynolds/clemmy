import assert from 'node:assert/strict';
import test from 'node:test';

import type { OriginHandoffLeaseMessage } from './native-bridge.js';
import { OriginHandoffMintCoordinator } from './origin-handoff-mint.js';

function lease(generation: number): OriginHandoffLeaseMessage {
  return {
    version: 2,
    token: `token-${generation}`,
    expiresAt: 1_900_000_000_000 + generation,
    handoffId: `handoff-${generation}`,
    generation,
    deviceId: 'device-1',
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('ten concurrent handoff requests share one mint and park operation', async () => {
  const coordinator = new OriginHandoffMintCoordinator();
  const pending = deferred<OriginHandoffLeaseMessage>();
  const parked: OriginHandoffLeaseMessage[] = [];
  let mintCount = 0;

  const mint = (): Promise<OriginHandoffLeaseMessage> => {
    mintCount += 1;
    return pending.promise;
  };
  const park = (value: OriginHandoffLeaseMessage): boolean => {
    parked.push(value);
    return true;
  };

  const requests = Array.from({ length: 10 }, () => coordinator.ensure(mint, park));
  assert.equal(mintCount, 1);
  assert.ok(requests.every((request) => request === requests[0]));

  pending.resolve(lease(1));
  assert.deepEqual(await Promise.all(requests), Array(10).fill(true));
  assert.deepEqual(parked, [lease(1)]);
});

test('a later request starts a fresh mint after the prior operation settles', async () => {
  const coordinator = new OriginHandoffMintCoordinator();
  const parked: OriginHandoffLeaseMessage[] = [];
  let generation = 0;

  const mint = async (): Promise<OriginHandoffLeaseMessage> => lease(++generation);
  const park = (value: OriginHandoffLeaseMessage): boolean => {
    parked.push(value);
    return true;
  };

  assert.equal(await coordinator.ensure(mint, park), true);
  assert.equal(await coordinator.ensure(mint, park), true);
  assert.equal(generation, 2);
  assert.deepEqual(parked, [lease(1), lease(2)]);
});

test('a rejected mint clears the single-flight slot for a retry', async () => {
  const coordinator = new OriginHandoffMintCoordinator();
  let mintCount = 0;
  let parkCount = 0;

  await assert.rejects(
    coordinator.ensure(
      async () => {
        mintCount += 1;
        throw new Error('mint unavailable');
      },
      () => {
        parkCount += 1;
        return true;
      },
    ),
    /mint unavailable/,
  );

  assert.equal(
    await coordinator.ensure(
      async () => {
        mintCount += 1;
        return lease(2);
      },
      () => {
        parkCount += 1;
        return true;
      },
    ),
    true,
  );
  assert.equal(mintCount, 2);
  assert.equal(parkCount, 1);
});
