import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  artifactBindingPresentation,
  buildRunEnvironmentHelpers,
  buildRunEnvironmentPlan,
  buildRunEnvironmentTools,
  chooseRunEnvironmentRun,
  collectRunEnvironmentReferences,
  elapsedLabel,
  isRunEnvironmentBackgroundable,
  isRunEnvironmentCancellable,
  runEnvironmentMetadata,
  runEnvironmentScopePresentation,
  runEnvironmentTasksHref,
  shouldReconcileRunEnvironmentDetail,
  type RunEnvironmentDetail,
} from './run-environment';

test('prefers the newest live run, then falls back to the newest recent run', () => {
  const recent = { id: 'recent', title: 'Recent', status: 'completed', updatedAt: '2026-07-16T12:02:00Z' };
  const live = { id: 'live', title: 'Live', status: 'running', updatedAt: '2026-07-16T12:01:00Z' };
  assert.equal(chooseRunEnvironmentRun([recent, live])?.id, 'live');
  assert.equal(chooseRunEnvironmentRun([recent])?.id, 'recent');
});

test('server control projection supports non-sess harness identifiers', () => {
  assert.equal(isRunEnvironmentCancellable({
    id: 'discord:channel:user',
    title: 'Discord run',
    status: 'running',
    canCancel: true,
    cancelEndpoint: '/api/console/harness-sessions/discord%3Achannel%3Auser/cancel',
  }), true);
  assert.equal(isRunEnvironmentCancellable({
    id: 'space-client-project', title: 'Finished', status: 'running', canCancel: false,
  }), false, 'server false overrides ambiguous ID/status heuristics');
  assert.equal(isRunEnvironmentCancellable({
    id: 'sess-guessed-only', title: 'No authority', status: 'running', canCancel: true,
  }), false, 'a boolean without an exact endpoint is not control authority');
  assert.equal(isRunEnvironmentBackgroundable({
    id: 'space-client-project',
    title: 'Workspace run',
    status: 'running',
    canBackground: true,
    backgroundEndpoint: '/api/console/harness-sessions/space-client-project/background?attemptId=a&runScopeId=s',
  }), true);
  assert.equal(isRunEnvironmentBackgroundable({
    id: 'space-client-project', title: 'Workspace run', status: 'running', canBackground: true,
  }), false, 'background also fails closed without exact server authority');
});

test('reconciles detail when the compact list reaches terminal state first', () => {
  assert.equal(shouldReconcileRunEnvironmentDetail(
    { status: 'completed' },
    { status: 'running' },
  ), true);
  assert.equal(shouldReconcileRunEnvironmentDetail(
    { status: 'running' },
    { status: 'running' },
  ), false);
  assert.equal(shouldReconcileRunEnvironmentDetail(
    { status: 'completed' },
    { status: 'completed' },
  ), false);
});

test('Tasks handoff carries exact canonical attempt and scope identity', () => {
  assert.equal(runEnvironmentTasksHref({
    id: 'discord:channel:user',
    runEnvironmentMeta: {
      attemptId: 'attempt:desktop:abc',
      runScopeId: 'discord:channel:user::brain:desktop:abc',
    },
  }), '/tasks?select=discord%3Achannel%3Auser&attemptId=attempt%3Adesktop%3Aabc&runScopeId=discord%3Achannel%3Auser%3A%3Abrain%3Adesktop%3Aabc');
  assert.equal(runEnvironmentTasksHref({ id: 'legacy-run' }), '/tasks?select=legacy-run');
});

test('mobile Environment dialog is viewport-contained and its actions can wrap', () => {
  const source = readFileSync(new URL('../components/RunEnvironmentPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /fixed inset-x-3 inset-y-3[^'\n]*min-w-0[^'\n]*max-w-\[calc\(100vw-24px\)\][^'\n]*overflow-hidden/);
  assert.match(source, /min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto/);
  assert.match(source, /w-full min-w-0 max-w-full rounded-md/);
  assert.match(source, /flex min-w-0 flex-wrap gap-2/);
  assert.match(source, /min-w-0 flex-1 basis-\[8rem\]/);
});

