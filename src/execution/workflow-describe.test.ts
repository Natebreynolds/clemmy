/**
 * Run: npx tsx --test src/execution/workflow-describe.test.ts
 *
 * Plain-English / printable workflow renderer — pure, no I/O.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeCron,
  describeSchedule,
  describeInputs,
  describeStep,
  describeProduces,
  describeWorkflowPlainEnglish,
  describeWorkflowOneLine,
  deriveStepDataSources,
} from './workflow-describe.js';
import type { WorkflowDefinition } from '../memory/workflow-store.js';

function wf(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: 'demo',
    description: 'demo workflow',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'a', prompt: 'do a thing' }],
    ...overrides,
  } as WorkflowDefinition;
}

// ─── describeCron ────────────────────────────────────────────────────

test('describeCron: common recurrences read as plain English', () => {
  assert.equal(describeCron('0 8 * * 1-5'), 'every weekday at 8:00 AM');
  assert.equal(describeCron('30 17 * * *'), 'every day at 5:30 PM');
  assert.equal(describeCron('0 9 * * 1'), 'every Monday at 9:00 AM');
  assert.equal(describeCron('0 0 1 * *'), 'on the 1st of the month at 12:00 AM');
  assert.equal(describeCron('*/15 * * * *'), 'every 15 minutes');
  assert.equal(describeCron('0 * * * *'), 'every day at :00 past every hour');
});

test('describeCron: anything it cannot phrase falls back to the raw expression (never wrong)', () => {
  assert.match(describeCron('0 8 1-7 3 2'), /schedule `0 8 1-7 3 2`/);
  assert.match(describeCron('not a cron'), /schedule `not a cron`/);
});

// ─── describeSchedule ────────────────────────────────────────────────

test('describeSchedule: on-demand when no schedule', () => {
  assert.match(describeSchedule(wf()), /On demand/);
});

test('describeSchedule: scheduled with timezone and paused state', () => {
  const s = describeSchedule(wf({ enabled: false, trigger: { schedule: '0 8 * * 1-5', timezone: 'America/Los_Angeles' } }));
  assert.match(s, /Every weekday at 8:00 AM/);
  assert.match(s, /America\/Los_Angeles/);
  assert.match(s, /paused/);
});

// ─── describeInputs ──────────────────────────────────────────────────

test('describeInputs: none / required / defaulted', () => {
  assert.match(describeInputs(wf()), /Nothing/);
  assert.match(
    describeInputs(wf({ inputs: { url: { type: 'string' }, seg: { type: 'string', default: 'enterprise' } } as WorkflowDefinition['inputs'] })),
    /url \(required\), seg \(defaults to "enterprise"\)/,
  );
});

// ─── describeStep ────────────────────────────────────────────────────

test('describeStep: detokenizes prompt + annotates forEach / approval / skill / script', () => {
  assert.match(
    describeStep({ id: 'x', prompt: 'analyze {{steps.fetch.output}} for {{input.url}}' }, 0),
    /1\. analyze the result of "fetch" for the url/,
  );
  assert.match(
    describeStep({ id: 'x', prompt: 'process {{item.lead}}', forEach: 'list' }, 1),
    /once for each item from "list"/,
  );
  assert.match(
    describeStep({ id: 'x', prompt: 'send the emails', requiresApproval: true, approvalPreview: 'Send 25 emails' }, 2),
    /pauses for your approval: Send 25 emails/,
  );
  assert.match(
    describeStep({ id: 'x', prompt: 'audit the site', usesSkill: 'seo-audit' }, 3),
    /uses the "seo-audit" skill/,
  );
  assert.match(
    describeStep({ id: 'x', prompt: 'transform rows', deterministic: { runner: 'scripts/x.ts' } }, 4),
    /runs a script \(no AI\)/,
  );
});

test('describeStep: long prompt is clipped to the first sentence', () => {
  const long = 'First sentence here. Then a second sentence that should not appear in the short label at all.';
  const out = describeStep({ id: 'x', prompt: long }, 0);
  assert.match(out, /First sentence here\./);
  assert.doesNotMatch(out, /second sentence/);
});

// ─── describeProduces ────────────────────────────────────────────────

test('describeProduces: synthesis / required_keys / url / fallback', () => {
  assert.match(describeProduces(wf({ synthesis: { prompt: 'combine' } })), /final summary/);
  assert.match(
    describeProduces(wf({ steps: [{ id: 'out', prompt: 'p', output: { required_keys: ['sheetUrl', 'count'] } }] })),
    /from the final step "out": sheetUrl, count/,
  );
  assert.match(
    describeProduces(wf({ steps: [{ id: 'deploy', prompt: 'p', output: { verify: { url_present: ['liveUrl'] } } }] })),
    /published link/,
  );
  assert.match(describeProduces(wf({ steps: [{ id: 'last', prompt: 'p' }] })), /result of the final step \("last"\)/);
});

