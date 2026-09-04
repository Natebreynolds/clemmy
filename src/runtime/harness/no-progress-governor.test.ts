import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NO_PROGRESS_RETRY_BUDGET,
  NO_PROGRESS_STAGE_TRANSITION_BUDGET,
  canonicalNoProgressAskArguments,
  createNoProgressConsequence,
  initializeNoProgressGovernor,
  normalizeAuthorityProgressSnapshot,
  observeNoProgress,
  isCanonicalNoProgressAskArguments,
  parseNoProgressGovernorState,
  type AuthorityProgressSnapshot,
  type NoProgressAttemptClass,
} from './no-progress-governor.js';

const EMPTY: AuthorityProgressSnapshot = {
  operation: [],
  account: [],
  target: [],
  evidence: [],
  effect: [],
};

function snapshot(
  patch: Partial<Record<keyof AuthorityProgressSnapshot, readonly string[]>> = {},
): AuthorityProgressSnapshot {
  return { ...EMPTY, ...patch };
}

function observe(
  state: ReturnType<typeof initializeNoProgressGovernor>,
  attemptClass: NoProgressAttemptClass,
  authority: AuthorityProgressSnapshot = state.authority,
) {
  return observeNoProgress(state, {
    taskKey: state.taskKey,
    attemptClass,
    authority,
  });
}

/** Spend every clean retry with zero-gain metered lookups. */
function exhaust(
  state: ReturnType<typeof initializeNoProgressGovernor>,
  attemptClass: NoProgressAttemptClass = 'dependency_lookup',
) {
  let cursor = observe(state, attemptClass);
  for (let index = 1; index < NO_PROGRESS_RETRY_BUDGET; index += 1) {
    assert.equal(cursor.action, 'continue');
    assert.equal(cursor.reason, 'retry_available');
    cursor = observe(cursor.state, attemptClass);
  }
  assert.equal(cursor.state.retriesRemaining, 0);
  return cursor;
}

test('one grounded lookup with an exact action path receives one clean recovery', () => {
  const initial = initializeNoProgressGovernor({
    taskKey: 'accepted:invite',
    authority: snapshot({ operation: ['operation:create'], account: ['account:current'] }),
  });

  const decision = observe(initial, 'dependency_lookup');
  assert.equal(decision.action, 'continue');
  assert.equal(decision.reason, 'retry_available');
  assert.equal(decision.state.retriesRemaining, NO_PROGRESS_RETRY_BUDGET - 1);
  assert.equal(decision.state.noProgressAttempts, 1);
});

test('the lookup after the retry budget is spent terminalizes before another model call', () => {
  const initial = initializeNoProgressGovernor({
    taskKey: 'accepted:lookup-loop',
    authority: snapshot({ operation: ['operation:exact'], account: ['account:exact'] }),
  });
  const spent = exhaust(initial, 'dependency_lookup');
  const second = observe(spent.state, 'authority_acquisition');

  assert.deepEqual(second, {
    action: 'terminalize',
    reason: 'control_no_progress_exhausted',
    gained: [],
    owner: 'host_terminal_reducer',
    requiredProjection: 'factual_internal_failure',
    publicResumable: false,
    blockedAttemptClass: 'authority_acquisition',
    consequentialEffectState: 'not_started',
    resumeOn: ['authority_progress', 'user_input'],
    state: {
      version: 2,
      taskKey: 'accepted:lookup-loop',
      authority: snapshot({ operation: ['operation:exact'], account: ['account:exact'] }),
      noProgressAttempts: NO_PROGRESS_RETRY_BUDGET + 1,
      retriesRemaining: 0,
      seenConsequenceKeys: [],
      lastConsequence: null,
      stageTransitionsRemaining: NO_PROGRESS_STAGE_TRANSITION_BUDGET,
      observations: NO_PROGRESS_RETRY_BUDGET + 1,
    },
  });
});

