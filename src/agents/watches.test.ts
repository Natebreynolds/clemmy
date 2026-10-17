/**
 * Run: node scripts/run-tests-isolated.mjs src/agents/watches.test.ts
 *
 * A watch is a saved, read-only workflow with a `watch` declaration. Its run's
 * report becomes retained history, From Clem items for new findings (after
 * the owner's rules), and memory for what it learned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-watches-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';

const watches = await import('./watches.js');
const { writeWorkflow, readWorkflow } = await import('../memory/workflow-store.js');
const { validateWorkflowDefinition } = await import('../execution/workflow-validator.js');

const WATCH = { source: 'Slack #platform-49', lookFor: 'a client who sounds unhappy', purpose: 'tell_me' as const };

function deps(over: Partial<import('./watches.js').WatchRunDeps> = {}) {
  const raised: string[] = [];
  const remembered: string[] = [];
  const base: import('./watches.js').WatchRunDeps = {
    now: () => Date.parse('2026-10-17T18:00:00.000Z'),
    contract: (id) => ({ id, notify: 'quiet', rules: [], updatedAt: new Date(0).toISOString() }),
    judge: async () => null,
    publish: ({ finding }) => { raised.push(finding.title); },
    remember: ({ text }) => { remembered.push(text); return remembered.length; },
    ...over,
  };
  return { deps: base, raised, remembered };
}

test('a watch declaration survives save and read back, and a watch may not send', () => {
  writeWorkflow('platform-49-watch', {
    name: 'platform-49-watch',
    description: 'Watch #platform-49 for unhappy clients.',
    enabled: true,
    trigger: { schedule: '0 */2 * * *' },
    steps: [{ id: 'read', prompt: 'Read new messages in #platform-49 and judge them.', sideEffect: 'read' }],
    watch: WATCH,
  } as Parameters<typeof writeWorkflow>[1]);
  assert.deepEqual(readWorkflow('platform-49-watch')?.data.watch, WATCH);

  const sends = validateWorkflowDefinition({
    name: 'bad-watch',
    steps: [{ id: 'post', prompt: 'Post a summary to the channel.', sideEffect: 'send' }],
    watch: { source: 'Slack #platform-49', look_for: 'anything' },
  } as never);
  assert.ok(sends.errors.some((error) => /a watch only reads/.test(error)), sends.errors.join('\n'));
  const vague = validateWorkflowDefinition({
    name: 'vague-watch',
    steps: [{ id: 'read', prompt: 'Read the channel.', sideEffect: 'read' }],
    watch: { source: 'Slack #platform-49' },
  } as never);
  assert.ok(vague.errors.some((error) => /needs a source and what to look for/.test(error)));
});

test("a watch run's report is read from its last step, fenced or plain", () => {
  const fenced = 'Here is what I found:\n```json\n{"findings":[{"title":"Acme sounds frustrated","detail":"Two pings today.","link":"https://x/1","key":"m1"}],"learned":["Dana runs Acme."]}\n```';
  const report = watches.extractWatchReport({
    steps: [{ id: 'read' }, { id: 'judge' }],
    stepOutputs: { read: '[{"raw":true}]', judge: fenced },
  });
  assert.deepEqual(report, {
    findings: [{ key: 'm1', title: 'Acme sounds frustrated', detail: 'Two pings today.', link: 'https://x/1' }],
    learned: ['Dana runs Acme.'],
  });
  assert.equal(watches.extractWatchReport({ steps: [{ id: 'judge' }], stepOutputs: { judge: 'Nothing new today.' } }), null);
  const empty = watches.extractWatchReport({ steps: [{ id: 'judge' }], stepOutputs: { judge: { findings: [] } } });
  assert.deepEqual(empty, { findings: [], learned: [] }, 'an empty list is a normal, good run');
});

