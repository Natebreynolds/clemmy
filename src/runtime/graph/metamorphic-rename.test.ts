/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/graph/metamorphic-rename.test.ts
 *
 * The walking-skeleton oracle (blank-state amendments §5): rename every
 * provider, action, field, and account identifier; the admitted plan must be
 * isomorphic. ~50 cases in PR. Replay a failure with METAMORPHIC_SEED.
 */
import { randomInt } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';

import { compileAcceptedGoal } from './accepted-goal.js';
import { computeEffectIdentity, type EffectIdentityInput } from './effect-lifecycle.js';
import {
  proposeTurnGraphFromGoal,
  validateProposedGraph,
  type ProposedTurnGraphV1,
} from './turn-graph-proposal.js';

const CASES = Number(process.env.METAMORPHIC_CASES ?? 50);
const SEED = process.env.METAMORPHIC_SEED
  ? Number(process.env.METAMORPHIC_SEED) >>> 0
  : randomInt(0, 0xffffffff);

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function token(rng: () => number, prefix: string, i: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  let body = '';
  for (let n = 0; n < 8; n += 1) body += alphabet[Math.floor(rng() * alphabet.length)]!;
  return `${prefix}${i}${body}`;
}

function planShape(proposed: ProposedTurnGraphV1): unknown {
  return {
    kinds: proposed.nodes.map((node) => `${node.kind}:${node.capabilityRole ?? ''}`),
    effects: proposed.nodes.map((node) => node.effect ?? ''),
    destCount: proposed.destinationFamilies?.length ?? 0,
    fieldCounts: proposed.nodes.map((node) => node.requiredFields?.length ?? 0),
    cardinalities: proposed.nodes.map((node) => node.cardinality ?? null),
  };
}

function walkingGoal(families: readonly [string, string], fields: readonly string[]) {
  const goal = compileAcceptedGoal({
    text: 'Read the source, derive evidence-backed changes, create one artifact, then update the tracker',
    sourceUserSeq: 9001,
    multiItem: { itemCount: 5, isMultiItem: false, collectThenConstruct: true },
    destinations: [
      { posture: 'create_new', family: families[0], handleRequired: true },
      { posture: 'named_existing', family: families[1], handleRequired: false },
    ],
  });
  return {
    ...goal,
    collection: { count: 5, projection: [...fields] },
  };
}

test(`admitted plan is isomorphic under identifier rename (${CASES} cases, seed=${SEED})`, () => {
  const rng = mulberry32(SEED);
  for (let i = 0; i < CASES; i += 1) {
    const label = `seed=${SEED} case=${i}`;
    const leftFamilies = [token(rng, 'fam', i), token(rng, 'fam', i + 100)] as const;
    const rightFamilies = [token(rng, 'fam', i + 200), token(rng, 'fam', i + 300)] as const;
    const leftFields = [token(rng, 'fld', i), token(rng, 'fld', i + 1), token(rng, 'fld', i + 2)];
    const rightFields = [token(rng, 'fld', i + 10), token(rng, 'fld', i + 11), token(rng, 'fld', i + 12)];
    const left = walkingGoal(leftFamilies, leftFields);
    const right = walkingGoal(rightFamilies, rightFields);
    const leftPlan = proposeTurnGraphFromGoal(left);
    const rightPlan = proposeTurnGraphFromGoal(right);
    assert.equal(validateProposedGraph(left, leftPlan.proposed).ok, true, label);
    assert.equal(validateProposedGraph(right, rightPlan.proposed).ok, true, label);
    assert.deepEqual(planShape(rightPlan.proposed), planShape(leftPlan.proposed), label);
    assert.deepEqual(leftPlan.proposed.destinationFamilies, [...leftFamilies], label);
    assert.deepEqual(rightPlan.proposed.destinationFamilies, [...rightFamilies], label);
    assert.equal(left.effectCeiling, right.effectCeiling, `${label} family rename changed the effect ceiling`);
  }
});

test(`effect identity diverges on any material rename (${CASES} cases, seed=${SEED})`, () => {
  const rng = mulberry32(SEED ^ 0x9e3779b9);
  for (let i = 0; i < CASES; i += 1) {
    const label = `seed=${SEED} case=${i}`;
    const base: EffectIdentityInput = {
      admissionDigest: token(rng, 'adm', i),
      provider: token(rng, 'prov', i),
      operation: token(rng, 'op', i),
      effectClass: 'write',
      accountIdentity: `${token(rng, 'acct', i)}@example.invalid`,
      recipientKey: `${token(rng, 'res', i)}:1`,
      argumentsDigest: token(rng, 'args', i),
    };
    const same = computeEffectIdentity(base);
    assert.equal(computeEffectIdentity({ ...base }), same, label);
    assert.notEqual(computeEffectIdentity({ ...base, provider: token(rng, 'provX', i) }), same, label);
    assert.notEqual(computeEffectIdentity({ ...base, operation: token(rng, 'opX', i) }), same, label);
    assert.notEqual(computeEffectIdentity({ ...base, accountIdentity: `${token(rng, 'acctX', i)}@example.invalid` }), same, label);
    assert.notEqual(computeEffectIdentity({ ...base, recipientKey: `${token(rng, 'resX', i)}:2` }), same, label);
    assert.notEqual(computeEffectIdentity({ ...base, argumentsDigest: token(rng, 'argsX', i) }), same, label);
    assert.notEqual(computeEffectIdentity({ ...base, admissionDigest: token(rng, 'admX', i) }), same, label);
  }
});

test('admitted destination family strings do not select the write ceiling', () => {
  const alpha = walkingGoal(['artifact-alpha', 'tracker-beta'], ['title', 'date', 'link']);
  const sheets = walkingGoal(['workbook', 'email'], ['title', 'date', 'link']);
  assert.equal(alpha.effectCeiling, sheets.effectCeiling);
  assert.deepEqual(planShape(proposeTurnGraphFromGoal(alpha).proposed), planShape(proposeTurnGraphFromGoal(sheets).proposed));
});