test('varying discovery, lookup, plan, and refusal classes cannot mint progress', () => {
  const initial = initializeNoProgressGovernor({
    taskKey: 'accepted:varied-loop',
    authority: EMPTY,
  });
  const first = exhaust(initial, 'authority_acquisition');
  const second = observe(first.state, 'plan_admission');
  assert.equal(second.action, 'terminalize');

  const repairedInitial = initializeNoProgressGovernor({
    taskKey: 'accepted:varied-repair-loop',
    authority: EMPTY,
  });
  const repair = exhaust(repairedInitial, 'zero_crossing_repair');
  const lookup = observe(repair.state, 'dependency_lookup');
  assert.equal(lookup.action, 'terminalize');
});

test('provider repair is bounded, and alternative authority resets it without widening task work', () => {
  const initial = initializeNoProgressGovernor({
    taskKey: 'accepted:provider-invalid-arguments',
    authority: EMPTY,
  });
  const consequence = createNoProgressConsequence({
    stage: 'execution:invalid_arguments',
    recovery: 'repair_model',
    effectState: 'known_terminal',
    recoveryToolNames: ['work_call', 'tool_search'],
  });
  const first = observeNoProgress(initial, {
    taskKey: initial.taskKey,
    attemptClass: 'provider_repair',
    authority: EMPTY,
    consequence,
  });
  assert.equal(first.action, 'continue');
  assert.equal(first.reason, 'retry_available');
  assert.deepEqual(first.state.lastConsequence?.recoveryToolNames, ['tool_search', 'work_call']);

  const repeated = observeNoProgress(first.state, {
    taskKey: initial.taskKey,
    attemptClass: 'provider_repair',
    authority: EMPTY,
    consequence,
  });
  assert.equal(repeated.action, 'terminalize', 'the same provider failure cannot loop');
  assert.equal(repeated.blockedAttemptClass, 'provider_repair');
  assert.equal(repeated.consequentialEffectState, 'known_terminal');

  const discovered = observeNoProgress(first.state, {
    taskKey: initial.taskKey,
    attemptClass: 'authority_acquisition',
    authority: snapshot({ operation: ['capability:alternative-read'] }),
  });
  assert.equal(discovered.action, 'continue');
  assert.equal(discovered.reason, 'authority_progress');
  assert.deepEqual(discovered.gained, ['operation']);
  assert.equal(discovered.state.noProgressAttempts, 0);
  assert.equal(discovered.state.retriesRemaining, NO_PROGRESS_RETRY_BUDGET);
  assert.deepEqual(discovered.state.seenConsequenceKeys, []);
  assert.equal(discovered.state.lastConsequence, null);
});

for (const kind of ['operation', 'account', 'target', 'evidence', 'effect'] as const) {
  test(`new exact ${kind} authority resets the retry budget`, () => {
    const initial = initializeNoProgressGovernor({
      taskKey: `accepted:progress:${kind}`,
      authority: EMPTY,
    });
    const miss = exhaust(initial, 'dependency_lookup');
    assert.equal(miss.state.retriesRemaining, 0);

    const progress = observe(
      miss.state,
      'dependency_lookup',
      snapshot({ [kind]: [`${kind}:one`] }),
    );
    assert.equal(progress.action, 'continue');
    assert.equal(progress.reason, 'authority_progress');
    assert.deepEqual(progress.gained, [kind]);
    assert.equal(progress.state.noProgressAttempts, 0);
    assert.equal(progress.state.retriesRemaining, NO_PROGRESS_RETRY_BUDGET);

    const nextMiss = observe(progress.state, 'plan_admission');
    assert.equal(nextMiss.action, 'continue');
    assert.equal(nextMiss.reason, 'retry_available');
  });
}

test('a mixed frame that gains multiple authority dimensions reports each once', () => {
  const initial = initializeNoProgressGovernor({
    taskKey: 'accepted:mixed-progress',
    authority: EMPTY,
  });
  const decision = observe(initial, 'authority_acquisition', snapshot({
    operation: ['operation:one', 'operation:one'],
    account: ['account:one'],
    target: ['target:one'],
  }));

  assert.equal(decision.action, 'continue');
  assert.deepEqual(decision.gained, ['operation', 'account', 'target']);
  assert.deepEqual(decision.state.authority.operation, ['operation:one']);
});

