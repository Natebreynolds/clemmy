/**
 * Run: npx tsx --test src/runtime/harness/turn-openness.test.ts
 *
 * The openness pass exists because of two live failures on the same day: one
 * run ignored an explicit alignment directive and started working, the other
 * never triggered one because a closed vocabulary of destinations had never
 * heard of the toolkit the user named. These pins hold the properties that
 * make the replacement safe to leave on: it never blocks, never scripts a
 * sentence, and stays silent unless a reading would actually change the result.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-openness-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'openness-machine\n');

import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseOpennessVerdict,
  turnOpennessWarranted,
  resolveTurnOpenness,
  renderTurnOpennessForContext,
  turnOpennessEnabled,
  turnOpennessBrainFamily,
  selectIndependentTurnOpennessJudgeRoute,
  _setOpennessJudgeForTests,
  _setOpennessJudgePortForTests,
} = await import('./turn-openness.js');
const currentCapabilityFixtures = await import('./current-capability-manifest.fixture.js');
const priorCapabilityFactory = currentCapabilityFixtures.installCurrentCapabilityManifestFixtures([
  {
    operationId: 'SCHEDULERCO_LIST_EVENTS',
    providerKind: 'composio',
    effect: 'read',
  },
  {
    operationId: 'AIRTABLE_CREATE_MULTIPLE_RECORDS',
    providerKind: 'composio',
    effect: 'external_write',
    destination: { family: 'records', posture: 'named_existing' },
  },
]);

after(() => {
  currentCapabilityFixtures.restoreCurrentCapabilityManifestFixtures(priorCapabilityFactory);
  rmSync(TMP_HOME, { recursive: true, force: true });
});
afterEach(() => {
  _setOpennessJudgeForTests(null);
  _setOpennessJudgePortForTests(null);
  delete process.env.CLEMMY_TURN_OPENNESS;
  delete process.env.CLEMMY_TURN_OPENNESS_TIMEOUT_MS;
});

test('a settled request produces NOTHING — no block, no prompt tax', () => {
  assert.equal(parseOpennessVerdict('SETTLED: the request names the list and the format'), null);
  assert.equal(renderTurnOpennessForContext(null), '');
});

test('open dimensions parse into data, most consequential first', () => {
  const parsed = parseOpennessVerdict('OPEN: which Airtable base | which of the scraped firms | field layout');
  assert.deepEqual(parsed?.open, ['which Airtable base', 'which of the scraped firms', 'field layout']);
});

test('the verdict is bounded — a rambling judge cannot flood the turn', () => {
  const parsed = parseOpennessVerdict(`OPEN: ${['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(200)).join(' | ')}`);
  assert.equal(parsed?.open.length, 3, 'at most three dimensions');
  for (const dim of parsed!.open) assert.ok(dim.length <= 121, 'each dimension is clipped');
});

test('garbage, prose, and empty verdicts all fail OPEN (silence, never an error)', () => {
  for (const raw of ['', null, undefined, 'I think maybe you should ask about the base?', 'OPEN:', '{"open":["x"]}']) {
    assert.equal(parseOpennessVerdict(raw), null, `must fail open for: ${String(raw).slice(0, 30)}`);
  }
});

test('a judge that throws never breaks the turn', async () => {
  _setOpennessJudgeForTests(async () => { throw new Error('judge exploded'); });
  assert.equal(await resolveTurnOpenness({ message: 'do the thing', brainFamily: 'codex' }), null);
});

test('the public openness ceiling includes alternate-port and setup time', async () => {
  process.env.CLEMMY_TURN_OPENNESS_TIMEOUT_MS = '500';
  _setOpennessJudgeForTests(async () => {
    await new Promise((resolve) => setTimeout(resolve, 900));
    return { open: ['late dimension that must not tax the turn'] };
  });
  const startedAt = Date.now();
  assert.equal(await resolveTurnOpenness({ message: 'do the thing', brainFamily: 'codex' }), null);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= 450, `deadline returned too early: ${elapsedMs}ms`);
  assert.ok(elapsedMs < 800, `setup/alternate-port work escaped the public ceiling: ${elapsedMs}ms`);
});

test('a hung production judge fails open at the configured wall-clock ceiling', async () => {
  process.env.CLEMMY_TURN_OPENNESS_TIMEOUT_MS = '500';
  const independentRoute = {
    model: {} as any,
    modelId: 'claude-haiku-4-5',
    judgeFamily: 'claude' as const,
    brainFamily: 'codex' as const,
    transport: 'claude_subscription' as const,
    selfJudge: false,
  };
  _setOpennessJudgePortForTests({
    async resolveRoutes() { return [independentRoute]; },
    async run() { return await new Promise<never>(() => {}); },
  });

  const startedAt = Date.now();
  assert.equal(await resolveTurnOpenness({ message: 'do the thing', brainFamily: 'codex' }), null);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= 450, `deadline returned too early: ${elapsedMs}ms`);
  assert.ok(elapsedMs < 1_500, `hung judge delayed the turn for ${elapsedMs}ms`);
});

test('the kill-switch stops the pass entirely without touching the judge', async () => {
  process.env.CLEMMY_TURN_OPENNESS = 'off';
  let called = false;
  _setOpennessJudgeForTests(async () => { called = true; return { open: ['x'] }; });
  assert.equal(turnOpennessEnabled(), false);
  assert.equal(await resolveTurnOpenness({ message: 'do the thing', brainFamily: 'codex' }), null);
  assert.equal(called, false, 'a disabled pass must not spend a model call');
});

test('THE LIVE FIXTURE: the run that started with no conversation surfaces its open dimensions', async () => {
  // The owner's real message. Its destination ("airtable") was absent from the
  // preflight vocabulary, so no alignment beat fired and 61 records landed in a
  // table nobody had agreed on.
  _setOpennessJudgeForTests(async (input) => {
    assert.match(input.message, /arizona/i);
    assert.match(input.capabilityBlock ?? '', /AIRTABLE/i, 'the judge must see the runtime facts a text classifier cannot');
    return { open: ['which Airtable base', 'which of the scraped firms to load'] };
  });
  const openness = await resolveTurnOpenness({
    message: 'we started pulling the data for arizona criminal defense firms but still havnt gotten them into a new airtable base can we finalize that',
    brainFamily: 'codex',
    capabilityBlock: '✓ proven: create records — composio:AIRTABLE_CREATE_MULTIPLE_RECORDS [connection active]',
  });
  const rendered = renderTurnOpennessForContext(openness);
  assert.match(rendered, /which Airtable base/);
  assert.match(rendered, /ask_user_question is loaded/i, 'the floor must point at the instrument');
  assert.match(rendered, /BEFORE you commit/i, 'settling must precede the work, not follow it');
});

// THE GATE. The first cut ran this pass whenever ANY capability resolved,
// which taxed ordinary chat: a proven capability is just as often a read, and
// "what's on my calendar" is not ambiguous in a way worth a question. The full
// suite caught it — a pin asserting ordinary chat reaches the same seam and
// pays nothing for it. The gate is now the effect the capability carries,
// judged by the classifier every other gate already shares.
test('a resolved READ capability does NOT spend the pass', () => {
  const readOnly = [{ kind: 'composio', identifier: 'SCHEDULERCO_LIST_EVENTS' }];
  assert.equal(
    turnOpennessWarranted(readOnly, (id) => ({ mutating: /CREATE|UPDATE|SEND|DELETE/.test(id) })),
    false,
    'looking something up must never cost a clarification pass',
  );
});

test('a resolved WRITE capability warrants the pass', () => {
  const writes = [
    { kind: 'composio', identifier: 'SCHEDULERCO_LIST_EVENTS' },
    { kind: 'composio', identifier: 'AIRTABLE_CREATE_MULTIPLE_RECORDS' },
  ];
  assert.equal(
    turnOpennessWarranted(writes, (id) => ({ mutating: /CREATE|UPDATE|SEND|DELETE/.test(id) })),
    true,
    'a turn that can change the world is worth settling first',
  );
});

test('an unclassifiable capability is not treated as evidence of a write', () => {
  const entries = [{ kind: 'composio', identifier: 'MYSTERY_TOOL' }];
  assert.equal(
    turnOpennessWarranted(entries, () => { throw new Error('classifier blew up'); }),
    false,
    'a broken classifier must fail toward silence, not toward interrupting the user',
  );
  assert.equal(turnOpennessWarranted([]), false, 'no capabilities, no pass');
});

test('the real classifier agrees: a list carrier reads, a create carrier writes', () => {
  // No stub — this is the shared taxonomy the tool boundary itself enforces,
  // so the pass and the gate that ultimately stops a write cannot disagree.
  assert.equal(turnOpennessWarranted([{ kind: 'composio', identifier: 'SCHEDULERCO_LIST_EVENTS' }]), false);
  assert.equal(turnOpennessWarranted([{ kind: 'composio', identifier: 'AIRTABLE_CREATE_MULTIPLE_RECORDS' }]), true);
});

test('a runtime-proven deterministic openness floor survives a dead judge', async () => {
  // This exercises the primitive for a future caller that has positively read
  // multiple live account identities. Request-text classification alone does
  // not supply this fact; current callers leave that judgment to the independent
  // openness pass and the provider gateway fails closed on actual ambiguity.
  _setOpennessJudgeForTests(async () => { throw new Error('judge unavailable'); });
  const openness = await resolveTurnOpenness({
    message: 'can you pull 5 stale accounts for me in salesfroce and help me draft some emails',
    brainFamily: 'claude',
    deterministicOpen: ['which emails account/instance to use — you have more than one and none was named'],
  });
  assert.ok(openness, 'a certain unknown must not depend on a judge being alive');
  assert.match(openness!.open[0]!, /which emails account/i);
  assert.match(renderTurnOpennessForContext(openness), /BEFORE you commit/i);
});

test('certain unknowns lead, and duplicates across the two sources collapse', async () => {
  _setOpennessJudgeForTests(async () => ({ open: ['Which Emails Account/Instance To Use — you have more than one and none was named', 'the tone'] }));
  const openness = await resolveTurnOpenness({
    message: 'draft some emails',
    brainFamily: 'claude',
    deterministicOpen: ['which emails account/instance to use — you have more than one and none was named'],
  });
  assert.equal(openness?.open.length, 2, 'the same dimension from both sources is one dimension');
  assert.match(openness!.open[0]!, /^which emails account/, 'the certain one leads');
});

test('the caller-boundary helper derives the actual brain family from the selected model', () => {
  assert.equal(turnOpennessBrainFamily('gpt-5.6-sol'), 'codex');
  assert.equal(turnOpennessBrainFamily('claude-sonnet-5'), 'claude');
  assert.equal(turnOpennessBrainFamily('glm-5.2'), 'byo');
});

test('production topology selects a different family from the ACTUAL brain and executes exactly once', async () => {
  let calls = 0;
  const sameActualFamily = {
    model: {} as any,
    modelId: 'claude-haiku-4-5',
    judgeFamily: 'claude' as const,
    // Deliberately stale/misleading route metadata: actual input below wins.
    brainFamily: 'codex' as const,
    transport: 'claude_subscription' as const,
    selfJudge: false,
  };
  const independentFromActualFamily = {
    model: {} as any,
    modelId: 'gpt-5.4-mini',
    judgeFamily: 'codex' as const,
    brainFamily: 'codex' as const,
    transport: 'codex_responses' as const,
    selfJudge: false,
  };
  assert.equal(
    selectIndependentTurnOpennessJudgeRoute(
      [sameActualFamily, independentFromActualFamily],
      'claude',
    ),
    independentFromActualFamily,
  );
  _setOpennessJudgePortForTests({
    async resolveRoutes() { return [sameActualFamily, independentFromActualFamily]; },
    async run(request) {
      calls += 1;
      assert.equal(request.route, independentFromActualFamily);
      assert.deepEqual(request.tools, []);
      assert.equal(request.maxTurns, 1);
      return 'SETTLED: all result-changing values are specified';
    },
  });
  assert.equal(await resolveTurnOpenness({
    message: 'Create the specified sheet and email its link.',
    brainFamily: 'claude',
  }), null);
  assert.equal(calls, 1, 'one openness verdict means exactly one model call');
});

test('a route marked self-judge is refused even when its cached brain label is stale', () => {
  const staleSelfRoute = {
    model: {} as any,
    modelId: 'gpt-5.4-mini',
    judgeFamily: 'codex' as const,
    brainFamily: 'codex' as const,
    transport: 'codex_responses' as const,
    selfJudge: true,
  };
  assert.equal(
    selectIndependentTurnOpennessJudgeRoute([staleSelfRoute], 'claude'),
    null,
  );
});

test('no different-family judge route fails open without executing a model', async () => {
  let calls = 0;
  const sameFamily = {
    model: {} as any,
    modelId: 'gpt-5.4-mini',
    judgeFamily: 'codex' as const,
    brainFamily: 'claude' as const,
    transport: 'codex_responses' as const,
    selfJudge: false,
  };
  _setOpennessJudgePortForTests({
    async resolveRoutes() { return [sameFamily]; },
    async run() { calls += 1; return 'OPEN: something'; },
  });
  assert.equal(await resolveTurnOpenness({
    message: 'Do the specified task.',
    brainFamily: 'codex',
  }), null);
  assert.equal(calls, 0);
});

test('a CONSEQUENTIAL turn with zero proven capabilities still runs the pass', async () => {
  // Live miss, one hour after this shipped: "pull 5 stale accounts in
  // salesforce and help me draft some emails" resolved ZERO capability entries
  // (no proven memo matched), so a gate keyed only on resolved capabilities
  // stayed silent — on a turn the preflight had already typed align /
  // consequential / destination-instance-unstated. A novel request is the most
  // ambiguous kind, not the least. Both lanes must accept EITHER signal.
  const { readFileSync } = await import('node:fs');
  for (const [name, url] of [
    ['claude-agent-brain.ts', new URL('./claude-agent-brain.ts', import.meta.url)],
    ['loop.ts', new URL('./loop.ts', import.meta.url)],
  ] as const) {
    const source = readFileSync(url, 'utf8');
    const gate = source.slice(
      Math.max(0, source.indexOf('turnOpennessEnabled()') - 400),
      source.indexOf('turnOpennessWarranted(') + 300,
    );
    assert.match(gate, /confirmBeat|preflightPhase === 'align'/,
      `${name} must also run the pass on a consequential turn with no capability history`);
  }
});

test('BOTH brain lanes run the pass — lane asymmetry is the bug that caused this', async () => {
  // The root cause of the whole wave: the Codex lane assembled the ask tool
  // unconditionally, the Claude lane deferred it, and nothing noticed for
  // weeks because each lane was correct on its own terms. A capability that
  // exists on one brain and not the other is invisible until a user hits it.
  const { readFileSync } = await import('node:fs');
  const lanes = [
    ['claude-agent-brain.ts', new URL('./claude-agent-brain.ts', import.meta.url)],
    ['loop.ts', new URL('./loop.ts', import.meta.url)],
  ] as const;
  for (const [name, url] of lanes) {
    const source = readFileSync(url, 'utf8');
    assert.match(source, /resolveTurnOpenness\(/, `${name} must resolve turn openness`);
    assert.match(source, /renderTurnOpennessForContext\(/, `${name} must render it into context`);
    assert.match(source, /turnOpennessEnabled\(\)/, `${name} must honour the kill-switch`);
  }
});

test('the rendered block is DATA and a floor — it never scripts her words', () => {
  const rendered = renderTurnOpennessForContext({ open: ['which mailbox'] });
  // Voice-cosplay guard (owner rule): the harness states what must be
  // accomplished and never puts a sentence in her mouth.
  assert.doesNotMatch(rendered, /"[^"]*\?"/, 'no quoted example question');
  assert.doesNotMatch(rendered, /\bsay\s+["“]/i, 'no scripted utterance');
  assert.match(rendered, /^\[open —/, 'presented as a data block');
});
