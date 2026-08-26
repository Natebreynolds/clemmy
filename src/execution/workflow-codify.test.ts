/**
 * Run: npx tsx --test src/execution/workflow-codify.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeCodifiedStep, codifyMechanicalSteps } from './workflow-codify.js';
import { stepExecutor } from './workflow-execution-mode.js';

// A model step that SHOULD codify: single concrete tool, declared inputs +
// output contract, mechanical non-judgment read.
const mechanical = () => ({
  id: 'pull', prompt: 'Fetch the domain rank overview for the prospect.',
  allowedTools: ['dataforseo_domain_rank_overview'],
  inputs: { target: { from: 'input.domain' } },
  output: { type: 'object', required_keys: ['metrics'] },
});

test('codifyMechanicalSteps is currently a no-op — a bare call has no production dispatch authority', () => {
  // Regression pin (2026-08-26): the workflow definition validator and
  // runner now require any `call` step to carry a paired, exact
  // `invocationPlan` (workflow-validator.ts "structured call is missing its
  // exact invocationPlan"; workflow-runner.ts `workflow_exact_call_plan_missing`,
  // landed in the durable-activation wave, commit 60db67d8). This sync,
  // no-LLM pass has no access to the live capability/schema catalog needed to
  // compile that plan, so converting a working model step into an
  // un-writable-when-enabled `call` step would be strictly worse than leaving
  // it a model step. The candidate report (proposeCodifiedStep, covered by the
  // other tests below) is unaffected — only the mutating conversion stands down.
  const steps = [mechanical()] as any[];
  const r = codifyMechanicalSteps(steps);
  assert.deepEqual(r.codified, []);
  assert.equal(stepExecutor(steps[0]), 'model');
  assert.equal(steps[0].call, undefined);
  assert.equal(steps[0].codifiedFrom, undefined);
});

test('does NOT codify a JUDGMENT step behind a mechanical-looking verb', () => {
  const step = { id: 's', prompt: 'Write the executive summary paragraph.', allowedTools: ['gmail_send'], inputs: { a: {} }, output: { type: 'string' } } as any;
  assert.equal(proposeCodifiedStep(step), null);
});

test('does NOT codify an irreversible SEND', () => {
  const step = { id: 's', prompt: 'Post the summary row to the Slack channel.', allowedTools: ['slack_post_message'], inputs: { channel: {} }, output: { type: 'object' } } as any;
  assert.equal(proposeCodifiedStep(step), null);
});

test('does NOT codify a brittle scrape/SERP tool (shape drifts — keep an adaptive LLM)', () => {
  const step = { id: 's', prompt: 'Fetch the prospect homepage.', allowedTools: ['firecrawl_scrape'], inputs: { url: {} }, output: { type: 'string' } } as any;
  assert.equal(proposeCodifiedStep(step), null);
});

test('does NOT codify without an output contract (a bad codify could not be caught)', () => {
  const step = { id: 's', prompt: 'Fetch the ranked keywords.', allowedTools: ['dataforseo_ranked_keywords'], inputs: { target: {} } } as any;
  assert.equal(proposeCodifiedStep(step), null);
});

test('does NOT codify with a "*" or multi-tool allowlist (model still has to choose)', () => {
  const star = { id: 's', prompt: 'Fetch it.', allowedTools: ['*'], inputs: { a: {} }, output: { type: 'object' } } as any;
  const multi = { id: 's', prompt: 'Fetch it.', allowedTools: ['a', 'b'], inputs: { a: {} }, output: { type: 'object' } } as any;
  assert.equal(proposeCodifiedStep(star), null);
  assert.equal(proposeCodifiedStep(multi), null);
});

test('does NOT codify harness, broker, MCP, or dynamic surface tools into direct calls', () => {
  for (const tool of ['read_file', 'run_shell_command', 'composio_execute_tool', 'mcp__firecrawl__scrape', 'dataforseo__ranked_keywords', 'cx_salesforce_get_records', 'composio_apify_*']) {
    const step = { id: 's', prompt: 'Fetch it.', allowedTools: [tool], inputs: { a: {} }, output: { type: 'object' } } as any;
    assert.equal(proposeCodifiedStep(step), null, `${tool} must stay on the model/tool lane`);
  }
});

test('does NOT codify when args are not mechanically derivable (no declared inputs)', () => {
  const step = { id: 's', prompt: 'Fetch the domain metrics.', allowedTools: ['dataforseo_domain_rank_overview'], output: { type: 'object' } } as any;
  assert.equal(proposeCodifiedStep(step), null);
});

test('is idempotent — repeated passes stay a no-op', () => {
  const steps = [mechanical()] as any[];
  codifyMechanicalSteps(steps);
  const again = codifyMechanicalSteps(steps);
  assert.deepEqual(again.codified, []);
  assert.equal(stepExecutor(steps[0]), 'model');
});

test('args resolve by input name and honor an explicit default', () => {
  const step = { id: 's', prompt: 'Get the report.', allowedTools: ['reporter_fetch'], inputs: { id: { from: 'steps.pull.output.id' }, format: { default: 'html' }, region: {} }, output: { type: 'object' } } as any;
  const p = proposeCodifiedStep(step);
  assert.ok(p);
  assert.deepEqual(p!.args, { id: '{{steps.pull.output.id}}', format: 'html', region: '{{input.region}}' });
});