test('snapshot ordering and duplicate event projections do not count as work', () => {
  const initial = initializeNoProgressGovernor({
    taskKey: 'accepted:canonical-set',
    authority: snapshot({ evidence: ['evidence:b', 'evidence:a'] }),
  });
  assert.deepEqual(initial.authority.evidence, ['evidence:a', 'evidence:b']);

  const first = observe(initial, 'dependency_lookup', snapshot({
    evidence: ['evidence:b', 'evidence:a', 'evidence:a'],
  }));
  assert.equal(first.reason, 'retry_available');
  let cursor = first;
  for (let index = 1; index < NO_PROGRESS_RETRY_BUDGET; index += 1) {
    cursor = observe(cursor.state, 'dependency_lookup', snapshot({
      evidence: ['evidence:a', 'evidence:b', 'evidence:b'],
    }));
    assert.equal(cursor.reason, 'retry_available');
  }
  const second = observe(cursor.state, 'dependency_lookup', snapshot({
    evidence: ['evidence:a', 'evidence:b'],
  }));
  assert.equal(second.action, 'terminalize');
});

test('task work and terminal projection never spend the no-progress retry', () => {
  const initial = initializeNoProgressGovernor({
    taskKey: 'accepted:real-work',
    authority: EMPTY,
  });
  const work = observe(initial, 'task_work');
  assert.equal(work.reason, 'unmetered_attempt');
  assert.equal(work.state.retriesRemaining, NO_PROGRESS_RETRY_BUDGET);
  assert.equal(work.state.noProgressAttempts, 0);

  const terminal = observe(work.state, 'terminal_projection');
  assert.equal(terminal.reason, 'unmetered_attempt');
  assert.equal(terminal.state.retriesRemaining, NO_PROGRESS_RETRY_BUDGET);
  assert.equal(terminal.state.noProgressAttempts, 0);
});

test('task work still resets a previously spent retry when it earns evidence', () => {
  const initial = initializeNoProgressGovernor({
    taskKey: 'accepted:work-progress',
    authority: EMPTY,
  });
  const miss = exhaust(initial, 'authority_acquisition');
  const work = observe(miss.state, 'task_work', snapshot({ evidence: ['receipt:read:one'] }));

  assert.equal(work.reason, 'authority_progress');
  assert.deepEqual(work.gained, ['evidence']);
  assert.equal(work.state.retriesRemaining, NO_PROGRESS_RETRY_BUDGET);
  assert.equal(work.state.noProgressAttempts, 0);
});

test('the same opaque identity in different authority dimensions is distinct progress', () => {
  const initial = initializeNoProgressGovernor({
    taskKey: 'accepted:typed-identities',
    authority: snapshot({ operation: ['digest:one'] }),
  });
  const decision = observe(initial, 'dependency_lookup', snapshot({
    operation: ['digest:one'],
    target: ['digest:one'],
  }));
  assert.equal(decision.reason, 'authority_progress');
  assert.deepEqual(decision.gained, ['target']);
});

test('state is immutable and observations cannot cross accepted tasks', () => {
  const initial = initializeNoProgressGovernor({
    taskKey: 'accepted:one',
    authority: EMPTY,
  });
  assert.ok(Object.isFrozen(initial));
  assert.ok(Object.isFrozen(initial.authority));

  assert.throws(
    () => observeNoProgress(initial, {
      taskKey: 'accepted:two',
      attemptClass: 'authority_acquisition',
      authority: EMPTY,
    }),
    /different accepted task/i,
  );
});

test('serialized state cannot restore a spent retry on approval resume', () => {
  const initial = initializeNoProgressGovernor({
    taskKey: 'accepted:resume',
    authority: EMPTY,
  });
  const spent = exhaust(initial, 'dependency_lookup').state;
  assert.deepEqual(parseNoProgressGovernorState(JSON.parse(JSON.stringify(spent))), spent);
  assert.equal(parseNoProgressGovernorState({
    ...spent,
    retriesRemaining: NO_PROGRESS_RETRY_BUDGET,
  }), null, 'a recorded miss cannot restore the full budget');
  assert.equal(parseNoProgressGovernorState({
    ...spent,
    retriesRemaining: NO_PROGRESS_RETRY_BUDGET + 1,
  }), null);
  assert.equal(parseNoProgressGovernorState({
    ...spent,
    noProgressAttempts: 0,
  }), null);
});

