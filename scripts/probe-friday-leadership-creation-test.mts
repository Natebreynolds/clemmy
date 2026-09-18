/**
 * LIVE probe: re-run the creation test for the owner's friday-sales-leadership-email
 * workflow against the citation + inheritance changes.
 *
 *   Run: npx tsx scripts/probe-friday-leadership-creation-test.mts
 *
 * What it exercises, end to end, with the REAL sf CLI and the REAL model:
 *   - workflow_create → recordAuthoredStepCitations lands the authored step's
 *     cited operation in its own scope, and the toolkit binder defers to it
 *     instead of guessing the Composio family the prompt forbids.
 *   - the creation test's prompted read step → materializeCitedStepOperations
 *     acquires salesforce_sf_soql_query by exact identifier before the model runs.
 *
 * The live failure this re-runs (2026-09-18T04:17Z, daemon 3.18.14):
 *   step collect_and_validate_salesforce_metrics → step_blocked
 *   "The tool stopped after execution may have begun ... must be reconciled"
 *
 * SAFETY: an ISOLATED CLEMENTINE_HOME seeded with ONLY the credential/config
 * files, exactly like smoke-workflow-creation-test.mts. The live runs, vault and
 * db are never touched and the owner's real workflow is never executed. HOME
 * stays real so the sf CLI keeps its own auth. The send step is a creation-test
 * PREVIEW, never a real email.
 */
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, readdirSync, readFileSync, rmSync, cpSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REAL_HOME = path.join(os.homedir(), '.clementine-next');
const WORKFLOW_NAME = 'friday-sales-leadership-email';
const ISO_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-friday-probe-'));

process.env.CLEMENTINE_HOME = ISO_HOME;
mkdirSync(path.join(ISO_HOME, 'state'), { recursive: true });
const seed = (rel: string) => {
  const from = path.join(REAL_HOME, rel);
  const to = path.join(ISO_HOME, rel);
  if (existsSync(from)) { mkdirSync(path.dirname(to), { recursive: true }); copyFileSync(from, to); return true; }
  return false;
};
const seeded = {
  env: seed('.env'),
  auth: seed('state/auth.json'),
  vault: seed('state/secrets-vault.json'),
  catalog: seed('state/composio-catalog-cache.json'),
};
console.log(`[probe] isolated home: ${ISO_HOME}`);
console.log(`[probe] seeded: ${JSON.stringify(seeded)}`);

const { initHome } = await import('../src/setup/init-home.js');
const { ClementineAssistant } = await import('../src/assistant/core.js');
const { createRuntimeFromConfig } = await import('../src/runtime/factory.js');
const { processWorkflowRuns } = await import('../src/execution/workflow-runner.js');
const { listWorkflows, readWorkflow } = await import('../src/memory/workflow-store.js');
const { WORKFLOWS_DIR } = await import('../src/memory/vault.js');
const { WORKFLOW_RUNS_DIR } = await import('../src/tools/shared.js');

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

await initHome().catch((e) => console.warn('[probe] initHome warn:', e?.message ?? e));

// A fresh home has no CLI inventory, so the reviewed Salesforce read would not
// be in the catalog and the creation test would have nothing to acquire. This
// is the same seam the daemon runs at boot — discovery, indexing, and the
// reviewed-read reconcile that 3.18.14 stopped retiring.
console.log('[probe] scanning CLIs + reconciling reviewed reads (the daemon boot seam)…');
try {
  const { fullScan } = await import('../src/runtime/cli-discovery.js');
  const scan = await fullScan();
  console.log(`[probe] CLI scan: ${scan.clis.length} detected`);
  const { reconcileCatalogReviewedCliReads } = await import('../src/runtime/harness/catalog-reviewed-cli-reconcile.js');
  const reconciled = await reconcileCatalogReviewedCliReads({ rehash: false });
  console.log(`[probe] reviewed-read reconcile: ${JSON.stringify(reconciled).slice(0, 300)}`);
} catch (e) {
  console.warn('[probe] CLI discovery warn:', (e as Error).message);
}
try {
  const { searchCapabilityOperations } = await import('../src/memory/capability-index.js');
  const hits = await searchCapabilityOperations('salesforce soql query', { limit: 5 } as never);
  console.log(`[probe] catalog lookup for the cited read: ${JSON.stringify(hits).slice(0, 400)}`);
} catch (e) {
  console.warn('[probe] catalog lookup warn:', (e as Error).message);
}

// Copy the owner's REAL definition into the isolated home so the parser — not a
// hand transcription — produces the graph this probe authors.
const sourceDir = path.join(REAL_HOME, 'vault/00-System/workflows', WORKFLOW_NAME);
if (!existsSync(sourceDir)) { console.error(`✗ ${WORKFLOW_NAME} not found at ${sourceDir}`); process.exit(2); }
mkdirSync(WORKFLOWS_DIR, { recursive: true });
cpSync(sourceDir, path.join(WORKFLOWS_DIR, WORKFLOW_NAME), { recursive: true });
rmSync(path.join(WORKFLOWS_DIR, WORKFLOW_NAME, 'runs'), { recursive: true, force: true });

