import assert from 'node:assert/strict';
import test from 'node:test';
import { groupSessions, pinChangeForDrop } from './groupSessions';
import type { Session } from '../types';

const chat = (id: string, pinned: boolean, updatedAt: string) => ({ id, pinned, updatedAt, tags: [] }) as unknown as Session;

test('the Pinned section is marked as the drop target that pins', () => {
  const now = Date.parse('2026-10-15T18:00:00.000Z');
  const groups = groupSessions([chat('a', true, '2026-10-01T10:00:00.000Z'), chat('b', false, '2026-10-15T17:00:00.000Z')], now);
  assert.deepEqual(groups.map((group) => [group.label, group.pinned ?? false]), [['Pinned', true], ['Today', false]]);
});

test('a drop pins onto Pinned, unpins elsewhere, and leaves a chat already there alone', () => {
  assert.equal(pinChangeForDrop({ pinned: false }, true), true);
  assert.equal(pinChangeForDrop({ pinned: true }, false), false);
  assert.equal(pinChangeForDrop({ pinned: true }, true), null);
  assert.equal(pinChangeForDrop({ pinned: false }, false), null);
});