test('authority snapshots reject empty tokens instead of treating absence as progress', () => {
  assert.throws(
    () => normalizeAuthorityProgressSnapshot(snapshot({ operation: [' '] })),
    /non-empty operation authority token/i,
  );
});

test('unknown attempt classes fail closed instead of becoming unmetered work', () => {
  const initial = initializeNoProgressGovernor({
    taskKey: 'accepted:unknown-class',
    authority: EMPTY,
  });
  assert.throws(
    () => observeNoProgress(initial, {
      taskKey: initial.taskKey,
      attemptClass: 'invented_class' as NoProgressAttemptClass,
      authority: EMPTY,
    }),
    /unknown attempt class/i,
  );
});

test('host-validated schema to semantic admission is bounded acyclic progress', () => {
  const initial = initializeNoProgressGovernor({
    taskKey: 'accepted:typed-repair-stages',
    authority: snapshot({ operation: ['operation:calendar'], account: ['account:acme'] }),
  });
  const schema = createNoProgressConsequence({
    stage: 'schema_invalid',
    recovery: 'repair_model',
    effectState: 'not_started',
    recoveryToolNames: ['plan_task'],
  });
  const semantic = createNoProgressConsequence({
    stage: 'semantic_admission:destination_identity',
    recovery: 'retry_host',
    effectState: 'not_started',
    recoveryToolNames: ['plan_task'],
  });
  const execution = createNoProgressConsequence({
    stage: 'execution:invalid_arguments',
    recovery: 'repair_model',
    effectState: 'not_started',
    recoveryToolNames: ['work_call'],
  });

  const first = observeNoProgress(initial, {
    taskKey: initial.taskKey,
    attemptClass: 'plan_admission',
    authority: initial.authority,
    consequence: schema,
  });
  assert.equal(first.action, 'continue');
  assert.equal(first.reason, 'retry_available');

  const second = observeNoProgress(first.state, {
    taskKey: initial.taskKey,
    attemptClass: 'plan_admission',
    authority: initial.authority,
    consequence: semantic,
  });
  assert.equal(second.action, 'recover');
  assert.equal(second.reason, 'host_recovery_available');
  assert.equal(second.state.lastConsequence?.key, semantic.key);

  const third = observeNoProgress(second.state, {
    taskKey: initial.taskKey,
    attemptClass: 'zero_crossing_repair',
    authority: initial.authority,
    consequence: execution,
  });
  assert.equal(third.action, 'continue');
  assert.equal(third.reason, 'consequence_progress');
  // The clean retry absorbed the first stage; each later distinct stage spends
  // one transition of the budget (2026-09-01: raised so a converging repair
  // sequence is bounded by the budget, not killed at its third distinct stage).
  assert.equal(third.state.stageTransitionsRemaining, NO_PROGRESS_STAGE_TRANSITION_BUDGET - 2);
  assert.deepEqual(
    parseNoProgressGovernorState(JSON.parse(JSON.stringify(third.state))),
    third.state,
  );
  // Every further DISTINCT consequence is bounded progress until the budget is
  // spent; the one after that terminalizes. (A repeated key terminalizes at
  // once — pinned separately — so this bounds convergence, not loops.)
  let cursor = third;
  let remaining = third.state.stageTransitionsRemaining;
  let ordinal = 0;
  while (remaining > 0) {
    ordinal += 1;
    const distinct = createNoProgressConsequence({
      stage: `execution:transient:${ordinal}`,
      recovery: 'repair_model',
      effectState: 'known_terminal',
      recoveryToolNames: ['work_call'],
    });
    cursor = observeNoProgress(cursor.state, {
      taskKey: initial.taskKey,
      attemptClass: 'zero_crossing_repair',
      authority: initial.authority,
      consequence: distinct,
    });
    assert.equal(cursor.action, 'continue', `distinct stage ${ordinal} within the budget continues`);
    remaining = cursor.state.stageTransitionsRemaining;
  }
  const beyondBudget = createNoProgressConsequence({
    stage: 'execution:transient:beyond',
    recovery: 'repair_model',
    effectState: 'known_terminal',
    recoveryToolNames: ['work_call'],
  });
  const stopped = observeNoProgress(cursor.state, {
    taskKey: initial.taskKey,
    attemptClass: 'zero_crossing_repair',
    authority: initial.authority,
    consequence: beyondBudget,
  });
  assert.equal(stopped.action, 'terminalize');
  assert.deepEqual(
    parseNoProgressGovernorState(JSON.parse(JSON.stringify(stopped.state))),
    stopped.state,
  );
});

