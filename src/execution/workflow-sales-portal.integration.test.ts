/**
 * Run:
 *   npx tsx --test src/execution/workflow-sales-portal.integration.test.ts
 *
 * Sanitized acceptance proof for the long-running end-of-month sales portal
 * shape. It deliberately drives the production workflow compiler, durable
 * workspace, graph scheduler, deterministic artifact runner, governed call
 * node, mutation receipt store, synthesis projection, and terminal publisher.
 * Model/provider boundaries are the only test doubles; no network is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-sales-portal-acceptance-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_WATCHER_JUDGE = 'off';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.CLEMMY_FAILURE_LEARNING = 'off';
process.env.WORKFLOW_USE_HARNESS = 'off';
process.env.CLEMMY_HARNESS_WORKFLOW = 'off';
process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';

// A provider SDK that ignores the injected harness test seam still cannot
// reach the network. This is principally a belt for the best-effort voice pass.
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error('network disabled by sales-portal acceptance fixture');
}) as typeof fetch;

const { readWorkflow, writeWorkflow } = await import('../memory/workflow-store.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const {
  _setWorkflowCallNodeForTests,
  _setWorkflowHarnessLoopImplsForTests,
  finalizeStepOutput,
  processWorkflowRuns,
  renderCallArgs,
} = await import('./workflow-runner.js');
const { appendWorkflowEvent, readWorkflowEvents } = await import('./workflow-events.js');
const {
  readWorkspaceManifest,
  runWorkspaceDir,
} = await import('./workflow-run-workspace.js');
const {
  compileWorkflowStepsToGraph,
  workflowSubgraphSpecialistNodeId,
  WORKFLOW_GRAPH_ALLOWED_TOOLS,
} = await import('./workflow-graph.js');
const { persistWorkflowGraphSnapshot } = await import('./workflow-graph-store.js');
const {
  executeWorkflowCallMutation,
  inspectWorkflowCallMutation,
} = await import('./workflow-call-receipts.js');

test.after(() => {
  _setWorkflowCallNodeForTests();
  _setWorkflowHarnessLoopImplsForTests();
  globalThis.fetch = realFetch;
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('end-of-month sales portal resumes, fans out three analysts, builds artifacts, and deploys once', async () => {
  const workflowSlug = 'sales-portal-sanitized-acceptance';
  const workflowName = 'Sanitized End-of-Month Sales Portal';
  const runId = 'sales-portal-sanitized-acceptance-run';
  const publicReport = 'July sales portal is live: 1,200 transactions analyzed across 4 regions; dashboard and API deployed to https://sales-portal.example.test.';
  const reducerResult = 'REDUCER-PUBLIC-SALES-MODEL: 1,200 transactions; 4 regions; use the verified regional, rep, and pipeline evidence.';
  const finalOpaqueTransactionId = 'txn-001199';
  const specialistIds = {
    trend: workflowSubgraphSpecialistNodeId('analyze_sales', 'trend'),
    rep: workflowSubgraphSpecialistNodeId('analyze_sales', 'rep_performance'),
    pipeline: workflowSubgraphSpecialistNodeId('analyze_sales', 'pipeline_risk'),
  };
  const expectedPortalDir = path.join(WORKFLOWS_DIR, workflowSlug, 'generated', runId);
  const expectedHtmlPath = path.join(expectedPortalDir, 'index.html');
  const expectedBackendPath = path.join(expectedPortalDir, 'server.mjs');

  const transactions = Array.from({ length: 1_200 }, (_, index) => ({
    id: `txn-${String(index).padStart(6, '0')}`,
    closedAt: `2026-07-${String((index % 28) + 1).padStart(2, '0')}T12:00:00.000Z`,
    rep: `rep-${String(index % 12).padStart(2, '0')}`,
    region: ['west', 'central', 'northeast', 'southeast'][index % 4],
    segment: ['commercial', 'enterprise', 'strategic'][index % 3],
    stage: index % 11 === 0 ? 'at-risk' : 'closed-won',
    revenue: 1_000 + ((index * 137) % 24_000),
    notes: `sanitized-eom-row-${String(index).padStart(4, '0')}-${'x'.repeat(44)}`,
  }));
  assert.equal(transactions.at(-1)?.id, finalOpaqueTransactionId);
  assert.ok(
    Buffer.byteLength(JSON.stringify({ transactions }), 'utf8') > 200 * 1024,
    'the fixture must be large enough to require a durable artifact reference',
  );

  const portalBuilderSource = `
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const payload = JSON.parse(raw);
const transactions = payload.stepOutputs.sales_input.transactions;
const targetDir = path.join(process.cwd(), 'generated', payload.runId);
mkdirSync(targetDir, { recursive: true });

const regionTotals = {};
const repTotals = {};
let totalRevenue = 0;
for (const row of transactions) {
  totalRevenue += row.revenue;
  regionTotals[row.region] = (regionTotals[row.region] || 0) + row.revenue;
  repTotals[row.rep] = (repTotals[row.rep] || 0) + row.revenue;
}
const salesModel = {
  period: '2026-07',
  transactionCount: transactions.length,
  totalRevenue,
  regionTotals,
  topReps: Object.entries(repTotals).sort((a, b) => b[1] - a[1]).slice(0, 5),
  analysis: payload.stepOutputs.analyze_sales,
};

const htmlPath = path.join(targetDir, 'index.html');
const backendPath = path.join(targetDir, 'server.mjs');
const dataPath = path.join(targetDir, 'sales.json');
const html = [
  '<!doctype html>',
  '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>Sanitized July Sales Portal</title>',
  '<style>body{font:16px system-ui;margin:2rem;max-width:960px}#regions{display:grid;grid-template-columns:repeat(2,1fr);gap:1rem}.card{padding:1rem;border:1px solid #ddd;border-radius:12px}</style></head>',
  '<body><h1>July sales summary</h1><p id="summary">Loading verified totals...</p><div id="regions"></div>',
  '<script>fetch("/api/sales").then(r=>r.json()).then(d=>{document.querySelector("#summary").textContent=d.transactionCount+" transactions · $"+d.totalRevenue.toLocaleString();document.querySelector("#regions").innerHTML=Object.entries(d.regionTotals).map(([k,v])=>"<div class=card><strong>"+k+"</strong><br>$"+v.toLocaleString()+"</div>").join("")})</script>',
  '</body></html>',
].join('\\n');
const server = [
  "import http from 'node:http';",
  "import { readFileSync } from 'node:fs';",
  "const port = Number(process.env.PORT || 3000);",
  "http.createServer((req,res)=>{const file=req.url==='/api/sales'?'sales.json':'index.html';const type=file.endsWith('.json')?'application/json':'text/html;res.writeHead(200,{'content-type':type});res.end(readFileSync(new URL('./'+file,import.meta.url)))}).listen(port);",
].join('\\n');

writeFileSync(htmlPath, html, 'utf8');
writeFileSync(backendPath, server, 'utf8');
writeFileSync(dataPath, JSON.stringify(salesModel, null, 2), 'utf8');
console.log(JSON.stringify({
  site_dir: targetDir,
  html_path: htmlPath,
  backend_path: backendPath,
  data_path: dataPath,
  transaction_count: transactions.length,
  total_revenue: totalRevenue,
}));
`;

  const authoredWorkflow = {
    name: workflowName,
    description: '',
    enabled: true,
    trigger: { manual: true as const, schedule: '0 7 1 * *', timezone: 'America/Los_Angeles' },
    goal: {
      objective: 'Build the sanitized end-of-month sales portal and its backend artifact.',
      successCriteria: [
        `The generated HTML exists at ${expectedHtmlPath}.`,
        `The generated backend exists at ${expectedBackendPath}.`,
      ],
      maxAttempts: 1,
    },
    steps: [
      {
        id: 'sales_input',
        prompt: 'Return the complete sanitized end-of-month sales transaction set.',
        sideEffect: 'read' as const,
        output: { type: 'object' as const, required_keys: ['transactions'], min_items: { transactions: 1 } },
      },
      {
        id: 'analyze_sales',
        prompt: 'Join the three private analyses into one compact, decision-ready sales model.',
        dependsOn: ['sales_input'],
        sideEffect: 'read' as const,
        subgraph: {
          mode: 'read_parallel_v1' as const,
          specialists: [
            { id: 'trend', prompt: 'Calculate month-end sales trends and regional movement from the exact artifact.' },
            { id: 'rep_performance', prompt: 'Rank representative performance and concentration from the exact artifact.' },
            { id: 'pipeline_risk', prompt: 'Audit at-risk pipeline and late-page anomalies from the exact artifact.' },
          ],
        },
      },
      {
        id: 'build_portal',
        prompt: 'Materialize the verified local HTML dashboard, JSON data model, and backend server artifact.',
        dependsOn: ['sales_input', 'analyze_sales'],
        sideEffect: 'read' as const,
        deterministic: { runner: 'build-portal.mjs', source: portalBuilderSource },
        output: {
          type: 'object' as const,
          required_keys: ['site_dir', 'html_path', 'backend_path', 'data_path', 'transaction_count', 'total_revenue'],
          verify: { path_exists: ['site_dir', 'html_path', 'backend_path', 'data_path'] },
        },
      },
      {
        id: 'deploy_portal',
        prompt: 'Deploy the already-built sales portal directory and return the governed preview URL.',
        dependsOn: ['build_portal'],
        sideEffect: 'write' as const,
        requiresApproval: true,
        approvalPreview: 'Deploy the sanitized end-of-month sales portal preview.',
        call: {
          tool: 'NETLIFY_DEPLOY_SITE',
          args: { directory: '{{steps.build_portal.output.site_dir}}', site_slug: 'sanitized-sales-portal' },
        },
        output: {
          type: 'object' as const,
          required_keys: ['url', 'deployId', 'apiBaseUrl'],
          verify: { url_present: ['url', 'apiBaseUrl'] },
        },
      },
    ],
    synthesis: {
      prompt: 'Return one concise public status with the transaction/region counts and verified portal URL. Do not expose private specialist notes or raw transaction ids.',
    },
  };

  writeWorkflow(workflowSlug, authoredWorkflow);
  const storedWorkflow = readWorkflow(workflowSlug)?.data;
  assert.ok(storedWorkflow, 'the production workflow store must round-trip the acceptance definition');
  const graph = compileWorkflowStepsToGraph(storedWorkflow.steps, {
    id: `${workflowSlug}:${runId}`,
    name: workflowName,
  });
  persistWorkflowGraphSnapshot({ workflowName: workflowSlug, runId, graph });

  const deployNode = graph.nodes.find((node) => node.id === 'deploy_portal');
  assert.equal(deployNode?.sideEffect, 'write');
  assert.equal(deployNode?.requiresApproval, true);
  assert.equal(deployNode?.config?.subgraphRole, undefined, 'deployment remains a separate governed effect node');
  for (const specialistId of Object.values(specialistIds)) {
    const node = graph.nodes.find((candidate) => candidate.id === specialistId);
    assert.equal(node?.sideEffect, 'read');
    assert.equal(node?.requiresApproval, false);
    assert.equal(node?.config?.subgraphRole, 'specialist');
    assert.equal(node?.call, undefined, 'a specialist can never inherit deployment authority');
  }

  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  const runFile = path.join(WORKFLOW_RUNS_DIR, `${runId}.json`);
  writeFileSync(runFile, JSON.stringify({
    id: runId,
    workflow: workflowName,
    status: 'running',
    source: 'schedule',
    inputs: {},
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  }), 'utf8');
  appendWorkflowEvent(workflowSlug, runId, { kind: 'run_started', meta: { source: 'pre-restart-process' } });
  finalizeStepOutput(workflowSlug, runId, storedWorkflow.steps[0], { transactions });

  const sourceArtifact = readWorkspaceManifest(workflowSlug, runId)
    .find((entry) => entry.tool === 'step-output' && entry.agent === 'sales_input');
  assert.ok(sourceArtifact, 'the exact large sales input is durable before restart');
  const sourceArtifactPath = path.join(runWorkspaceDir(workflowSlug, runId), sourceArtifact.path);

  let activeSpecialists = 0;
  let maxActiveSpecialists = 0;
  let specialistStarts = 0;
  let reducerCalls = 0;
  let synthesisCalls = 0;
  let conversationCalls = 0;
  let releaseSpecialists = (): void => {};
  const allSpecialistsStarted = new Promise<void>((resolve) => { releaseSpecialists = resolve; });
  const concurrencyFallback = setTimeout(releaseSpecialists, 1_000);
  const specialistPrompts: string[] = [];
  const reducerPrompts: string[] = [];
  const synthesisPrompts: string[] = [];
  const queriedOffsets: number[] = [];

  _setWorkflowHarnessLoopImplsForTests({
    configureRuntime: (async () => ({ ok: true })) as never,
    runConversation: (async (request: {
      input?: string;
      sessionId?: string;
      agent?: {
        tools?: Array<{
          name?: string;
          invoke?: (ctx: unknown, input: string, details?: unknown) => Promise<unknown>;
        }>;
      };
    }) => {
      conversationCalls += 1;
      const sessionId = String(request.sessionId ?? '');
      assert.ok(!sessionId.endsWith(':sales_input'), 'the pre-restart sales source must be reused, not re-run');
      const specialistEntry = Object.entries(specialistIds)
        .find(([, specialistId]) => sessionId.endsWith(`:${specialistId}`));

      if (specialistEntry) {
        const [role, specialistId] = specialistEntry;
        specialistPrompts.push(String(request.input ?? ''));
        const tools = request.agent?.tools ?? [];
        assert.deepEqual(
          tools.map((toolRef) => toolRef.name),
          WORKFLOW_GRAPH_ALLOWED_TOOLS,
          `${specialistId} stays physically result-only`,
        );
        const queryTool = tools.find((toolRef) => toolRef.name === 'workspace_artifact_query');
        assert.ok(queryTool?.invoke);
        activeSpecialists += 1;
        specialistStarts += 1;
        maxActiveSpecialists = Math.max(maxActiveSpecialists, activeSpecialists);
        if (specialistStarts === 3) releaseSpecialists();
        await allSpecialistsStarted;

        const offset = role === 'trend' ? 0 : role === 'rep' ? 500 : 1_180;
        const page = String(await queryTool.invoke(
          { context: { sessionId } },
          JSON.stringify({
            path: sourceArtifactPath,
            json_path: 'transactions',
            fields: ['id', 'rep', 'region', 'stage', 'revenue'],
            offset,
            limit: 20,
          }),
          { toolCall: { callId: `sales-portal-${role}-${offset}` } },
        ));
        queriedOffsets.push(offset);
        assert.match(page, /showing 20 record\(s\)/);
        if (role === 'pipeline') assert.ok(page.includes(finalOpaqueTransactionId));
        activeSpecialists -= 1;
        const marker = role === 'trend'
          ? 'PRIVATE-TREND-EVIDENCE:region-movement-verified'
          : role === 'rep'
            ? 'PRIVATE-REP-EVIDENCE:top-five-verified'
            : `PRIVATE-PIPELINE-EVIDENCE:${finalOpaqueTransactionId}:risk-reviewed`;
        return {
          sessionId,
          status: 'completed',
          steps: 1,
          lastTurn: 1,
          lastDecision: { summary: marker },
        };
      }

      if (sessionId.endsWith(':analyze_sales')) {
        reducerCalls += 1;
        const prompt = String(request.input ?? '');
        reducerPrompts.push(prompt);
        assert.match(prompt, /PRIVATE-TREND-EVIDENCE/);
        assert.match(prompt, /PRIVATE-REP-EVIDENCE/);
        assert.match(prompt, /PRIVATE-PIPELINE-EVIDENCE/);
        assert.deepEqual(
          (request.agent?.tools ?? []).map((toolRef) => toolRef.name),
          WORKFLOW_GRAPH_ALLOWED_TOOLS,
          'the reducer is physically result-only too',
        );
        return {
          sessionId,
          status: 'completed',
          steps: 1,
          lastTurn: 1,
          lastDecision: { summary: reducerResult },
        };
      }

      assert.ok(sessionId.endsWith(':synthesis'), `unexpected model session ${sessionId}`);
      synthesisCalls += 1;
      const prompt = String(request.input ?? '');
      synthesisPrompts.push(prompt);
      assert.match(prompt, /REDUCER-PUBLIC-SALES-MODEL/);
      assert.match(prompt, /https:\/\/sales-portal\.example\.test/);
      assert.doesNotMatch(
        prompt,
        /PRIVATE-TREND-EVIDENCE|PRIVATE-REP-EVIDENCE|PRIVATE-PIPELINE-EVIDENCE|txn-001199/,
        'public synthesis receives the reducer projection, never private specialist artifacts',
      );
      return {
        sessionId,
        status: 'completed',
        steps: 1,
        lastTurn: 1,
        lastDecision: { summary: publicReport },
      };
    }) as never,
  });

  let providerDispatches = 0;
  let effectStepExecutions = 0;
  let effectReceiptInput: Parameters<typeof executeWorkflowCallMutation>[0] | undefined;
  _setWorkflowCallNodeForTests(async (step, ctx) => {
    effectStepExecutions += 1;
    assert.equal(step.id, 'deploy_portal');
    assert.equal(step.requiresApproval, true);
    assert.equal(step.sideEffect, 'write');
    const args = renderCallArgs(step.call?.args, ctx.inputs, ctx.stepOutputs);
    assert.equal(
      realpathSync(String(args.directory)),
      realpathSync(expectedPortalDir),
      'the rendered deploy input resolves to the verified portal directory (macOS /var and /private/var are aliases)',
    );
    effectReceiptInput = {
      workflowSlug: ctx.workflowSlug,
      runId: ctx.runId,
      stepId: step.id,
      tool: step.call!.tool,
      account: { connectionId: 'sanitized-netlify-connection', identity: 'sales-team@example.test' },
      args,
    };
    return executeWorkflowCallMutation(effectReceiptInput, async () => {
      providerDispatches += 1;
      return {
        url: 'https://sales-portal.example.test',
        deployId: 'deploy-sanitized-eom-001',
        apiBaseUrl: 'https://sales-portal.example.test/api/sales',
      };
    });
  });

  try {
    await processWorkflowRuns({ respond: async () => ({ text: 'legacy provider must not run' }) } as never);
    const callsAfterCompletion = conversationCalls;
    await processWorkflowRuns({ respond: async () => ({ text: 'legacy provider must not run' }) } as never);
    assert.equal(conversationCalls, callsAfterCompletion, 'a completed run is a no-op on the next daemon poll');
  } finally {
    clearTimeout(concurrencyFallback);
    _setWorkflowCallNodeForTests();
    _setWorkflowHarnessLoopImplsForTests();
  }

  assert.equal(specialistStarts, 3);
  assert.equal(maxActiveSpecialists, 3, 'all three analytical branches overlap in one scheduler wave');
  assert.deepEqual(queriedOffsets.sort((a, b) => a - b), [0, 500, 1_180]);
  assert.equal(reducerCalls, 1, 'one reducer owns analytical synthesis');
  assert.equal(synthesisCalls, 1, 'one public synthesis owns the terminal response');
  assert.equal(effectStepExecutions, 1);
  assert.equal(providerDispatches, 1, 'the governed external deployment crosses its provider boundary exactly once');
  assert.ok(effectReceiptInput);
  assert.equal(inspectWorkflowCallMutation(effectReceiptInput).status, 'committed');
  assert.ok(
    specialistPrompts.every((prompt) => prompt.includes('__clementine_context_ref')),
    'all specialists receive a bounded reference to the exact durable sales artifact',
  );
  assert.equal(reducerPrompts.length, 1);
  assert.equal(synthesisPrompts.length, 1);

  const html = readFileSync(expectedHtmlPath, 'utf8');
  const backend = readFileSync(expectedBackendPath, 'utf8');
  assert.match(html, /fetch\("\/api\/sales"\)/);
  assert.match(backend, /createServer/);
  assert.match(backend, /\/api\/sales/);

  const terminal = JSON.parse(readFileSync(runFile, 'utf8')) as {
    status?: string;
    output?: string;
    reportBack?: { detail?: string };
  };
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.output, publicReport, 'the canonical terminal is the single public synthesis');
  assert.match(terminal.reportBack?.detail ?? '', /July sales portal is live: 1,200 transactions analyzed/);
  assert.equal(
    (terminal.reportBack?.detail ?? '').split('July sales portal is live: 1,200 transactions analyzed').length - 1,
    1,
    'report-back contains the one public result exactly once',
  );
  assert.doesNotMatch(
    `${terminal.output ?? ''}\n${terminal.reportBack?.detail ?? ''}`,
    /PRIVATE-TREND-EVIDENCE|PRIVATE-REP-EVIDENCE|PRIVATE-PIPELINE-EVIDENCE|txn-001199/,
    'neither terminal nor report-back narrates private branch evidence',
  );

  const events = readWorkflowEvents(workflowSlug, runId);
  for (const stepId of [
    'sales_input',
    specialistIds.trend,
    specialistIds.rep,
    specialistIds.pipeline,
    'analyze_sales',
    'build_portal',
    'deploy_portal',
    '__synthesis__',
  ]) {
    assert.equal(
      events.filter((event) => event.kind === 'step_completed' && event.stepId === stepId).length,
      1,
      `${stepId} completes exactly once across restart and the no-op poll`,
    );
  }
  assert.equal(events.filter((event) => event.kind === 'run_completed').length, 1);
  assert.ok(events.some((event) =>
    event.kind === 'step_started'
    && event.stepId === 'deploy_portal'
    && event.meta?.gate === 'auto_approved_unattended'),
  'the scheduled write remains visibly governed by the runner-owned approval boundary');
  assert.ok(events.some((event) =>
    event.kind === 'workflow_node_ready'
    && event.stepId === specialistIds.trend
    && event.meta?.parallel === true
    && event.meta?.readyWidth === 3),
  'the production scheduler observes a real three-wide specialist wave');
});
