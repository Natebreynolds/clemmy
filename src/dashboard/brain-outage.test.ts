/**
 * Run: node scripts/run-tests-isolated.mjs src/dashboard/brain-outage.test.ts
 *
 * Home follows a brain outage: one update when the backups take over, one
 * question when the chosen brain answers again, and both retire when the
 * outage closes. The records carry typed facts; Clem's voice pass writes
 * what the owner reads.
 */
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NotificationRecord } from '../runtime/notifications.js';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-brain-outage-cards-'));
process.env.CLEMENTINE_HOME = HOME;

const backups = await import('../runtime/harness/brain-backups.js');
const cards = await import('./brain-outage.js');

const OUTAGE_FILE = path.join(HOME, 'brain-outage.json');

beforeEach(() => {
  rmSync(OUTAGE_FILE, { force: true });
  backups.__brainBackupsTest__.reset(OUTAGE_FILE);
  backups.__brainBackupsTest__.setOptions(() => ['chosen-brain', 'backup-one'].map((modelId) => ({
    id: 'api_key' as const, value: `api_key:${modelId}`, label: `Provider — ${modelId}`, available: true, modelId,
  })));
  process.env[backups.BRAIN_BACKUPS_ENV] = JSON.stringify(['backup-one']);
});

after(() => {
  backups.__brainBackupsTest__.reset();
  rmSync(HOME, { recursive: true, force: true });
});

function fakeHome() {
  const added: NotificationRecord[] = [];
  const read: string[] = [];
  return { added, read, deps: { add: (item: NotificationRecord) => { added.push(item); }, markRead: (id: string) => { read.push(id); } } };
}

test('switched, then back, then closed: one update, one question, both retired', async () => {
  const home = fakeHome();
  const stop = cards.startBrainOutageCards(home.deps);
  try {
    backups.noteBrainNoAnswer('chosen-brain', 'model.http_5xx');
    backups.noteBrainNoAnswer('chosen-brain', 'model.http_5xx');
    const outage = backups.currentBrainOutage()!;
    assert.equal(home.added.length, 1);
    const switched = home.added[0]!;
    assert.equal(switched.id, `brain-outage-${outage.id}-switched`);
    assert.equal(switched.metadata?.inboxOnly, true, 'a switch is news on Home, not a push');
    assert.equal(switched.metadata?.needsAttention, undefined, 'telling asks nothing');
    assert.equal(switched.metadata?.heartbeatId, 'brain-health');
    assert.match(switched.title, /chosen-brain stopped answering, so backup-one is answering for now/);
    assert.match(switched.body, /server errors/);

    backups.setBrainOutageProber(async () => {});
    assert.equal(await backups.runBrainOutageProbe(), 'recovered');
    assert.deepEqual(home.read, [switched.id], 'the update gives way to the question');
    const back = home.added[1]!;
    assert.equal(back.id, `brain-outage-${outage.id}-back`);
    assert.equal(back.metadata?.needsAttention, true);
    assert.equal(back.metadata?.brainOutageId, outage.id);
    assert.match(back.body, /switch back to chosen-brain\? If not, backup-one becomes the brain/);

    assert.equal(await cards.resolveBrainOutage('not-this-outage', 'switch_back'), false);
    assert.equal(await cards.resolveBrainOutage(outage.id, 'switch_back'), true);
    assert.equal(backups.currentBrainOutage(), null);
    assert.deepEqual(home.read.slice(1), [switched.id, back.id]);
  } finally {
    stop();
  }
});

test('an outage that outlived a restart keeps its card', () => {
  backups.noteBrainNoAnswer('chosen-brain', 'model.overloaded');
  backups.noteBrainNoAnswer('chosen-brain', 'model.overloaded');
  const home = fakeHome();
  const stop = cards.startBrainOutageCards(home.deps);
  try {
    assert.equal(home.added.length, 1);
    assert.match(home.added[0]!.body, /overloaded/);
  } finally {
    stop();
  }
});
