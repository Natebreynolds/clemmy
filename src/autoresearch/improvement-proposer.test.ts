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
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-test-improve-proposer';
process.env.CLEMENTINE_HOME = TEST_HOME;
delete process.env.CLEMMY_IMPROVEMENT_PROPOSER;
delete process.env.CLEMMY_MEMORY_APPROVE;

const {
  buildImprovementProposals,
  proposerEnabled,
  proposeFromReport,
  recordProposals,
  listPendingProposals,
  approveProposal,
  dismissProposal,
  proposalsFromStepFailures,
  buildWorkflowStepProposals,
} = await import('./improvement-proposer.js');
const { writeDistilledSkill, loadSkill } = await import('../memory/skill-store.js');
const { writeWorkflow, readWorkflow } = await import('../memory/workflow-store.js');
const { revertStepEdit, listStepEditBackups } = await import('../execution/workflow-step-edit.js');
import type { ObservatoryReport } from './observatory.js';
import type { StepFailureObservation } from './improvement-proposer.js';
import type { WorkflowDefinition } from '../memory/workflow-store.js';

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
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
  const b = buildImprovementProposals(r, { listSkills: NO_SKILLS, countRetirableNoise: NO_NOISE, nowIso: '2026-07-01T00:00:00Z' })[0];
  assert.equal(a.id, b.id, 'same issue → same id regardless of when proposed');
});

// ── gating ─────────────────────────────────────────────────────────────────

test('proposerEnabled: OFF by default; on only with CLEMMY_IMPROVEMENT_PROPOSER=on', () => {
  delete process.env.CLEMMY_IMPROVEMENT_PROPOSER;
  assert.equal(proposerEnabled(), false);
  process.env.CLEMMY_IMPROVEMENT_PROPOSER = 'on';
  assert.equal(proposerEnabled(), true);
  delete process.env.CLEMMY_IMPROVEMENT_PROPOSER;
});

test('proposeFromReport is a no-op when the flag is off, drafts when on', () => {
  const r = report([{ toolName: 'flaky_tool', calls: 10, successes: 4, errors: 6, emptyResults: 0, wrongPickHints: 0 }]);
  delete process.env.CLEMMY_IMPROVEMENT_PROPOSER;
  assert.equal(proposeFromReport(r, { listSkills: NO_SKILLS, countRetirableNoise: NO_NOISE }).ran, false);
  process.env.CLEMMY_IMPROVEMENT_PROPOSER = 'on';
  const res = proposeFromReport(r, { listSkills: NO_SKILLS, countRetirableNoise: NO_NOISE });
  assert.equal(res.ran, true);
  assert.ok(res.added >= 1);
  delete process.env.CLEMMY_IMPROVEMENT_PROPOSER;
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
  const def: WorkflowDefinition = {
    name: 'hist-wf',
    description: 'history workflow',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'scrape', prompt: 'Scrape the directory and return rows.', sideEffect: 'read' }],
  };
  writeWorkflow('hist-wf', def);
  const [p] = proposalsFromStepFailures([
    obs('hist-wf', 'scrape', 'r1', ['min_items: got 2, needs 10']),
    obs('hist-wf', 'scrape', 'r2', ['min_items: got 1, needs 10']),
  ], NOW);
  recordProposals([p]);

  // dry run: previews, no write
  const dry = approveProposal(p.id, { dryRun: true });
  assert.equal(dry.status, 'pending');
  assert.equal(readWorkflow('hist-wf')!.data.steps[0].prompt, 'Scrape the directory and return rows.', 'dryRun did not edit the step');

  // real apply: addendum lands on the step prompt, proposal applied, reversible
  const real = approveProposal(p.id);
  assert.equal(real.ok, true);
  assert.equal(real.status, 'applied');
  assert.match(readWorkflow('hist-wf')!.data.steps[0].prompt, /Recurring issue \(seen in 2 runs\)/);

  const backups = listStepEditBackups().filter((b) => b.workflow === 'hist-wf');
  assert.ok(backups.length >= 1, 'a reversible backup was snapshotted');
  const rev = revertStepEdit(backups[0].id);
  assert.equal(rev.ok, true);
  assert.equal(readWorkflow('hist-wf')!.data.steps[0].prompt, 'Scrape the directory and return rows.', 'revert restored the original prompt');
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
