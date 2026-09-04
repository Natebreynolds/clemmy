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

test('identified proposal-free calls remain ordinary until the exact tool edge', () => {
  const materializedWrite = work({
    callId: 'write',
    effectiveName: 'GOOGLESHEETS_UPDATE_VALUES_BATCH',
    effect: 'external_write',
    argumentsValue: {
      requirement_id: 'cap:resolved:update-values',
      universe_item_id: null,
      universe_selector: null,
      seal_amendment: null,
      source_call_ids: null,
      source_record_ids: null,
      name: 'composio_execute_tool',
      args_json: '{"tool_slug":"GOOGLESHEETS_UPDATE_VALUES_BATCH","arguments":{}}',
    },
  });
  for (const call of [
    work(),
    work({ effect: 'compute' }),
    work({ effectiveName: 'LOCAL_WRITE_ACTION', effect: 'local_write' }),
    materializedWrite,
    work({
      effectiveName: 'EXTERNAL_WRITE_FROM_RESULT',
      effect: 'external_write',
      argumentsValue: {
        requirement_id: 'cap:resolved:external-write-from-result',
        universe_item_id: null,
        universe_selector: null,
        seal_amendment: null,
        source_call_ids: ['settled-read-call'],
        source_record_ids: null,
        name: 'business_tool',
        args_json: '{"record_id":"record-1"}',
      },
    }),
    work({ effectiveName: 'ADMIN_ACTION', effect: 'admin' }),
    work({ effectiveName: 'SOME_PROVIDER_ACTION', effect: 'unknown' }),
  ]) {
    assert.deepEqual(classifyHostModelFrame({
      calls: [call],
      planActivated: false,
      allowFreshPlanReadFusion: true,
    }), { kind: 'ordinary' }, call.effectiveName ?? 'unidentified');
  }

  assert.deepEqual(classifyHostModelFrame({
    calls: [work({ proposalFreeWorkCarrier: false })],
    planActivated: false,
    allowFreshPlanReadFusion: true,
  }), {
    kind: 'refused',
    reason: 'host_planned_work_call_requires_plan_sibling',
  }, 'an unmarked work_call lookalike retains no configured-tool provenance');

  assert.deepEqual(classifyHostModelFrame({
    calls: [plan()],
    planActivated: true,
    allowFreshPlanReadFusion: true,
  }), { kind: 'refused', reason: 'fresh_plan_already_activated' });
});

test('only an unidentified unknown proposal-free carrier is refused at frame classification', () => {
  assert.deepEqual(classifyHostModelFrame({
    calls: [work({
      effectiveName: null,
      effect: 'unknown',
      argumentsValue: {
        name: 'composio_execute_tool',
        args_json: '{"channel":"C0BL9LLUSBD","limit":5}',
      },
    })],
    planActivated: false,
    allowFreshPlanReadFusion: true,
  }), {
    kind: 'refused',
    reason: 'host_work_call_inner_operation_unidentified',
  });
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
