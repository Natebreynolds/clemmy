/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-step-effect-reading.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-step-effect-reading-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const reading = await import('./workflow-step-effect-reading.js');
const enforce = await import('./workflow-enforce.js');
const { BASE_DIR } = await import('../tools/shared.js');

test.after(() => rmSync(TEST_HOME, { recursive: true, force: true }));

const draftStep = (prompt = 'Create one unsent email draft to me with the note below as its body.') => ({
  id: 'stage_draft', prompt, usesSkill: 'house-style', allowedTools: ['task_list'],
});

test('an unmarked prompt step is read once per exact version and an unchanged rerun reads nothing', async () => {
  reading._resetWorkflowStepEffectReadingsForTests();
  const asked: string[] = [];
  reading._setWorkflowStepEffectReaderForTests(async (user) => { asked.push(user); return { effect: 'write' }; });
  mkdirSync(path.join(BASE_DIR, 'skills', 'house-style'), { recursive: true });
  writeFileSync(path.join(BASE_DIR, 'skills', 'house-style', 'SKILL.md'), '---\nname: house-style\n---\nBe brief.');
  try {
    const step = draftStep();
    assert.equal(enforce.classifyStepSideEffect(step), 'read', 'before any reading, the wording guess misses this write');
    assert.equal(await reading.ensureWorkflowStepEffectsRead({ steps: [step] }), 1);
    assert.equal(reading.savedStepEffect(step), 'write');
    assert.equal(enforce.classifyStepSideEffect(step), 'write');
    assert.equal(enforce.stepLooksMutating(step), true, 'the rehearsal previews it');

    assert.equal(await reading.ensureWorkflowStepEffectsRead({ steps: [step] }), 0, 'an unchanged rerun makes no reading');

    const edited = draftStep('Create one unsent email draft to me, signed "Clem".');
    assert.equal(reading.savedStepEffect(edited), undefined, 'an edited prompt is a new version');
    assert.equal(await reading.ensureWorkflowStepEffectsRead({ steps: [edited] }), 1);

    writeFileSync(path.join(BASE_DIR, 'skills', 'house-style', 'SKILL.md'), '---\nname: house-style\n---\nBe brief and warm.');
    assert.equal(reading.savedStepEffect(step), undefined, 'a changed skill invalidates the reading');
    assert.equal(await reading.ensureWorkflowStepEffectsRead({ steps: [step] }), 1);

    const marked = { ...step, sideEffect: 'read' as const };
    const call = { id: 'c', call: { tool: 'write_file' }, prompt: '' };
    assert.equal(await reading.ensureWorkflowStepEffectsRead({ steps: [marked, call] }), 0, 'declared and structured steps are never read');
    assert.equal(asked.length, 3);
    assert.doesNotMatch(asked[0]!, /Be brief/, 'the skill is named, its body is not sent');
  } finally {
    reading._setWorkflowStepEffectReaderForTests(null);
  }
});

test('a reading that fails saves nothing, and the wording fallback stands', async () => {
  reading._resetWorkflowStepEffectReadingsForTests();
  reading._setWorkflowStepEffectReaderForTests(async () => { throw new Error('model unavailable'); });
  try {
    const step = draftStep('Summarize the attached notes.');
    assert.equal(await reading.ensureWorkflowStepEffectsRead({ steps: [step] }), 1);
    assert.equal(reading.savedStepEffect(step), undefined);
    assert.equal(enforce.classifyStepSideEffect(step), 'read');
  } finally {
    reading._setWorkflowStepEffectReaderForTests(null);
  }
});
