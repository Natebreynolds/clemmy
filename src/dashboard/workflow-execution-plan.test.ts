import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflowExecutionPlan } from './workflow-execution-plan.js';

test('buildWorkflowExecutionPlan exposes DAG batches, critical path, fanout, gates, and tool surface', () => {
  const plan = buildWorkflowExecutionPlan([
    {
      id: 'fetch_crm',
      prompt: 'Fetch accounts from Salesforce.',
      call: { tool: 'SALESFORCE_GET_RECORDS', args: { objectName: 'Account' } },
      sideEffect: 'read',
      output: { type: 'array' },
    },
    {
      id: 'fetch_docs',
      prompt: 'Read local notes.',
      allowedTools: ['read_file'],
      sideEffect: 'read',
    },
    {
      id: 'process_each',
      prompt: 'Process each account.',
      dependsOn: ['fetch_crm'],
      forEach: 'fetch_crm',
      forEachNewOnly: true,
      intent: 'research',
      model: 'gpt-5-codex',
      output: { type: 'object', required_keys: ['summary'] },
    },
    {
      id: 'merge',
      prompt: 'Merge all evidence.',
      dependsOn: ['fetch_docs', 'process_each'],
      deterministic: { runner: 'merge.py' },
    },
    {
      id: 'send',
      prompt: 'Send the final email.',
      dependsOn: ['merge'],
      allowedTools: ['GMAIL_SEND_EMAIL', 'run_shell_command'],
      sideEffect: 'send',
      requiresApproval: true,
      approvalPreview: 'Send final report',
      usesSkill: 'outreach-writer',
    },
  ], {
    stepConcurrency: 3,
    runConcurrency: 2,
    forEachBatchSize: 50,
    workflowGoal: {
      objective: 'Deliver and send the final report.',
      successCriteria: ['Report contains CRM and local evidence.', 'Email is ready to send.'],
      maxAttempts: 3,
    },
    readiness: {
      availableTools: ['read_file', 'run_shell_command', 'composio_execute_tool'],
      installedSkills: ['outreach-writer'],
      workflowScripts: ['merge.py'],
    },
  });

  assert.equal(plan.stepCount, 5);
  assert.equal(plan.runner.stepConcurrency, 3);
  assert.equal(plan.runner.runConcurrency, 2);
  assert.equal(plan.runner.forEachBatchSize, 50);
  assert.deepEqual(plan.levels.map((level) => level.stepIds), [
    ['fetch_crm', 'fetch_docs'],
    ['process_each'],
    ['merge'],
    ['send'],
  ]);
  assert.equal(plan.maxParallelWidth, 2);
  assert.equal(plan.estimatedRounds, 4);
  assert.equal(plan.parallelSavings, 1);
  assert.deepEqual(plan.criticalPath, ['fetch_crm', 'process_each', 'merge', 'send']);
  assert.deepEqual(plan.fanout.map((row) => ({
    stepId: row.stepId,
    source: row.source,
    concurrency: row.concurrency,
    batchSize: row.batchSize,
    workerModel: row.workerModel,
    safeToResume: row.safeToResume,
  })), [{
    stepId: 'process_each',
    source: 'fetch_crm',
    concurrency: 3,
    batchSize: 50,
    workerModel: 'gpt-5-codex',
    safeToResume: true,
  }]);
  assert.equal(plan.modelSurface.portability, 'mixed');
  assert.equal(plan.modelSurface.portable, false);
  assert.equal(plan.modelSurface.modelSteps, 3);
  assert.equal(plan.modelSurface.nonModelSteps, 2);
  assert.equal(plan.modelSurface.defaultModelSteps, 2);
  assert.equal(plan.modelSurface.intentRoutedSteps, 0);
  assert.equal(plan.modelSurface.explicitModelSteps, 1);
  assert.deepEqual(plan.modelSurface.explicitModels, ['gpt-5-codex']);
  assert.deepEqual(plan.modelSurface.providers, ['codex']);
  assert.ok(plan.modelSurface.warnings.some((warning) => warning.includes('process_each') && warning.includes('gpt-5-codex')));
  assert.ok(plan.gates.some((gate) => gate.stepId === 'send' && gate.kind === 'approval'));
  assert.ok(plan.gates.some((gate) => gate.stepId === 'send' && gate.kind === 'grounding_judge'));
  assert.ok(plan.gates.some((gate) => gate.stepId === 'process_each' && gate.kind === 'output_contract'));
  assert.ok(plan.gates.some((gate) => gate.stepId === '(run goal)' && gate.kind === 'run_goal_judge' && gate.severity === 'block'));
  assert.deepEqual(plan.toolSurface.composioTools.sort(), ['GMAIL_SEND_EMAIL', 'SALESFORCE_GET_RECORDS']);
  assert.deepEqual(plan.toolSurface.localTools, ['read_file']);
  assert.deepEqual(plan.toolSurface.cliTools, ['run_shell_command']);
  assert.deepEqual(plan.toolSurface.deterministicRunners, ['merge.py']);
  assert.deepEqual(plan.toolSurface.skills, ['outreach-writer']);
  assert.equal(plan.toolReadiness.ready, false);
  assert.equal(plan.toolReadiness.missingCount, 0);
  assert.equal(plan.toolReadiness.unknownCount, 2);
  const readinessByName = new Map(plan.toolReadiness.items.map((item) => [item.name, item]));
  assert.equal(readinessByName.get('read_file')?.status, 'ready');
  assert.equal(readinessByName.get('run_shell_command')?.status, 'ready');
  assert.equal(readinessByName.get('merge.py')?.status, 'ready');
  assert.equal(readinessByName.get('outreach-writer')?.status, 'ready');
  assert.equal(readinessByName.get('SALESFORCE_GET_RECORDS')?.status, 'unknown');
  assert.equal(readinessByName.get('GMAIL_SEND_EMAIL')?.status, 'unknown');
  assert.deepEqual(readinessByName.get('SALESFORCE_GET_RECORDS')?.sources, ['step_call']);
  assert.ok(readinessByName.get('SALESFORCE_GET_RECORDS')?.evidence?.some((entry) => entry.kind === 'composio_broker' && entry.name === 'composio_execute_tool' && entry.status === 'ready'));
  assert.deepEqual(readinessByName.get('GMAIL_SEND_EMAIL')?.sources, ['step_allowed_tool']);
  assert.deepEqual(readinessByName.get('merge.py')?.sources, ['deterministic_runner']);
  assert.ok(readinessByName.get('merge.py')?.evidence?.some((entry) => entry.kind === 'script' && entry.name === 'merge.py' && entry.status === 'ready'));
  assert.deepEqual(readinessByName.get('outreach-writer')?.sources, ['uses_skill']);
  assert.ok(readinessByName.get('run_shell_command')?.evidence?.some((entry) => entry.kind === 'tool_catalog' && entry.status === 'ready'));
  assert.equal(plan.visualContract.status, 'attention');
  assert.equal(plan.visualContract.blockedCount, 0);
  assert.ok(plan.visualContract.warningCount >= 2);
  const contractByKind = new Map(plan.visualContract.checks.map((check) => [check.kind, check]));
  assert.equal(contractByKind.get('structure')?.status, 'pass');
  assert.equal(contractByKind.get('parallelism')?.status, 'pass');
  assert.equal(contractByKind.get('fanout')?.status, 'pass');
  assert.equal(contractByKind.get('judges')?.status, 'pass');
  assert.equal(contractByKind.get('tool_readiness')?.status, 'warn');
  assert.equal(contractByKind.get('model_portability')?.status, 'warn');
  assert.equal(contractByKind.get('recovery')?.status, 'pass');
  assert.ok(contractByKind.get('fanout')?.detail.includes('worker'));
  assert.ok(contractByKind.get('tool_readiness')?.stepIds.includes('fetch_crm'));
  const remediationByKind = new Map(plan.visualContract.remediations.map((fix) => [fix.kind, fix]));
  assert.equal(remediationByKind.get('make_models_portable')?.status, 'warn');
  assert.ok(remediationByKind.get('make_models_portable')?.stepIds.includes('process_each'));
  assert.ok(remediationByKind.get('make_models_portable')?.actions?.some((action) =>
    action.kind === 'apply_contract_fix' && action.safeToAutomate === true));
  assert.ok(plan.visualContract.remediations.some((fix) =>
    fix.kind === 'confirm_tool_connection'
    && fix.evidence.some((entry) => entry.includes('SALESFORCE_GET_RECORDS'))
    && fix.actions?.some((action) => action.kind === 'confirm_tool_connection' && action.command?.includes('composio search'))));
  assert.deepEqual(plan.issues, []);
});

