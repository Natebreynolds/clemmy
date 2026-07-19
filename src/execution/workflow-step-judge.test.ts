import test from 'node:test';
import assert from 'node:assert/strict';

import { judgeStepSkillExecution } from './workflow-step-judge.js';
import type { ObjectiveJudgeVerdict, SkillExecutionContext } from '../runtime/harness/objective-judge.js';
import type { WorkflowStepInput } from '../memory/workflow-store.js';

const step = (over: Partial<WorkflowStepInput> = {}): WorkflowStepInput => ({
  id: 'build',
  prompt: 'Build the prospect homepage redesign.',
  ...over,
});

const okLoad = () => 'Phase 1: generate a hero image. Phase 2: write the index.html. Produce the deployed URL.';

test('judgeStepSkillExecution: SKIPS a step with no usesSkill (zero cost, untouched)', async () => {
  let called = 0;
  const v = await judgeStepSkillExecution({
    step: step({ usesSkill: undefined }),
    sessionId: 's1',
    output: 'whatever',
    judgeFn: async () => { called += 1; return { done: false, reason: 'should not run' }; },
    loadSkillBody: okLoad,
    toolSummaryFn: () => 'x',
  });
  assert.equal(v.executed, true);
  assert.equal(v.judged, false);
  assert.equal(called, 0);
});

test('judgeStepSkillExecution: executed when the judge confirms the skill ran', async () => {
  const v = await judgeStepSkillExecution({
    step: step({ usesSkill: 'redesign' }),
    sessionId: 's1',
    output: 'Deployed to https://acme.netlify.app with a generated hero image.',
    judgeFn: async () => ({ done: true, reason: 'image generated + URL present' }),
    loadSkillBody: okLoad,
    toolSummaryFn: () => 'image_generate×1',
  });
  assert.equal(v.executed, true);
  assert.equal(v.judged, true);
});

test('judgeStepSkillExecution: NOT executed when the judge finds a skipped deliverable', async () => {
  const v = await judgeStepSkillExecution({
    step: step({ usesSkill: 'redesign' }),
    sessionId: 's1',
    output: 'Wrote index.html (no image).',
    judgeFn: async () => ({ done: false, reason: 'skill prescribes a hero image; no image tool fired' }),
    loadSkillBody: okLoad,
    toolSummaryFn: () => 'write_file×1',
  });
  assert.equal(v.executed, false);
  assert.equal(v.judged, true);
  assert.match(v.reason, /image/);
});

test('judgeStepSkillExecution: prompt tells the judge the skill was INJECTED + to judge only deliverables (H1 false-positive guard)', async () => {
  let objective = '';
  await judgeStepSkillExecution({
    step: step({ usesSkill: 'acme-outbound' }),
    sessionId: 's1',
    output: 'drafted 3 outreach emails in the right brand voice',
    judgeFn: async (obj: string): Promise<ObjectiveJudgeVerdict> => { objective = obj; return { done: true, reason: 'ok' }; },
    loadSkillBody: () => 'Read references/brand-voice.md — always. Then draft the emails.',
    toolSummaryFn: () => 'GMAIL_CREATE_DRAFT×3',
  });
  // Must neutralize the "skill prescribes reading a reference file but no read tool fired" false-positive.
  assert.match(objective, /inject/i, 'judge must be told the skill was injected into the prompt');
  assert.match(objective, /read/i);
  assert.match(objective, /deliverable/i, 'judge must focus on concrete output deliverables');
});

test('judgeStepSkillExecution: passes the skill body + tool evidence to the judge as the rubric', async () => {
  let captured: SkillExecutionContext | undefined;
  await judgeStepSkillExecution({
    step: step({ usesSkill: 'redesign' }),
    sessionId: 's1',
    output: 'some deliverable',
    judgeFn: async (_obj: string, _resp: string, ctx?: SkillExecutionContext): Promise<ObjectiveJudgeVerdict> => {
      captured = ctx;
      return { done: true, reason: 'ok' };
    },
    loadSkillBody: () => 'PRESCRIBED SKILL BODY',
    toolSummaryFn: () => 'composio:GMAIL_SEND×2',
  });
  assert.ok(captured, 'skill context must be passed');
  assert.equal(captured!.skills.length, 1);
  assert.equal(captured!.skills[0].name, 'redesign');
  assert.match(captured!.skills[0].body, /PRESCRIBED SKILL BODY/);
  assert.match(captured!.toolCallSummary, /GMAIL_SEND×2/);
});

test('judgeStepSkillExecution: FAILS OPEN when the skill body cannot be loaded', async () => {
  let called = 0;
  const v = await judgeStepSkillExecution({
    step: step({ usesSkill: 'redesign' }),
    sessionId: 's1',
    output: 'deliverable',
    judgeFn: async () => { called += 1; return { done: false, reason: 'nope' }; },
    loadSkillBody: () => null,
    toolSummaryFn: () => '',
  });
  assert.equal(v.executed, true);
  assert.equal(v.judged, false);
  assert.equal(called, 0, 'judge not consulted when there is no rubric to judge against');
});

test('judgeStepSkillExecution: SKIPS when the step produced no output', async () => {
  const v = await judgeStepSkillExecution({
    step: step({ usesSkill: 'redesign' }),
    sessionId: 's1',
    output: '',
    judgeFn: async () => ({ done: false, reason: 'nope' }),
    loadSkillBody: okLoad,
    toolSummaryFn: () => '',
  });
  assert.equal(v.executed, true);
  assert.equal(v.judged, false);
});

test('judgeStepSkillExecution: FAILS OPEN when the judge throws (never wedges a step)', async () => {
  const v = await judgeStepSkillExecution({
    step: step({ usesSkill: 'redesign' }),
    sessionId: 's1',
    output: 'deliverable',
    judgeFn: async () => { throw new Error('model down'); },
    loadSkillBody: okLoad,
    toolSummaryFn: () => '',
  });
  assert.equal(v.executed, true);
  assert.equal(v.judged, false);
});