test('a typed repair consequence still reaches the model after one untyped lookup spent the clean retry', () => {
  const initial = initializeNoProgressGovernor({
    taskKey: 'accepted:landed-read-recall-repair',
    authority: snapshot({ operation: ['operation:calendar-read'] }),
  });
  const lookup = exhaust(initial, 'dependency_lookup');
  assert.equal(lookup.reason, 'retry_available');
  assert.equal(lookup.state.retriesRemaining, 0);
  assert.equal(lookup.state.lastConsequence, null);

  const schema = createNoProgressConsequence({
    stage: 'schema_invalid',
    recovery: 'repair_model',
    effectState: 'not_started',
    recoveryToolNames: ['plan_task'],
  });
  const repair = observeNoProgress(lookup.state, {
    taskKey: initial.taskKey,
    attemptClass: 'plan_admission',
    authority: initial.authority,
    consequence: schema,
  });
  assert.equal(repair.action, 'continue',
    'a new host-typed consequence is bounded structural progress, not another untyped lookup');
  assert.equal(repair.reason, 'consequence_progress');
  assert.equal(repair.state.lastConsequence?.key, schema.key);

  const repeated = observeNoProgress(repair.state, {
    taskKey: initial.taskKey,
    attemptClass: 'plan_admission',
    authority: initial.authority,
    consequence: schema,
  });
  assert.equal(repeated.action, 'terminalize',
    'the exact same typed repair still stops without another model loop');
});

test('the same host consequence repeats once then stops without user-owned projection', () => {
  const initial = initializeNoProgressGovernor({ taskKey: 'accepted:same-stage', authority: EMPTY });
  const consequence = createNoProgressConsequence({
    stage: 'schema_invalid',
    recovery: 'repair_model',
    effectState: 'not_started',
    recoveryToolNames: ['work_call'],
  });
  const first = observeNoProgress(initial, {
    taskKey: initial.taskKey,
    attemptClass: 'zero_crossing_repair',
    authority: EMPTY,
    consequence,
  });
  const second = observeNoProgress(first.state, {
    taskKey: initial.taskKey,
    attemptClass: 'zero_crossing_repair',
    authority: EMPTY,
    consequence,
  });
  assert.equal(second.action, 'terminalize');
  assert.equal(second.reason, 'control_no_progress_exhausted');
  assert.equal(second.publicResumable, false);
  assert.equal(second.requiredProjection, 'factual_internal_failure');
});

test('an A to B to A repair cycle stops even while distinct stages remain available', () => {
  const initial = initializeNoProgressGovernor({ taskKey: 'accepted:cycle', authority: EMPTY });
  const a = createNoProgressConsequence({
    stage: 'schema_invalid', recovery: 'repair_model', effectState: 'not_started',
  });
  const b = createNoProgressConsequence({
    stage: 'semantic_refusal', recovery: 'repair_model', effectState: 'not_started',
  });
  const first = observeNoProgress(initial, {
    taskKey: initial.taskKey, attemptClass: 'plan_admission', authority: EMPTY, consequence: a,
  });
  const second = observeNoProgress(first.state, {
    taskKey: initial.taskKey, attemptClass: 'plan_admission', authority: EMPTY, consequence: b,
  });
  assert.equal(second.action, 'continue');
  const third = observeNoProgress(second.state, {
    taskKey: initial.taskKey, attemptClass: 'plan_admission', authority: EMPTY, consequence: a,
  });
  assert.equal(third.action, 'terminalize');
});

