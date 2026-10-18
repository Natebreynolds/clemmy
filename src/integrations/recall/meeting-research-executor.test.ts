import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Agent } from '@openai/agents';
import type { RuntimeContextValue } from '../../types.js';
import type { BuildOrchestratorAgentOptions } from '../../agents/orchestrator.js';
import type { RunConversationOptions } from '../../runtime/harness/loop.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-meeting-executor-policy-'));
const keys = ['CLEMENTINE_HOME', 'CLEMMY_TEST_ISOLATED_HOME', 'CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT',
  'OPENAI_AGENTS_DISABLE_TRACING', 'CLEMMY_COMPLETION_REVIEW'] as const;
const prior = new Map(keys.map(key => [key, process.env[key]]));
Object.assign(process.env, { CLEMENTINE_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1',
  CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT: 'off', OPENAI_AGENTS_DISABLE_TRACING: '1' });
const { createMeetingResearchExecutor } = await import('./meeting-research-executor.js');
after(() => {
  for (const key of keys) {
    const value = prior.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

test('default research adapter follows OFF, ON and default owner policy without opening stores or changing its private surface', async () => {
  const input = { sessionId: 'sess-controlled-meeting-executor', sourceUserSeq: 37,
    runAttemptId: 'attempt:controlled-meeting-executor', input: 'Controlled supplied-evidence question.' };
  const result = { status: 'controlled_result' };
  const agent = new Agent<RuntimeContextValue, any>({ name: 'Controlled recording agent', instructions: 'Controlled only.', tools: [] });
  let loaded = 0;
  const calls: RunConversationOptions[] = [];
  const builds: BuildOrchestratorAgentOptions[] = [];
  const execute = createMeetingResearchExecutor(async () => {
    loaded++;
    return {
      runConversation: async options => {
        calls.push(options);
        assert.ok(options.buildAgent);
        assert.equal(await options.buildAgent({ sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq }), agent);
        return result;
      },
      buildOrchestratorAgent: async options => { builds.push(options); return agent; },
    };
  });
  assert.equal(loaded, 0, 'adapter construction must stay passive');
  for (const [setting, expected] of [['off', false], ['on', true], [undefined, true]] as const) {
    if (setting === undefined) delete process.env.CLEMMY_COMPLETION_REVIEW;
    else process.env.CLEMMY_COMPLETION_REVIEW = setting;
    const environment = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const previousCalls = calls.length; const previousBuilds = builds.length;
    assert.equal(await execute(input), result);
    assert.equal(calls.length, previousCalls + 1); assert.equal(builds.length, previousBuilds + 1);
    const seen = calls.at(-1); const built = builds.at(-1);
    assert.ok(seen);
    assert.equal(seen.judgeCompletion, expected, `canonical owner setting ${String(setting)}`);
    assert.deepEqual({ sessionId: seen.sessionId, sourceUserSeq: seen.sourceUserSeq,
      runAttemptId: seen.runAttemptId, input: seen.input }, input);
    assert.equal(seen.reuseRecordedUserInput, true);
    assert.deepEqual(seen.learningPolicy, { version: 1, mode: 'exclude', reason: 'owner_opt_out' });
    assert.equal(seen.suppressMemoryCapture, true); assert.equal(seen.suppressAutomaticMemoryForRequest, true);
    assert.equal(seen.mcpToolScope, null); assert.equal(seen.callerOwnsRecovery, true);
    assert.deepEqual([seen.maxSteps, seen.maxTurns, seen.maxWallClockMs, seen.maxRunTokens], [1, 2, 90_000, 32_000]);
    assert.deepEqual(built, { sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq,
      userInput: input.input, allowedToolNames: [], allowToolJit: false });
    assert.deepEqual(Object.fromEntries(keys.map(key => [key, process.env[key]])), environment,
      'executing the adapter must not rewrite owner settings or its environment');
    assert.deepEqual(readdirSync(home), [], 'no database, settings file or other home artifact is created');
  }
  assert.equal(loaded, 3, 'each accepted execution reads current owner policy, not factory-time policy');
});