test('counts only canonical top-level calls and reports transport mirrors separately', () => {
  const run: RunEnvironmentDetail = {
    id: 'sess-one', title: 'One', status: 'running',
    events: [
      { type: 'tool_called', data: { tool: 'composio_execute_tool', slug: 'GOOGLEDOCS_CREATE_DOCUMENT', canonicalCallId: 'toolu_1', accounting: 'top_level' } },
      { type: 'tool_called', data: { tool: 'mcp-googledocs-create', canonicalCallId: 'toolu_1', accounting: 'transport_mirror' } },
      { type: 'tool_called', data: { tool: 'run_shell_command', canonicalCallId: 'toolu_2', accounting: 'top_level' } },
    ],
  };
  assert.deepEqual(buildRunEnvironmentTools(run), {
    names: ['GOOGLEDOCS_CREATE_DOCUMENT', 'run_shell_command'],
    countsByName: { GOOGLEDOCS_CREATE_DOCUMENT: 1, run_shell_command: 1 },
    logicalCount: 2,
    recordedCalls: 2,
    mirrorEvents: 1,
  });
});

test('prefers the compact scoped tool aggregate over the bounded event projection', () => {
  const run: RunEnvironmentDetail = {
    id: 'sess-compact', title: 'Compact', status: 'completed',
    toolSummary: {
      names: ['web_search', 'GOOGLEDOCS_CREATE_DOCUMENT'],
      countsByName: { web_search: 4, GOOGLEDOCS_CREATE_DOCUMENT: 1 },
      logicalCount: 5,
      recordedCalls: 5,
      mirrorEvents: 2,
    },
    // The compact environment projection omits ordinary tool events.
    events: [],
  };
  assert.deepEqual(buildRunEnvironmentTools(run), {
    names: ['web_search', 'GOOGLEDOCS_CREATE_DOCUMENT'],
    countsByName: { web_search: 4, GOOGLEDOCS_CREATE_DOCUMENT: 1 },
    logicalCount: 5,
    recordedCalls: 5,
    mirrorEvents: 2,
  });
});

test('describes the selected scope and bounded projection without implying full history', () => {
  const run: RunEnvironmentDetail = {
    id: 'sess-scope', title: 'Scope', status: 'running',
    runEnvironmentMeta: {
      scopeKind: 'current_attempt',
      auditEventsTotal: 43,
      projectionEventsReturned: 18,
      projectionEventsTotal: 25,
      projectionEventsOmitted: 7,
      artifactsReturned: 8,
      artifactsTotal: 11,
      artifactsOmitted: 3,
    },
  };
  assert.deepEqual(runEnvironmentScopePresentation(run), {
    label: 'current attempt',
    audit: '43 audit events in scope',
    projection: '18 of 25 structural events · 7 omitted',
    artifacts: '8 of 11 artifacts · 3 omitted',
  });
});

test('reports unavailable artifact coverage instead of an authoritative zero', () => {
  assert.equal(runEnvironmentScopePresentation({
    id: 'sess-artifact-db-error',
    title: 'Artifact lookup failed',
    status: 'running',
    runEnvironmentMeta: {
      artifactCoverageStatus: 'unavailable',
      artifactsTotal: 0,
      artifactsReturned: 0,
      artifactsOmitted: 0,
    },
  }).artifacts, 'unavailable');
});

test('never presents untagged legacy events as a canonical logical count', () => {
  const run: RunEnvironmentDetail = {
    id: 'legacy', title: 'Legacy', status: 'completed',
    events: [{ type: 'tool_called', data: { tool: 'read_file' } }],
  };
  const summary = buildRunEnvironmentTools(run);
  assert.equal(summary.logicalCount, null);
  assert.equal(summary.recordedCalls, 1);
});

