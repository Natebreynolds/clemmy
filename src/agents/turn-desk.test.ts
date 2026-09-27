/** The round-one desk's pure decision (agents/turn-desk.ts): a fixed ladder,
 * rungs and evidence read from the registry declarations, a session floor
 * that never descends, and misses that climb exactly to the missed tool's
 * rung. The host path is pinned in
 * runtime/harness/turn-desk-reachability.integration.test.ts. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DESK_RUNGS,
  NO_TARGET_STARTS_LEAN,
  decideTurnDesk,
  deferredOnRung,
  deskRungForEvidence,
  fullTurnDesk,
  renderDeskNamesLine,
  type TurnDeskFacts,
} from './turn-desk.js';
import { TOOL_REGISTRY, deskDeclarationFor } from '../tools/tool-registry.js';

const DESK_TOOLS = TOOL_REGISTRY.filter((declaration) => declaration.desk).map((declaration) => declaration.name).sort();
const READERS = DESK_TOOLS.filter((name) => deskDeclarationFor(name)?.rung === 'readers');
const FULL_ONLY = DESK_TOOLS.filter((name) => deskDeclarationFor(name)?.rung === 'full');
const SURFACE = ['tool_search', 'call_tool', 'ask_user_question', 'work_call', ...DESK_TOOLS, 'read_file'];
const NONE = { retained_output: false, delegation: false, listed_skill: false, long_work: false } as const;
const facts = (overrides: Partial<TurnDeskFacts> = {}): TurnDeskFacts => ({
  identifiedTarget: true,
  evidence: NONE,
  missed: [],
  sessionFloor: null,
  ...overrides,
});

test('the ladder is lean, readers, full, and every desk declaration names a rung above lean', () => {
  assert.deepEqual(DESK_RUNGS, ['lean', 'readers', 'full']);
  assert.ok(READERS.length > 0 && FULL_ONLY.length > 0);
  for (const name of DESK_TOOLS) {
    const declaration = deskDeclarationFor(name)!;
    assert.ok(['readers', 'full'].includes(declaration.rung), name);
    assert.ok(declaration.purpose.trim().length > 0, `${name} has a purpose phrase`);
  }
  for (const door of ['tool_search', 'call_tool', 'work_call', 'ask_user_question', 'request_approval',
    'plan_step_result', 'publish_plan', 'memory_recall_all', 'session_search', 'run_worker']) {
    assert.equal(deskDeclarationFor(door), null, `${door} is never deferred`);
  }
});

test('evidence climbs to the rung of the tools that declare it', () => {
  assert.equal(deskRungForEvidence('retained_output'), 'readers');
  assert.equal(deskRungForEvidence('listed_skill'), 'full');
  assert.equal(deskRungForEvidence('long_work'), 'full');
  assert.equal(deskRungForEvidence('delegation'), 'full', 'delegation evidence is the full rung');
});

test('an identified target with no evidence is the lean rung: every desk tool on the surface is deferred', () => {
  const decision = decideTurnDesk(SURFACE, facts(), 7);
  assert.equal(decision.rung, 'lean');
  assert.equal(decision.fallbackReason, null);
  assert.deepEqual([...decision.deferred].sort(), DESK_TOOLS);
  assert.equal(decision.sourceUserSeq, 7);
});

test('no identified target follows the no-signal rule constant', () => {
  const decision = decideTurnDesk(SURFACE, facts({ identifiedTarget: false }), 7);
  if (NO_TARGET_STARTS_LEAN) {
    assert.equal(decision.rung, 'lean');
  } else {
    assert.equal(decision.rung, 'full');
    assert.deepEqual(decision.climbedBy, ['no_identified_target']);
    assert.deepEqual(decision.deferred, []);
  }
});

test('retained output climbs to readers; any full-rung evidence climbs to full', () => {
  const readers = decideTurnDesk(SURFACE, facts({ evidence: { ...NONE, retained_output: true } }), 7);
  assert.equal(readers.rung, 'readers');
  assert.deepEqual([...readers.deferred].sort(), FULL_ONLY);
  for (const kind of ['delegation', 'listed_skill', 'long_work'] as const) {
    const full = decideTurnDesk(SURFACE, facts({ evidence: { ...NONE, [kind]: true } }), 7);
    assert.equal(full.rung, 'full', kind);
    assert.deepEqual(full.deferred, [], kind);
    assert.deepEqual(full.climbedBy, [kind]);
  }
});

test('a miss climbs exactly to the missed tool\'s rung', () => {
  for (const name of DESK_TOOLS) {
    const decision = decideTurnDesk(SURFACE, facts({ missed: [name] }), 7);
    assert.equal(decision.rung, deskDeclarationFor(name)!.rung, name);
    assert.deepEqual(decision.missed, [name]);
    assert.ok(decision.climbedBy.includes('miss'));
  }
  assert.equal(decideTurnDesk(SURFACE, facts({ missed: ['read_file'] }), 7).rung, 'lean',
    'a tool that declares no rung is not a miss');
});

test('a session never descends below the rung its previous source recorded', () => {
  assert.equal(decideTurnDesk(SURFACE, facts({ sessionFloor: 'readers' }), 7).rung, 'readers');
  assert.equal(decideTurnDesk(SURFACE, facts({ sessionFloor: 'full' }), 7).rung, 'full');
  assert.equal(decideTurnDesk(SURFACE, facts({ sessionFloor: 'full', identifiedTarget: true }), 7).deferred.length, 0);
});

test('only desk tools on this surface are deferred, and the full fallback defers nothing', () => {
  assert.deepEqual(deferredOnRung(['tool_search', 'check_in'], 'lean'), ['check_in']);
  assert.deepEqual(deferredOnRung(['tool_search', 'check_in', 'recall_tool_result'], 'readers'), ['check_in']);
  assert.deepEqual(deferredOnRung(SURFACE, 'full'), []);
  for (const reason of ['out_of_scope', 'doors_absent', 'facts_unavailable'] as const) {
    const fallback = fullTurnDesk(reason, 3);
    assert.equal(fallback.rung, 'full');
    assert.equal(fallback.fallbackReason, reason);
    assert.deepEqual(fallback.deferred, []);
  }
});

test('the names line names each deferred tool with its purpose and the two doors, and is absent when nothing is deferred', () => {
  const line = renderDeskNamesLine(DESK_TOOLS)!;
  assert.ok(line.startsWith('[on-request tools]'));
  assert.equal(line.split('\n').length, 1, 'one line');
  for (const name of DESK_TOOLS) assert.ok(line.includes(`${name} (${deskDeclarationFor(name)!.purpose})`), name);
  assert.match(line, /tool_search/);
  assert.match(line, /call_tool/);
  assert.equal(renderDeskNamesLine([]), null);
});
