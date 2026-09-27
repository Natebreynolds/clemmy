/**
 * Run: node scripts/run-tests-isolated.mjs src/agents/advertised-tool-contracts.test.ts
 *
 * A tool's advertised definition states its call contract. Policy lives with
 * its one owner: the host instructions and rubric, the tool's own result where
 * the situation arises, or a refusal that teaches the fix. These tools ride
 * every round of every tool-bearing turn, so each is measured on the exact
 * projection the host runner sends (serializeAdvertisedTools over the built
 * orchestrator agent, or over the production work_call builder) under a byte
 * ceiling, and each lesson that left a description is pinned where it lives
 * now. Ceilings sit just above the trimmed size and below the prior one
 * (Lean Rounds round-1 wire, before -> after, in each test).
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-advertised-tool-contracts-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const { buildOrchestratorAgent } = await import('./orchestrator.js');
const { serializeAdvertisedTools } = await import('../runtime/harness/advertised-tool-wire.js');
const { closeEventLog } = await import('../runtime/harness/eventlog.js');
const { buildWorkCall } = await import('../tools/work-call.js');
const { digestToolOutput } = await import('../runtime/harness/tool-output-digest.js');

after(() => {
  try { closeEventLog(); } catch { /* not opened */ }
  rmSync(TMP_HOME, { recursive: true, force: true });
});

interface WireTool { name: string; description: string; parameters: Record<string, unknown> }

function wireOf(tools: readonly unknown[]): Map<string, WireTool> {
  const wire = serializeAdvertisedTools(tools as never) as WireTool[];
  return new Map(wire.map((tool) => [tool.name, tool]));
}

let builtSurface: Promise<Map<string, WireTool>> | null = null;
/** The default orchestrator surface, projected exactly as the runner sends it. */
function builtWire(): Promise<Map<string, WireTool>> {
  builtSurface ??= buildOrchestratorAgent().then((agent) => wireOf(agent.tools ?? []));
  return builtSurface;
}

function withinCeiling(tool: WireTool | undefined, name: string, ceiling: number): WireTool {
  assert.ok(tool, `${name} is on the advertised surface`);
  const size = Buffer.byteLength(JSON.stringify(tool), 'utf8');
  assert.ok(size <= ceiling, `${name} advertises ${size} B, above its ${ceiling} B ceiling`);
  return tool;
}

test('session_search advertises its call contract; paging, coverage and authority live in its result', async () => {
  // 2,684 -> 1,029 B.
  const tool = withinCeiling((await builtWire()).get('session_search'), 'session_search', 1_100);
  assert.match(tool.description, /session_history/, 'the call contract names the exact reader for a hit');
  assert.match(tool.description, /include_current_conversation/);
  assert.match(tool.description, /all must match/);
  const properties = tool.parameters.properties as Record<string, { anyOf?: Array<Record<string, unknown>> }>;
  for (const field of ['after', 'before']) {
    const branch = properties[field]!.anyOf!.find((entry) => entry.type === 'string')!;
    assert.equal(branch.format, 'date-time', `${field} states its grammar by format name`);
    assert.equal(Object.hasOwn(branch, 'pattern'), false, `${field} no longer carries zod's date-time regex`);
  }
});

test('the proposal-free work_call states its call contract; planning policy stays with its one owner', () => {
  // 4,427 -> 2,969 B.
  const tool = withinCeiling(wireOf([buildWorkCall({ requireHostPlan: true })]).get('work_call'), 'work_call', 3_050);
  assert.match(tool.description, /consent and dispatch boundary/);
  assert.match(tool.description, /plan_task/, 'a pre-plan carrier names where graph work goes');
  assert.match(tool.description, /plan_step_result/);
  assert.doesNotMatch(tool.description, /source_call_ids|broad-search/,
    'lineage and discovery policy live in the [action-planning] line, the field contract and the rubric');
  const fields = tool.parameters.properties as Record<string, { description?: string }>;
  assert.match(fields.requirement_id!.description ?? '', /never search again/,
    'a disclosed capabilityRef is not re-obtained through tool_search');
  assert.match(fields.source_call_ids!.description ?? '', /null when a read only informed order, a condition or a decision/);
  assert.match(fields.universe_item_id!.description ?? '', /JSON null, not "null"/);
});

test('tool_output_query advertises its query contract; the lossless-storage lesson lives in the reader footer', async () => {
  // 3,301 -> 2,520 B.
  const tool = withinCeiling((await builtWire()).get('tool_output_query'), 'tool_output_query', 2_600);
  assert.match(tool.description, /counts, totals, averages and top-N rankings/);
  const where = (tool.parameters.properties as Record<string, { anyOf?: Array<{ items?: { properties?: Record<string, { enum?: unknown }> } }> }>).where!;
  assert.deepEqual(where.anyOf![0]!.items!.properties!.op!.enum, ['eq', 'ne', 'contains', 'lt', 'lte', 'gt', 'gte'],
    'the operator list is the enum, not description prose');
  const rows = Array.from({ length: 40 }, (_, index) => ({ id: `row-${index}`, title: `Row ${index} ${'x'.repeat(60)}` }));
  const digest = digestToolOutput(JSON.stringify(rows), { maxChars: 1_500, toolName: 'fixture_list', callId: 'call_footer' });
  assert.match(digest, /tool_output_query \{"call_id":"call_footer"/);
  assert.match(digest, /do NOT say the data is unavailable/);
});

test('recall_tool_result advertises its read contract; the next offset lives in each slice header', async () => {
  // 1,127 -> 905 B.
  const tool = withinCeiling((await builtWire()).get('recall_tool_result'), 'recall_tool_result', 960);
  assert.match(tool.description, /one slice from `offset`/);
  assert.match(tool.description, /recall_tool_result \{"call_id":"call_abc123"\}/);
});
