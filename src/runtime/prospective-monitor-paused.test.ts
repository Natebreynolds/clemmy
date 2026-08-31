import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-prospective-monitor-paused-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_PROSPECTIVE_MEMORY = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const prospective = await import('./prospective-intentions.js');
const { syncProspectiveIntentions } = await import('./prospective-sync.js');

test.after(() => {
  prospective.closeProspectiveIntentionsDbForTest();
  rmSync(testHome, { recursive: true, force: true });
});

test('Future Commitments projects unavailable inbox/calendar watches as blocked with one prepared-read setup path', () => {
  const now = new Date('2026-08-30T18:00:00.000Z');
  const result = syncProspectiveIntentions(now);
  assert.equal(result.sources.monitor, 2);

  for (const sourceId of ['inbox', 'calendar'] as const) {
    const monitor = prospective.getProspectiveIntention(`monitor:${sourceId}`);
    assert.ok(monitor, `${sourceId} monitor intention should be materialized`);
    assert.equal(monitor.status, 'blocked');
    assert.equal(monitor.metadata?.availability, 'paused');
    assert.equal(monitor.metadata?.reason, 'prepared_read_authority_unavailable');
    assert.deepEqual(monitor.trigger, { kind: 'manual' });
    assert.equal(monitor.action.kind, 'notify');
    assert.equal(monitor.action.ref, 'automation_opportunity_propose');
    assert.equal(monitor.approvalMode, 'enforce_at_action');
    assert.equal(monitor.recurring, false);
    assert.equal(monitor.evidence?.reason, 'prepared_read_authority_unavailable');
    const setup = monitor.evidence?.setupAction as Record<string, unknown>;
    assert.equal(setup.firstTool, 'automation_opportunity_propose');
    assert.deepEqual(setup.authorityPath, [
      'automation_opportunity_propose',
      'automation_opportunity_review_request',
      'automation_read_pilot_request',
      'automation_recurrence_request',
    ]);
  }

  const firstInbox = prospective.getProspectiveIntention('monitor:inbox')!;
  syncProspectiveIntentions(new Date('2026-08-30T18:01:00.000Z'));
  const reloadedInbox = prospective.getProspectiveIntention('monitor:inbox')!;
  assert.equal(reloadedInbox.status, 'blocked');
  assert.equal(reloadedInbox.generation, firstInbox.generation);
  assert.equal(reloadedInbox.updatedAt, firstInbox.updatedAt, 'unchanged paused truth must not churn or reactivate on the next daemon sync');

  const projected = prospective.buildProspectiveIntentionContext({
    query: 'What are you watching in my inbox and calendar?',
    now,
  });
  assert.match(projected.text, /\[BLOCKED\].*Inbox watch is paused/i);
  assert.match(projected.text, /\[BLOCKED\].*Calendar watch is paused/i);
  assert.doesNotMatch(projected.text, /\[ACTIVE\].*(?:Inbox|Calendar) watch/i);
  assert.doesNotMatch(projected.text, /while watching (?:inbox|calendar)/i);
});
