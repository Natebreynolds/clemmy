/**
 * Run: npx tsx --test src/runtime/harness/plan-first.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectAmbiguousAction,
  planRequiresUserApproval,
  renderPlanFirstFailureReply,
  renderPlanNeedsInputReply,
  renderPlanReply,
  shouldUsePlanFirst,
} from './plan-first.js';
import type { Plan } from '../../agents/planner.js';

const VAGUE_DEAL_REQUEST =
  'can you get me a list of the deals we closed recently and put it somewhere i can look at it';

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    objective: 'Create a short local markdown SEO opportunity brief for review.',
    steps: [
      {
        n: 1,
        action: 'Use Clementine memory and saved workflow context first.',
        rationale: 'Use local context before outside research.',
        verification: null,
      },
      {
        n: 2,
        action: 'Write the final markdown report to a local reviewable file.',
        rationale: 'The user asked for a local artifact.',
        verification: 'The local markdown file exists and lists sources.',
      },
    ],
    successCriteria: ['A local markdown brief exists and lists the sources used.'],
    risks: [],
    estimatedComplexity: 'moderate',
    recommendsTrackedExecution: false,
    needsUserInput: [],
    appliedInstructions: [],
    ...overrides,
  };
}

test('shouldUsePlanFirst: fresh multi-system batch work gets planner-first gate', () => {
  const input =
    'Find 8 law firm accounts from Salesforce that fit our Market Leader outreach lane. For each one, gather one concrete SEO or web visibility signal, create a local markdown report, then draft Outlook emails for the top 3 with my Chili Piper link.';

  assert.equal(shouldUsePlanFirst({ input, freshSession: true }), true);
});

test('shouldUsePlanFirst: continuations and approvals do not get replanned', () => {
  assert.equal(
    shouldUsePlanFirst({
      input: 'go ahead and create those drafts now',
      freshSession: true,
    }),
    false,
  );
  assert.equal(
    shouldUsePlanFirst({
      input: 'approve apr-1234',
      freshSession: true,
    }),
    false,
  );
});

test('shouldUsePlanFirst: simple existing chat continuations do not get forced through first-turn gate', () => {
  const input =
    'Can we go back to the social media post and make that caption a little warmer before we publish?';

  assert.equal(shouldUsePlanFirst({ input, freshSession: false }), false);
});

test('shouldUsePlanFirst: complex existing-session pivots get planner-first gate', () => {
  const input =
    'Find 8 Salesforce accounts, gather SEO signals for each firm, write a local report, and create Outlook draft emails with my Chili Piper link.';

  assert.equal(shouldUsePlanFirst({ input, freshSession: false }), true);
});

test('shouldUsePlanFirst: simple local or conversational asks run normally', () => {
  assert.equal(
    shouldUsePlanFirst({
      input: 'Can you explain what happened in the last run?',
      freshSession: true,
    }),
    false,
  );
  assert.equal(
    shouldUsePlanFirst({
      input: 'Write a short local markdown note with three bullets.',
      freshSession: true,
    }),
    false,
  );
});

test('shouldUsePlanFirst: vague prospecting help stays conversational so Clem can clarify', () => {
  assert.equal(
    shouldUsePlanFirst({
      input: 'hey i could use your help with some prospecting emails',
      freshSession: true,
    }),
    false,
  );
});

test('renderPlanFirstFailureReply: planner failures stop before tool execution', () => {
  const reply = renderPlanFirstFailureReply();

  assert.match(reply, /did not start the tool work/i);
  assert.match(reply, /retry plan/);
  assert.match(reply, /simplify/);
  assert.match(reply, /proceed/);
});

test('renderPlanNeedsInputReply: asks for clarification without approval language', () => {
  const reply = renderPlanNeedsInputReply({
    objective: 'Prepare a local SEO opportunity brief.',
    steps: [
      {
        n: 1,
        action: 'Read relevant memory and workflow context.',
        rationale: 'Use Clementine context before asking for outside data.',
        verification: null,
      },
      {
        n: 2,
        action: 'Draft the local markdown brief.',
        rationale: 'Produce the requested artifact after context is clear.',
        verification: null,
      },
    ],
    successCriteria: ['The brief names the firm and sources used.'],
    risks: [],
    estimatedComplexity: 'moderate',
    recommendsTrackedExecution: false,
    needsUserInput: ['Which local law firm should I brief?'],
    appliedInstructions: [],
  });

  assert.match(reply, /Before I start, I need one detail:/);
  assert.match(reply, /Which local law firm/);
  assert.doesNotMatch(reply, /approve/i);
  assert.doesNotMatch(reply, /I drafted the plan/i);
  assert.doesNotMatch(reply, /^Plan:/m);
});

test('renderPlanReply: keeps blocking plans conversational and compact', () => {
  const reply = renderPlanReply(makePlan({
    objective: 'Draft six Outlook emails for review before sending anything.',
    steps: [
      {
        n: 1,
        action: 'Read memory for standing outbound instructions.',
        rationale: 'Follow user preferences.',
        verification: null,
      },
      {
        n: 2,
        action: 'Create six Outlook drafts.',
        rationale: 'The user requested drafts.',
        verification: 'Six drafts exist.',
      },
    ],
  }), 'plan-abc123');

  assert.match(reply, /I can do that/i);
  assert.match(reply, /Approve this plan/i);
  assert.doesNotMatch(reply, /I drafted the plan/i);
  assert.doesNotMatch(reply, /^Plan:/m);
});

test('planRequiresUserApproval: safe local markdown reports do not block on approval', () => {
  const plan = makePlan({
    objective: 'Create a short, reviewable local markdown SEO opportunity brief with no external sends or updates.',
    steps: [
      {
        n: 1,
        action: 'Use Clementine memory and saved proposal workflow context first.',
        rationale: 'Use known context first.',
        verification: null,
      },
      {
        n: 2,
        action: 'Draft the local markdown report and stop before any external send, post, update, or deploy.',
        rationale: 'The user requested a local-only deliverable.',
        verification: 'The markdown file exists locally.',
      },
    ],
  });

  assert.equal(planRequiresUserApproval(plan, 'Create a local markdown report only; do not send or update external systems.'), false);
});

test('planRequiresUserApproval: external writes and large tracked work still block', () => {
  assert.equal(planRequiresUserApproval(makePlan({
    objective: 'Create Outlook draft emails for six prospects.',
    steps: [
      {
        n: 1,
        action: 'Create six Outlook drafts.',
        rationale: 'The user asked for email drafts.',
        verification: 'Drafts exist in Outlook.',
      },
    ],
  }), 'create six Outlook drafts'), true);

  assert.equal(planRequiresUserApproval(makePlan({
    estimatedComplexity: 'large',
    recommendsTrackedExecution: true,
  }), 'prepare a multi-day research project'), true);
});

test('detectAmbiguousAction: the vague deal request is ambiguous and missing source + destination', () => {
  const result = detectAmbiguousAction(VAGUE_DEAL_REQUEST);
  assert.equal(result.ambiguous, true);
  assert.ok(result.missing.includes('source'), 'expected source missing');
  assert.ok(result.missing.includes('destination'), 'expected destination missing');
  // "recently" with no concrete window should also flag scope.
  assert.ok(result.missing.includes('scope'), 'expected scope missing');
});

test('detectAmbiguousAction: a simple clear question is not an ambiguous action', () => {
  const result = detectAmbiguousAction("what's on my calendar today");
  assert.equal(result.ambiguous, false);
  assert.deepEqual(result.missing, []);
});

test('detectAmbiguousAction: a concrete batch send is an action but not ambiguous', () => {
  const result = detectAmbiguousAction('send these 40 emails to the list');
  assert.equal(typeof result.ambiguous, 'boolean');
  // Concrete count + named target → no missing slots.
  assert.equal(result.ambiguous, false);
});

test('shouldUsePlanFirst: vague deal request stays in the orchestrator even if old converse flag is on', () => {
  const prev = process.env.CLEMMY_CHAT_CONVERSE;
  try {
    process.env.CLEMMY_CHAT_CONVERSE = 'on';
    assert.equal(
      shouldUsePlanFirst({ input: VAGUE_DEAL_REQUEST, freshSession: true, autonomy: 'balanced' }),
      false,
    );
    assert.equal(
      shouldUsePlanFirst({ input: VAGUE_DEAL_REQUEST, freshSession: true, autonomy: 'strict' }),
      false,
    );
    assert.equal(
      shouldUsePlanFirst({ input: VAGUE_DEAL_REQUEST, freshSession: true, autonomy: 'yolo' }),
      false,
    );
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_CHAT_CONVERSE;
    else process.env.CLEMMY_CHAT_CONVERSE = prev;
  }
});

test('shouldUsePlanFirst: flag off is byte-identical (vague deal request stays false)', () => {
  const prev = process.env.CLEMMY_CHAT_CONVERSE;
  try {
    // Force 'off' rather than delete: getRuntimeEnv falls back to the
    // BASE_DIR/.env file when process.env is unset, and a dev box may have
    // CLEMMY_CHAT_CONVERSE=on persisted there (v0.5.37 default-on rollout).
    // Deleting would make this test machine-dependent; setting 'off' pins
    // the flag-off contract deterministically. (process.env wins in
    // getRuntimeEnv, so 'off' here beats any .env value.)
    process.env.CLEMMY_CHAT_CONVERSE = 'off';
    assert.equal(
      shouldUsePlanFirst({ input: VAGUE_DEAL_REQUEST, freshSession: true, autonomy: 'balanced' }),
      false,
    );
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_CHAT_CONVERSE;
    else process.env.CLEMMY_CHAT_CONVERSE = prev;
  }
});

test('shouldUsePlanFirst: short vague actions stay conversational', () => {
  const shortVague = 'get me the deals we closed somewhere';
  assert.ok(shortVague.length < 80, 'precondition: message is under the size floor');
  assert.equal(detectAmbiguousAction(shortVague).ambiguous, true);
  const prev = process.env.CLEMMY_CHAT_CONVERSE;
  try {
    process.env.CLEMMY_CHAT_CONVERSE = 'on';
    assert.equal(
      shouldUsePlanFirst({ input: shortVague, freshSession: true, autonomy: 'balanced' }),
      false,
      'short vague action must stay in the orchestrator so Clem can clarify naturally',
    );
    process.env.CLEMMY_CHAT_CONVERSE = 'off';
    assert.equal(
      shouldUsePlanFirst({ input: shortVague, freshSession: true, autonomy: 'balanced' }),
      false,
      'flag off: same behavior',
    );
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_CHAT_CONVERSE;
    else process.env.CLEMMY_CHAT_CONVERSE = prev;
  }
});

test('shouldUsePlanFirst: explicit planning requests can still use the separate planner', () => {
  assert.equal(
    shouldUsePlanFirst({
      input: 'Before you start, plan out the Salesforce to Outlook outreach workflow.',
      freshSession: true,
    }),
    true,
  );
});

test('shouldUsePlanFirst: local SEO brief runs through the main orchestrator', () => {
  assert.equal(
    shouldUsePlanFirst({
      input: 'Can you help me make an SEO opportunity brief for a local law firm and save it somewhere I can review? Use anything Clementine already knows first.',
      freshSession: true,
      autonomy: 'balanced',
    }),
    false,
  );
});

test('shouldUsePlanFirst: a control reply never engages even with the flag on', () => {
  // "approve" / "continue" must short-circuit ahead of the ambiguity branch.
  const prev = process.env.CLEMMY_CHAT_CONVERSE;
  try {
    process.env.CLEMMY_CHAT_CONVERSE = 'on';
    for (const control of ['approve', 'continue', 'cancel']) {
      assert.equal(
        shouldUsePlanFirst({ input: control, freshSession: true, autonomy: 'balanced' }),
        false,
        `control word "${control}" must not engage plan-first`,
      );
    }
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_CHAT_CONVERSE;
    else process.env.CLEMMY_CHAT_CONVERSE = prev;
  }
});
