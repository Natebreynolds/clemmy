/**
 * LIVE integration smoke for the workflow CREATION-TEST (Part B).
 *
 * Run: npx tsx scripts/smoke-workflow-creation-test.mts
 *
 * What it proves end-to-end against REAL tools (real Composio + real model):
 *   PASS  — a workflow with a read-only step that actually returns data is saved
 *           DISABLED, the creation test runs the read step for real + PREVIEWS
 *           the mutating send step, and the workflow AUTO-ENABLES on the pass.
 *   FAIL  — a workflow whose read step can't return data stays DISABLED with a
 *           "found issues" verdict (never silently saved live + broken).
 *   SKIP  — a pure-LLM workflow (nothing external to validate) enables directly,
 *           no creation test queued.
 *
 * SAFETY: runs in an ISOLATED CLEMENTINE_HOME seeded with the real creds
 * (.env / state/auth.json / secrets-vault / composio catalog) so it uses real
 * Composio + auth but never touches the live daemon's runs/vault/db and can
 * never execute one of the user's real workflows. HOME stays real for ~/.codex.
 */
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REAL_HOME = path.join(os.homedir(), '.clementine-next');
const ISO_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-creationtest-smoke-'));

// Seed the isolated home with ONLY the credential/config bits — runs, vault, and
// db stay empty + isolated. Must happen BEFORE any src import (config reads
// CLEMENTINE_HOME + .env at module load).
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
console.log(`[smoke] isolated home: ${ISO_HOME}`);
console.log(`[smoke] seeded: ${JSON.stringify(seeded)}`);

// ── imports (after env + seed) ──────────────────────────────────────────────
const { initHome } = await import('../src/setup/init-home.js');
const { ClementineAssistant } = await import('../src/assistant/core.js');
const { createRuntimeFromConfig } = await import('../src/runtime/factory.js');
const { processWorkflowRuns } = await import('../src/execution/workflow-runner.js');
const { listWorkflows } = await import('../src/memory/workflow-store.js');
const { WORKFLOW_RUNS_DIR } = await import('../src/tools/shared.js');

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

await initHome().catch((e) => console.warn('[smoke] initHome warn:', e?.message ?? e));

// Capture the REAL workflow_create handler (drives the actual tool body).
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
  console.error('✗ PREFLIGHT: could not construct assistant (auth not wired in isolated home):', (e as Error).message);
  rmSync(ISO_HOME, { recursive: true, force: true });
  process.exit(3);
}
console.log('[smoke] assistant constructed (auth OK)');

