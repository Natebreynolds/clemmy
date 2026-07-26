import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userRequestedSkillDistillation } from './skill-tools.js';

test('manual skill distillation requires explicit preservation intent', () => {
  assert.equal(userRequestedSkillDistillation('Remember how to do this next time.'), true);
  assert.equal(userRequestedSkillDistillation('Save this as a reusable playbook.'), true);
  assert.equal(userRequestedSkillDistillation('Turn this into a skill for future runs.'), true);
});

test('ordinary completion and generic memory language do not mint manual skill authority', () => {
  assert.equal(userRequestedSkillDistillation('The deployment is complete.'), false);
  assert.equal(userRequestedSkillDistillation('Remember my favorite color is orange.'), false);
  assert.equal(userRequestedSkillDistillation('You should learn from every run automatically.'), false);
});
