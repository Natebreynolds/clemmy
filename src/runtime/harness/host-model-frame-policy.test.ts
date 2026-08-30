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
    {
      label: 'carried plan',
      calls: [work({ effectiveName: 'plan_task' })],
      reason: 'host_control_requires_direct_first_class_call',
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
