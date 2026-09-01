/**
 * Causal host-v1 regression for a contracted workflow step that finishes a
 * model batch with prose before emitting workflow_step_result.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-workflow-result-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-host-workflow-result\n', 'utf8');

const { runConversation } = await import('./loop.js');
const { HarnessSession } = await import('./session.js');
const eventlog = await import('./eventlog.js');
const stepResults = await import('../../tools/step-result-tool.js');
const { auditAcceptedSourceSettlementTruth } = await import('./accepted-source-settlement-audit.js');

after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const textMessage = (text: string) => ({
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text }],
});

async function* modelStream(this: {
  getResponse: (request: unknown) => Promise<{
    output: unknown[];
    responseId: string;
    usage: Record<string, unknown>;
  }>;
}, request: unknown) {
  const response = await this.getResponse(request);
  yield { type: 'response_started' } as never;
  yield { type: 'model', event: { type: 'finish', finishReason: 'stop' } } as never;
  yield {
    type: 'response_done',
    response: {
      id: response.responseId,
      usage: response.usage,
      output: response.output,
    },
  } as never;
}

test('host_v1 keeps one accepted workflow source alive until its contracted result is captured', async () => {
  const session = HarnessSession.create({
    kind: 'workflow',
    title: 'Platform 49 contracted step',
  });
  stepResults.registerStepContract(session.id, {
    type: 'object',
    required_keys: ['url', 'leads'],
    non_empty: ['leads'],
    min_items: { leads: 1 },
    verify: { url_present: ['url'] },
  });

  let calls = 0;
  const requests: unknown[] = [];
  const model = {
    async getResponse(request: unknown) {
      requests.push(request);
      calls += 1;
      if (calls === 2) {
        stepResults.recordStepResult(session.id, {
          url: 'https://example.test/platform-49',
          leads: [{ id: 'new-platform-item' }],
        });
      }
      return {
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          requests: 1,
        },
        output: [textMessage(calls === 1
          ? 'I found new activity, but no writes or structured result have been completed.'
          : 'Done.')],
        responseId: `host-workflow-result-${calls}`,
      };
    },
    getStreamedResponse: modelStream,
  };

  try {
    const result = await runConversation({
      sessionId: session.id,
      input: 'Run the contracted Platform 49 workflow step.',
      turnEngine: 'host_v1',
      maxTurns: 4,
      judgeCompletion: false,
      buildAgent: async () => ({
        model,
        instructions: 'Complete the workflow step and emit its structural result.',
        tools: [],
      }) as never,
      makeRunner: () => {
        const runner = new EventEmitter();
        (runner as unknown as { run: () => never }).run = () => {
          throw new Error('legacy Runner.run must remain unreachable');
        };
        return runner as never;
      },
    });

    assert.equal(result.status, 'completed');
    assert.equal(calls, 2, 'the first prose stop is continued inside the same host activation');
    assert.match(JSON.stringify(requests[1]), /WORKFLOW STEP CONTINUATION/);
    assert.match(JSON.stringify(requests[1]), /do not repeat a successful call/i);

    const acceptedSources = eventlog.listEvents(session.id, {
      types: ['user_input_received'],
    });
    assert.equal(acceptedSources.length, 1, 'the repair cannot mint a new user source');
    const authorityRows = eventlog.openEventLog().prepare(`
      SELECT source_user_seq
        FROM accepted_turn_call_authorities
       WHERE session_id = ?
    `).all(session.id) as Array<{ source_user_seq: number }>;
    assert.deepEqual(
      authorityRows,
      [{ source_user_seq: acceptedSources[0]!.seq }],
      'the repair remains inside the original frozen call authority',
    );
    assert.deepEqual(stepResults.peekStepResult(session.id), {
      found: true,
      value: {
        url: 'https://example.test/platform-49',
        leads: [{ id: 'new-platform-item' }],
      },
    });
  } finally {
    stepResults.clearStepContract(session.id);
    stepResults.clearStepResult(session.id);
  }
});

test('host_v1 bounds repeated missing-result prose to two continuations', async () => {
  const session = HarnessSession.create({
    kind: 'workflow',
    title: 'Bounded contracted step',
  });
  stepResults.registerStepContract(session.id, {
    type: 'object',
    required_keys: ['url'],
    verify: { url_present: ['url'] },
  });

  let calls = 0;
  const requests: unknown[] = [];
  const model = {
    async getResponse(request: unknown) {
      requests.push(request);
      calls += 1;
      return {
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          requests: 1,
        },
        output: [textMessage(`Still incomplete after model step ${calls}.`)],
        responseId: `host-workflow-result-bounded-${calls}`,
      };
    },
    getStreamedResponse: modelStream,
  };

  try {
    const result = await runConversation({
      sessionId: session.id,
      input: 'Run the bounded contracted workflow step.',
      turnEngine: 'host_v1',
      maxTurns: 6,
      judgeCompletion: false,
      buildAgent: async () => ({
        model,
        instructions: 'Complete the workflow step and emit its structural result.',
        tools: [],
      }) as never,
      makeRunner: () => {
        const runner = new EventEmitter();
        (runner as unknown as { run: () => never }).run = () => {
          throw new Error('legacy Runner.run must remain unreachable');
        };
        return runner as never;
      },
    });

    assert.equal(result.status, 'completed');
    assert.equal(calls, 3, 'two local nudges are allowed, then the third prose stop is terminal');
    assert.match(JSON.stringify(requests[1]), /WORKFLOW STEP CONTINUATION/);
    assert.match(JSON.stringify(requests[2]), /WORKFLOW STEP CONTINUATION/);
    assert.equal(requests[3], undefined, 'the bounded repair cannot start a fourth model step');
    assert.equal(stepResults.peekStepResult(session.id).found, false);

    const acceptedSources = eventlog.listEvents(session.id, {
      types: ['user_input_received'],
    });
    assert.equal(acceptedSources.length, 1, 'bounded continuation cannot mint retry sources');
  } finally {
    stepResults.clearStepContract(session.id);
    stepResults.clearStepResult(session.id);
  }
});

test('host_v1 ordinary chat without a registered step contract remains one model call', async () => {
  const session = HarnessSession.create({
    kind: 'chat',
    title: 'Ordinary chat',
  });

  let calls = 0;
  const requests: unknown[] = [];
  const model = {
    async getResponse(request: unknown) {
      requests.push(request);
      calls += 1;
      return {
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          requests: 1,
        },
        output: [textMessage('Here is the ordinary answer.')],
        responseId: `host-ordinary-chat-${calls}`,
      };
    },
    getStreamedResponse: modelStream,
  };

  const result = await runConversation({
    sessionId: session.id,
    input: 'Give me an ordinary answer.',
    turnEngine: 'host_v1',
    maxTurns: 4,
    judgeCompletion: false,
    buildAgent: async () => ({
      model,
      instructions: 'Answer the user.',
      tools: [],
    }) as never,
    makeRunner: () => {
      const runner = new EventEmitter();
      (runner as unknown as { run: () => never }).run = () => {
        throw new Error('legacy Runner.run must remain unreachable');
      };
      return runner as never;
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(calls, 1, 'the completion fence is opt-in through the registered workflow contract');
  assert.doesNotMatch(JSON.stringify(requests[0]), /WORKFLOW STEP CONTINUATION/);
  assert.equal(requests[1], undefined);
});

test('host_v1 does not continue a missing workflow result across an uncertain write', async () => {
  const session = HarnessSession.create({
    kind: 'workflow',
    title: 'Contracted step with uncertain write',
  });
  stepResults.registerStepContract(session.id, {
    type: 'object',
    required_keys: ['url'],
    verify: { url_present: ['url'] },
  });

  let calls = 0;
  const requests: unknown[] = [];
  let acceptedSourceUserSeq: number | undefined;
  const model = {
    async getResponse(request: unknown) {
      requests.push(request);
      calls += 1;
      const acceptedSource = eventlog.listEvents(session.id, {
        types: ['user_input_received'],
      })[0];
      assert.ok(acceptedSource, 'the host must accept the source before its first model step');
      acceptedSourceUserSeq = acceptedSource.seq;
      eventlog.appendEvent({
        sessionId: session.id,
        turn: acceptedSource.turn,
        role: 'system',
        type: 'external_write',
        data: {
          shapeKey: 'GOOGLESHEETS_BATCH_UPDATE',
          preDispatch: true,
          canonicalCallId: 'call-host-uncertain-write',
          targets: ['sheet-1'],
        },
      });
      eventlog.appendEvent({
        sessionId: session.id,
        turn: acceptedSource.turn,
        role: 'system',
        type: 'external_write_orphaned',
        data: {
          shapeKey: 'GOOGLESHEETS_BATCH_UPDATE',
          canonicalCallId: 'call-host-uncertain-write',
          targets: ['sheet-1'],
          reason: '[provider-dispatch:uncertain] provider outcome is unknown after dispatch',
        },
      });
      return {
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          requests: 1,
        },
        output: [textMessage('The workflow result has not been captured.')],
        responseId: `host-workflow-result-uncertain-${calls}`,
      };
    },
    getStreamedResponse: modelStream,
  };

  try {
    await runConversation({
      sessionId: session.id,
      input: 'Run the contracted workflow step with a write.',
      turnEngine: 'host_v1',
      maxTurns: 4,
      judgeCompletion: false,
      buildAgent: async () => ({
        model,
        instructions: 'Complete the workflow step and emit its structural result.',
        tools: [],
      }) as never,
      makeRunner: () => {
        const runner = new EventEmitter();
        (runner as unknown as { run: () => never }).run = () => {
          throw new Error('legacy Runner.run must remain unreachable');
        };
        return runner as never;
      },
    });

    assert.equal(calls, 1, 'uncertain write truth cannot start a continuation model step');
    assert.equal(requests[1], undefined);
    assert.ok(acceptedSourceUserSeq !== undefined);
    const audit = auditAcceptedSourceSettlementTruth({
      sessionId: session.id,
      sourceUserSeq: acceptedSourceUserSeq,
      requiresBusinessEvidence: false,
      requireEveryBusinessReadToSettle: false,
    });
    assert.equal(audit.status, 'uncertain_write', JSON.stringify(audit));
  } finally {
    stepResults.clearStepContract(session.id);
    stepResults.clearStepResult(session.id);
  }
});
