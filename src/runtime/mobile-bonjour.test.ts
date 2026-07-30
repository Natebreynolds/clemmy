import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { BONJOUR_SERVICE_TYPE, bonjourArgs, startBonjourAdvertisement } from './mobile-bonjour.js';

class FakeChild extends EventEmitter {
  killed = false;
  kill(): boolean { this.killed = true; return true; }
}

function fakeSpawn(): { impl: typeof spawn; calls: Array<{ cmd: string; args: string[] }>; children: FakeChild[] } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const children: FakeChild[] = [];
  const impl = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const child = new FakeChild();
    children.push(child);
    return child;
  }) as unknown as typeof spawn;
  return { impl, calls, children };
}

test('advertises the exact dns-sd registration the iOS app browses for', () => {
  // Pin: the app filters on service type and reads fp from TXT. If this
  // shape drifts, rediscovery silently dies while pairing still works.
  const args = bonjourArgs({ port: 8421, fingerprint: 'abc123', hostname: 'Nates-Mac.local' });
  assert.deepEqual(args, ['-R', 'Clementine (Nates-Mac)', BONJOUR_SERVICE_TYPE, 'local', '8421', 'fp=abc123']);
  assert.equal(BONJOUR_SERVICE_TYPE, '_clemmy._tcp');
});

test('spawns dns-sd, respawns after exit, and stop() kills without respawning', async () => {
  const { impl, calls, children } = fakeSpawn();
  const ad = startBonjourAdvertisement({ port: 8421, fingerprint: 'fp1', spawnImpl: impl, hostname: 'Test' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'dns-sd');

  // Crash → respawn on a timer (2s base; just assert the timer path arms by
  // waiting past it with fake-free real time kept short: emit + poll).
  children[0].emit('exit', 1, null);
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(calls.length, 2, 'a crashed advertisement re-registers');

  ad.stop();
  assert.equal(children[1].killed, true);
  children[1].emit('exit', 0, null);
  await new Promise((resolve) => setTimeout(resolve, 2300));
  assert.equal(calls.length, 2, 'stop() ends supervision for good');
});

test('a missing dns-sd binary degrades to no advertisement, never a crash', () => {
  const impl = ((() => { throw new Error('ENOENT'); }) as unknown) as typeof spawn;
  const ad = startBonjourAdvertisement({ port: 8421, fingerprint: 'fp1', spawnImpl: impl, hostname: 'Test' });
  ad.stop(); // no throw = pass
});