test('buildWorkflowExecutionPlan preflights inherited tools, missing skills/scripts, MCP tools, and explicit CLIs', () => {
  const plan = buildWorkflowExecutionPlan([
    { id: 'draft', prompt: 'Draft from local files.' },
    { id: 'scrape', prompt: 'Scrape the source.', allowedTools: ['mcp__firecrawl__scrape'] },
    { id: 'ship', prompt: 'Open a PR.', allowedTools: ['cli:gh'] },
    { id: 'transform', prompt: 'Transform the payload.', deterministic: { runner: 'missing.py' } },
    { id: 'polish', prompt: 'Polish copy.', usesSkill: 'missing-skill' },
  ], {
    workflowAllowedTools: ['read_file'],
    readiness: {
      availableTools: ['read_file', 'mcp__firecrawl__scrape'],
      availableClis: ['gh'],
      installedSkills: [],
      workflowScripts: [],
      mcpServers: [{ name: 'firecrawl', slug: 'firecrawl', enabled: true, state: 'connected', toolCount: 1 }],
    },
  });

  assert.deepEqual(plan.toolSurface.localTools, ['read_file']);
  assert.deepEqual(plan.toolSurface.mcpTools, ['mcp__firecrawl__scrape']);
  assert.deepEqual(plan.toolSurface.cliTools, ['cli:gh']);
  assert.equal(plan.toolReadiness.ready, false);
  assert.equal(plan.toolReadiness.missingCount, 2);
  assert.equal(plan.toolReadiness.unknownCount, 0);
  const readinessByName = new Map(plan.toolReadiness.items.map((item) => [item.name, item]));
  assert.equal(readinessByName.get('read_file')?.status, 'ready');
  assert.deepEqual(readinessByName.get('read_file')?.stepIds, ['draft', 'polish']);
  assert.deepEqual(readinessByName.get('read_file')?.sources, ['workflow_allowed_tool']);
  assert.equal(readinessByName.get('mcp__firecrawl__scrape')?.status, 'ready');
  assert.equal(readinessByName.get('cli:gh')?.status, 'ready');
  assert.equal(readinessByName.get('missing.py')?.status, 'missing');
  assert.equal(readinessByName.get('missing-skill')?.status, 'missing');
  assert.deepEqual(readinessByName.get('mcp__firecrawl__scrape')?.sources, ['step_allowed_tool']);
  assert.ok(readinessByName.get('mcp__firecrawl__scrape')?.evidence?.some((entry) => entry.kind === 'tool_catalog' && entry.status === 'ready'));
  assert.deepEqual(readinessByName.get('cli:gh')?.sources, ['step_allowed_tool']);
  assert.ok(readinessByName.get('cli:gh')?.evidence?.some((entry) => entry.kind === 'cli_command' && entry.name === 'gh' && entry.status === 'ready'));
  assert.deepEqual(readinessByName.get('missing.py')?.sources, ['deterministic_runner']);
  assert.ok(readinessByName.get('missing.py')?.evidence?.some((entry) => entry.kind === 'script' && entry.status === 'missing'));
  assert.deepEqual(readinessByName.get('missing-skill')?.sources, ['uses_skill']);
  assert.equal(plan.modelSurface.portability, 'portable');
  assert.equal(plan.modelSurface.portable, true);
  assert.equal(plan.modelSurface.modelSteps, 4);
  assert.equal(plan.modelSurface.nonModelSteps, 1);
  assert.equal(plan.modelSurface.defaultModelSteps, 4);
  assert.equal(plan.modelSurface.explicitModelSteps, 0);
  assert.equal(plan.visualContract.status, 'blocked');
  assert.equal(plan.visualContract.checks.find((check) => check.kind === 'tool_readiness')?.status, 'block');
  assert.equal(plan.visualContract.checks.find((check) => check.kind === 'judges')?.status, 'pass');
  assert.ok(plan.visualContract.remediations.some((fix) =>
    fix.kind === 'add_workflow_script'
    && fix.status === 'block'
    && fix.stepIds.includes('transform')
    && fix.actions?.some((action) => action.kind === 'add_workflow_script')));
  assert.ok(plan.visualContract.remediations.some((fix) =>
    fix.kind === 'install_skill'
    && fix.status === 'block'
    && fix.stepIds.includes('polish')
    && fix.actions?.some((action) => action.kind === 'install_skill')));
});

