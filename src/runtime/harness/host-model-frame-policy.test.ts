import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyHostModelFrame,
  type HostModelFrameCall,
} from './host-model-frame-policy.js';

function plan(callId = 'plan'): HostModelFrameCall {
  return {
    callId,
    name: 'plan_task',
    argumentsJson: '{}',
    effectiveName: 'plan_task',
    effect: 'host_only',
    proposalFreeWorkCarrier: false,
    argumentsValue: {
      preamble: 'I’ll collect the records and create the artifact.',
      draft: {
        operations: [
          { id: 'read_source', effect: 'read', dependsOn: [] },
          { id: 'write_once', effect: 'external_write', dependsOn: ['read_source'] },
        ],
      },
    },
  };
}

function work(input: Partial<HostModelFrameCall> = {}): HostModelFrameCall {
  return {
    callId: 'read',
    name: 'work_call',
    argumentsJson: '{}',
    effectiveName: 'RESTAURANTS_SEARCH',
    effect: 'read',
    proposalFreeWorkCarrier: true,
    argumentsValue: {
      requirement_id: 'read_source',
      universe_item_id: null,
      universe_selector: null,
      name: 'composio_execute_tool',
      args_json: '{}',
    },
    ...input,
  };
}

test('fresh plan frame admits only standalone or one exact proposal-free dependency-root read', () => {
  assert.equal(classifyHostModelFrame({ calls: [plan()], planActivated: false, allowFreshPlanReadFusion: true }).kind,
    'standalone_control');
  assert.deepEqual(classifyHostModelFrame({ calls: [plan(), work()], planActivated: false, allowFreshPlanReadFusion: true }), {
    kind: 'fresh_plan_then_root_read',
    plan: plan(),
    sibling: work(),
    prePlanEffect: 'read',
    requirementId: 'read_source',
  });
});

test('fresh plan frame refuses every unsafe ordering, cardinality, carrier, effect, and carried-control shape', () => {
  const cases: Array<{
    label: string;
    calls: HostModelFrameCall[];
    reason: string;
  }> = [
    {
      label: 'plan not first',
      calls: [work(), plan()],
      reason: 'fresh_plan_must_be_first',
    },
    {
      label: 'more than one sibling',
      calls: [plan(), work(), work({ callId: 'read-2' })],
      reason: 'fresh_plan_allows_exactly_one_sibling',
    },
    {
      label: 'write sibling',
      calls: [plan(), work({ effect: 'external_write' })],
      reason: 'fresh_plan_sibling_must_be_read_compute',
    },
    {
      label: 'unknown sibling',
      calls: [plan(), work({ effect: 'unknown' })],
      reason: 'fresh_plan_sibling_must_be_read_compute',
    },
    {
      label: 'unmarked carrier',
      calls: [plan(), work({ proposalFreeWorkCarrier: false })],
      reason: 'fresh_plan_sibling_requires_proposal_free_work_carrier',
    },
    {
      label: 'dependent operation',
      calls: [plan(), work({
        argumentsValue: {
          requirement_id: 'write_once',
          name: 'composio_execute_tool',
          args_json: '{}',
        },
      })],
      reason: 'fresh_plan_sibling_requires_dependency_root',
    },
    {
      label: 'data-dependent operation',
      calls: [
        plan('plan-data-dependent'),
        work({
          argumentsValue: {
            requirement_id: 'read_source',
            name: 'composio_execute_tool',
            args_json: '{}',
          },
        }),
      ].map((call, index) => index === 0
        ? {
            ...call,
            argumentsValue: {
              ...call.argumentsValue,
              draft: {
                operations: [
                  { id: 'read_source', effect: 'read', dependsOn: [], dataFrom: ['upstream'] },
                ],
              },
            },
          }
        : call),
      reason: 'fresh_plan_sibling_requires_dependency_root',
    },
  ];
  for (const fixture of cases) {
    const result = classifyHostModelFrame({
      calls: fixture.calls,
      planActivated: false,
      allowFreshPlanReadFusion: true,
    });
    assert.deepEqual(result, { kind: 'refused', reason: fixture.reason }, fixture.label);
  }
});

