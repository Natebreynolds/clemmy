/** Run with scripts/run-tests-isolated.mjs; no daemon, providers, or home needed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplySpeaker } from './reply-speaker';

test('the speaker button reads one reply at a time, stops on a second press, and switches between replies', () => {
  const calls: string[] = [];
  const speaker = new ReplySpeaker({ say: (text) => calls.push(`say:${text}`), stop: () => calls.push('stop') });
  const seen: Array<string | null> = [];
  speaker.subscribe((key) => seen.push(key));
  assert.equal(speaker.toggle('a', 'First reply.'), true);
  assert.equal(speaker.current, 'a');
  assert.equal(speaker.toggle('b', 'Second reply.'), true, 'another reply takes over');
  assert.equal(speaker.current, 'b');
  assert.equal(speaker.toggle('b', 'Second reply.'), false, 'pressing the reply being read stops it');
  assert.equal(speaker.current, null);
  speaker.toggle('a', 'First reply.');
  speaker.idle();
  assert.equal(speaker.current, null, 'the player finishing clears the state');
  assert.deepEqual(calls, ['stop', 'say:First reply.', 'stop', 'say:Second reply.', 'stop', 'stop', 'say:First reply.']);
  assert.deepEqual(seen, ['a', 'b', null, 'a', null]);
});