test('buildWorkflowExecutionPlan preflights workflow and step local project requirements', () => {
  const plan = buildWorkflowExecutionPlan([
    { id: 'inspect_repo', prompt: 'Inspect the default repo.' },
    { id: 'patch_other', prompt: 'Patch the other repo.', project: 'missing-project', dependsOn: ['inspect_repo'] },
  ], {
    workflowProject: 'clementine-next',
    readiness: {
      availableTools: [],
      workspaceProjects: [
        { name: 'clementine-next', path: '/Users/tester/Developer/clementine-next', type: 'node' },
      ],
    },
  });

  assert.deepEqual(plan.toolSurface.projects, ['clementine-next', 'missing-project']);
  assert.equal(plan.toolReadiness.ready, false);
  assert.equal(plan.toolReadiness.missingCount, 1);
  assert.equal(plan.toolReadiness.unknownCount, 0);
  const readinessByName = new Map(plan.toolReadiness.items.map((item) => [item.name, item]));
  assert.equal(readinessByName.get('clementine-next')?.kind, 'project');
  assert.equal(readinessByName.get('clementine-next')?.status, 'ready');
  assert.deepEqual(readinessByName.get('clementine-next')?.stepIds, ['inspect_repo']);
  assert.deepEqual(readinessByName.get('clementine-next')?.sources, ['workflow_project']);
  assert.ok(readinessByName.get('clementine-next')?.evidence?.some((entry) => entry.kind === 'project' && entry.status === 'ready' && entry.detail?.includes('/Users/tester/Developer/clementine-next')));
  assert.equal(readinessByName.get('missing-project')?.status, 'missing');
  assert.deepEqual(readinessByName.get('missing-project')?.stepIds, ['patch_other']);
  assert.deepEqual(readinessByName.get('missing-project')?.sources, ['step_project']);
  assert.ok(readinessByName.get('missing-project')?.evidence?.some((entry) => entry.kind === 'project' && entry.status === 'missing'));
  assert.ok(plan.visualContract.remediations.some((fix) =>
    fix.kind === 'select_local_project'
    && fix.status === 'block'
    && fix.stepIds.includes('patch_other')
    && fix.actions?.some((action) => action.kind === 'select_local_project')));
});

