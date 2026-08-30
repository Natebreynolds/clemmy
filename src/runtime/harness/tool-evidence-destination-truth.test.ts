/**
 * B3 pins: the fresh-external-write requirement derives from what the turn
 * TOUCHED, with request-text regexes as fallback only.
 *
 * The live lie (2026-08-09, sess-msmactpy): "Let's just find those slack ids
 * and save them in the workflow" — a LOCAL file edit — classified as an
 * external-write objective because the clause names slack and a save verb;
 * the finished turn's real report was replaced with "I cannot honestly
 * confirm the work went out". The 2026-08-05 point fix (one regex) recurred
 * in four days; this is the class fix.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'destination-truth-test-'));
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

import test from 'node:test';
import assert from 'node:assert/strict';

const { appendEvent, createSession } = await import('./eventlog.js');
const graphCompiler = await import('../graph/turn-graph-compiler.js');
const graphShadow = await import('../graph/turn-graph-shadow.js');
const proactivity = await import('../../agents/proactivity-policy.js');
const workAdmission = await import('./expected-work-admission.js');
const workContracts = await import('./expected-work-contract.js');
const {
  freshExternalWriteRequirement,
  objectiveRequiresFreshExternalWrite,
} = await import('./tool-evidence.js');

const LIVE_TEXT = "Let's just find those slack ids and save them in the workflow which should make it easier to run in the future";

function sessionWith(effects: Array<string | { type: string }>): { sessionId: string; sourceUserSeq: number } {
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: LIVE_TEXT },
  });
  let call = 0;
  for (const entry of effects) {
    if (typeof entry !== 'string') {
      appendEvent({
        sessionId: sess.id, turn: 1, role: 'Clem', type: entry.type as never,
        data: { sourceUserSeq: source.seq, shapeKey: 'GMAIL_SEND_EMAIL', targets: [] },
      });
      continue;
    }
    call += 1;
    appendEvent({
      sessionId: sess.id, turn: 1, role: 'Clem', type: 'tool_called',
      data: {
        sourceUserSeq: source.seq,
        tool: 'run_shell_command',
        callId: `call-${call}`,
        canonicalCallId: `call-${call}`,
        accounting: 'top_level',
        effect: entry,
      },
    });
  }
  return { sessionId: sess.id, sourceUserSeq: source.seq };
}

let structuralSerial = 0;

function generatedOpaqueName(seed: number): string {
  const alphabet = 'QZXJKVBP';
  let remaining = seed;
  const uniquePrefix = Array.from({ length: 4 }, () => {
    const character = alphabet[remaining % alphabet.length];
    remaining = Math.floor(remaining / alphabet.length);
    return character;
  }).join('');
  return `${uniquePrefix}VQBKZ`;
}

function structuralChatSource(input: {
  text: string;
  graphEffect: 'external_write' | 'local_write' | 'unknown';
  contractEffect?: 'external_write' | 'admin' | 'local_write';
}): { sessionId: string; sourceUserSeq: number } {
  const session = createSession({
    id: `destination-truth-structural-${++structuralSerial}`,
    kind: 'chat',
  });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: input.text },
  });
  const compiled = graphCompiler.compileTurnGraph({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
    input: input.text,
    sessionKind: 'chat',
    surface: 'discord',
    policy: graphCompiler.snapshotTurnGraphPolicy(proactivity.getProactivityPolicySnapshot()),
    signals: {
      intent: { intent: 'action', confidence: 1, reasons: ['generated_causal_cohort'] },
      externalEffect: {
        requested: input.graphEffect === 'external_write',
        kinds: [],
      },
    },
  });
  assert.equal(compiled.validation.ok, true, compiled.validation.errors.join('; '));
  assert.equal(compiled.graph.effectCeiling, input.graphEffect);
  const recorded = graphShadow.recordTurnGraphShadowChecked({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
    surface: 'discord',
    graph: compiled.graph,
  });
  assert.equal(recorded.ok, true, recorded.ok ? '' : recorded.reason);

  if (input.contractEffect) {
    const activated = workAdmission.activateActionExpectedWork({
      sessionId: session.id,
      sourceUserSeq: source.seq,
    });
    assert.ok(
      activated.status === 'activated' || activated.status === 'replayed',
      JSON.stringify(activated),
    );
    const frozen = workContracts.freezeActionExpectedWorkContract({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      proposal: {
        version: 1,
        operations: [{
          id: `generated-requirement-${structuralSerial}`,
          effect: input.contractEffect,
          dependsOn: [],
          dataFrom: [],
          cardinality: { kind: 'once' },
        }],
        universes: [],
      },
    });
    assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed', JSON.stringify(frozen));
  }
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

test('FAILS-ON-OLD-CODE: the live text still classifies external by text alone', () => {
  assert.equal(
    objectiveRequiresFreshExternalWrite(LIVE_TEXT),
    true,
    'precondition: the regex classifier still gets this wrong — if this starts failing, the text path was fixed and this pin should be revisited',
  );
});

test('THE CLASS FIX: local-only observed activity → no external receipt required, any phrasing', () => {
  const { sessionId, sourceUserSeq } = sessionWith(['read', 'local_write', 'read', 'compute']);
  const requirement = freshExternalWriteRequirement({ objectiveText: LIVE_TEXT, sessionId, sourceUserSeq });
  assert.equal(requirement.required, false);
  assert.equal(requirement.basis, 'observed_local_only');
  assert.equal(requirement.touchedExternal, 0);
});

test('HOLE STAYS CLOSED: a turn that was supposed to send and did NOTHING falls to the text classifier', () => {
  const { sessionId, sourceUserSeq } = sessionWith([]);
  const requirement = freshExternalWriteRequirement({
    objectiveText: 'email these figures to the team now',
    sessionId,
    sourceUserSeq,
  });
  assert.equal(requirement.basis, 'objective_text');
  assert.equal(requirement.required, true, 'no observed activity must never waive a send objective');
});

test('an external touch keeps the requirement on the text/evidence path', () => {
  const { sessionId, sourceUserSeq } = sessionWith(['read', { type: 'external_write' }]);
  const requirement = freshExternalWriteRequirement({
    objectiveText: 'email these figures to the team now',
    sessionId,
    sourceUserSeq,
  });
  assert.equal(requirement.basis, 'objective_text');
  assert.equal(requirement.required, true);
  assert.equal(requirement.touchedExternal, 1);
});

test('unknown effects prove nothing: unclassified-only activity falls to text', () => {
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: LIVE_TEXT },
  });
  appendEvent({
    sessionId: sess.id, turn: 1, role: 'Clem', type: 'tool_called',
    data: { sourceUserSeq: source.seq, tool: 'mystery', callId: 'c1', canonicalCallId: 'c1', accounting: 'top_level' },
  });
  const requirement = freshExternalWriteRequirement({
    objectiveText: LIVE_TEXT, sessionId: sess.id, sourceUserSeq: source.seq,
  });
  assert.equal(requirement.basis, 'objective_text');
});

test('mirror rows do not count as touched destinations', () => {
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: LIVE_TEXT },
  });
  appendEvent({
    sessionId: sess.id, turn: 1, role: 'Clem', type: 'tool_called',
    data: { sourceUserSeq: source.seq, tool: 'x', callId: 'c1', canonicalCallId: 'c1', accounting: 'transport_mirror', effect: 'local_write' },
  });
  const requirement = freshExternalWriteRequirement({
    objectiveText: LIVE_TEXT, sessionId: sess.id, sourceUserSeq: source.seq,
  });
  assert.equal(requirement.touchedTotal, 0, 'canonical projection only — mirrors would double-count');
  assert.equal(requirement.basis, 'objective_text');
});

test('a missing session or ledger error falls to text, never throws, never waives', () => {
  const requirement = freshExternalWriteRequirement({
    objectiveText: 'email these figures to the team now',
    sessionId: 'sess-does-not-exist',
    sourceUserSeq: 1,
  });
  assert.equal(requirement.basis, 'objective_text');
  assert.equal(requirement.required, true);
});

test('generated ordinary-chat cohort: opaque admitted external writes survive zero calls', () => {
  for (let seed = 1; seed <= 12; seed += 1) {
    const destination = generatedOpaqueName(seed);
    const objectiveText = `Update the accepted record inside ${destination}.`;
    assert.equal(
      objectiveRequiresFreshExternalWrite(objectiveText),
      false,
      `${destination}: precondition — no provider vocabulary recognizes the generated destination`,
    );
    const source = structuralChatSource({
      text: objectiveText,
      graphEffect: 'external_write',
    });
    assert.deepEqual(freshExternalWriteRequirement({
      objectiveText,
      ...source,
    }), {
      required: true,
      basis: 'accepted_graph',
      touchedTotal: 0,
      touchedExternal: 0,
    }, destination);
  }
});

test('an admitted external outcome dominates an observed local side task', () => {
  const destination = generatedOpaqueName(41);
  const objectiveText = `Update the accepted record inside ${destination}.`;
  const source = structuralChatSource({
    text: objectiveText,
    graphEffect: 'external_write',
    contractEffect: 'external_write',
  });
  appendEvent({
    sessionId: source.sessionId,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: {
      sourceUserSeq: source.sourceUserSeq,
      tool: 'write_file',
      callId: 'local-side-task',
      canonicalCallId: 'local-side-task',
      accounting: 'top_level',
      effect: 'local_write',
    },
  });
  assert.deepEqual(freshExternalWriteRequirement({
    objectiveText,
    ...source,
  }), {
    required: true,
    basis: 'expected_work',
    touchedTotal: 1,
    touchedExternal: 0,
  });
});

test('generated local/text artifacts never acquire an external receipt requirement', () => {
  for (let seed = 60; seed < 72; seed += 1) {
    const subject = generatedOpaqueName(seed);
    const objectiveText = `Create a local text file comparing ${subject} records; keep it on this machine.`;
    assert.equal(objectiveRequiresFreshExternalWrite(objectiveText), false, subject);
    const source = structuralChatSource({
      text: objectiveText,
      graphEffect: 'local_write',
      contractEffect: 'local_write',
    });
    assert.deepEqual(freshExternalWriteRequirement({
      objectiveText,
      ...source,
    }), {
      required: false,
      basis: 'objective_text',
      touchedTotal: 0,
      touchedExternal: 0,
    }, subject);
  }
});

test('an under-scoped non-external proposal cannot waive the zero-call text safety floor', () => {
  const objectiveText = 'Send the accepted payload to the release owner now.';
  assert.equal(objectiveRequiresFreshExternalWrite(objectiveText), true);
  const source = structuralChatSource({
    text: objectiveText,
    graphEffect: 'unknown',
    contractEffect: 'local_write',
  });
  assert.deepEqual(freshExternalWriteRequirement({
    objectiveText,
    ...source,
  }), {
    required: true,
    basis: 'objective_text',
    touchedTotal: 0,
    touchedExternal: 0,
  });
});

test.after(() => {
  rmSync(process.env.CLEMENTINE_HOME!, { recursive: true, force: true });
});