// ─── full render ─────────────────────────────────────────────────────

test('describeWorkflowPlainEnglish: a realistic workflow renders clearly with no raw tokens or cron', () => {
  const def = wf({
    name: 'Morning Prospect Prep',
    description: 'Pull leads, research SEO, draft outreach.',
    trigger: { schedule: '0 8 * * 1-5', timezone: 'America/Los_Angeles' },
    inputs: { segment: { type: 'string', default: 'law firms' } } as WorkflowDefinition['inputs'],
    steps: [
      { id: 'fetch', prompt: 'pull new leads for {{input.segment}}' },
      { id: 'research', prompt: 'research {{item.domain}} SEO', forEach: 'fetch', usesSkill: 'seo-audit' },
      { id: 'draft', prompt: 'draft an outreach email using {{steps.research.output}}', requiresApproval: true, approvalPreview: 'Send drafts to review' },
    ],
    synthesis: { prompt: 'summarize' },
  });
  const out = describeWorkflowPlainEnglish(def);
  assert.match(out, /📋 \*\*Morning Prospect Prep\*\*/);
  assert.match(out, /Every weekday at 8:00 AM \(America\/Los_Angeles\)/);
  assert.match(out, /segment \(defaults to "law firms"\)/);
  assert.match(out, /final summary/);
  assert.match(out, /1\. pull new leads for the segment/);
  assert.match(out, /once for each item from "fetch".*uses the "seo-audit" skill/);
  assert.match(out, /pauses for your approval/);
  // No engine internals leaked to the user.
  assert.doesNotMatch(out, /\{\{/);
  assert.doesNotMatch(out, /0 8 \* \* 1-5/);
});

test('describeWorkflowPlainEnglish: empty-steps workflow does not throw', () => {
  const out = describeWorkflowPlainEnglish(wf({ steps: [] }));
  assert.match(out, /none yet/);
});

// ─── deriveStepDataSources (the Salesforce-vs-Composio grounding signal) ───

test('deriveStepDataSources: surfaces the real connector slug from the prompt (Salesforce, not guessed)', () => {
  const out = deriveStepDataSources({
    id: 'pull',
    prompt: 'Call composio_execute_tool with SALESFORCE_QUERY to pull emails for {{input.account_id}}.',
    sideEffect: 'read',
  });
  const joined = out.join(' · ');
  assert.match(joined, /SALESFORCE_QUERY/, 'the real connector slug is surfaced');
  assert.match(joined, /composio_execute_tool/, 'the tool it calls is surfaced');
  assert.match(joined, /input\.account_id/, 'data-flow binding surfaced');
  assert.match(joined, /side-effect: read/);
});

test('deriveStepDataSources: a deterministic step shows its script + allowed tools', () => {
  const out = deriveStepDataSources({
    id: 'export',
    prompt: 'run it',
    deterministic: { runner: 'scripts/salesforce-pull.py' },
    allowedTools: ['run_shell_command'],
  }).join(' · ');
  assert.match(out, /script: scripts\/salesforce-pull\.py/);
  assert.match(out, /allowed tools: run_shell_command/);
});

test('deriveStepDataSources: engine grammar tokens (STEP_CONTEXT) are NOT mistaken for connectors', () => {
  const out = deriveStepDataSources({ id: 'x', prompt: 'Read STEP_CONTEXT.upstream and write a JSON summary.' }).join(' · ');
  assert.doesNotMatch(out, /STEP_CONTEXT/, 'engine token excluded');
  assert.doesNotMatch(out, /\bJSON\b/, 'generic token excluded');
});

test('deriveStepDataSources: forEach + mcp tool names are surfaced', () => {
  const out = deriveStepDataSources({
    id: 'each',
    prompt: 'For {{item}}, call mcp__claude_ai_Gmail__authenticate.',
    forEach: 'leads',
  }).join(' · ');
  assert.match(out, /mcp__claude_ai_Gmail__authenticate/);
  assert.match(out, /forEach leads/);
  assert.match(out, /item/);
});

test('describeWorkflowOneLine: compact list summary', () => {
  const def = wf({
    name: 'Daily Digest',
    trigger: { schedule: '0 7 * * *' },
    steps: [{ id: 'a', prompt: 'x' }, { id: 'b', prompt: 'y', requiresApproval: true }],
  });
  const line = describeWorkflowOneLine(def);
  assert.match(line, /Daily Digest — every day at 7:00 AM · 2 steps · pauses for approval/);
});
