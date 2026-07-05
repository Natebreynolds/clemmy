import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderConsoleHtml } from './console.js';
import { upcomingWorkflowOccurrences } from './console-routes.js';

function workflow(name: string, schedule: string, enabled = true): any {
  return {
    name,
    layout: 'directory',
    data: {
      name,
      description: `${name} description`,
      enabled,
      trigger: schedule ? { manual: true, schedule } : { manual: true },
      steps: [{ id: 'step', prompt: 'Do the work.' }],
    },
  };
}

test('workflow home schedule aggregation omits disabled and malformed schedules', () => {
  const now = new Date(2026, 4, 28, 12, 0, 0);
  const occurrences = upcomingWorkflowOccurrences([
    workflow('daily-enabled', '30 12 * * *', true),
    workflow('weekday-enabled', '45 12 * * 1-5', true),
    workflow('disabled', '30 12 * * *', false),
    workflow('manual', '', true),
    workflow('malformed', 'not a cron', true),
  ], now, 1);
  const names = new Set(occurrences.map((item) => item.workflowName));
  assert.equal(names.has('daily-enabled'), true);
  assert.equal(names.has('weekday-enabled'), true);
  assert.equal(names.has('disabled'), false);
  assert.equal(names.has('manual'), false);
  assert.equal(names.has('malformed'), false);
});

test('workflow dashboard inline scripts compile and expose the home controls', () => {
  const html = renderConsoleHtml('test-token');
  assert.match(html, /data-wf-home/);
  assert.match(html, /Workflow home/);
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .filter((script) => script.trim());
  assert.ok(scripts.length >= 1);
  scripts.forEach((script, index) => {
    new vm.Script(script, { filename: `console-inline-${index}.js` });
  });
});

test('workflow dashboard exposes the run inspector + board cockpit controls', () => {
  const html = renderConsoleHtml('test-token');
  // Board entry point + view.
  assert.match(html, /data-wf-board/);
  assert.match(html, /Task board/);
  // The board consumes the never-before-fetched board + queue endpoints.
  assert.match(html, /\/api\/console\/board/);
  assert.match(html, /\/board\/run\//);
  // Run inspector open hook + its functions (proves the past-run event replay
  // path exists; the compile assertion above proves the script parses).
  assert.match(html, /data-wf-run-open/);
  assert.match(html, /openRunInspector/);
  assert.match(html, /buildRunInspectorModel/);
  assert.match(html, /\/graph-overlay/);
  assert.match(html, /RUN_GOAL_STEP_ID/);
  assert.match(html, /renderInspectorGoalCard/);
  assert.match(html, /RUN GOAL JUDGE/);
  assert.match(html, /data-wf-goal-open-run/);
  assert.match(html, /data-wf-goal-rerun/);
  assert.match(html, /resume-safe/);
  assert.match(html, /ATTEMPT LINEAGE/);
  assert.match(html, /wf-insp-goal-lineage/);
  assert.match(html, /RECOVERY LINEAGE/);
  assert.match(html, /data-wf-recovery-open-run/);
  assert.match(html, /wfRenderRecoveryLineageGraph/);
  assert.match(html, /recovery-run-node/);
  assert.match(html, /recovery-lineage-edge/);
  assert.match(html, /wfNodePlanLine/);
  assert.match(html, /wfExecutionPlanDrawer/);
  assert.match(html, /wf-graph-plan/);
  assert.match(html, /visualContract/);
  assert.match(html, /VISUAL CONTRACT/);
  assert.match(html, /wf-visual-contract/);
  assert.match(html, /RECOMMENDED FIXES/);
  assert.match(html, /data-wf-contract-fix-kind/);
  assert.match(html, /data-wf-contract-action-kind/);
  assert.match(html, /contract-fixes/);
  assert.match(html, /contract-actions/);
  assert.match(html, /handleWfContractFixAction/);
  assert.match(html, /handleWfContractManualAction/);
  assert.match(html, /wfCliCommandForContractAction/);
  assert.match(html, /Save this CLI command to the local runtime inventory/);
  assert.match(html, /maybeLaunchWfToolConnectionRepair/);
  assert.match(html, /wfLaunchToolConnectionAction/);
  assert.match(html, /toolConnectionChecks/);
  assert.match(html, /set_composio_api_key/);
  assert.match(html, /authorize_composio_toolkit/);
  assert.match(html, /set_mcp_credentials/);
  assert.match(html, /reconnect_mcp/);
  assert.match(html, /wfContractFixDrawer/);
  assert.match(html, /wfNodeContractLine/);
  assert.match(html, /contract-block/);
  assert.match(html, /wfNodeVerdictLine/);
  assert.match(html, /wfNodeVerdictDrawer/);
  assert.match(html, /wf-graph-verdict/);
  assert.match(html, /verdict-blocked/);
  assert.match(html, /has-plan-fanout/);
  assert.match(html, /model route/);
  assert.match(html, /openWfRecoveryRunDrawer/);
  assert.match(html, /handleWfRecoveryNodeAction/);
  assert.match(html, /data-wf-recovery-node-action/);
  assert.match(html, /FOCUS GRAPH/);
  assert.match(html, /OPEN SOURCE/);
  assert.match(html, /recovery_graph/);
  assert.match(html, /wfExecutionEfficiencyLine/);
  assert.match(html, /executionEfficiency/);
  assert.match(html, /execution-drift/);
  assert.match(html, /wfRunVerdictLine/);
  assert.match(html, /runVerdict/);
  assert.match(html, /run-verdict-proven/);
  assert.match(html, /fanout_underused/);
  assert.match(html, /optimize-rerun/);
  assert.match(html, /execution_optimize/);
  assert.match(html, /graph_execution_drift/);
  assert.match(html, /RE-RUN TO PLAN|RE-RUN FANOUT|RE-RUN CRITICAL PATH/);
  // Graph-node recovery actions reuse the safe run primitives from the drawer.
  assert.match(html, /data-wf-graph-action/);
  assert.match(html, /retry-failed-items/);
  assert.match(html, /wfGraphRecoveryActions/);
  assert.match(html, /handleWfGraphRecoveryAction/);
  assert.match(html, /wfRuntimeFailedTools/);
  assert.match(html, /repair-runtime-tool/);
  assert.match(html, /REPAIR TOOL/);
  // Inspector renders attempt records, judge/quality verdicts (step_advisory),
  // run summary, and per-step tokens — the full T4.2 event set.
  assert.match(html, /attempt_record/);
  assert.match(html, /step_advisory/);
  assert.match(html, /renderInspectorAdvisories/);
  assert.match(html, /run_summary/);
  assert.match(html, /inspStepTokens/);
});
