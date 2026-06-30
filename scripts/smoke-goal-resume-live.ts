/**
 * LIVE smoke for the self-driving goal RESUME path (the "runs across a session
 * end / laptop sleep" property). Unlike scripts/smoke-next-level.ts (which mocks
 * the model runner), this drives the REAL processGoalResumptions → REAL
 * runConversation → REAL model on the REAL home (auth), proving the
 * daemon-equivalent resume actually fires a model turn that makes progress and
 * SATISFIES the goal — with no human in the loop.
 *
 * Safety: a uniquely-named throwaway goal/session/file (cannot collide with real
 * goals — all existing goals are non-self-driving), cleaned up at the end
 * regardless of outcome so NO self-driving goal is left behind for the daemon.
 * Run as the SOLE owner of the home (stop the dev daemon first).
 *
 *   CLEMENTINE_HOME=$HOME/.clementine-next npx tsx scripts/smoke-goal-resume-live.ts
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';

process.env.CLEMENTINE_HOME = process.env.CLEMENTINE_HOME || `${process.env.HOME}/.clementine-next`;
// Production behavior — do NOT disable brackets/gates; this is a real run.

const { configureHarnessRuntime } = await import('../src/runtime/harness/codex-client.js');
const {
  surfacePlan, approvePlanProposal, enableGoalSelfDrive, getPlanProposal,
} = await import('../src/agents/plan-proposals.js');
const { processGoalResumptions } = await import('../src/execution/goal-resume.js');
const { HarnessSession } = await import('../src/runtime/harness/session.js');
const { closePlanScope } = await import('../src/agents/plan-scope.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const info = (m: string) => console.log(`  · ${m}`);

const token = `RESUMELIVE-${Date.now().toString(36).toUpperCase()}`;
// write_file is sandboxed to workspaceRoots() (~/.clementine-next is one); a
// /tmp path is OUTSIDE the sandbox and would be refused — use a workspace path
// so the tool actually writes, isolating the resume behavior from path guards.
const file = `${process.env.CLEMENTINE_HOME}/tmp-goal-resume-${token}.txt`;
const sessionId = `goal-resume-live-${token}`;
let goalId = '';

async function cleanup() {
  try { if (goalId) { const g = getPlanProposal(goalId); if (g) { (g as any).status = 'expired'; (g as any).selfDriving = false; (g as any).parked = { at: new Date().toISOString(), reason: 'blocker', note: 'smoke cleanup' }; } } } catch { /* */ }
  // Hard-remove the throwaway goal proposal + session so NOTHING self-driving lingers.
  try {
    const dir = `${process.env.CLEMENTINE_HOME}/state/plan-proposals`;
    if (goalId && existsSync(`${dir}/${goalId}.json`)) rmSync(`${dir}/${goalId}.json`, { force: true });
  } catch { /* */ }
  try { closePlanScope(sessionId, 'smoke cleanup'); } catch { /* */ }
  try {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(`${process.env.CLEMENTINE_HOME}/state/harness.db`);
    db.prepare("DELETE FROM events WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    db.close();
  } catch { /* */ }
  try { if (existsSync(file)) rmSync(file, { force: true }); } catch { /* */ }
}

