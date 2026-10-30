/** Claude's real turn-context producer with synthetic project knowledge only. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-claude-project-memory-'));
Object.assign(process.env, {
  CLEMENTINE_HOME: home,
  CLEMMY_LOCAL_EMBEDDINGS: 'off', EMBEDDINGS_DISABLED: 'true',
  CLEMMY_TURN_MEMORY_PRIMER: 'on', CLEMMY_BRAIN_QUERY_RECALL: 'on',
  CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT: 'on', CLEMMY_TURN_OPENNESS: 'off',
  CLEMMY_RECALL_SHADOW: 'off', OPENAI_AGENTS_DISABLE_TRACING: '1',
});
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('No network in Claude project-memory fixtures'); }) as typeof fetch;
const brain = await import('./claude-agent-brain.js');
const { resetMemoryDb } = await import('../../memory/db.js');
const { rememberFact, forgetFact } = await import('../../memory/facts.js');
const { captureProjectMemoryContext } = await import('../../memory/project-memory-context.js');
const projects = await import('../../projects/project-record.js');
const { setSessionProject } = await import('../../projects/session-project.js');
const { createSession, closeEventLog } = await import('./eventlog.js');
await import('./memory-scope-binding.js');
const { withSessionMemoryScope } = await import('../../memory/memory-scope.js');

const query = 'What is known about this fixture project?';
let sequence = 0;
function fixture() {
  const result = projects.createProject({ name: `Claude fixture ${sequence++}`, context: 'Manual text remains untouched.' });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('Project fixture failed');
  const session = createSession({ kind: 'chat', channel: 'desktop', userId: 'desktop' });
  assert.equal(setSessionProject(session.id, result.project.id, { by: 'owner' }).ok, true);
  const fact = rememberFact({ kind: 'project', content: 'The synthetic project handoff is due Friday at noon.', sessionId: session.id });
  return { project: result.project, sessionId: session.id, fact };
}
const emptyRecall = async (objective: string) => ({ objective, purpose: 'ambient' as const,
  hits: [], perStore: {}, answerability: 'insufficient' as const,
  diagnostics: { candidates: 0, stores: [], elapsedMs: 0 } });

beforeEach(() => {
  resetMemoryDb();
  process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = 'on';
  process.env.CLEMMY_BRAIN_QUERY_RECALL = 'on';
  process.env.CLEMMY_TURN_MEMORY_PRIMER = 'on';
  brain.setClaudeAgentSdkBrainUnifiedPrimerForTest(emptyRecall);
  brain.setClaudeAgentSdkBrainSearchFactsHybridForTest(async () => []);
  brain.setClaudeAgentSdkBrainFallbackBreadcrumbsForTest(async () => '');
});
afterEach(() => {
  brain.setClaudeAgentSdkBrainUnifiedPrimerForTest(null);
  brain.setClaudeAgentSdkBrainSearchFactsHybridForTest(null);
  brain.setClaudeAgentSdkBrainFallbackBreadcrumbsForTest(null);
});
after(() => {
  resetMemoryDb();
  projects._closeProjectStoreForTests();
  closeEventLog();
  globalThis.fetch = originalFetch;
  rmSync(home, { recursive: true, force: true });
});

for (const split of ['on', 'off']) {
  test(`Claude includes the bound directory and brief when context splitting is ${split}`, async () => {
    const saved = fixture();
    process.env.CLEMMY_CLAUDE_SDK_CONTEXT_SPLIT = split;
    const text = await brain.renderClaudeAgentBrainTurnContext({ sessionId: saved.sessionId, message: query });
    assert.match(text, /## Project Knowledge/);
    assert.match(text, /synthetic project handoff is due Friday at noon/);
    assert.ok(text.includes(saved.project.id), 'the exact supported project read remains recoverable');
    assert.ok(text.includes(`fact:${saved.fact.id}`), 'the exact fact read remains recoverable');
    assert.equal(projects.getProject(saved.project.id)?.context, saved.project.context);
    assert.equal(text.split('## Project Knowledge').length - 1, 1, 'one prepared project block per turn');
  });
}

test('Claude keeps project navigation when unified recall degrades to the existing fallback', async () => {
  const saved = fixture();
  brain.setClaudeAgentSdkBrainUnifiedPrimerForTest(async () => { throw new Error('Synthetic ranker unavailable'); });
  const text = await brain.renderClaudeAgentBrainTurnContext({ sessionId: saved.sessionId, message: query });
  assert.match(text, /## Project Knowledge/);
  assert.ok(text.includes(`fact:${saved.fact.id}`));
});

test('Claude captures the project once before asynchronous retrieval and refreshes it next turn', async () => {
  const saved = fixture();
  let changed = false;
  brain.setClaudeAgentSdkBrainUnifiedPrimerForTest(async objective => {
    if (!changed) {
      changed = true;
      assert.equal(forgetFact(saved.fact.id), true);
      rememberFact({ kind: 'project', content: 'The synthetic project handoff is due Monday at noon.', sessionId: saved.sessionId });
    }
    return emptyRecall(objective);
  });
  const first = await brain.renderClaudeAgentBrainTurnContext({ sessionId: saved.sessionId, message: query });
  assert.match(first, /synthetic project handoff is due Friday at noon/);
  assert.doesNotMatch(first, /synthetic project handoff is due Monday at noon/);
  const next = await brain.renderClaudeAgentBrainTurnContext({ sessionId: saved.sessionId, message: query });
  assert.match(next, /synthetic project handoff is due Monday at noon/);
  assert.doesNotMatch(next, /synthetic project handoff is due Friday at noon/);
});

test('Claude reserves project bytes within its existing unified memory allowance', async () => {
  const saved = fixture();
  const hit = (index: number) => ({ type: 'entity' as const, ref: `fixture-${index}`, title: `Fixture source ${index}`,
    snippet: `Candidate ${index}: ${'Bounded synthetic evidence. '.repeat(9)}`, score: 1 });
  brain.setClaudeAgentSdkBrainUnifiedPrimerForTest(async objective => ({ objective, purpose: 'ambient',
    hits: Array.from({ length: 8 }, (_, index) => hit(index)), perStore: { entity: 8 }, answerability: 'partial',
    diagnostics: { candidates: 8, stores: ['entity'], elapsedMs: 0 } }));
  const snapshot = withSessionMemoryScope(saved.sessionId, () => captureProjectMemoryContext(saved.sessionId, query));
  assert.ok(snapshot?.text, 'the fixture has a bounded project projection to reserve');
  const text = await brain.renderClaudeAgentBrainTurnContext({ sessionId: saved.sessionId, message: query });
  const primerAt = text.indexOf('[MEMORY PRIMER]');
  const knowledgeAt = text.indexOf('## Project Knowledge');
  assert.ok(primerAt >= 0 && knowledgeAt > primerAt, 'the request retains both independent memory fragments');
  const primer = text.slice(primerAt, knowledgeAt).trim();
  assert.ok(primer.length + snapshot.text.length + 2 <= 1_800,
    `unified recall and prepared project context share the original allowance: ${primer.length}+${snapshot.text.length}`);
});

test('Claude respects disabled recall, explicit opt-out and a declined parent for project projection', async () => {
  const saved = fixture();
  const optedOut = await brain.renderClaudeAgentBrainTurnContext({ sessionId: saved.sessionId,
    message: 'Do not use memory. Answer only from this request.' });
  assert.doesNotMatch(optedOut, /## Project Knowledge|synthetic project handoff/);
  process.env.CLEMMY_BRAIN_QUERY_RECALL = 'off';
  assert.doesNotMatch(await brain.renderClaudeAgentBrainTurnContext({ sessionId: saved.sessionId, message: query }), /## Project Knowledge/);
  process.env.CLEMMY_BRAIN_QUERY_RECALL = 'on';
  const declined = await brain.renderClaudeAgentBrainTurnContext({ sessionId: saved.sessionId, message: 'No', taskContinuation: {
    packetId: 'fixture-declined', parentSourceUserSeq: 1, consumingSourceUserSeq: 2,
    parentInput: query, question: 'Continue?', options: ['Yes', 'No'], answer: 'No', disposition: 'declined',
    retrievalQuery: query, capabilities: [],
  } });
  assert.doesNotMatch(declined, /## Project Knowledge|synthetic project handoff/);
});

test('Claude does not infer a project for an unbound conversation from similar wording', async () => {
  fixture();
  const unbound = createSession({ kind: 'chat', channel: 'desktop', userId: 'desktop' });
  const text = await brain.renderClaudeAgentBrainTurnContext({ sessionId: unbound.id, message: query });
  assert.doesNotMatch(text, /## Project Knowledge|synthetic project handoff/);
});