test('folds plan steps and helpers into compact, current-state rows', () => {
  const run: RunEnvironmentDetail = {
    id: 'sess-plan', title: 'Plan', status: 'running',
    events: [
      { type: 'plan_drafted', data: { objective: 'Research once, create one document', stepCount: 2 } },
      { type: 'step_started', data: { step: 'Research the firm' } },
      { type: 'step_completed', data: { step: 'Research the firm' } },
      { type: 'step_started', data: { step: 'Create the document' } },
      { type: 'worker_started', data: { item: 'Source review', model: 'fast' } },
      { type: 'worker_result', data: { item: 'Source review', ok: true } },
    ],
  };
  assert.deepEqual(buildRunEnvironmentPlan(run), {
    objective: 'Research once, create one document',
    declaredCount: 2,
    recorded: true,
    steps: [
      { label: 'Research the firm', state: 'done' },
      { label: 'Create the document', state: 'running' },
    ],
  });
  assert.deepEqual(buildRunEnvironmentHelpers(run), [{
    key: 'Source review', label: 'Source review', state: 'done', meta: 'fast',
  }]);
});

test('labels telemetry-only URLs as observed references and computes terminal elapsed time', () => {
  const run: RunEnvironmentDetail = {
    id: 'sess-resources',
    title: 'Resources',
    status: 'completed',
    createdAt: '2026-07-16T12:00:00.000Z',
    completedAt: '2026-07-16T12:02:05.000Z',
    outputPreview: 'Draft at https://example.com/report and /Users/example/report.docx',
  };
  assert.deepEqual(collectRunEnvironmentReferences(run), {
    urls: ['https://example.com/report'],
    files: ['/Users/example/report.docx'],
  });
  assert.equal(elapsedLabel(run), '2m 05s');
});

test('environment metadata distinguishes recorded state from event-observed targets', () => {
  assert.deepEqual(runEnvironmentMetadata({
    id: 'sess-recorded-environment',
    title: 'Recorded environment',
    status: 'running',
    metadata: { workspacePath: '/workspace/clementine', gitBranch: 'feat/current', modelId: 'claude-sonnet' },
    events: [{
      type: 'tool_called',
      data: { args: { cwd: '/tmp/target', branch: 'release/target' }, model: 'worker-model' },
    }],
  }), {
    workspace: { value: '/workspace/clementine', provenance: 'recorded' },
    branch: { value: 'feat/current', provenance: 'recorded' },
    model: { value: 'claude-sonnet', provenance: 'recorded' },
  });

  assert.deepEqual(runEnvironmentMetadata({
    id: 'sess-observed-environment',
    title: 'Observed environment',
    status: 'running',
    events: [{
      type: 'tool_called',
      data: { args: { cwd: '/tmp/target', branch: 'release/target' }, model: 'worker-model' },
    }],
  }), {
    workspace: { value: '/tmp/target', provenance: 'observed' },
    branch: { value: 'release/target', provenance: 'observed' },
    model: { value: 'worker-model', provenance: 'observed' },
  });
});

test('computes elapsed time from the projected attempt instead of the reusable session', () => {
  const run: RunEnvironmentDetail = {
    id: 'sess-reused',
    title: 'Current request',
    status: 'completed',
    createdAt: '2026-07-16T10:00:00.000Z',
    completedAt: '2026-07-16T12:02:05.000Z',
    runEnvironmentMeta: {
      scopeStartedAt: '2026-07-16T12:00:00.000Z',
    },
  };

  assert.equal(elapsedLabel(run), '2m 05s');
});

test('artifact presentation distinguishes a parsed create pointer from provider read-back proof', () => {
  assert.deepEqual(artifactBindingPresentation({ status: 'bound', resourceId: 'doc-1' }), {
    meta: 'resource found · verification pending',
    state: 'warning',
  });
  assert.deepEqual(artifactBindingPresentation({
    status: 'bound', resourceId: 'doc-1', bindingVerifiedAt: '2026-07-16T12:03:00.000Z',
  }), {
    meta: 'provider verified',
    state: 'done',
  });
  assert.deepEqual(artifactBindingPresentation({ status: 'uncertain' }), {
    meta: 'outcome uncertain',
    state: 'warning',
  });
});
