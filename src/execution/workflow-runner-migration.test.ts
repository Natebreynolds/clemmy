/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-runner-migration.test.ts
 *
 * The migration primitive (owner 2026-09-01: "Clem needs the right tools to
 * migrate workflows"). The fixture carries the idioms of the live
 * team-activity runner that a model failed to rewrite 18 times in a day: a
 * frozen rep list, a derived quoted filter, six SOQL template literals with
 * placeholders, a computed date, a per-record attribution loop, baseline
 * files, and a pushed-lines renderer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { draftRunnerMigration, SALESFORCE_SOQL_READ_TOOL } = await import('./workflow-runner-migration.js');

const RUNNER_SOURCE = `
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
export const TARGET_ORG = 'owner@example.com';
export const REPS = Object.freeze([
  'Bobby Romano',
  'Brett Lorenzini',
  "Kim O'Hara",
]);
const REP_FILTER = REPS.map((name) => \`'\${name.replaceAll("'", "\\\\'")}'\`).join(',');
export function buildCoreQueries(occurrenceDate) {
  const staleCutoff = calendarDateMinusDays(occurrenceDate, 5);
  return Object.freeze([
    { name: 'calls-emails-today', soql: \`SELECT Owner.Name ownerName, TaskSubtype, COUNT(Id) cnt FROM Task WHERE ActivityDate = TODAY AND TaskSubtype IN ('Call','Email') AND Owner.Name IN (\${REP_FILTER}) GROUP BY Owner.Name, TaskSubtype\` },
    { name: 'calls-emails-week', soql: \`SELECT Owner.Name ownerName, COUNT(Id) cnt FROM Task WHERE ActivityDate = THIS_WEEK AND Owner.Name IN (\${REP_FILTER}) GROUP BY Owner.Name\` },
    { name: 'discovery-set', soql: \`SELECT Id, Owner.Name, Subject FROM Event WHERE CreatedDate = TODAY AND Owner.Name IN (\${REP_FILTER}) AND Subject LIKE '%Discovery%'\` },
    { name: 'discovery-ended', soql: \`SELECT Id, Owner.Name, Subject, EndDateTime FROM Event WHERE ActivityDate = TODAY AND Owner.Name IN (\${REP_FILTER})\` },
    { name: 'closed-won', soql: \`SELECT Owner.Name ownerName, COUNT(Id) cnt, SUM(Amount) amt FROM Opportunity WHERE IsWon = true AND CloseDate = TODAY AND Owner.Name IN (\${REP_FILTER}) GROUP BY Owner.Name\` },
    { name: 'stale', soql: \`SELECT Id, Owner.Name, Name FROM Opportunity WHERE IsClosed = false AND Owner.Name IN (\${REP_FILTER}) AND (LastActivityDate <= \${staleCutoff} OR LastActivityDate = null)\` },
  ]);
}
async function attribution(meetings) {
  for (const meeting of meetings) {
    await runSf(\`SELECT Id, Subject FROM Task WHERE WhoId = '\${meeting.WhoId}' AND Status = 'Completed'\`);
  }
}
async function baseline(filePath, value) {
  await writeFile(filePath, JSON.stringify(value));
}
function render(core, clock) {
  const lines = [];
  lines.push(\`*Team Activity Update — \${clock.label}*\`);
  lines.push('*PER-REP*');
  lines.push(\`• *\${rep}* — \${row.calls} calls / \${row.emails} emails · \${row.wtd} WTD\`);
  lines.push('', '*ZERO-ACTIVITY FLAGS*');
  lines.push('', '*LEADERBOARD*');
  return lines.join('\\n');
}
const now = new Date();
`;

const definition = {
  name: 'team-activity',
  description: 'Team activity to Slack',
  enabled: true,
  trigger: { manual: true, schedule: '0 9,16 * * 1-5', timezone: 'America/Los_Angeles' },
  resources: {
    salesforce_org: { id: 'salesforce_org', kind: 'account', cli: 'sf', account: 'owner@example.com', required: true },
  },
  steps: [
    {
      id: 'pull_activity',
      prompt: '',
      deterministic: { runner: 'scripts/pull.mjs' },
      sideEffect: 'write',
      output: { type: 'object', required_keys: ['summary', 'totals'], non_empty: ['summary'] },
    },
    {
      id: 'post_slack',
      prompt: 'Post exactly {{steps.pull_activity.output.summary}} to C0BHT7WHZDL.',
      dependsOn: ['pull_activity'],
      allowedTools: ['composio_execute_tool'],
      sideEffect: 'send',
      output: { type: 'object', required_keys: ['messageTs'] },
    },
  ],
} as never;

test('the draft turns every SOQL read into an exact call step, resolves the rep filter, lifts the computed date into an input, packages, renders, and repoints the send', () => {
  const draft = draftRunnerMigration({ definition, runnerStepId: 'pull_activity', runnerSource: RUNNER_SOURCE });
  assert.equal(draft.ok, true, draft.gaps.join('\n'));
  // The attribution loop's per-record query is a read too, but it depends on
  // a prior record; it is drafted as a step and named as a gap for forEach.
  assert.equal(draft.reads.length, 7, JSON.stringify(draft.reads.map((read) => read.stepId)));
  const stepIds = draft.definition.steps.map((step) => step.id);
  assert.equal(stepIds.includes('pull_activity'), false, 'the runner step is replaced');
  const calls = draft.definition.steps.filter((step) => step.call?.tool === SALESFORCE_SOQL_READ_TOOL);
  assert.equal(calls.length, 7);
  for (const call of calls) {
    assert.equal(call.sideEffect, 'read');
    assert.equal(call.call?.args?.target_org, 'owner@example.com');
    assert.deepEqual(call.output, { type: 'object', required_keys: ['stdout'], non_empty: ['stdout'] });
  }
  const today = calls.find((step) => String(step.call?.args?.query).includes('ActivityDate = TODAY AND TaskSubtype'))!;
  assert.match(String(today.call?.args?.query), /Owner\.Name IN \('Bobby Romano','Brett Lorenzini','Kim O\\'Hara'\)/, 'the derived quoted filter resolves from the frozen rep list');
  const stale = calls.find((step) => String(step.call?.args?.query).includes('LastActivityDate <='))!;
  assert.match(String(stale.call?.args?.query), /LastActivityDate <= \{\{input\.staleCutoff\}\}/, 'a computed value becomes a declared input');
  assert.equal(draft.definition.inputs?.staleCutoff?.required, true);
  assert.match(draft.definition.inputs?.staleCutoff?.description ?? '', /computed inside the legacy runner/);

  const pkg = draft.definition.steps.find((step) => step.transform)!;
  assert.deepEqual(pkg.dependsOn, calls.map((step) => step.id));
  assert.equal(pkg.sideEffect, 'read');

  const render = draft.definition.steps.find((step) => step.id === draft.renderStepId)!;
  assert.deepEqual(render.dependsOn, [pkg.id]);
  assert.deepEqual(render.output?.required_keys, ['summary', 'totals'], 'the render step owes what the runner owed');
  assert.match(render.prompt, /\*PER-REP\*/);
  assert.match(render.prompt, /\*LEADERBOARD\*/);
  assert.match(render.prompt, /<value> calls \/ <value> emails/);
  assert.match(render.prompt, new RegExp(`\\{\\{steps\\.${pkg.id}\\.output\\}\\}`));

  const send = draft.definition.steps.find((step) => step.id === 'post_slack')!;
  assert.deepEqual(send.dependsOn, [draft.renderStepId]);
  assert.match(send.prompt, /\{\{steps\.render_summary\.output\.summary\}\}/);
  assert.equal(send.sideEffect, 'send');
  assert.deepEqual(send.allowedTools, ['composio_execute_tool'], 'the send step is untouched');

  assert.ok(draft.gaps.some((gap) => /wrote local files/.test(gap)), draft.gaps.join('\n'));
  assert.ok(draft.gaps.some((gap) => /query per record/.test(gap)));
  assert.ok(draft.gaps.some((gap) => /computed dates/.test(gap)));
});

test('a runner with no recognisable read is not drafted; the legacy lane stays the right one', () => {
  const draft = draftRunnerMigration({
    definition,
    runnerStepId: 'pull_activity',
    runnerSource: 'import fs from "node:fs"; console.log(JSON.stringify({ summary: fs.readFileSync("x").toString() }));',
  });
  assert.equal(draft.ok, false);
  assert.deepEqual(draft.reads, []);
  assert.ok(draft.gaps.some((gap) => /No SOQL read was recognised/.test(gap)));
  assert.equal(draft.definition.steps.length, 2, 'the definition is returned unchanged');
});