function resultText(r: ToolResult): string { return r.content.map((c) => c.text).join('\n'); }
function wfEnabled(name: string): boolean | undefined { return listWorkflows().find((e) => e.data.name === name)?.data.enabled; }
function runRecordsFor(name: string): Array<Record<string, unknown>> {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return [];
  return readdirSync(WORKFLOW_RUNS_DIR).filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, f), 'utf-8')); } catch { return {}; } })
    .filter((r) => r.workflow === name);
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}: ${detail}`);
};

async function drainOnce(label: string, timeoutMs = 240_000): Promise<void> {
  console.log(`[smoke] draining (${label})…`);
  await Promise.race([
    processWorkflowRuns(assistant),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`drain timeout after ${timeoutMs}ms`)), timeoutMs)),
  ]);
}

// ── Scenario PASS ────────────────────────────────────────────────────────────
const PASS_NAME = 'Smoke Creation Test PASS';
try {
  const res = resultText(await workflowCreate({
    name: PASS_NAME,
    description: 'Smoke: read-only Firecrawl scrape, then a previewed send.',
    steps: [
      {
        // Deterministic real read: search the live Composio catalog (a real
        // tool call returning real structured data — no flaky external site /
        // rate limit). A live external scrape (Firecrawl) is verified
        // separately by probe-creationtest-pass.mts; this committed smoke needs
        // a repeatable pass signal.
        id: 'scrape',
        prompt: 'Search the available tools for "gmail" by calling composio_search_tools with query "gmail". Return the list of matching tool slugs you find. If nothing comes back, reply starting with the word "blocked" and the reason.',
        allowedTools: ['composio_search_tools', 'composio_list_tools'],
        maxTurns: 6,
      },
      {
        id: 'send',
        prompt: 'Send the morning summary email to the owner using the scraped text from the scrape step.',
        dependsOn: ['scrape'],
        requiresApproval: true,
        approvalPreview: 'Send summary email to owner',
        maxTurns: 4,
      },
    ],
  }));
  const savedDisabled = /DISABLED/i.test(res) && /creation test/i.test(res);
  const enabledAfterCreate = wfEnabled(PASS_NAME);
  const queued = runRecordsFor(PASS_NAME).some((r) => r.status === 'creation_test');
  record('PASS/save-disabled', savedDisabled && enabledAfterCreate === false && queued,
    `tool said DISABLED+test=${savedDisabled}, on-disk enabled=${enabledAfterCreate}, creation_test queued=${queued}`);

  await drainOnce('PASS');
  const enabledAfterTest = wfEnabled(PASS_NAME);
  const rec = runRecordsFor(PASS_NAME).find((r) => r.status === 'creation_test' && r.finishedAt);
  const verdictPass = typeof rec?.output === 'string' && /passed/i.test(rec.output);
  record('PASS/auto-enable', enabledAfterTest === true && verdictPass,
    `on-disk enabled=${enabledAfterTest}, run output="${rec?.output ?? '(none)'}"`);
} catch (e) {
  record('PASS', false, `threw: ${(e as Error).message}`);
}

// ── Scenario FAIL ─────────────────────────────────────────────────────────────
const FAIL_NAME = 'Smoke Creation Test FAIL';
try {
  const res = resultText(await workflowCreate({
    name: FAIL_NAME,
    description: 'Smoke: read step that cannot return data → must stay disabled.',
    steps: [
      {
        id: 'scrape',
        prompt: 'Fetch data by calling composio_execute_tool with tool_slug "NONEXISTENT_SMOKE_TOOLKIT_XYZ" and arguments {}. This tool does not exist. Return EXACTLY {"ok": false, "error": "<the error message you received>"} as JSON. Do not call any other tool and do not invent data.',
        allowedTools: ['composio_execute_tool'],
        output: { type: 'object', required_keys: ['records'] },
        maxTurns: 6,
      },
    ],
  }));
  const savedDisabled = /DISABLED/i.test(res) && /creation test/i.test(res);
  record('FAIL/save-disabled', savedDisabled && wfEnabled(FAIL_NAME) === false,
    `tool said DISABLED+test=${savedDisabled}, on-disk enabled=${wfEnabled(FAIL_NAME)}`);

  await drainOnce('FAIL');
  const enabledAfter = wfEnabled(FAIL_NAME);
  const rec = runRecordsFor(FAIL_NAME).find((r) => r.status === 'creation_test' && r.finishedAt);
  const verdictFail = typeof rec?.output === 'string' && /found issues/i.test(rec.output);
  record('FAIL/stays-disabled', enabledAfter === false && verdictFail,
    `on-disk enabled=${enabledAfter}, run output="${rec?.output ?? '(none)'}"`);
} catch (e) {
  record('FAIL', false, `threw: ${(e as Error).message}`);
}

// ── Scenario SKIP (pure-LLM) ───────────────────────────────────────────────────
const SKIP_NAME = 'Smoke Creation Test SKIP';
try {
  const res = resultText(await workflowCreate({
    name: SKIP_NAME,
    description: 'Smoke: pure-LLM workflow — nothing external to validate.',
    steps: [
      { id: 'quote', prompt: 'Write a single short motivational sentence. No tools.', maxTurns: 2 },
    ],
  }));
  const enabledImmediately = wfEnabled(SKIP_NAME);
  const noTestQueued = !runRecordsFor(SKIP_NAME).some((r) => r.status === 'creation_test');
  const notDisabledMsg = !/saved DISABLED/i.test(res);
  record('SKIP/enable-directly', enabledImmediately === true && noTestQueued && notDisabledMsg,
    `on-disk enabled=${enabledImmediately}, creation_test queued=${!noTestQueued}, msg-not-disabled=${notDisabledMsg}`);
} catch (e) {
  record('SKIP', false, `threw: ${(e as Error).message}`);
}

// ── Summary ────────────────────────────────────────────────────────────────────
const allOk = results.every((r) => r.ok);
console.log('\n──────── SMOKE SUMMARY ────────');
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name} — ${r.detail}`);
console.log(`\n${allOk ? '✅ ALL CHECKS PASSED' : '❌ SOME CHECKS FAILED'}`);

rmSync(ISO_HOME, { recursive: true, force: true });
process.exit(allOk ? 0 : 1);