test('buildWorkflowExecutionPlan reports missing dependencies and cycles', () => {
  const plan = buildWorkflowExecutionPlan([
    { id: 'a', prompt: 'A', dependsOn: ['b', 'missing'] },
    { id: 'b', prompt: 'B', dependsOn: ['a'] },
  ]);
  assert.ok(plan.issues.some((issue) => issue.includes('missing')));
  assert.ok(plan.issues.some((issue) => issue.includes('Dependency cycle')));
  assert.deepEqual(plan.levels, []);
  assert.equal(plan.visualContract.status, 'blocked');
  assert.equal(plan.visualContract.checks.find((check) => check.kind === 'structure')?.status, 'block');
  assert.equal(plan.visualContract.remediations.find((fix) => fix.kind === 'fix_graph_structure')?.status, 'block');
});

test('buildWorkflowExecutionPlan distinguishes default, intent-routed, exact-model, and direct-tool steps', () => {
  const plan = buildWorkflowExecutionPlan([
    { id: 'draft', prompt: 'Draft the memo.' },
    { id: 'design', prompt: 'Design the layout.', intent: 'design' },
    { id: 'judge', prompt: 'Judge the result.', model: 'claude-opus-4-8' },
    { id: 'lookup', prompt: 'Lookup account.', call: { tool: 'SALESFORCE_GET_RECORDS', args: {} } },
    { id: 'render', prompt: 'Render artifact.', deterministic: { runner: 'render.py' } },
  ]);

  assert.equal(plan.modelSurface.portability, 'mixed');
  assert.deepEqual(plan.modelSurface.intents, ['design']);
  assert.deepEqual(plan.modelSurface.explicitModels, ['claude-opus-4-8']);
  assert.deepEqual(plan.modelSurface.providers, ['claude']);
  assert.deepEqual(plan.modelSurface.routes.map((route) => ({
    stepId: route.stepId,
    binding: route.binding,
    provider: route.provider,
    portable: route.portable,
  })), [
    { stepId: 'draft', binding: 'default', provider: null, portable: true },
    { stepId: 'design', binding: 'intent', provider: null, portable: true },
    { stepId: 'judge', binding: 'explicit_model', provider: 'claude', portable: false },
    { stepId: 'lookup', binding: 'non_model', provider: null, portable: true },
    { stepId: 'render', binding: 'non_model', provider: null, portable: true },
  ]);
});
