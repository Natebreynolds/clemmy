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
