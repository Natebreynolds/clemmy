/** Run: node scripts/run-tests-isolated.mjs src/runtime/semantic-boundary/exhaust-collection-dispatch.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-exhaust-collection-'));
process.env.CLEMENTINE_HOME = HOME;
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-exhaust-collection\n', 'utf8');

const { closeEventLog } = await import('../harness/eventlog.js');
const { describeGoalCatalogGap } = await import('../harness/connected-goal-catalog.js');
const { compileAcceptedGoal } = await import('../graph/accepted-goal.js');
const { detectMultiItemIntent } = await import('../harness/multi-item-intent.js');


test.after(() => {
  closeEventLog();
});

const COLLECT_PROMPT = [
  'Populate a database of matching local professionals, grouped by category.',
  'The information that I would like pulled is the following:',
  'Name',
  'Organization',
  'Category',
  'Phone',
  'Email',
  'Website',
  'Address',
].join('\n');

test('a missing collection contract names the requested fields, not a recipe', () => {
  const goal = compileAcceptedGoal({
    text: COLLECT_PROMPT,
    sourceUserSeq: 1,
    multiItem: detectMultiItemIntent(COLLECT_PROMPT),
  });
  assert.equal(goal.construct, 'collect_then_construct');
  const question = describeGoalCatalogGap(['search', 'row_create'], {
    projection: goal.collection?.projection,
  });
  assert.match(question, /name|organization|phone|email|website|address/i);
  assert.match(question, /connected apps|certify/i);
});
