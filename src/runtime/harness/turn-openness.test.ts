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
  _setOpennessJudgeForTests,
} = await import('./turn-openness.js');

after(() => { rmSync(TMP_HOME, { recursive: true, force: true }); });
afterEach(() => { _setOpennessJudgeForTests(null); delete process.env.CLEMMY_TURN_OPENNESS; });

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

test('a judge that throws or hangs never breaks the turn', async () => {
  _setOpennessJudgeForTests(async () => { throw new Error('judge exploded'); });
  assert.equal(await resolveTurnOpenness({ message: 'do the thing' }), null);
});

test('the kill-switch stops the pass entirely without touching the judge', async () => {
  process.env.CLEMMY_TURN_OPENNESS = 'off';
  let called = false;
  _setOpennessJudgeForTests(async () => { called = true; return { open: ['x'] }; });
  assert.equal(turnOpennessEnabled(), false);
  assert.equal(await resolveTurnOpenness({ message: 'do the thing' }), null);
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
