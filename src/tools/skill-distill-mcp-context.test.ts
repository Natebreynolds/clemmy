/** Actual local MCP registration: manual learning uses its exact accepted
 * request and query owner, without a new model call or transport workaround. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Runner } from '@openai/agents';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-manual-skill-mcp-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_GOAL_CONTRACT = 'on';
process.env.CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT = 'off';

const { createClementineMcpServer } = await import('./mcp-server.js');
const { appendEvent, beginRunAttempt, bindRunAttemptSourceUserEvent, closeEventLog, createSession } =
  await import('../runtime/harness/eventlog.js');
const { activateDispatchLease, revokeDispatchLease, StaleDispatchLeaseError } =
  await import('../runtime/harness/dispatch-lease.js');
const { loadSkill, writeDistilledSkill } = await import('../memory/skill-store.js');
const { commitTurnOutcome } = await import('../runtime/harness/delivery-committer.js');
const { turnOutcomeId } = await import('../runtime/harness/turn-outcome.js');
const { peekTaskContinuityPacket, consumeTaskContinuityPacket } = await import('../memory/task-continuity.js');
const { canonicalClarificationTaskInput, CLARIFICATION_RESOLVER_VERSION, rehydrateConsumedClarificationContext } =
  await import('../runtime/harness/task-continuity-runtime.js');

let modelCalls = 0;
test.mock.method(Runner.prototype, 'run', async () => {
  modelCalls++;
  throw new Error('No model execution is permitted in this controlled MCP fixture.');
});
test.after(() => { test.mock.restoreAll(); closeEventLog(); rmSync(TEST_HOME, { recursive: true, force: true }); });

function fixture(label: string, text: string, priorConsent = false) {
  const session = createSession({ kind: 'chat' });
  if (priorConsent) appendEvent({ sessionId: session.id, turn: 0, role: 'user', type: 'user_input_received',
    data: { text: 'Save this as a reusable playbook.' } });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text } });
  const attempt = beginRunAttempt(session.id);
  bindRunAttemptSourceUserEvent(attempt, source.seq);
  const lease = activateDispatchLease({ sessionId: session.id, scopeId: `${session.id}::query`,
    runAttemptId: attempt.attemptId });
  const objective = `Read controlled ${label} records and prepare a reusable report`;
  const name = `manual-mcp-${label}`;
  assert.equal(writeDistilledSkill({ name, description: objective, body: '1. Read the controlled input.\n2. Verify the report.',
    origin: { kind: 'chat', sourceId: `fixture:${label}` }, capabilityTask: objective }), name);
  const server = createClementineMcpServer({ sessionId: session.id, sourceUserSeq: source.seq,
    dispatchLease: lease, runScopeId: `${session.id}::run`, directOrchestrator: true,
    allowedTools: ['skill_distill', 'skill_read'] });
  const tools = (server as unknown as { _registeredTools: Record<string, {
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text?: string }> }>;
  }> })._registeredTools;
  assert.ok(tools.skill_distill);
  return { session, source, attempt, lease, objective, name, tools };
}

function body(result: { content: Array<{ text?: string }> }): string {
  return result.content.map(item => item.text ?? '').join('\n');
}

test('actual MCP manual save retains exact human consent across unrelated and synthetic session updates', async () => {
  const f = fixture('exact-consent', 'Save this as a reusable playbook.');
  for (let n = 0; n < 24; n++) appendEvent({ sessionId: f.session.id, turn: n + 2, role: 'user',
    type: 'user_input_received', data: { text: 'A controlled background result arrived.', synthetic: true,
      source: 'outcome', sourceLabel: 'controlled workflow', sourceId: `fixture-outcome-${n}`, deliveryPhase: 'report' } });
  appendEvent({ sessionId: f.session.id, turn: 30, role: 'user', type: 'user_input_received',
    data: { text: 'What time is the next meeting?' } });
  const result = body(await f.tools.skill_distill.handler({ objective: f.objective }));
  assert.match(result, /already matches an existing skill/);
  const saved = loadSkill(f.name)!;
  assert.ok(saved.frontmatter.capabilityOrigins?.some(origin => origin.kind === 'manual' && origin.sourceId === f.source.id));
  const receipt = saved.frontmatter.learningReceipts?.find(row => row.authority === 'manual_user_request');
  assert.equal(receipt?.sessionId, f.session.id);
  assert.equal(receipt?.sourceId, f.source.id);
  assert.ok(receipt?.evidence.includes('explicit_user_request'));
  assert.ok(receipt?.evidence.includes('manual_draft_request'));
  assert.equal(receipt?.evidence.includes('terminal_success'), false);
  assert.equal(saved.frontmatter.tier, 'draft');
  assert.equal(receipt?.evidence.includes('independent_validation'), false,
    'manual opt-in is never relabelled as independent execution proof');
  const read = body(await f.tools.skill_read.handler({ name: f.name }));
  assert.match(read, /USER-REQUESTED DRAFT/);
  assert.match(read, /not independent execution proof/);
  assert.equal(modelCalls, 0, 'duplicate reuse adds no model or judge round');
});

test('actual MCP ordinary accepted request cannot borrow an older or newer preservation message', async () => {
  const f = fixture('ordinary-request', 'Read the controlled input and summarize it.', true);
  appendEvent({ sessionId: f.session.id, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Save this as a reusable playbook.' } });
  const before = readFileSync(loadSkill(f.name)!.skillPath, 'utf8');
  const result = body(await f.tools.skill_distill.handler({ objective: f.objective }));
  assert.doesNotMatch(result, /already matches|Distilled a draft skill/);
  assert.equal(readFileSync(loadSkill(f.name)!.skillPath, 'utf8'), before);
  assert.equal(modelCalls, 0);
});

test('actual MCP revoked physical query cannot enter manual save or alter its retained draft', async () => {
  const f = fixture('revoked-query', 'Remember how to do this next time.');
  const before = readFileSync(loadSkill(f.name)!.skillPath, 'utf8');
  revokeDispatchLease(f.lease);
  await assert.rejects(f.tools.skill_distill.handler({ objective: f.objective }),
    (err: unknown) => err instanceof StaleDispatchLeaseError);
  assert.equal(readFileSync(loadSkill(f.name)!.skillPath, 'utf8'), before);
  assert.equal(modelCalls, 0);
});

test('actual MCP clarification answer rehydrates exact earlier consent, while a current opt-out wins', async () => {
  for (const decline of [false, true]) {
    const f = fixture(decline ? 'clarification-optout' : 'clarification-consent', 'Save this as a reusable playbook.');
    const question = 'Which controlled input should I use?';
    appendEvent({ sessionId: f.session.id, turn: f.source.turn, role: 'Clem', type: 'awaiting_user_input',
      data: { question, purpose: 'clarification', sourceUserSeq: f.source.seq } });
    const identity = { sessionId: f.session.id, sourceUserSeq: f.source.seq, turn: f.source.turn };
    commitTurnOutcome({ version: 2, id: turnOutcomeId(identity), identity, status: 'needs_input', resumable: true,
      needs: { kind: 'input' }, presentation: { kind: 'question', text: question } });
    assert.equal(peekTaskContinuityPacket({ sessionId: f.session.id }).status, 'available');
    const answer = decline ? "Use the controlled input, but don't save this as a skill." : 'Use the controlled input.';
    const source = appendEvent({ sessionId: f.session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: answer } });
    const canonical = canonicalClarificationTaskInput({ parentInput: String(f.source.data.text), question, answer });
    assert.ok(canonical);
    assert.equal(consumeTaskContinuityPacket({ sessionId: f.session.id, consumingSourceUserSeq: source.seq,
      resolution: { resolverVersion: CLARIFICATION_RESOLVER_VERSION, disposition: 'provided',
        semanticInputHash: createHash('sha256').update(canonical).digest('hex') } }).status, 'consumed');
    assert.equal(rehydrateConsumedClarificationContext({ sessionId: f.session.id, sourceUserSeq: source.seq, answer })
      ?.parentSourceUserSeq, f.source.seq);
    const attempt = beginRunAttempt(f.session.id);
    bindRunAttemptSourceUserEvent(attempt, source.seq);
    const lease = activateDispatchLease({ sessionId: f.session.id, scopeId: `${f.session.id}::followup-query`,
      runAttemptId: attempt.attemptId });
    // The real MCP options have no taskContinuation. The handler must recover
    // the exact consumed A/Q/B edge rather than borrow a visible/latest input.
    const server = createClementineMcpServer({ sessionId: f.session.id, sourceUserSeq: source.seq, dispatchLease: lease,
      allowedTools: ['skill_distill'] });
    const registered = (server as unknown as { _registeredTools: typeof f.tools })._registeredTools;
    const before = readFileSync(loadSkill(f.name)!.skillPath, 'utf8');
    const result = body(await registered.skill_distill.handler({ objective: f.objective }));
    if (decline) {
      assert.doesNotMatch(result, /already matches|Distilled a draft skill/);
      assert.equal(readFileSync(loadSkill(f.name)!.skillPath, 'utf8'), before);
    } else {
      assert.match(result, /already matches an existing skill/);
      const receipt = loadSkill(f.name)!.frontmatter.learningReceipts?.find(row => row.authority === 'manual_user_request');
      assert.equal(receipt?.sourceId, f.source.id);
      assert.notEqual(receipt?.sourceId, source.id, 'the clarification answer supplies execution, not a new consent quote');
    }
  }
  assert.equal(modelCalls, 0);
});
