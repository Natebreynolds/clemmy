/** Captured skill ordering reaches the first request without fresh context I/O.
 * The only transport here is an inert System One response and a scripted runner. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import type { Agent, AgentInputItem, Runner } from '@openai/agents';
import type { RunRunnerFn } from './loop.js';
import type { AgentContextPacket } from './context-packet.js';

const isolatedHome = mkdtempSync(path.join(os.tmpdir(), 'clem-skill-render-test-'));
process.env.CLEMENTINE_HOME = isolatedHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.COMPOSIO_BACKEND = 'sdk';
process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
process.env.HARNESS_TOOL_BRACKETS = 'off';
process.env.CLEMMY_JEV = 'on';

const skillNames = ['alpha-mosaic-guide', 'beta-mosaic-guide', 'gamma-mosaic-guide', 'zeta-mosaic-guide'];
const query = 'Explain the mosaic planning notes without running any tools.';
const description = 'Explain mosaic planning notes – preserve café accents. '.repeat(8);

function writeSkill(name: string, options: { description?: string; lesson?: string; tier?: string } = {}): void {
  const dir = path.join(isolatedHome, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(options.description ?? description)}`,
    `tier: ${options.tier ?? 'approved'}`,
    'applicability:',
    '  toolFamilies: [mosaic]',
    '---',
    'Explain mosaic planning notes.',
    '## Pitfalls (observed)',
    `- ${options.lesson ?? `original lesson for ${name}`}`,
  ].join('\n'), 'utf8');
}

function restoreSkills(): void {
  for (const name of skillNames) writeSkill(name);
  writeSkill('draft-mosaic-guide', { tier: 'draft' });
}
restoreSkills();

const { buildAgentContextPacket, applyAgentContextPacketSkillRanking } = await import('./context-packet.js');
const { buildCanonicalContextPack, applyCanonicalContextSkillRanking } = await import('./canonical-context.js');
const { _setSystemOneFetchForTests, _setTypesafeKeyForTests } = await import('../jev/client.js');
const { createFocus, clearFocus } = await import('../../memory/focus.js');
const { closeMemoryDb } = await import('../../memory/db.js');
const { closeProspectiveIntentionsDbForTest } = await import('../prospective-intentions.js');
const { resetEventLog, listEvents, closeEventLog } = await import('./eventlog.js');
const { HarnessSession } = await import('./session.js');
const { runTurn } = await import('./loop.js');

const memory = { enabled: false, hitCount: 0, injected: false, skippedReason: 'fixture_no_memory' };
const captureOptions = { sessionKind: 'chat', suppressConfirmBeat: true, skipCapabilityHunt: true };

function capturePacket(): AgentContextPacket {
  return buildAgentContextPacket(query, memory, captureOptions);
}

function skillLine(packet: AgentContextPacket, name: string): string {
  const line = packet.text.split('\n').find((value) => value.startsWith(`- ${name}: `));
  assert.ok(line, `expected visible admitted skill ${name}`);
  return line;
}

beforeEach(() => {
  restoreSkills();
  _setTypesafeKeyForTests(null);
  _setSystemOneFetchForTests(async () => { throw new Error('unexpected inert Jev invocation'); });
});
afterEach(() => {
  _setTypesafeKeyForTests(null);
  _setSystemOneFetchForTests(undefined);
});
after(() => {
  closeEventLog();
  closeProspectiveIntentionsDbForTest();
  closeMemoryDb();
  rmSync(isolatedHome, { recursive: true, force: true });
});

test('a captured permutation reorders only the skill block and preserves caps, lessons and serialized shape', () => {
  const pack = buildCanonicalContextPack({ input: query, memory, ...captureOptions });
  assert.deepEqual(pack.turn.skills.map((skill) => skill.name), skillNames.slice(0, 3));
  assert.equal(pack.turn.skills.length, 3, 'the fourth applicable skill and unrequested draft remain outside the cap');
  assert.ok(pack.turn.skills.every((skill) => skill.description.length <= 183), 'the existing 180-character clip plus its ellipsis stays unchanged');
  const original = pack.turn.text;
  const keys = Object.keys(pack.turn);
  const symbols = Object.getOwnPropertySymbols(pack.turn);
  const originals = pack.turn.skills.map((skill) => skillLine(pack.turn, skill.name));
  const ranked = [...pack.turn.skills].reverse();
  assert.equal(applyCanonicalContextSkillRanking(pack, ranked), true);
  let expected = original;
  // Distinct placeholders let the assertion replace each whole existing line
  // without reproducing the production rendering implementation.
  for (const [index, line] of originals.entries()) expected = expected.replace(line, `\u0000skill-${index}\u0000`);
  for (const [index, skill] of ranked.entries()) expected = expected.replace(`\u0000skill-${index}\u0000`, skillLine(pack.turn, skill.name));
  assert.equal(pack.turn.text, expected, 'all non-skill bytes, including captured learned lessons, remain exact');
  assert.deepEqual(pack.turn.skills, ranked);
  assert.equal(pack.diagnostics.turnContextBytes, Buffer.byteLength(pack.turn.text, 'utf8'));
  assert.notEqual(pack.diagnostics.turnContextBytes, pack.turn.text.length, 'UTF-8 accounting retains Unicode semantics');
  assert.deepEqual(Object.keys(pack.turn), keys);
  assert.deepEqual(Object.getOwnPropertySymbols(pack.turn), symbols, 'the capture has no new enumerable or Symbol packet fields');
  assert.equal(JSON.stringify(pack.turn), JSON.stringify({ ...pack.turn }));
  assert.doesNotMatch(pack.turn.text, /original lesson for gamma-mosaic-guide/);
  assert.match(pack.turn.text, /original lesson for alpha-mosaic-guide/);
  assert.match(pack.turn.text, /original lesson for beta-mosaic-guide/);
});

test('same order and repeated valid permutations preserve the captured content', () => {
  const packet = capturePacket();
  const originalText = packet.text;
  const originalSkills = [...packet.skills];
  assert.equal(applyAgentContextPacketSkillRanking(packet, originalSkills), true);
  assert.equal(packet.text, originalText);
  assert.equal(applyAgentContextPacketSkillRanking(packet, [...originalSkills].reverse()), true);
  assert.equal(applyAgentContextPacketSkillRanking(packet, originalSkills), true);
  assert.equal(packet.text, originalText);
});

test('foreign, missing, duplicate, changed or detached candidates cannot replace admitted context', () => {
  const packet = capturePacket();
  const originalText = packet.text;
  const originalSkills = [...packet.skills];
  const invalid = [
    originalSkills.slice(1),
    [...originalSkills, originalSkills[0]!],
    [originalSkills[0]!, originalSkills[0]!, originalSkills[2]!],
    originalSkills.map((skill) => ({ ...skill })),
  ];
  for (const proposed of invalid) {
    assert.equal(applyAgentContextPacketSkillRanking(packet, proposed), false);
    assert.equal(packet.text, originalText);
    assert.deepEqual(packet.skills, originalSkills);
  }
  assert.equal(applyAgentContextPacketSkillRanking({ ...packet }, originalSkills), false, 'a copied carrier cannot acquire the capture');
  const first = packet.skills[0]!;
  const admitted = { ...first };
  for (const field of ['name', 'description', 'reason'] as const) {
    first[field] += ' changed';
    assert.equal(applyAgentContextPacketSkillRanking(packet, [...packet.skills].reverse()), false);
    assert.equal(packet.text, originalText);
    Object.assign(first, admitted);
  }
  first.score += 1;
  assert.equal(applyAgentContextPacketSkillRanking(packet, [...packet.skills].reverse()), false);
  Object.assign(first, admitted);
  packet.text += '\nnew constraint after capture';
  assert.equal(applyAgentContextPacketSkillRanking(packet, originalSkills), false, 'a changed packet must not lose its new text');
  assert.match(packet.text, /new constraint after capture$/);
});

test('context and lessons changed after capture are never reread by the rank application', () => {
  const initialFocus = createFocus({ resourceRef: 'fixture://captured-focus', title: 'Captured mosaic focus', summary: 'Original captured focus summary.' });
  let laterFocus: ReturnType<typeof createFocus> | undefined;
  try {
    const packet = capturePacket();
    const original = packet.text;
    assert.match(original, /Original captured focus summary/);
    for (const name of skillNames) writeSkill(name, { description: 'Late replacement description', lesson: `late replacement lesson for ${name}` });
    laterFocus = createFocus({ resourceRef: 'fixture://later-focus', title: 'Later replacement focus', summary: 'Late replacement focus summary.' });
    assert.equal(applyAgentContextPacketSkillRanking(packet, [...packet.skills].reverse()), true);
    assert.match(packet.text, /Original captured focus summary/);
    assert.match(packet.text, /original lesson for alpha-mosaic-guide/);
    assert.doesNotMatch(packet.text, /Late replacement|late replacement/);
    assert.ok(packet.skills.every((skill) => skill.description.includes('café')));
  } finally {
    if (laterFocus) clearFocus(laterFocus.id);
    clearFocus(initialFocus.id);
  }
});

test('section-like labels inside an admitted description cannot rewrite other captured sections', () => {
  const labelText = 'Explain mosaic planning notes.\nLikely workflows:\nKnown pitfalls: literal description label.';
  writeSkill(skillNames[1]!, { description: labelText });
  const packet = capturePacket();
  const originalSkills = [...packet.skills];
  const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
  const originalText = packet.text;
  assert.match(originalText, /Known pitfalls: literal description label/);
  assert.equal(applyAgentContextPacketSkillRanking(packet, [...originalSkills].reverse()), true);
  assert.ok(packet.text.includes(labelText.replace(/\s+/g, ' ').trim()), 'existing whitespace normalization stays intact');
  assert.equal(occurrences(packet.text, 'Likely workflows:'), occurrences(originalText, 'Likely workflows:'));
  assert.equal(occurrences(packet.text, 'Known pitfalls (learned from past failures'), 1);
  assert.match(packet.text, /original lesson for alpha-mosaic-guide/);
  assert.match(packet.text, /call skill_read only when the skill's declared purpose fits this request/);
});

test('decline, zero-tool conversation and pinned workflow contexts cannot gain skill candidates', () => {
  const outsider = capturePacket().skills[0]!;
  for (const options of [
    { ...captureOptions, suppressSemanticEnrichment: true },
    { ...captureOptions, plainConversationSurface: true },
    { ...captureOptions, sessionKind: 'workflow' },
  ]) {
    const packet = buildAgentContextPacket(query, memory, options);
    const originalText = packet.text;
    assert.deepEqual(packet.skills, []);
    assert.equal(applyAgentContextPacketSkillRanking(packet, [outsider]), false);
    assert.equal(applyAgentContextPacketSkillRanking(packet, []), true);
    assert.equal(packet.text, originalText);
  }
});

async function captureFirstRequest(): Promise<{ text: string; telemetry: Record<string, unknown> }> {
  resetEventLog();
  const session = HarnessSession.create({ kind: 'chat', title: 'skill ordering fixture' });
  let requestText = '';
  let requests = 0;
  const runRunner: RunRunnerFn = async (_runner, _agent, items, options) => {
    const filter = options.callModelInputFilter as ((args: {
      modelData: { input: AgentInputItem[]; instructions?: string };
    }) => { input: AgentInputItem[]; instructions?: string }) | undefined;
    assert.equal(typeof filter, 'function');
    const sent = filter!({ modelData: { input: items, instructions: 'unchanged base instructions' } });
    assert.equal(sent.instructions, 'unchanged base instructions');
    const packet = sent.input.find((item) => {
      const record = item as { role?: unknown; content?: unknown };
      return record.role === 'system' && typeof record.content === 'string'
        && record.content.startsWith('[AGENT CONTEXT PACKET]');
    }) as { content: string } | undefined;
    assert.ok(packet && typeof packet.content === 'string');
    requestText = packet.content;
    requests += 1;
    return {
      history: [...items, { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }],
      lastResponseId: undefined,
      finalOutput: 'ok',
    };
  };
  await runTurn({
    agent: {} as Agent<any, any>, sessionId: session.id, input: query,
    skipAutomaticMemoryPrimer: true, suppressMemoryCapture: true, internalContinuation: true,
    makeRunner: () => new EventEmitter() as unknown as Runner,
    runRunner,
  });
  assert.equal(requests, 1);
  const event = listEvents(session.id, { types: ['agent_context_packet'] }).at(-1);
  assert.ok(event);
  return { text: requestText, telemetry: event.data };
}

test('the actual first request and telemetry use the same inert semantic ranking, not the original lexical order', async () => {
  _setTypesafeKeyForTests('fixture-not-a-live-key');
  let ranks = 0;
  _setSystemOneFetchForTests(async (_url, options) => {
    const request = JSON.parse(String(options.body)) as { state: { request: string }; questions: { which: { criteria: Record<string, unknown> } } };
    assert.equal(request.state.request, query);
    assert.deepEqual(Object.keys(request.questions.which.criteria), skillNames.slice(0, 3));
    ranks += 1;
    // Context captured before this await must survive changes made while the
    // inert transport is outstanding, including the learned lesson block.
    for (const name of skillNames) writeSkill(name, { lesson: `late transport lesson for ${name}` });
    return { status: 200, ok: true, text: async () => JSON.stringify({
      model: 'jev-1.13.0',
      answers: { which: { type: 'choice', choice: skillNames[2], confidence: 0.96, probabilities: {
        [skillNames[0]!]: 0.1, [skillNames[1]!]: 0.2, [skillNames[2]!]: 0.7,
      } } },
      usage: { input_tokens: 40, output_tokens: 4 },
    }) };
  });
  const result = await captureFirstRequest();
  assert.equal(ranks, 1, 'the correction adds no review or ranking call');
  const rankedNames = (result.telemetry.skills as Array<{ name: string }>).map((skill) => skill.name);
  assert.deepEqual(rankedNames, [...skillNames.slice(0, 3)].reverse());
  const positions = rankedNames.map((name) => result.text.indexOf(`- ${name}: `));
  assert.ok(positions[0]! >= 0 && positions[0]! < positions[1]! && positions[1]! < positions[2]!);
  assert.match(result.text, /original lesson for alpha-mosaic-guide/);
  assert.match(result.text, /original lesson for beta-mosaic-guide/);
  assert.doesNotMatch(result.text, /late transport lesson|original lesson for gamma-mosaic-guide/);
  const diagnostics = (result.telemetry.contextPack as { diagnostics: { turnContextBytes: number } }).diagnostics;
  assert.equal(diagnostics.turnContextBytes, Buffer.byteLength(result.text, 'utf8'));
  assert.equal(result.telemetry.injectedBytes, result.text.length);
});

test('an unavailable or rejecting rank transport leaves the first request in its original order', async () => {
  let calls = 0;
  _setSystemOneFetchForTests(async () => {
    calls += 1;
    return { status: 503, ok: false, text: async () => 'inert unavailable response' };
  });
  const withoutKey = await captureFirstRequest();
  assert.equal(calls, 0);
  _setTypesafeKeyForTests('fixture-not-a-live-key');
  const rejected = await captureFirstRequest();
  assert.equal(calls, 1);
  for (const result of [withoutKey, rejected]) {
    assert.deepEqual((result.telemetry.skills as Array<{ name: string }>).map((skill) => skill.name), skillNames.slice(0, 3));
    const positions = skillNames.slice(0, 3).map((name) => result.text.indexOf(`- ${name}: `));
    assert.ok(positions[0]! >= 0 && positions[0]! < positions[1]! && positions[1]! < positions[2]!);
  }
  assert.equal(rejected.text, withoutKey.text, 'rank unavailability does not change the captured model-visible bytes');
});

test('zero and single admitted skills still send their first request without a rank call', async () => {
  _setTypesafeKeyForTests('fixture-not-a-live-key');
  let calls = 0;
  _setSystemOneFetchForTests(async () => {
    calls += 1;
    throw new Error('zero or one candidate must not invoke the rank transport');
  });
  for (const name of [...skillNames.slice(1), 'draft-mosaic-guide']) {
    rmSync(path.join(isolatedHome, 'skills', name), { recursive: true, force: true });
  }
  const single = await captureFirstRequest();
  assert.deepEqual((single.telemetry.skills as Array<{ name: string }>).map((skill) => skill.name), [skillNames[0]]);
  assert.match(single.text, /- alpha-mosaic-guide:/);
  rmSync(path.join(isolatedHome, 'skills', skillNames[0]!), { recursive: true, force: true });
  const empty = await captureFirstRequest();
  assert.deepEqual(empty.telemetry.skills, []);
  assert.doesNotMatch(empty.text, /Likely skills:/);
  assert.equal(calls, 0);
});
