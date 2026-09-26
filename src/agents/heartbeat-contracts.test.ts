/**
 * Run: npx tsx --test src/agents/heartbeat-contracts.test.ts
 *
 * The owner's rules for a heartbeat are kept in their words, once each,
 * bounded, and read back numbered; how items reach them defaults to quiet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-heartbeat-contracts-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { addHeartbeatRule, loadHeartbeatContract, removeHeartbeatRule, renderHeartbeatRules, setHeartbeatNotify } = await import('./heartbeat-contracts.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

test('a heartbeat starts quiet with no rules; rules are added once each, in the owner words, and removed by id', () => {
  const fresh = loadHeartbeatContract('work-review');
  assert.equal(fresh.notify, 'quiet');
  assert.deepEqual(fresh.rules, []);

  const added = addHeartbeatRule('work-review', '  Skip anything from   test or fixture workflows. ', 'owner', new Date('2026-09-26T17:00:00Z'));
  assert.ok(added.ok);
  assert.equal(added.rule.text, 'Skip anything from test or fixture workflows.');
  assert.equal(added.rule.by, 'owner');
  const dup = addHeartbeatRule('work-review', 'skip anything from test or fixture workflows.', 'clementine');
  assert.deepEqual(dup, { ok: false, reason: 'duplicate' });
  assert.deepEqual(addHeartbeatRule('work-review', '   ', 'owner'), { ok: false, reason: 'empty' });
  assert.deepEqual(addHeartbeatRule('work-review', 'x'.repeat(401), 'owner'), { ok: false, reason: 'too_long' });

  const second = addHeartbeatRule('work-review', 'Only raise failures during work hours.', 'clementine');
  assert.ok(second.ok);
  assert.deepEqual(renderHeartbeatRules(loadHeartbeatContract('work-review')), [
    '1. Skip anything from test or fixture workflows.',
    '2. Only raise failures during work hours.',
  ]);

  const removed = removeHeartbeatRule('work-review', added.rule.id);
  assert.ok(removed);
  assert.deepEqual(removed!.rules.map((r) => r.text), ['Only raise failures during work hours.']);
  assert.equal(removeHeartbeatRule('work-review', 'rule-missing'), null);

  // Notify mode is per heartbeat and survives a reload.
  setHeartbeatNotify('work-review', 'push');
  assert.equal(loadHeartbeatContract('work-review').notify, 'push');
  assert.equal(loadHeartbeatContract('calendar').notify, 'quiet', 'another heartbeat is untouched');
});
