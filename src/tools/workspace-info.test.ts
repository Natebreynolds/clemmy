import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunContext } from '@openai/agents';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-workspace-info-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const { getLocalRuntimeTools, getLocalDeferredDispatchTools } = await import('./local-runtime-tools.js');
const { InvalidArgumentsPreDispatchResult, attemptSignalsFromTypedResult } = await import('../runtime/harness/attempt-settlement.js');
const { createSession, getToolOutputForInvocation } = await import('../runtime/harness/eventlog.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { exactToolOutputForInvocation } = await import('../runtime/harness/tool-output-format.js');

after(() => rmSync(testHome, { recursive: true, force: true }));

for (const [surface, tools] of [
  ['native', getLocalRuntimeTools],
  ['deferred', getLocalDeferredDispatchTools],
] as const) {
  test(`${surface} workspace_info file/missing path is a repairable non-dispatch result`, async () => {
    const info = tools().find(t => t.name === 'workspace_info');
    assert.ok(info && info.type === 'function');
    const file = path.join(testHome, `${surface}-performance.csv`);
    writeFileSync(file, 'account,revenue\nAcorn,60000\n');
    for (const projectPath of [file, path.join(testHome, `${surface}-absent`)]) {
      const result = await info.invoke(new RunContext({ sessionId: `workspace-info-${surface}` }),
        JSON.stringify({ project_path: projectPath, include_tree: false }));
      assert.ok(result instanceof InvalidArgumentsPreDispatchResult,
        'a directory precondition failure must not become a succeeded read');
      assert.deepEqual(attemptSignalsFromTypedResult(result), {
        preDispatch: true, argumentValidationFailed: true, schemaAvailable: true,
      });
      assert.match(String(result), /directory/i);
      if (projectPath === file) assert.match(String(result), /read_file/);
    }
    const repaired = await info.invoke(new RunContext({ sessionId: `workspace-info-${surface}` }),
      JSON.stringify({ project_path: testHome, include_tree: false }));
    assert.equal(typeof repaired, 'string');
    assert.match(String(repaired), /Path:/);
  });
}

test('workspace_info retains complete project sources and late directory entries across the real adapter', async () => {
  const project = path.join(testHome, 'complete-project');
  mkdirSync(path.join(project, '.claude'), { recursive: true });
  const notes = 'Project guidance\n' + 'n'.repeat(8000) + '\nNOTES_TAIL: use the owner-approved framework.\n';
  const readme = 'Project brief\n' + 'r'.repeat(24000) + '\nREADME_TAIL: only the revised objective governs.\n';
  writeFileSync(path.join(project, '.claude/CLAUDE.md'), notes);
  writeFileSync(path.join(project, 'README.md'), readme);
  for (let i = 0; i < 90; i++) writeFileSync(path.join(project, `record-${String(i).padStart(3, '0')}.txt`), '');
  const session = createSession({ id: 'workspace-info-complete', kind: 'chat', userId: 'workspace-info-test' });
  const callId = 'workspace-info-complete-call';
  const settlementNonce = randomUUID();
  const info = getLocalDeferredDispatchTools().find(t => t.name === 'workspace_info');
  assert.ok(info && info.type === 'function');
  const output = await withToolOutputContext({ sessionId: session.id, callId, toolName: 'workspace_info', settlementNonce }, () =>
    info.invoke(new RunContext({ sessionId: session.id }), JSON.stringify({ project_path: project, include_tree: true }),
      { toolCall: { call_id: callId } } as never));
  const retained = getToolOutputForInvocation(session.id, callId, settlementNonce);
  assert.ok(retained && !retained.truncatedAtWrite);
  assert.ok(retained.output.includes(notes), 'late project instructions are preserved exactly');
  assert.ok(retained.output.includes(readme), 'late README requirements are preserved exactly');
  assert.match(retained.output, /record-089.txt/, 'listing must not silently omit entries after 60');
  assert.equal(exactToolOutputForInvocation({ sessionId: session.id, callId, toolName: 'workspace_info',
    compactResult: output, settlementNonce }), retained.output, 'the displayed result redeems the same complete bytes');
  assert.match(String(output), /recall_tool_result|tool_output_query/);
});