const original = readWorkflow(WORKFLOW_NAME);
if (!original) { console.error('✗ could not parse the workflow definition'); process.exit(2); }
console.log(`[probe] parsed ${original.data.steps.length} steps; enabled=${original.data.enabled}`);
for (const step of original.data.steps) {
  console.log(`[probe]   step ${step.id}: sideEffect=${step.sideEffect ?? '(none)'} allowedTools=${JSON.stringify(step.allowedTools ?? null)}`);
}

// Author it fresh through the REAL workflow_create body, which is where the
// citation pass runs. Remove the copied definition first so this is a create.
rmSync(path.join(WORKFLOWS_DIR, WORKFLOW_NAME), { recursive: true, force: true });

const handlers = new Map<string, ToolHandler>();
const { registerOrchestrationTools } = await import('../src/tools/orchestration-tools.js');
registerOrchestrationTools({
  tool(name: string, _d: string, _s: unknown, handler: ToolHandler) { handlers.set(name, handler); },
} as never);
const workflowCreate = handlers.get('workflow_create');
if (!workflowCreate) { console.error('✗ workflow_create not registered'); process.exit(2); }

let assistant: InstanceType<typeof ClementineAssistant>;
try {
  assistant = new ClementineAssistant(createRuntimeFromConfig());
} catch (e) {
  console.error('✗ PREFLIGHT: could not construct assistant:', (e as Error).message);
  rmSync(ISO_HOME, { recursive: true, force: true });
  process.exit(3);
}
console.log('[probe] assistant constructed (auth OK)');

const resultText = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

const steps = original.data.steps.map((step) => ({
  id: step.id,
  ...(step.prompt ? { prompt: step.prompt } : {}),
  ...(step.dependsOn?.length ? { dependsOn: step.dependsOn } : {}),
  ...(step.intent ? { intent: step.intent } : {}),
  ...(step.allowedTools?.length ? { allowedTools: step.allowedTools } : {}),
  ...(step.output ? { output: step.output } : {}),
  ...(step.sideEffect ? { sideEffect: step.sideEffect } : {}),
  ...(step.requiresApproval !== undefined ? { requiresApproval: step.requiresApproval } : {}),
}));

console.log('\n[probe] ── authoring through the real workflow_create ──');
const created = resultText(await workflowCreate({
  name: WORKFLOW_NAME,
  description: original.data.description ?? 'Friday sales leadership email',
  steps,
  ...(original.data.resources ? { resources: JSON.stringify(original.data.resources) } : {}),
  ...(original.data.synthesis?.prompt ? { synthesis_prompt: original.data.synthesis.prompt } : {}),
  ...(original.data.goal ? { goal: {
    objective: original.data.goal.objective,
    ...(original.data.goal.successCriteria ? { success_criteria: original.data.goal.successCriteria } : {}),
    ...(original.data.goal.maxAttempts ? { max_attempts: original.data.goal.maxAttempts } : {}),
  } } : {}),
}));
console.log(created.slice(0, 2500));

// What did the citation pass actually record?
const saved = readWorkflow(WORKFLOW_NAME);
console.log('\n[probe] ── saved step scopes (the citations) ──');
for (const step of saved?.data.steps ?? []) {
  const tools = JSON.stringify(step.allowedTools ?? null);
  const composio = (step.allowedTools ?? []).some((t) => String(t).startsWith('composio'));
  console.log(`[probe]   ${step.id}: allowedTools=${tools}${composio ? '   ⚠️  COMPOSIO FAMILY BOUND' : ''}`);
}

console.log('\n[probe] ── draining the creation test (real sf CLI + real model) ──');
const DRAIN_MS = Number(process.env.PROBE_DRAIN_MS ?? 900_000);
try {
  await Promise.race([
    processWorkflowRuns(assistant),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`drain timeout after ${DRAIN_MS}ms`)), DRAIN_MS)),
  ]);
} catch (e) {
  console.error(`[probe] drain ended: ${(e as Error).message}`);
}

const after = listWorkflows().find((e) => e.data.name === WORKFLOW_NAME);
console.log(`\n[probe] ── verdict ──`);
console.log(`[probe] enabled after creation test: ${after?.data.enabled}`);

const runDir = path.join(WORKFLOWS_DIR, WORKFLOW_NAME, 'runs');
if (existsSync(runDir)) {
  for (const id of readdirSync(runDir)) {
    const events = path.join(runDir, id, 'events.jsonl');
    if (!existsSync(events)) continue;
    console.log(`[probe] run ${id}:`);
    for (const line of readFileSync(events, 'utf-8').split('\n').filter(Boolean)) {
      try {
        const e = JSON.parse(line);
        const detail = e.error ?? (e.output ? JSON.stringify(e.output).slice(0, 220) : '');
        console.log(`[probe]   ${e.kind} ${e.stepId ?? ''} ${String(detail).slice(0, 260)}`);
      } catch { /* a partial line is not a verdict */ }
    }
  }
}

if (existsSync(WORKFLOW_RUNS_DIR)) {
  const records = readdirSync(WORKFLOW_RUNS_DIR).filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')); } catch { return {}; } })
    .filter((r) => r.workflow === WORKFLOW_NAME);
  for (const record of records) {
    console.log(`[probe] run record: status=${record.status} verdict=${JSON.stringify(record.verdict ?? record.creationTest ?? null).slice(0, 400)}`);
  }
}

console.log(`\n[probe] isolated home retained for inspection: ${ISO_HOME}`);
