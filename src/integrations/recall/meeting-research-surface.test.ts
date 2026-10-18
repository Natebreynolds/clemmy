import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-meeting-research-surface-'));
Object.assign(process.env, { CLEMENTINE_HOME: home, CLEMMY_TEST_ISOLATED_HOME: '1',
  CLEMMY_TEST_DISABLE_LIVE_MODELS: '1', CLEMMY_ALLOW_LIVE_MODEL_TRANSPORT: 'off',
  OPENAI_AGENTS_DISABLE_TRACING: '1', MCP_AUTO_IMPORT_ENABLED: 'false', EMBEDDINGS_DISABLED: 'true',
  CLEMMY_EMBEDDINGS: 'off', HARNESS_TOOL_BRACKETS: 'on' });
const eventlog = await import('../../runtime/harness/eventlog.js');
const memory = await import('../../memory/db.js');
const facts = await import('../../memory/facts.js');
const { createFocus } = await import('../../memory/focus.js');
const vault = await import('../../memory/vault.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const { memoryTailScopeFor } = await import('../../agents/harness-context.js');
const boundary = await import('./meeting-research-boundary.js');
const brackets = await import('../../runtime/harness/brackets.js');
const { RunContext } = await import('@openai/agents');
test.after(() => { boundary.installMeetingResearchBoundary(null); eventlog.closeEventLog(); memory.closeMemoryDb(); rmSync(home, { recursive: true, force: true }); });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
let ordinal = 0;
function acceptedResearch() {
  const index = ++ordinal;
  const session = eventlog.createSession({ id: `meeting-research-surface-${index}`, kind: 'chat', userId: 'controlled-owner' });
  const text = 'Privately answer the meeting question using only its selected supplied evidence.';
  const requestId = `meeting-research-controlled-${index}`; const runId = `meeting-research-run-${index}`;
  const receipt = eventlog.claimHarnessChatRequest({ requestId, sessionId: session.id, runId, inputHash: sha(text), sinceSeq: 0 });
  assert.equal(receipt.inserted, true);
  const claim = eventlog.claimRunAttemptLease({ sessionId: session.id, runId, ownerId: 'controlled-surface-test', leaseMs: 60_000 });
  assert.ok(claim.claimed && claim.attempt); if (!claim.attempt) throw new Error('fixture source has no attempt');
  const source = eventlog.recordRunAttemptUserInput(claim.attempt, { turn: 1, role: 'user', data: {
    text, displayText: text, source: 'meeting_research', requestId, clientRequestId: requestId,
    runId, attemptId: claim.attempt.attemptId,
    meetingResearchInputDigest: sha(text), meetingResearchReference: { meetingId: `meeting-${index}`,
      jobId: sha(`job-${index}`), grantRevision: 1, grantDigest: sha(`grant-${index}`) },
  } }, { armRunInFlight: false });
  return { session, source, text };
}

test('actual orchestrator constructor derives zero tools/MCP and bounded standing context from the exact research source', async () => {
  const f = acceptedResearch();
  for (const file of [vault.SOUL_FILE, vault.MEMORY_FILE, vault.IDENTITY_FILE]) {
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, 'PRIVATE_VAULT_SURFACE_SENTINEL\n');
  }
  facts.rememberFact({ kind: 'project', content: 'Ordinary information PRIVATE_PROJECT_FACT_SURFACE_SENTINEL.' });
  const global = facts.rememberFact({ kind: 'constraint', content: 'Always label uncertainty with GLOBAL_STANDING_SURFACE_SENTINEL.' });
  const userInstruction = facts.rememberFact({ kind: 'user', content: 'Always lead with LEGACY_USER_INSTRUCTION_SURFACE_SENTINEL.' });
  facts.setFactPinned(userInstruction.id, true);
  facts.rememberFact({ kind: 'constraint', content: 'Use PRIVATE_PROJECT_RULE_SURFACE_SENTINEL here.', scope: { projectId: 'private-project', agentKey: null } });
  createFocus({ resourceRef: `session:${f.session.id}`, resourceKind: 'thread', relatedSessionId: f.session.id,
    title: 'PRIVATE_FOCUS_SURFACE_SENTINEL', summary: 'Unrelated active work.' });
  let networkAttempts = 0; const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { networkAttempts++; throw new Error('Network is forbidden in this surface control.'); };
  let agent;
  try {
    agent = await buildOrchestratorAgent({ sessionId: f.session.id, sourceUserSeq: f.source.seq, userInput: f.text,
      allowedToolNames: ['call_tool', 'work_call', 'run_shell_command', 'composio_execute_tool', 'run_worker', 'read_file', 'memory_recall_all'],
      allowToolJit: true, mcpToolScope: { authority: 'catalog', allowAll: true, reason: 'Caller attempts a broader surface' } });
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(networkAttempts, 0, 'construction cannot buy discovery/model work');
  assert.equal(agent.name, 'Clem'); assert.deepEqual(agent.tools, []); assert.deepEqual(agent.mcpServers ?? [], []);
  const instructions = await agent.getSystemPrompt(new RunContext({} as never));
  assert.equal(typeof instructions, 'string'); assert.ok(instructions!.includes(global.content)); assert.ok(instructions!.includes(userInstruction.content));
  assert.doesNotMatch(instructions!, /PRIVATE_VAULT_SURFACE_SENTINEL|PRIVATE_PROJECT_FACT_SURFACE_SENTINEL|PRIVATE_FOCUS_SURFACE_SENTINEL|PRIVATE_PROJECT_RULE_SURFACE_SENTINEL/);
  assert.equal(memoryTailScopeFor(agent.instructions), undefined);
  const policy = eventlog.listEvents(f.session.id, { types: ['tool_policy_resolved'] }).find(row => row.data.sourceUserSeq === f.source.seq);
  assert.ok(policy); assert.deepEqual(policy.data.resolvedToolNames, []);
  assert.equal(policy.data.semanticAcquisitionSkipped, true); assert.equal(policy.data.schemaWarmSkipped, true);
});

test('actual wrapped tool entry refuses research carriers before execution, while source ownership stays exact', async () => {
  const f = acceptedResearch(); let entered = 0;
  for (const name of ['call_tool', 'work_call', 'run_shell_command', 'composio_execute_tool', 'memory_recall_all']) {
    const tool = brackets.wrapToolForHarness({ name, execute: async (_input: unknown) => { entered++; return 'must not execute'; } });
    let detail: unknown;
    try { detail = await brackets.withHarnessRunContext({ sessionId: f.session.id, sourceUserSeq: f.source.seq,
      counter: new brackets.ToolCallsCounter(8) }, () => tool.execute({})); }
    catch (error) { detail = error instanceof Error ? error.message : String(error); }
    assert.match(typeof detail === 'string' ? detail : JSON.stringify(detail), /Tool execution is not authorized/);
  }
  assert.equal(entered, 0);
  boundary.installMeetingResearchBoundary(null);
  assert.throws(() => boundary.assertMeetingResearchModelAllowed(f.session.id, f.source.seq), /permission is unavailable/);
  const later = eventlog.appendEvent({ sessionId: f.session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'A separate owner request.' } });
  assert.equal(boundary.meetingResearchSource(f.session.id, later.seq), null);
  assert.equal(boundary.meetingResearchToolRefusal(f.session.id, later.seq), undefined);
  assert.equal(boundary.meetingResearchSource('foreign-session', f.source.seq), null);
});
