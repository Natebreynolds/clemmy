/**
 * Run: npx tsx --test src/autoresearch/improvement-proposer.test.ts
 *
 * Phase C improvement proposer — the human-gated ACT step of the OODA loop:
 *   - buildImprovementProposals: deterministic detectors map observatory
 *     tool-health → structured proposals (skill_pitfall / tool_desc / retire_fact)
 *   - stable ids dedup re-proposals across nightly runs
 *   - proposerEnabled / approveEnabled gating (PROPOSE off by default; APPLY needs
 *     an explicit human call and never self-applies)
 *   - approveProposal: manual = acknowledge only; auto skill_pitfall applies via
 *     appendSkillPitfall and is journaled; dryRun never mutates
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-improve-proposer';
process.env.CLEMENTINE_HOME = TEST_HOME;
delete process.env.CLEMMY_IMPROVEMENT_PROPOSER;
delete process.env.CLEMMY_MEMORY_APPROVE;

const {
  buildImprovementProposals,
  proposerEnabled,
  proposeFromReport,
  recordProposals,
  listProposals,
  listPendingProposals,
  approveProposal,
  dismissProposal,
  proposalsFromStepFailures,
  buildWorkflowStepProposals,
  splitWorkflowStepTarget,
  proposalsFromDoctorFixes,
  buildDoctorFixProposals,
} = await import('./improvement-proposer.js');
const { writeDistilledSkill, loadSkill } = await import('../memory/skill-store.js');
const { writeWorkflow, readWorkflow } = await import('../memory/workflow-store.js');
const { revertStepEdit, listStepEditBackups } = await import('../execution/workflow-step-edit.js');
const { recordProposedFix, applyProposedFix } = await import('../execution/workflow-diagnosis.js');
import type { ObservatoryReport } from './observatory.js';
import type { StepFailureObservation } from './improvement-proposer.js';
import type { WorkflowDefinition } from '../memory/workflow-store.js';
import type { ProposedFix, WorkflowDiagnosis } from '../execution/workflow-diagnosis.js';

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

test('source stays text-searchable: no NUL delimiters in stable proposal keys', () => {
  const source = readFileSync(new URL('./improvement-proposer.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('\0'), false);
});

function report(toolHealth: ObservatoryReport['toolHealth']): ObservatoryReport {
  return {
    generatedAt: '2026-06-23T00:00:00.000Z',
    windowStart: '2026-06-22T00:00:00.000Z',
    windowEnd: '2026-06-23T00:00:00.000Z',
    toolHealth,
    workflowRuns: [],
    sessionCount: 1,
    totalToolCalls: toolHealth.reduce((s, h) => s + h.calls, 0),
    suggestions: [],
  };
}

const NO_SKILLS = () => [];
const NO_NOISE = () => 0;
const NOW = '2026-06-23T12:00:00.000Z';

// ── detectors ────────────────────────────────────────────────────────────────

test('error-rate tool with NO owning skill → a manual tool_desc proposal', () => {
  const r = report([{ toolName: 'flaky_tool', calls: 10, successes: 4, errors: 6, emptyResults: 0, wrongPickHints: 0 }]);
  const proposals = buildImprovementProposals(r, { listSkills: NO_SKILLS, countRetirableNoise: NO_NOISE, nowIso: NOW });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].kind, 'tool_desc');
  assert.equal(proposals[0].applyMode, 'manual');
  assert.equal(proposals[0].target, 'flaky_tool');
  assert.match(proposals[0].evidence, /60% over 10 calls/);
});

test('error-rate tool referenced by a skill → an auto skill_pitfall on that skill', () => {
  const r = report([{ toolName: 'composio_execute_tool', calls: 8, successes: 2, errors: 6, emptyResults: 0, wrongPickHints: 0 }]);
  const proposals = buildImprovementProposals(r, {
    listSkills: () => [{ name: 'outreach', body: 'use composio_execute_tool to send' }],
    countRetirableNoise: NO_NOISE,
    nowIso: NOW,
  });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].kind, 'skill_pitfall');
  assert.equal(proposals[0].applyMode, 'auto');
  assert.equal(proposals[0].target, 'outreach');
  assert.match(proposals[0].proposedText, /composio_execute_tool` failed 75%/);
});

test('empty + wrong-pick tool → a tool_desc "when NOT to use" proposal', () => {
  const r = report([{ toolName: 'wide_search', calls: 10, successes: 3, errors: 0, emptyResults: 5, wrongPickHints: 3 }]);
  const proposals = buildImprovementProposals(r, { listSkills: NO_SKILLS, countRetirableNoise: NO_NOISE, nowIso: NOW });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].kind, 'tool_desc');
  assert.match(proposals[0].proposedText, /when NOT to use wide_search/);
});

test('internal-noise count > 0 → an auto retire_fact proposal', () => {
  const r = report([]);
  const proposals = buildImprovementProposals(r, { listSkills: NO_SKILLS, countRetirableNoise: () => 12, nowIso: NOW });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].kind, 'retire_fact');
  assert.equal(proposals[0].applyMode, 'auto');
  assert.match(proposals[0].proposedText, /Retire 12 self-referential/);
});

test('low-call tools (<5) and healthy tools produce nothing', () => {
  const r = report([
    { toolName: 'rare', calls: 3, successes: 0, errors: 3, emptyResults: 0, wrongPickHints: 0 },
    { toolName: 'healthy', calls: 50, successes: 50, errors: 0, emptyResults: 0, wrongPickHints: 0 },
  ]);
  assert.deepEqual(buildImprovementProposals(r, { listSkills: NO_SKILLS, countRetirableNoise: NO_NOISE, nowIso: NOW }), []);
});

test('proposal ids are stable across runs (dedup substrate)', () => {
  const r = report([{ toolName: 'flaky_tool', calls: 10, successes: 4, errors: 6, emptyResults: 0, wrongPickHints: 0 }]);
  const a = buildImprovementProposals(r, { listSkills: NO_SKILLS, countRetirableNoise: NO_NOISE, nowIso: NOW })[0];
  const changedWindow = report([{ toolName: 'flaky_tool', calls: 20, successes: 10, errors: 10, emptyResults: 0, wrongPickHints: 0 }]);
  const b = buildImprovementProposals(changedWindow, { listSkills: NO_SKILLS, countRetirableNoise: NO_NOISE, nowIso: '2026-07-01T00:00:00Z' })[0];
  assert.equal(a.id, b.id, 'same issue → same id regardless of when proposed');
  assert.notEqual(a.proposedText, b.proposedText, 'visible telemetry can still update under the stable id');
});

// ── gating ─────────────────────────────────────────────────────────────────

test('proposerEnabled: ON by default (graduated); only CLEMMY_IMPROVEMENT_PROPOSER=off disables', () => {
  delete process.env.CLEMMY_IMPROVEMENT_PROPOSER;
  assert.equal(proposerEnabled(), true, 'default ON');
  process.env.CLEMMY_IMPROVEMENT_PROPOSER = 'off';
  assert.equal(proposerEnabled(), false, '=off kill-switch');
  process.env.CLEMMY_IMPROVEMENT_PROPOSER = 'on';
  assert.equal(proposerEnabled(), true);
  delete process.env.CLEMMY_IMPROVEMENT_PROPOSER;
});

test('proposeFromReport drafts by default, no-op only with the =off kill-switch', () => {
  const r = report([{ toolName: 'flaky_tool', calls: 10, successes: 4, errors: 6, emptyResults: 0, wrongPickHints: 0 }]);
  rmSync(`${TEST_HOME}/state/autoresearch`, { recursive: true, force: true });
  delete process.env.CLEMMY_IMPROVEMENT_PROPOSER; // unset = default ON now
  const onByDefault = proposeFromReport(r, { listSkills: NO_SKILLS, countRetirableNoise: NO_NOISE });
  assert.equal(onByDefault.ran, true, 'drafts by default');
  assert.ok(onByDefault.added >= 1);
  process.env.CLEMMY_IMPROVEMENT_PROPOSER = 'off';
  assert.equal(proposeFromReport(r, { listSkills: NO_SKILLS, countRetirableNoise: NO_NOISE }).ran, false, '=off no-op');
  delete process.env.CLEMMY_IMPROVEMENT_PROPOSER;
});

test('proposeFromReport uses injected workflow-step failure evidence', () => {
  rmSync(`${TEST_HOME}/state/autoresearch`, { recursive: true, force: true });
  process.env.CLEMMY_IMPROVEMENT_PROPOSER = 'on';
  try {
    const res = proposeFromReport(report([]), {
      listSkills: NO_SKILLS,
      countRetirableNoise: NO_NOISE,
      collectStepFailures: () => [
        obs('wf', 'scrape', 'run-1', ['min_items: got 2, needs 10']),
        obs('wf', 'scrape', 'run-2', ['min_items: got 3, needs 10']),
      ],
      nowIso: NOW,
    });

    assert.equal(res.ran, true);
    assert.equal(res.added, 1);
    const [pending] = listPendingProposals();
    assert.equal(pending.kind, 'workflow_step');
    assert.equal(pending.target, 'wf::scrape');
  } finally {
    delete process.env.CLEMMY_IMPROVEMENT_PROPOSER;
  }
});

// ── persistence ──────────────────────────────────────────────────────────────

test('recordProposals dedups by id and preserves a resolved status', () => {
  rmSync(`${TEST_HOME}/state/autoresearch`, { recursive: true, force: true });
  const r = report([{ toolName: 'flaky_tool', calls: 10, successes: 4, errors: 6, emptyResults: 0, wrongPickHints: 0 }]);
  const fresh = buildImprovementProposals(r, { listSkills: NO_SKILLS, countRetirableNoise: NO_NOISE, nowIso: NOW });
  const first = recordProposals(fresh);
  assert.equal(first.added, 1);
  // Dismiss it, then re-record the SAME proposal → not resurrected as pending.
  dismissProposal(fresh[0].id);
  const second = recordProposals(fresh);
  assert.equal(second.added, 0, 're-proposing a known id adds nothing');
  assert.equal(listPendingProposals().length, 0, 'dismissed stays dismissed');
});

test('approveProposal: dismissed auto proposals are terminal and do not apply later', () => {
  rmSync(`${TEST_HOME}/state/autoresearch`, { recursive: true, force: true });
  writeDistilledSkill({ name: 'dismissed-skill', description: 'd', body: 'Use bad_tool carefully.', origin: { kind: 'manual' } });
  const [p] = buildImprovementProposals(
    report([{ toolName: 'bad_tool', calls: 10, successes: 1, errors: 9, emptyResults: 0, wrongPickHints: 0 }]),
    {
      listSkills: () => [{ name: 'dismissed-skill', body: 'Use bad_tool carefully.' }],
      countRetirableNoise: NO_NOISE,
      nowIso: NOW,
    },
  );
  recordProposals([p]);
  assert.equal(dismissProposal(p.id).ok, true);

  const res = approveProposal(p.id);

  assert.equal(res.ok, true);
  assert.equal(res.status, 'dismissed');
  assert.equal(res.reason, 'already');
  assert.ok(!loadSkill('dismissed-skill')!.body.includes('Pitfalls (observed)'), 'dismissed proposal did not mutate the skill');
});

test('dismissProposal: resolved auto proposals are terminal and are not downgraded', () => {
  rmSync(`${TEST_HOME}/state/autoresearch`, { recursive: true, force: true });
  delete process.env.CLEMMY_MEMORY_APPROVE;
  writeDistilledSkill({ name: 'applied-skill', description: 'd', body: 'Use stale_tool carefully.', origin: { kind: 'manual' } });
  const [p] = buildImprovementProposals(
    report([{ toolName: 'stale_tool', calls: 10, successes: 1, errors: 9, emptyResults: 0, wrongPickHints: 0 }]),
    {
      listSkills: () => [{ name: 'applied-skill', body: 'Use stale_tool carefully.' }],
      countRetirableNoise: NO_NOISE,
      nowIso: NOW,
    },
  );
  recordProposals([p]);
  const applied = approveProposal(p.id);
  assert.equal(applied.status, 'applied');

  const dismissed = dismissProposal(p.id);

  assert.equal(dismissed.ok, true);
  assert.equal(dismissed.status, 'applied');
  assert.equal(dismissed.reason, 'already');
  assert.equal(listProposals()[0].status, 'applied');
});

test('recordProposals refreshes a pending proposal with newer evidence instead of duplicating it', () => {
  rmSync(`${TEST_HOME}/state/autoresearch`, { recursive: true, force: true });
  const first = buildImprovementProposals(
    report([{ toolName: 'flaky_tool', calls: 10, successes: 4, errors: 6, emptyResults: 0, wrongPickHints: 0 }]),
    { listSkills: NO_SKILLS, countRetirableNoise: NO_NOISE, nowIso: NOW },
  )[0];
  const newer = buildImprovementProposals(
    report([{ toolName: 'flaky_tool', calls: 20, successes: 10, errors: 10, emptyResults: 0, wrongPickHints: 0 }]),
    { listSkills: NO_SKILLS, countRetirableNoise: NO_NOISE, nowIso: '2026-06-24T00:00:00.000Z' },
  )[0];
  assert.equal(first.id, newer.id);
  assert.notEqual(first.evidence, newer.evidence);

  assert.equal(recordProposals([first]).added, 1);
  assert.equal(recordProposals([newer]).added, 0);
  const [pending] = listPendingProposals();
  assert.equal(pending.id, first.id);
  assert.equal(pending.evidence, newer.evidence);
  assert.equal(pending.proposedAt, first.proposedAt, 'first-seen timestamp is preserved');
});

// ── apply (human-gated) ────────────────────────────────────────────────────────

test('approveProposal: disabled when CLEMMY_MEMORY_APPROVE=off', () => {
  process.env.CLEMMY_MEMORY_APPROVE = 'off';
  const res = approveProposal('anything');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'disabled');
  delete process.env.CLEMMY_MEMORY_APPROVE;
});

test('approveProposal: a missing id is reported, never throws', () => {
  const res = approveProposal('deadbeef0000');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-found');
});

test('approveProposal: a manual tool_desc proposal is acknowledged, not mutated', () => {
  rmSync(`${TEST_HOME}/state/autoresearch`, { recursive: true, force: true });
  const r = report([{ toolName: 'flaky_tool', calls: 10, successes: 4, errors: 6, emptyResults: 0, wrongPickHints: 0 }]);
  const [p] = buildImprovementProposals(r, { listSkills: NO_SKILLS, countRetirableNoise: NO_NOISE, nowIso: NOW });
  recordProposals([p]);
  const res = approveProposal(p.id);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'approved');
  assert.equal(res.applied, 0);
  assert.equal(res.reason, 'manual-acknowledged');
  assert.equal(listPendingProposals().length, 0, 'acknowledged item leaves the pending list');
});

// ── workflow_step: improve a workflow's own steps from run history ───────────

function obs(workflow: string, stepId: string, runId: string, problems: string[]): StepFailureObservation {
  return { workflow, stepId, runId, problems };
}

test('proposalsFromStepFailures: a ONE-off failure is noise — no proposal', () => {
  const out = proposalsFromStepFailures([obs('wf', 'scrape', 'run-1', ['min_items: got 2, needs 10'])], NOW);
  assert.equal(out.length, 0);
});

test('proposalsFromStepFailures: the SAME problem across 2+ runs → a workflow_step proposal', () => {
  const out = proposalsFromStepFailures([
    obs('wf', 'scrape', 'run-1', ['min_items: got 2, needs 10']),
    obs('wf', 'scrape', 'run-2', ['min_items: got 4, needs 10']), // digits normalized → same problem
  ], NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'workflow_step');
  assert.equal(out[0].applyMode, 'auto');
  assert.equal(out[0].target, 'wf::scrape');
  assert.match(out[0].proposedText, /Recurring issue \(seen in 2 runs\)/);
});

test('splitWorkflowStepTarget: splits on the final separator so workflow ids may contain "::"', () => {
  assert.deepEqual(splitWorkflowStepTarget('daily::research::scrape'), { workflow: 'daily::research', stepId: 'scrape' });
  assert.equal(splitWorkflowStepTarget('daily-research'), null);
  assert.equal(splitWorkflowStepTarget('::scrape'), null);
  assert.equal(splitWorkflowStepTarget('daily::'), null);
});

test('proposalsFromStepFailures: id is stable as the run count grows (no nightly duplicates)', () => {
  const two = proposalsFromStepFailures([
    obs('wf', 'scrape', 'r1', ['min_items: got 2, needs 10']),
    obs('wf', 'scrape', 'r2', ['min_items: got 3, needs 10']),
  ], NOW)[0];
  const three = proposalsFromStepFailures([
    obs('wf', 'scrape', 'r1', ['min_items: got 2, needs 10']),
    obs('wf', 'scrape', 'r2', ['min_items: got 3, needs 10']),
    obs('wf', 'scrape', 'r3', ['min_items: got 5, needs 10']),
  ], NOW)[0];
  assert.equal(two.id, three.id, 'same step+problem keeps one id even as run count (and proposedText) changes');
  assert.notEqual(two.proposedText, three.proposedText, 'text reflects the new count');
});

test('buildWorkflowStepProposals: uses the injected failure collector', () => {
  const out = buildWorkflowStepProposals({
    collectStepFailures: () => [
      obs('wf', 'a', 'r1', ['bad']),
      obs('wf', 'a', 'r2', ['bad']),
    ],
    nowIso: NOW,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].target, 'wf::a');
});

test('approveProposal: a workflow_step proposal appends a reversible prompt addendum (dryRun never mutates)', () => {
  rmSync(`${TEST_HOME}/state/autoresearch`, { recursive: true, force: true });
  const workflowName = 'hist::wf';
  const def: WorkflowDefinition = {
    name: 'history workflow',
    description: 'history workflow',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'scrape', prompt: 'Scrape the directory and return rows.', sideEffect: 'read' }],
  };
  writeWorkflow(workflowName, def);
  const [p] = proposalsFromStepFailures([
    obs(workflowName, 'scrape', 'r1', ['min_items: got 2, needs 10']),
    obs(workflowName, 'scrape', 'r2', ['min_items: got 1, needs 10']),
  ], NOW);
  assert.equal(p.target, 'hist::wf::scrape');
  recordProposals([p]);

  // dry run: previews, no write
  const dry = approveProposal(p.id, { dryRun: true });
  assert.equal(dry.status, 'pending');
  assert.equal(readWorkflow(workflowName)!.data.steps[0].prompt, 'Scrape the directory and return rows.', 'dryRun did not edit the step');

  // real apply: addendum lands on the step prompt, proposal applied, reversible
  const real = approveProposal(p.id);
  assert.equal(real.ok, true);
  assert.equal(real.status, 'applied');
  assert.match(readWorkflow(workflowName)!.data.steps[0].prompt, /Recurring issue \(seen in 2 runs\)/);

  const backups = listStepEditBackups().filter((b) => b.workflow === workflowName);
  assert.ok(backups.length >= 1, 'a reversible backup was snapshotted');
  const rev = revertStepEdit(backups[0].id);
  assert.equal(rev.ok, true);
  assert.equal(readWorkflow(workflowName)!.data.steps[0].prompt, 'Scrape the directory and return rows.', 'revert restored the original prompt');
});

test('approveProposal: an auto skill_pitfall applies via appendSkillPitfall (dryRun first never mutates)', () => {
  rmSync(`${TEST_HOME}/state/autoresearch`, { recursive: true, force: true });
  writeDistilledSkill({ name: 'outreach', description: 'send outreach', body: 'Use composio_execute_tool to send the email.', origin: { kind: 'manual' } });
  const r = report([{ toolName: 'composio_execute_tool', calls: 8, successes: 2, errors: 6, emptyResults: 0, wrongPickHints: 0 }]);
  const [p] = buildImprovementProposals(r, { countRetirableNoise: NO_NOISE, nowIso: NOW }); // default listSkills reads the real skill
  assert.equal(p.kind, 'skill_pitfall');
  assert.equal(p.target, 'outreach');
  recordProposals([p]);

  // dry run: previews, no mutation, stays pending
  const dry = approveProposal(p.id, { dryRun: true });
  assert.equal(dry.status, 'pending');
  assert.ok(!loadSkill('outreach')!.body.includes('Pitfalls (observed)'), 'dryRun did not write the pitfall');

  // real apply: pitfall lands in the skill body, proposal becomes applied
  const real = approveProposal(p.id);
  assert.equal(real.ok, true);
  assert.equal(real.status, 'applied');
  assert.equal(real.applied, 1);
  assert.match(loadSkill('outreach')!.body, /Pitfalls \(observed\)/);
  assert.match(loadSkill('outreach')!.body, /composio_execute_tool` failed 75%/);
  assert.equal(listPendingProposals().length, 0);
});

// ── keep-if-better outcome loop (Track 4a) ────────────────────────────────────

test('evaluateAppliedProposals: problem gone in post-apply runs → improved; recurring → regressed + human-gated step_revert', async () => {
  const { evaluateAppliedProposals, proposalsFromStepFailures: mk, recordProposals: record, listProposals: list, runIdTimestampMs } =
    await import('./improvement-proposer.js');
  rmSync(`${TEST_HOME}/state/autoresearch`, { recursive: true, force: true });

  // Run ids embed their mint time.
  assert.equal(runIdTimestampMs('1783052757607-89c716'), 1783052757607);
  assert.equal(runIdTimestampMs('sched-1783036811744-b6e45d'), 1783036811744);
  assert.equal(runIdTimestampMs('weird-id'), null);

  const APPLIED_MS = 1_783_000_000_000;
  const before = (n: number) => `${APPLIED_MS - n * 60_000}-aa`;
  const after = (n: number) => `${APPLIED_MS + n * 60_000}-bb`;
  const obs = (workflow: string, runId: string, problems: string[]): StepFailureObservation =>
    ({ workflow, stepId: 's1', runId, problems });

  // Two applied proposals: wf-good's fix worked; wf-bad's problem recurs post-apply.
  const seed = [
    ...mk([obs('wf-good', before(2), ['missing summary field']), obs('wf-good', before(1), ['missing summary field'])], NOW),
    ...mk([obs('wf-bad', before(2), ['empty rows returned']), obs('wf-bad', before(1), ['empty rows returned'])], NOW),
  ].map((p) => ({ ...p, status: 'applied' as const, appliedAt: new Date(APPLIED_MS).toISOString() }));
  record(seed);

  const counts = evaluateAppliedProposals({
    nowIso: NOW,
    listRunIds: (wf) => [after(1), after(2), before(1), before(2)],
    collectStepFailures: () => [
      // wf-good: post-apply runs are clean (only PRE-apply failures exist).
      obs('wf-good', before(1), ['missing summary field']),
      // wf-bad: the SAME problem (digits differ → same normalized signature) recurs after apply.
      obs('wf-bad', after(1), ['empty rows returned']),
    ],
  });
  assert.equal(counts.checked, 2);
  assert.equal(counts.improved, 1);
  assert.equal(counts.regressed, 1);

  const all = list();
  const good = all.find((p) => p.target === 'wf-good::s1' && p.kind === 'workflow_step');
  const bad = all.find((p) => p.target === 'wf-bad::s1' && p.kind === 'workflow_step');
  assert.equal(good?.outcome?.verdict, 'improved');
  assert.equal(bad?.outcome?.verdict, 'regressed');

  const revert = all.find((p) => p.kind === 'step_revert');
  assert.ok(revert, 'a regression drafts a step_revert suggestion');
  assert.equal(revert?.status, 'pending');
  assert.equal(revert?.applyMode, 'manual', 'nothing ever auto-reverts');
  assert.equal(revert?.target, 'wf-bad::s1');

  // Fewer than 2 post-apply runs → pending_data, no verdict.
  const pendingCounts = evaluateAppliedProposals({
    nowIso: NOW,
    listRunIds: () => [after(1), before(1), before(2)],
    collectStepFailures: () => [],
  });
  assert.equal(pendingCounts.pending, 2);
});

// ── step_efficiency outliers (Track 4c) ───────────────────────────────────────

test('proposalsFromStepMetrics: a step 3x+ its sibling median (above floors, 3+ runs) → ONE manual step_efficiency proposal', async () => {
  const { proposalsFromStepMetrics } = await import('./improvement-proposer.js');
  const row = (workflow: string, stepId: string, runId: string, tokens: number, durationMs = 10_000) =>
    ({ workflow, stepId, runId, tokens, durationMs });

  const observations = [
    // heavy_step: 90K tokens avg over 3 runs; siblings ~10K → 9x, above the 20K floor.
    row('wf', 'heavy_step', 'r1', 90_000), row('wf', 'heavy_step', 'r2', 95_000), row('wf', 'heavy_step', 'r3', 85_000),
    row('wf', 'light_a', 'r1', 10_000), row('wf', 'light_a', 'r2', 11_000), row('wf', 'light_a', 'r3', 9_000),
    row('wf', 'light_b', 'r1', 12_000), row('wf', 'light_b', 'r2', 8_000), row('wf', 'light_b', 'r3', 10_000),
  ];
  const out = proposalsFromStepMetrics(observations, NOW);
  assert.equal(out.length, 1, JSON.stringify(out.map((p) => p.target)));
  assert.equal(out[0].kind, 'step_efficiency');
  assert.equal(out[0].target, 'wf::heavy_step');
  assert.equal(out[0].applyMode, 'manual');
  assert.match(out[0].proposedText, /token spend/);

  // Below the absolute floor → silence, even at a high ratio (cheap workflows aren't worth a nudge).
  const cheap = [
    row('wf2', 'a', 'r1', 9_000), row('wf2', 'a', 'r2', 9_000), row('wf2', 'a', 'r3', 9_000),
    row('wf2', 'b', 'r1', 1_000), row('wf2', 'b', 'r2', 1_000), row('wf2', 'b', 'r3', 1_000),
  ];
  assert.equal(proposalsFromStepMetrics(cheap.map((r) => ({ ...r, durationMs: 1_000 })), NOW).length, 0);

  // Fewer than 3 runs → silence.
  const twoRuns = observations.filter((o) => o.runId !== 'r3');
  assert.equal(proposalsFromStepMetrics(twoRuns, NOW).length, 0);

  // A single-step workflow (no siblings) → silence.
  assert.equal(proposalsFromStepMetrics(observations.filter((o) => o.stepId === 'heavy_step'), NOW).length, 0);
});

// ── doctor_fix: reuse the Workflow Doctor's persisted diagnoses (T3.3) ─────────

function diagnosis(stepId: string, kind: WorkflowDiagnosis['fix']['kind'] = 'edit_step'): WorkflowDiagnosis {
  return {
    summary: 'The step blocked instead of finishing.',
    rootCause: 'The step named a Composio tool that no longer exists.',
    fix: {
      kind,
      stepId,
      description: 'Rewrite the step to use the correct tool slug.',
      newStepPrompt: kind === 'edit_step' ? `Scrape the directory and return rows (step ${stepId}).` : null,
      newOutputContractJson: null,
      service: kind === 'reconnect_service' ? 'Google Drive' : null,
      autoApplicable: kind === 'edit_step',
    },
    confidence: 'high',
  };
}

function proposedFix(workflow: string, stepId: string, createdAt: string, kind: WorkflowDiagnosis['fix']['kind'] = 'edit_step'): ProposedFix {
  return { id: `fix-${workflow}-${stepId}`, workflow, runId: 'run-x', stepId, diagnosis: diagnosis(stepId, kind), createdAt };
}

test('proposalsFromDoctorFixes: an unapplied Doctor fix drafts a doctor_fix proposal', () => {
  const out = proposalsFromDoctorFixes([proposedFix('wf', 'scrape', NOW)], NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'doctor_fix');
  assert.equal(out[0].applyMode, 'manual', 'never auto-applies — the Doctor owns its own apply path');
  assert.equal(out[0].target, 'wf::scrape');
  assert.match(out[0].proposedText, /Workflow Doctor diagnosed step "scrape"/);
  assert.match(out[0].proposedText, /Composio tool that no longer exists/);
  assert.match(out[0].proposedText, /apply fix fix-wf-scrape/);
});

test('proposalsFromDoctorFixes: id is stable per (workflow, step, fix kind) — dedupes on a second tick', () => {
  const a = proposalsFromDoctorFixes([proposedFix('wf', 'scrape', NOW)], NOW)[0];
  // A later tick with a newer record for the SAME triple → same id (recordProposals dedups).
  const b = proposalsFromDoctorFixes([proposedFix('wf', 'scrape', '2026-06-24T00:00:00.000Z')], '2026-06-24T12:00:00.000Z')[0];
  assert.equal(a.id, b.id, 'same (workflow, step, fix kind) keeps one stable id');
});

test('proposalsFromDoctorFixes: one proposal per distinct (workflow, step, fix kind), newest wins', () => {
  const out = proposalsFromDoctorFixes([
    proposedFix('wf', 'scrape', '2026-06-22T00:00:00.000Z'),
    proposedFix('wf', 'scrape', '2026-06-23T00:00:00.000Z'), // newer, same triple → collapses
    proposedFix('wf', 'scrape', NOW, 'reconnect_service'),   // different fix kind → its own proposal
    proposedFix('wf', 'send', NOW),                          // different step → its own proposal
  ], NOW);
  assert.equal(out.length, 3);
  const targets = out.map((p) => `${p.target}:${p.evidence.includes('reconnect') ? 'reconnect' : 'edit'}`);
  assert.ok(out.every((p) => p.kind === 'doctor_fix'));
  assert.equal(out.filter((p) => p.target === 'wf::scrape').length, 2, 'two fix kinds for the same step → two proposals');
  assert.equal(out.filter((p) => p.target === 'wf::send').length, 1);
  void targets;
});

test('proposalsFromDoctorFixes: records older than the window are ignored', () => {
  const old = proposedFix('wf', 'scrape', '2026-06-01T00:00:00.000Z'); // 22 days before NOW (2026-06-23)
  const recent = proposedFix('wf2', 'fetch', '2026-06-20T00:00:00.000Z'); // 3 days before NOW
  const out = proposalsFromDoctorFixes([old, recent], NOW); // default 7-day window
  assert.equal(out.length, 1);
  assert.equal(out[0].target, 'wf2::fetch');
});

test('buildDoctorFixProposals: an APPLIED Doctor fix is skipped (only the unapplied one remains)', () => {
  rmSync(`${TEST_HOME}/state/workflow-fixes`, { recursive: true, force: true });
  delete process.env.CLEMMY_MEMORY_APPROVE;

  // A real workflow the applicable fix targets, so applyProposedFix can write + dismiss it.
  const appliedWf = 'doc::applied';
  writeWorkflow(appliedWf, {
    name: 'applied wf', description: 'applied wf', enabled: true, trigger: { manual: true },
    steps: [{ id: 'scrape', prompt: 'Scrape the directory and return rows.', sideEffect: 'read' }],
  });
  // Record two Doctor fixes; apply one (which deletes its record via dismissProposedFix).
  const toApply = recordProposedFix(appliedWf, 'run-applied', diagnosis('scrape', 'edit_step'));
  recordProposedFix('doc::pending', 'run-pending', diagnosis('fetch', 'edit_step'));
  const res = applyProposedFix(toApply.id);
  assert.equal(res.ok, true, res.message);

  // Default source reads the on-disk store, which now excludes the applied fix.
  const out = buildDoctorFixProposals({ nowIso: NOW, windowDays: 3650 });
  assert.equal(out.length, 1, JSON.stringify(out.map((p) => p.target)));
  assert.equal(out[0].target, 'doc::pending::fetch');
});

test('proposeFromReport: an unapplied Doctor fix drafts exactly once, deduped on the second tick', () => {
  rmSync(`${TEST_HOME}/state/autoresearch`, { recursive: true, force: true });
  process.env.CLEMMY_IMPROVEMENT_PROPOSER = 'on';
  try {
    const deps = {
      listSkills: NO_SKILLS,
      countRetirableNoise: NO_NOISE,
      listDoctorFixes: () => [proposedFix('wf', 'scrape', NOW)],
      nowIso: NOW,
    };
    const first = proposeFromReport(report([]), deps);
    assert.equal(first.ran, true);
    assert.equal(first.added, 1);
    const [pending] = listPendingProposals();
    assert.equal(pending.kind, 'doctor_fix');
    assert.equal(pending.target, 'wf::scrape');

    // Second tick, same unapplied fix → no new draft.
    const second = proposeFromReport(report([]), deps);
    assert.equal(second.added, 0, 'same Doctor fix does not re-draft');
    assert.equal(listPendingProposals().filter((p) => p.kind === 'doctor_fix').length, 1);
  } finally {
    delete process.env.CLEMMY_IMPROVEMENT_PROPOSER;
  }
});