test('new findings are raised once, repeats are not, and learned things are remembered once', async () => {
  const slug = 'watch-raise-once';
  const report = {
    findings: [{ key: 'm1', title: 'Acme sounds frustrated' }, { key: 'm2', title: 'Beta asked for a refund' }],
    learned: ['Dana runs Acme.'],
  };
  const first = deps();
  const one = await watches.recordWatchRun({ workflowSlug: slug, workflowName: 'Watch', watch: WATCH, runId: 'r1', report }, first.deps);
  assert.deepEqual({ newFindings: one.newFindings, surfaced: one.surfaced, learned: one.learned }, { newFindings: 2, surfaced: 2, learned: 1 });
  assert.deepEqual(first.raised, ['Acme sounds frustrated', 'Beta asked for a refund']);
  assert.deepEqual(first.remembered, ['Dana runs Acme.']);

  const second = deps();
  const again = await watches.recordWatchRun({
    workflowSlug: slug, workflowName: 'Watch', watch: WATCH, runId: 'r2',
    report: { findings: [{ key: 'm1', title: 'Acme sounds frustrated' }, { key: 'm3', title: 'Gamma went quiet' }], learned: ['dana runs acme.'] },
  }, second.deps);
  assert.equal(again.newFindings, 1);
  assert.deepEqual(second.raised, ['Gamma went quiet'], 'a finding already raised is never raised again');
  assert.deepEqual(second.remembered, [], 'the same learning is remembered once');

  const replay = deps();
  const replayed = await watches.recordWatchRun({ workflowSlug: slug, workflowName: 'Watch', watch: WATCH, runId: 'r2', report }, replay.deps);
  assert.equal(replayed.recorded, false, 'a replayed completion records nothing twice');
  assert.deepEqual(replay.raised, []);
  assert.equal(watches.loadWatchState(slug).runs.length, 2);
});

test("the owner's rules hold a finding back, and a learn-only watch raises nothing", async () => {
  const ruled = deps({
    contract: (id) => ({ id, notify: 'quiet', rules: [{ id: 'r', text: 'skip anything from the bot account', by: 'owner', createdAt: '' }], updatedAt: '' }),
    judge: async ({ finding }) => ({ surface: !/bot/i.test(finding.title) }),
  });
  await watches.recordWatchRun({
    workflowSlug: 'watch-rules', workflowName: 'Watch', watch: WATCH, runId: 'r1',
    report: { findings: [{ key: 'b', title: 'The bot posted a deploy notice' }, { key: 'c', title: 'Acme asked for a date' }], learned: [] },
  }, ruled.deps);
  assert.deepEqual(ruled.raised, ['Acme asked for a date']);
  const held = watches.loadWatchState('watch-rules').findings.find((finding) => finding.key === 'b');
  assert.equal(held?.heldBy, 'rule');

  const learnOnly = deps();
  await watches.recordWatchRun({
    workflowSlug: 'watch-learn', workflowName: 'Watch', watch: { ...WATCH, purpose: 'learn' }, runId: 'r1',
    report: { findings: [{ key: 'x', title: 'Acme asked for a date' }], learned: ['Acme renews in March.'] },
  }, learnOnly.deps);
  assert.deepEqual(learnOnly.raised, []);
  assert.deepEqual(learnOnly.remembered, ['Acme renews in March.']);
});

test('a run with no findings list is recorded as such, so a broken watch is visible', async () => {
  const result = await watches.recordWatchRun({ workflowSlug: 'watch-missing', workflowName: 'Watch', watch: WATCH, runId: 'r1', report: null }, deps().deps);
  assert.equal(result.report, 'missing');
  assert.equal(watches.loadWatchState('watch-missing').runs[0]?.report, 'missing');
});

test('the watch list shows each watch with what it found and learned', async () => {
  const views = await watches.listWatchViews();
  const view = views.find((entry) => entry.slug === 'platform-49-watch');
  assert.ok(view);
  assert.equal(view.source, 'Slack #platform-49');
  assert.equal(view.lookFor, 'a client who sounds unhappy');
  assert.equal(view.schedule, '0 */2 * * *');
  assert.equal(view.notify, 'quiet');
});