test('unknown effect always transfers to reconciliation instead of repair', () => {
  const initial = initializeNoProgressGovernor({ taskKey: 'accepted:unknown-effect', authority: EMPTY });
  const uncertain = createNoProgressConsequence({
    stage: 'uncertain_write',
    recovery: 'reconcile',
    effectState: 'unknown',
  });
  const decision = observeNoProgress(initial, {
    taskKey: initial.taskKey,
    attemptClass: 'zero_crossing_repair',
    authority: EMPTY,
    consequence: uncertain,
  });
  assert.equal(decision.action, 'reconcile');
  assert.equal(decision.reason, 'effect_reconciliation_required');
});

test('a known terminal result gets one factual response step but cannot repeat', () => {
  const initial = initializeNoProgressGovernor({ taskKey: 'accepted:factual-stop', authority: EMPTY });
  const factual = createNoProgressConsequence({
    stage: 'execution:policy_denial',
    recovery: 'stop_factual',
    effectState: 'not_started',
  });
  const first = observeNoProgress(initial, {
    taskKey: initial.taskKey,
    attemptClass: 'zero_crossing_repair',
    authority: EMPTY,
    consequence: factual,
  });
  assert.equal(first.action, 'continue');
  assert.equal(first.reason, 'retry_available');
  const repeated = observeNoProgress(first.state, {
    taskKey: initial.taskKey,
    attemptClass: 'zero_crossing_repair',
    authority: EMPTY,
    consequence: factual,
  });
  assert.equal(repeated.action, 'terminalize');
  assert.equal(repeated.publicResumable, false);
});

test('only a typed exact user question selects the ask-user recovery lane', () => {
  const initial = initializeNoProgressGovernor({ taskKey: 'accepted:user-slot', authority: EMPTY });
  const exact = createNoProgressConsequence({
    stage: 'input_required:account_selection',
    recovery: 'ask_user',
    effectState: 'not_started',
    userInput: {
      question: 'Which connected account should I use?',
      choices: ['owner@acme.example', 'owner@personal.example'],
      purpose: 'clarification',
    },
  });
  const decision = observeNoProgress(initial, {
    taskKey: initial.taskKey,
    attemptClass: 'plan_admission',
    authority: EMPTY,
    consequence: exact,
  });
  assert.equal(decision.action, 'continue');
  assert.equal(decision.reason, 'user_input_required');
  assert.deepEqual(decision.state.lastConsequence?.userInput, exact.userInput);
  assert.throws(() => createNoProgressConsequence({
    stage: 'input_required:untyped',
    recovery: 'ask_user',
    effectState: 'not_started',
  }), /exact user input/i);
});

test('ask-user call authority fixes question, option order, purpose, and key set', () => {
  const userInput = {
    question: 'Which connected account should I use?',
    choices: ['Acme', 'Personal'],
    purpose: 'clarification' as const,
  };
  const canonical = canonicalNoProgressAskArguments(userInput);
  assert.deepEqual(canonical, {
    question: userInput.question,
    options: userInput.choices,
    purpose: 'clarification',
  });
  assert.equal(isCanonicalNoProgressAskArguments(canonical, userInput), true);
  assert.equal(isCanonicalNoProgressAskArguments({
    ...canonical, question: 'Which account?',
  }, userInput), false);
  assert.equal(isCanonicalNoProgressAskArguments({
    ...canonical, options: [...userInput.choices].reverse(),
  }, userInput), false);
  assert.equal(isCanonicalNoProgressAskArguments({
    ...canonical, purpose: 'approval',
  }, userInput), false);
  assert.equal(isCanonicalNoProgressAskArguments({
    ...canonical, extra: true,
  }, userInput), false);
});
