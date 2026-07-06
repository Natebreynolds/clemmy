/**
 * Run: npx tsx --test src/execution/workflow-execution-mode.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWorkflowExecutionMode, stepExecutor } from './workflow-execution-mode.js';

const wf = (steps: any[]) => ({ name: 'wf', description: 'd', enabled: true, trigger: { manual: true }, steps });

test('stepExecutor classifies by how a step actually runs', () => {
  assert.equal(stepExecutor({ id: 'a', prompt: 'x', call: { tool: 'gmail_send' } }), 'call');
  assert.equal(stepExecutor({ id: 'b', prompt: 'x', deterministic: { runner: 'x.py' } }), 'deterministic');
  assert.equal(stepExecutor({ id: 'c', prompt: 'x', usesSkill: 'brief' }), 'skill');
  assert.equal(stepExecutor({ id: 'd', prompt: 'x' }), 'model');
});

test('AGENTLESS: every step runs as code — no agent, no tokens per run', () => {
  const r = classifyWorkflowExecutionMode(wf([
    { id: 'pull', prompt: 'pull', call: { tool: 'dataforseo_rank' } },
    { id: 'enrich', prompt: 'enrich', deterministic: { runner: 'enrich.py' } },
    { id: 'file', prompt: 'save', call: { tool: 'write_file' } },
  ]));
  assert.equal(r.mode, 'agentless');
  assert.equal(r.codeSteps, 3);
  assert.equal(r.llmSteps, 0);
  assert.equal(r.codeRatio, 1);
  assert.match(r.summary, /pure code/);
});

test('HYBRID: code steps free, LLM only for judgment', () => {
  const r = classifyWorkflowExecutionMode(wf([
    { id: 'pull', prompt: 'pull', call: { tool: 'dataforseo_rank' } },
    { id: 'enrich', prompt: 'enrich', deterministic: { runner: 'enrich.py' } },
    { id: 'draft', prompt: 'Write a tailored brief weighing the competitive gaps.' },
    { id: 'file', prompt: 'save', call: { tool: 'write_file' } },
  ]));
  assert.equal(r.mode, 'hybrid');
  assert.equal(r.codeSteps, 3);
  assert.equal(r.llmSteps, 1);
  assert.deepEqual(r.llmStepIds, ['draft']);
});

test('AGENT + codify candidates: a single-tool mechanical LLM step is flagged as codifiable', () => {
  const r = classifyWorkflowExecutionMode(wf([
    { id: 'fetch', prompt: 'Pull the ranked keywords.', allowedTools: ['dataforseo_ranked_keywords'], output: { type: 'array' } },
    { id: 'judge', prompt: 'Decide which competitors matter most given our positioning and history.', allowedTools: ['*'] },
  ]));
  assert.equal(r.mode, 'agent');
  assert.equal(r.codeSteps, 0);
  // The single-tool mechanical step is a codify candidate; the judgment step is not.
  assert.deepEqual(r.codifyCandidates.map((c) => c.stepId), ['fetch']);
  assert.equal(r.codifyCandidates[0].tool, 'dataforseo_ranked_keywords');
  assert.match(r.summary, /could become code/);
});

test('codify candidates exclude local, broker, and MCP tool lanes', () => {
  const r = classifyWorkflowExecutionMode(wf([
    { id: 'local', prompt: 'Read the local file.', allowedTools: ['read_file'], output: { type: 'string' } },
    { id: 'broker', prompt: 'Fetch the records.', allowedTools: ['composio_execute_tool'], output: { type: 'object' } },
    { id: 'mcp', prompt: 'Query the MCP source.', allowedTools: ['mcp__source__query'], output: { type: 'object' } },
  ]));
  assert.deepEqual(r.codifyCandidates, []);
});

test('an approval-gated step is never proposed for codification', () => {
  const r = classifyWorkflowExecutionMode(wf([
    { id: 'send', prompt: 'Send the outreach.', allowedTools: ['gmail_send'], requiresApproval: true },
  ]));
  assert.equal(r.codifyCandidates.length, 0);
});

test('empty workflow is EMPTY, not a false agentless', () => {
  assert.equal(classifyWorkflowExecutionMode(wf([])).mode, 'empty');
});