test('proposal-free read/compute is ordinary without a graph while mutation and unknown stay plan-bound', () => {
  assert.deepEqual(classifyHostModelFrame({ calls: [work()], planActivated: false, allowFreshPlanReadFusion: true }), {
    kind: 'ordinary',
  });
  assert.deepEqual(classifyHostModelFrame({
    calls: [work({ effect: 'compute' })],
    planActivated: false,
    allowFreshPlanReadFusion: true,
  }), {
    kind: 'ordinary',
  });
  for (const effect of ['local_write', 'external_write', 'admin', 'unknown'] as const) {
    assert.deepEqual(classifyHostModelFrame({
      calls: [work({ effect })],
      planActivated: false,
      allowFreshPlanReadFusion: true,
    }), {
      kind: 'refused',
      reason: 'host_planned_work_call_requires_plan_sibling',
    }, effect);
  }
  assert.deepEqual(classifyHostModelFrame({ calls: [work()], planActivated: true, allowFreshPlanReadFusion: true }), {
    kind: 'ordinary',
  });
  assert.deepEqual(classifyHostModelFrame({ calls: [plan()], planActivated: true, allowFreshPlanReadFusion: true }), {
    kind: 'refused',
    reason: 'fresh_plan_already_activated',
  });
});

test('sole once-mutation stays eligible when strict materialization injects null lineage keys (8810)', () => {
  // Strict schema materialization emits every required+nullable key of the
  // host-planned work_call transport as JSON null before this policy runs.
  // Live 2026-08-31: two new lineage keys arrived as nulls, the field mirror
  // lacked them, and every sole Workspace write was refused
  // host_planned_work_call_requires_plan_sibling until the governor
  // terminalized the turn.
  const materialized = (overrides: Record<string, unknown> = {}): HostModelFrameCall => work({
    callId: 'save',
    effectiveName: 'space_save',
    effect: 'local_write',
    argumentsValue: {
      requirement_id: 'cap:local:space_save:reversible',
      universe_item_id: null,
      universe_selector: null,
      seal_amendment: null,
      source_call_ids: null,
      source_record_ids: null,
      name: 'space_save',
      args_json: '{"slug":"proof","title":"Proof"}',
      ...overrides,
    },
  });
  assert.deepEqual(
    classifyHostModelFrame({ calls: [materialized()], planActivated: false, allowFreshPlanReadFusion: true }),
    {
      kind: 'host_owned_single_action_plan',
      call: materialized(),
      requirementId: 'cap:local:space_save:reversible',
      effect: 'local_write',
    },
  );
  // Non-null lineage means the call depends on settled work; the sole-action
  // lane never compiles a dependent write.
  for (const lineage of [
    { source_call_ids: ['call_1'] },
    { source_record_ids: ['https://example.test/a'] },
  ]) {
    assert.deepEqual(
      classifyHostModelFrame({ calls: [materialized(lineage)], planActivated: false, allowFreshPlanReadFusion: true }),
      { kind: 'refused', reason: 'host_planned_work_call_requires_plan_sibling' },
      JSON.stringify(lineage),
    );
  }
});


test('a proposal-free work_call whose inner operation cannot be identified is refused as malformed, never as "requires a plan sibling"', () => {
  // Live 2026-09-01: GLM 5.3 called work_call → composio_execute_tool with
  // {channel, limit} as args_json — no tool_slug, no arguments wrapper — for
  // a proven Slack READ. The unwrap yields no effective name and effect
  // unknown; "requires plan sibling" was a wrong diagnosis with no door.
  assert.deepEqual(classifyHostModelFrame({
    calls: [work({ effectiveName: null, effect: 'unknown', argumentsValue: { name: 'composio_execute_tool', args_json: '{"channel":"C0BL9LLUSBD","limit":5}' } })],
    planActivated: false,
    allowFreshPlanReadFusion: true,
  }), { kind: 'refused', reason: 'host_work_call_inner_operation_unidentified' });
  // An identified-but-unknown effect (the operation is named, its effect is
  // not provable) is still the plan-bound mutation case.
  assert.deepEqual(classifyHostModelFrame({
    calls: [work({ effectiveName: 'SOME_PROVIDER_ACTION', effect: 'unknown' })],
    planActivated: false,
    allowFreshPlanReadFusion: true,
  }), { kind: 'refused', reason: 'host_planned_work_call_requires_plan_sibling' });
});

// A carried control is that control. The policy used to refuse a frame whose
// direct name was ordinary but whose effective name was a control, while
// computing that effective identity one line above — so it discarded a plan it
// had already understood. Three live runs on 2026-09-03 died there carrying a
// correct plan body. The standing gate is validate-before-write, not envelope
// shape.
test('a carried control is classified as that control, not refused', () => {
  const result = classifyHostModelFrame({
    calls: [work({ effectiveName: 'plan_task' })],
    planActivated: false,
    allowFreshPlanReadFusion: true,
  });
  assert.notEqual(result.kind, 'refused',
    'the host already resolved the effective identity; refusing discards it');
});
