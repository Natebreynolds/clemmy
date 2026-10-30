/** Project knowledge in the actual accepted-turn memory suffix. No providers or live home. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import type { TurnMemorySignal } from './harness-context.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-project-memory-context-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.CLEMMY_MODEL_PARITY = 'on';
process.env.CLEMMY_TURN_MEMORY_PRIMER = 'on';

const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('Network is forbidden in project knowledge fixtures'); }) as typeof fetch;

const { resetMemoryDb } = await import('../memory/db.js');
const { rememberFact, forgetFact } = await import('../memory/facts.js');
const { recordMemoryEpisode, linkFactEvidence } = await import('../memory/temporal-memory.js');
const { agentScopeKey, withSessionMemoryScope } = await import('../memory/memory-scope.js');
const { evaluateLearningCandidate } = await import('../memory/learning-receipt.js');
const { recordRunStrategy } = await import('../memory/run-strategy-store.js');
const projects = await import('../projects/project-record.js');
const { setSessionProject } = await import('../projects/session-project.js');
const { setSessionAgent } = await import('./session-agent.js');
const { createAgentRecord } = await import('./agent-record.js');
const { createSession, appendEvent, closeEventLog } = await import('../runtime/harness/eventlog.js');
const { captureFreshSourceSessionContext } = await import('../runtime/harness/source-session-context.js');
const { withSourceSessionContext } = await import('../runtime/harness/source-session-context-scope.js');
const { _forgetPinnedMemoryScopesForTests } = await import('../runtime/harness/memory-scope-binding.js');
const {
  harnessInstructions, memoryTailScopeFor, renderTurnMemoryTail, rankedTailHitBudget, RANKED_TAIL_MAX_CHARS,
} = await import('./harness-context.js');
const { CACHE_BREAK_SENTINEL } = await import('../runtime/harness/model-wire-registry.js');

let nextFixture = 0;
beforeEach(() => {
  resetMemoryDb();
  _forgetPinnedMemoryScopesForTests();
  process.env.CLEMMY_TURN_MEMORY_PRIMER = 'on';
});
afterEach(() => { process.env.CLEMMY_TURN_MEMORY_PRIMER = 'on'; });
after(() => {
  resetMemoryDb();
  projects._closeProjectStoreForTests();
  closeEventLog();
  globalThis.fetch = originalFetch;
  rmSync(home, { recursive: true, force: true });
});

function project(name = 'Fixture Knowledge', context = 'Owner-written context stays exactly as saved.') {
  const saved = projects.createProject({ name: `${name} ${nextFixture++}`, purpose: 'Controlled knowledge fixture.', context });
  assert.equal(saved.ok, true);
  if (!saved.ok) throw new Error('Fixture project was not created');
  return saved.project;
}

function conversation(projectId?: string, agentId?: string): string {
  const session = createSession({ kind: 'chat', channel: 'desktop', userId: 'desktop' });
  if (agentId) assert.equal(setSessionAgent(session.id, agentId, { by: 'owner' }).ok, true);
  if (projectId) assert.equal(setSessionProject(session.id, projectId, { by: 'owner' }).ok, true);
  return session.id;
}

function instructions(sessionId: string, request = 'Give me a quick check-in on this project.') {
  return harnessInstructions('UNCHANGED FIXTURE ROLE', { sessionId, focusInput: request, includeRememberedToolChoices: false });
}

function tail(instruction: ReturnType<typeof instructions>, signal: TurnMemorySignal = { kind: 'empty' }) {
  const scope = memoryTailScopeFor(instruction);
  assert.ok(scope, 'the real instructions producer registers its memory tail scope');
  return renderTurnMemoryTail(scope, signal, { request: 'Give me a quick check-in on this project.' });
}

function knowledge(instruction: ReturnType<typeof instructions>, signal?: TurnMemorySignal) {
  const rendered = tail(instruction, signal);
  const entry = rendered.manifest.find(section => section.section === 'Project Knowledge');
  assert.ok(entry, 'the actual model suffix must carry the project projection');
  return { ...rendered, entry };
}

function stablePrefix(instruction: ReturnType<typeof instructions>): string {
  const rendered = instruction();
  const boundary = rendered.indexOf(CACHE_BREAK_SENTINEL);
  assert.ok(boundary > 0, 'this fixture uses the normal cache boundary');
  return rendered.slice(0, boundary);
}

test('the delivered manifest pins supporting evidence editions even when a fact excerpt stays unchanged', () => {
  const saved = project();
  const session = conversation(saved.id);
  const content = 'The fixture review remains Friday.';
  const fact = rememberFact({ kind: 'project', content, sessionId: session });
  const source = recordMemoryEpisode({ kind: 'tool_result', content, sessionId: session,
    callId: 'project-knowledge-edition', metadata: { sourceRevision: 1 } });
  linkFactEvidence({ factId: fact.id, episodeId: source.id, excerpt: content });
  const first = instructions(session);
  const firstView = knowledge(first);
  const firstRevision = firstView.entry.refs.find(ref => ref.type === 'project_memory_revision')?.id;
  assert.match(firstRevision ?? '', /^[a-f0-9]{64}$/);
  recordMemoryEpisode({ kind: 'tool_result', content, sessionId: session,
    callId: 'project-knowledge-edition', metadata: { sourceRevision: 2 } });
  const next = knowledge(instructions(session));
  assert.match(firstView.text, /The fixture review remains Friday/);
  assert.match(next.text, /The fixture review remains Friday/);
  assert.notEqual(next.entry.refs.find(ref => ref.type === 'project_memory_revision')?.id, firstRevision);
  assert.deepEqual(knowledge(first).entry.refs, firstView.entry.refs, 'the current activation keeps its original source edition');
});

test('fresh conversations in one project receive durable knowledge and supported complete read references', () => {
  const saved = project();
  const first = conversation(saved.id);
  const learned = rememberFact({ kind: 'project', content: 'Fixture delivery remains Friday at noon.', sessionId: first });
  const resource = projects.saveResource(saved.id, { kind: 'space', label: 'Fixture review board', ref: 'fixture-review-board' });
  assert.equal(resource.ok, true);

  const earlier = knowledge(instructions(first));
  const later = knowledge(instructions(conversation(saved.id)));
  for (const view of [earlier, later]) {
    assert.match(view.text, /Fixture delivery remains Friday at noon/);
    assert.match(view.text, /project_get/);
    assert.ok(view.text.includes(saved.id), 'the minted project id is never truncated');
    assert.ok(view.text.includes(`fact:${learned.id}`), 'a fact excerpt keeps its exact memory_read target');
    assert.ok(view.entry.refs.some(ref => ref.type === 'fact' && ref.id === String(learned.id)));
    assert.ok(view.entry.refs.some(ref => ref.type === 'project' && ref.id === saved.id));
  }
  assert.deepEqual(earlier.entry.refs, later.entry.refs, 'cross-session continuity comes from the same canonical records');
  assert.equal(projects.getProject(saved.id)?.context, saved.context);
});

test('project and agent knowledge follows the existing project scope instead of similar project names', () => {
  const a = project('Same Topic A');
  const b = project('Same Topic B');
  const one = createAgentRecord({ name: `Fixture Analyst ${nextFixture++}`, handles: 'Controlled reporting fixture.', createdFrom: 'console' });
  const two = createAgentRecord({ name: `Fixture Reviewer ${nextFixture++}`, handles: 'Controlled reporting fixture.', createdFrom: 'console' });
  assert.equal(one.ok && two.ok, true);
  if (!one.ok || !two.ok) throw new Error('Fixture agents were not created');
  projects.saveAssignment(a.id, { agentId: one.agent.id, agentCreatedAt: one.agent.createdAt });
  projects.saveAssignment(a.id, { agentId: two.agent.id, agentCreatedAt: two.agent.createdAt });
  const ownSession = conversation(a.id, one.agent.id);
  const own = rememberFact({ kind: 'project', content: 'Visible fixture answer is violet.', scope: { projectId: a.id, agentKey: agentScopeKey(one.agent) } });
  const foreignAgent = rememberFact({ kind: 'project', content: 'Another specialist has the hidden amber fixture answer.', scope: { projectId: a.id, agentKey: agentScopeKey(two.agent) } });
  const foreignProject = rememberFact({ kind: 'project', content: 'Another project has the hidden cobalt fixture answer.', scope: { projectId: b.id, agentKey: null } });
  const global = rememberFact({ kind: 'reference', content: 'A global fixture observation is not this project brief.', scope: null });
  const view = knowledge(instructions(ownSession));
  assert.match(view.text, /Visible fixture answer is violet/);
  assert.doesNotMatch(view.text, /hidden amber|hidden cobalt|global fixture observation/);
  assert.ok(view.entry.refs.some(ref => ref.type === 'fact' && ref.id === String(own.id)));
  for (const id of [foreignAgent.id, foreignProject.id, global.id]) {
    assert.ok(!view.entry.refs.some(ref => ref.type === 'fact' && ref.id === String(id)));
  }
});

for (const signal of [{ kind: 'empty' }, { kind: 'ranked', text: 'Unrelated ranked evidence.', refs: [] }, { kind: 'no_signal' }] as const) {
  test(`the ${signal.kind} ranker path carries the same project directory and evidence manifest`, () => {
    const saved = project();
    const session = conversation(saved.id);
    const fact = rememberFact({ kind: 'project', content: 'The fixture project check-in answer is ready.', sessionId: session });
    const view = knowledge(instructions(session), signal as TurnMemorySignal);
    assert.match(view.text, /fixture project check-in answer is ready/);
    assert.ok(view.entry.refs.some(ref => ref.type === 'fact' && ref.id === String(fact.id)));
    assert.ok(view.entry.bytes > 0 && view.entry.tokens > 0, 'accepted-request memory evidence accounts for the delivered section');
  });
}

test('ranked fact evidence is not repeated in the project brief or its manifest', () => {
  const saved = project();
  const session = conversation(saved.id);
  const fact = rememberFact({ kind: 'project', content: 'Only one copy of this fixture answer should be carried.', sessionId: session });
  const view = knowledge(instructions(session), { kind: 'ranked', text: 'Only one copy of this fixture answer should be carried.', refs: [{ type: 'fact', id: String(fact.id) }] });
  assert.equal(view.text.split('Only one copy of this fixture answer should be carried.').length - 1, 1);
  assert.ok(!view.entry.refs.some(ref => ref.type === 'fact' && ref.id === String(fact.id)));
});

test('one activation retains its project snapshot while the next genuine turn receives a corrected current fact', () => {
  const saved = project();
  const session = conversation(saved.id);
  const original = rememberFact({ kind: 'project', content: 'Fixture delivery is Thursday at noon.', sessionId: session });
  const accepted = instructions(session);
  const before = knowledge(accepted);
  const prefixBefore = stablePrefix(accepted);
  assert.equal(forgetFact(original.id), true);
  const replacement = rememberFact({ kind: 'project', content: 'Fixture delivery is Friday at noon.', sessionId: session });

  assert.equal(knowledge(accepted).text, before.text, 'later cycles do not silently replace accepted-turn memory bytes');
  const next = instructions(session);
  const fresh = knowledge(next);
  assert.match(fresh.text, /Fixture delivery is Friday at noon/);
  assert.doesNotMatch(fresh.text, /Fixture delivery is Thursday at noon/);
  assert.ok(fresh.entry.refs.some(ref => ref.type === 'fact' && ref.id === String(replacement.id)));
  assert.ok(!fresh.entry.refs.some(ref => ref.type === 'fact' && ref.id === String(original.id)));
  assert.equal(stablePrefix(next), prefixBefore, 'learned project refreshes stay after the cache boundary');
  assert.equal(projects.getProject(saved.id)?.context, saved.context, 'refreshing a brief never edits the manual project record');
});

test('an accepted project remains pinned if the owner moves its conversation before the suffix is built', () => {
  const a = project('Pinned A');
  const b = project('Moved B');
  const session = conversation(a.id);
  const inA = rememberFact({ kind: 'project', content: 'Accepted fixture context belongs to project Alpha.', sessionId: session });
  rememberFact({ kind: 'project', content: 'Later fixture context belongs to project Beta.', scope: { projectId: b.id, agentKey: null } });
  const source = appendEvent({ sessionId: session, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Check the project.' } });
  const accepted = captureFreshSourceSessionContext({ sessionId: session, sourceUserSeq: source.seq });
  assert.ok(accepted);
  assert.equal(setSessionProject(session, b.id, { by: 'owner' }).ok, true);

  withSourceSessionContext(accepted, () => {
    const view = knowledge(instructions(session));
    assert.match(view.text, /Accepted fixture context belongs to project Alpha/);
    assert.doesNotMatch(view.text, /Later fixture context belongs to project Beta/);
    assert.ok(view.entry.refs.some(ref => ref.type === 'project' && ref.id === a.id));
    assert.ok(view.entry.refs.some(ref => ref.type === 'fact' && ref.id === String(inA.id)));
  });
  const next = knowledge(instructions(session));
  assert.match(next.text, /Later fixture context belongs to project Beta/);
  assert.doesNotMatch(next.text, /Accepted fixture context belongs to project Alpha/);
});

test('project context uses existing ranked-tail space and keeps a usable hit budget', () => {
  const saved = project();
  const session = conversation(saved.id);
  rememberFact({ kind: 'project', content: 'Fixture project briefing has a precise saved answer.', sessionId: session });
  const accepted = instructions(session);
  const scope = memoryTailScopeFor(accepted);
  assert.ok(scope?.projectMemory?.text);
  const projectChars = scope.projectMemory.text.length;
  const budget = rankedTailHitBudget('Give a project check-in.', false, scope);
  const unboundBudget = rankedTailHitBudget('Give a project check-in.', false);
  assert.ok(budget >= 300, 'project context cannot starve the request ranker');
  assert.ok(budget < unboundBudget, 'the new block reserves bytes rather than adding an unaccounted prompt');
  assert.ok(budget + projectChars + 2 <= RANKED_TAIL_MAX_CHARS);
});

test('explicit recall opt-out and a disabled automatic primer omit the new project knowledge block', () => {
  const saved = project();
  const session = conversation(saved.id);
  rememberFact({ kind: 'project', content: 'This fixture observation must not bypass a recall boundary.', sessionId: session });
  const optedOut = tail(instructions(session, 'Do not use memory for this request. Answer only the supplied sentence.'));
  assert.ok(!optedOut.manifest.some(section => section.section === 'Project Knowledge'));
  process.env.CLEMMY_TURN_MEMORY_PRIMER = 'off';
  const disabled = tail(instructions(session));
  assert.ok(!disabled.manifest.some(section => section.section === 'Project Knowledge'));
});

test('an unbound conversation does not receive a directory of somebody else\'s projects', () => {
  const saved = project();
  const scoped = conversation(saved.id);
  rememberFact({ kind: 'project', content: 'Scoped fixture knowledge stays with its minted project.', sessionId: scoped });
  const view = tail(instructions(conversation()));
  assert.ok(!view.manifest.some(section => section.section === 'Project Knowledge'));
  assert.doesNotMatch(view.text, /Scoped fixture knowledge stays/);
});

test('an actual request recall opt-out applies even when instructions were constructed without focusInput', () => {
  const saved = project();
  const session = conversation(saved.id);
  rememberFact({ kind: 'project', content: 'This fixture observation must not bypass the actual request.', sessionId: session });
  const accepted = harnessInstructions('UNCHANGED FIXTURE ROLE', { sessionId: session });
  const scope = memoryTailScopeFor(accepted);
  assert.ok(scope?.projectMemory, 'the projection was already captured before the actual request arrived');
  const view = renderTurnMemoryTail(scope, { kind: 'no_signal' }, {
    request: 'Do not use memory for this request. Answer only the supplied sentence.',
  });
  assert.ok(!view.manifest.some(section => section.section === 'Project Knowledge'));
  assert.ok(!view.manifest.some(section => section.refs.some(ref => ref.type === 'project' && ref.id === saved.id)));
  assert.doesNotMatch(view.text, /## Project Knowledge/);
});

test('a retained strategy and a large project projection share the existing ranked-tail budget', () => {
  const saved = project('Budget Full Projection');
  const session = conversation(saved.id);
  const request = 'Prepare controlled fixture briefing from saved source records.';
  for (let index = 0; index < 8; index++) {
    rememberFact({ kind: 'project', content: `Budget fixture record ${index} keeps its saved source facts current.`, sessionId: session });
  }
  for (let index = 0; index < 3; index++) {
    assert.equal(projects.saveResource(saved.id, {
      kind: 'space', label: `Controlled fixture board ${index}`, ref: `fixture-budget-board-${index}`,
    }).ok, true);
  }
  const decision = evaluateLearningCandidate({ target: 'strategy', authority: 'background_delivery_verifier',
    sessionId: session, sourceId: `fixture-budget-run-${nextFixture++}`, terminalSuccess: true, controllerValidation: true });
  assert.ok(decision.receipt);
  const learned = recordRunStrategy({ objective: request, toolsUsed: ['read_file', 'memory_read', 'write_file'],
    provenShapes: [{ tool: 'read_file', shape: '{"path":"string","max_chars":"number"}' },
      { tool: 'write_file', shape: '{"path":"string","content":"string"}' }],
    workerCount: 0, durationMs: 60_000, learningReceipt: decision.receipt,
    keptFor: { projectId: saved.id, agentKey: null } });
  assert.ok(learned, 'the fixture uses a normal retained, receipt-backed strategy');
  const accepted = harnessInstructions('UNCHANGED FIXTURE ROLE', {
    sessionId: session, focusInput: request, includeRememberedToolChoices: true,
  });
  const scope = memoryTailScopeFor(accepted);
  assert.ok(scope?.projectMemory);
  assert.ok(scope.projectMemory.text.length > 650, 'exercise a substantial source-linked project projection');
  const budget = withSessionMemoryScope(session, () => rankedTailHitBudget(request, true, scope));
  assert.ok(budget >= 300, 'the request ranker retains a usable budget');
  const view = renderTurnMemoryTail(scope, { kind: 'ranked', text: 'R'.repeat(budget), refs: [] }, { request });
  // The producer's manifest sizes identify the actual complete delivered
  // fragments; do not estimate a project preview from a stale captured size.
  let offset = 0;
  const bytes = Buffer.from(view.text, 'utf8');
  const fragments = view.manifest.map(entry => {
    const text = bytes.subarray(offset, offset + entry.bytes).toString('utf8');
    offset += entry.bytes + 2;
    return { section: entry.section, text };
  });
  assert.equal(fragments.map(fragment => fragment.text).join('\n\n'), view.text);
  assert.ok(fragments.some(fragment => fragment.section === 'Proven Run Strategies' && /Prior verified run/.test(fragment.text)));
  assert.ok(fragments.some(fragment => fragment.section === 'Project Knowledge' && /project_get/.test(fragment.text)));
  const budgeted = fragments.filter(fragment => ['Relevant To This Request', 'Proven Run Strategies', 'Project Knowledge'].includes(fragment.section));
  assert.ok(budgeted.map(fragment => fragment.text).join('\n\n').length <= RANKED_TAIL_MAX_CHARS,
    'ranked hits, the retained strategy and whole project entries must fit their shared original budget');
});