console.log(`\n=== LIVE goal-resume smoke (token ${token}) ===\n`);
let satisfied = false;
try {
  const auth = await configureHarnessRuntime();
  assert.ok(auth.ok, `runtime not configured: ${(auth as any).reason ?? 'unknown'}`);
  ok('harness runtime configured (real auth)');

  HarnessSession.create({ kind: 'chat', id: sessionId, title: 'goal resume live smoke' } as any);

  const p = surfacePlan({
    plan: {
      objective: `Use the write_file tool to write exactly the single word ${token} (nothing else) into the file ${file}. That one file write is the ENTIRE task — once the file exists with that word, you are done.`,
      steps: [{ n: 1, action: `write_file ${file} containing ${token}`, rationale: 'the whole task', verification: null }],
      successCriteria: [`The file ${file} exists and its contents are exactly ${token}`],
      stages: null,
      risks: [], estimatedComplexity: 'trivial', recommendsTrackedExecution: false,
      needsUserInput: [], appliedInstructions: [],
    },
    originatingRequest: 'self-driving file-write smoke',
    sessionId,
  });
  const goal = approvePlanProposal(p.id, { allowedTools: ['*'], autonomous: true });
  assert.ok(goal && goal.selfDriving, 'goal should be self-driving after autonomous approval');
  goalId = goal!.id;
  ok(`self-driving goal created (${goalId})`);

  // Make it due ~now (default cadence is 30 min). Tiny cadence so each
  // processGoalResumptions() pass re-arms quickly.
  enableGoalSelfDrive(goalId, { resumeEveryMs: 4000 });
  info('resume cadence set to 4s; firing resumption passes…');

  // Drive the resume loop the way the daemon tick does. The resume turn runs
  // fire-and-forget, so after each pass we wait for the async model turn.
  for (let i = 1; i <= 4 && !satisfied; i++) {
    await processGoalResumptions();
    info(`pass ${i}: resumption evaluated; waiting for the resumed turn…`);
    for (let w = 0; w < 12; w++) {
      await sleep(5000);
      const g = getPlanProposal(goalId);
      if (existsSync(file)) info(`  file appeared: ${readFileSync(file, 'utf-8').trim().slice(0, 40)}`);
      if (g?.status === 'satisfied') { satisfied = true; break; }
      if (existsSync(file) && (g?.resumeCount ?? 0) >= 1) break; // turn did the work; let next pass validate
    }
  }

  // Diagnostics BEFORE cleanup: what did the resumed turns actually do?
  try {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(`${process.env.CLEMENTINE_HOME}/state/harness.db`, { readonly: true });
    const rows = db.prepare("SELECT type, data_json FROM events WHERE session_id = ? ORDER BY seq").all(sessionId) as Array<{ type: string; data_json: string }>;
    db.close();
    console.log(`\n  --- session diagnostics (${rows.length} events) ---`);
    for (const r of rows) {
      let d: any = {}; try { d = JSON.parse(r.data_json); } catch { /* */ }
      if (r.type === 'tool_called') console.log(`  TOOL ${d.tool}  ${(d.arguments || '').slice(0, 80)}`);
      else if (r.type === 'conversation_completed') console.log(`  DONE reason=${d.reason ?? '-'} summary=${(d.summary || '').slice(0, 100)}`);
      else if (r.type === 'goal_validation') console.log(`  VALIDATE pass=${d.pass} reason=${(d.reason || '').slice(0, 90)}`);
      else if (r.type === 'run_failed' || r.type === 'guardrail_tripped' || r.type === 'awaiting_user_input') console.log(`  ${r.type.toUpperCase()} ${JSON.stringify(d).slice(0, 120)}`);
    }
    console.log('  --- end diagnostics ---\n');
  } catch (e) { info(`diagnostics read failed: ${(e as Error).message}`); }

  const g = getPlanProposal(goalId);
  info(`final: status=${g?.status} resumeCount=${g?.resumeCount} fileExists=${existsSync(file)}`);
  assert.ok((g?.resumeCount ?? 0) >= 1, 'the goal should have self-resumed at least once');
  ok(`goal self-resumed ${g?.resumeCount}× with no human input`);
  assert.ok(existsSync(file), 'the resumed model turn should have written the deliverable file');
  const contents = readFileSync(file, 'utf-8');
  assert.ok(contents.includes(token), `file should contain ${token}, got: ${contents.slice(0, 60)}`);
  ok('the resumed turn produced the real deliverable (file written by the model)');
  assert.equal(g?.status, 'satisfied', 'the goal should have validated + satisfied autonomously');
  ok('goal SATISFIED autonomously (resume → work → validate → satisfy)');

  console.log('\n=== LIVE RESUME SMOKE PASSED ===\n');
} catch (err) {
  console.error(`\n✗ LIVE RESUME SMOKE FAILED: ${(err as Error).message}\n`);
} finally {
  await cleanup();
  ok('cleaned up throwaway goal + session + file (no self-driving goal left behind)');
}
// Force-exit: a fire-and-forget resume turn (the async runConversation) keeps the
// event loop alive, so the process would otherwise hang after the asserts pass.
process.exit(satisfied ? 0 : 1);
