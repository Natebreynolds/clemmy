/**
 * LIVE smoke for the OODA re-Orient feedback edge (CLEMMY_GOAL_REORIENT_OBS).
 * Proves, with a REAL model turn on the REAL home, that a self-driving goal
 * resume folds FRESH monitor observations into its directive — so the resumed
 * turn re-reads the world instead of continuing blind.
 *
 * What it exercises (production path, no mocks):
 *   - seeds ONE relevant + ONE tangential monitor notification into the real
 *     notification store (source: inbox-monitor)
 *   - drives REAL processGoalResumptions → REAL runConversation → REAL model
 *   - asserts: the live reader injected the RELEVANT observation (ooda_cycle
 *     telemetry with observationsInjected≥1), the resumed model turn ACTED on it
 *     (wrote the observation's token into the deliverable), and the TANGENTIAL
 *     item was filtered out (its distinctive word never reaches the file).
 *
 * Safety: a uniquely-named throwaway goal/session/file + uniquely-prefixed
 * seeded notifications, all removed at the end regardless of outcome — NOTHING
 * self-driving and no needs-you card is left behind for the daemon. Run as the
 * SOLE owner of the home (stop the dev daemon first), else its flag-off tick
 * could fire the throwaway goal without the observation and pollute the test.
 *
 *   CLEMENTINE_HOME=$HOME/.clementine-next npx tsx scripts/smoke-goal-reorient-live.ts
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

process.env.CLEMENTINE_HOME = process.env.CLEMENTINE_HOME || `${process.env.HOME}/.clementine-next`;
process.env.CLEMMY_GOAL_REORIENT_OBS = 'on'; // the feature under test
// Production behavior — do NOT disable brackets/gates; this is a real run.

const { configureHarnessRuntime } = await import('../src/runtime/harness/codex-client.js');
const {
  surfacePlan, approvePlanProposal, enableGoalSelfDrive, getPlanProposal,
} = await import('../src/agents/plan-proposals.js');
const { processGoalResumptions } = await import('../src/execution/goal-resume.js');
const { HarnessSession } = await import('../src/runtime/harness/session.js');
const { closePlanScope } = await import('../src/agents/plan-scope.js');
const { addNotification } = await import('../src/runtime/notifications.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const info = (m: string) => console.log(`  · ${m}`);

const token = `REORIENTLIVE-${Date.now().toString(36).toUpperCase()}`;
const file = `${process.env.CLEMENTINE_HOME}/tmp-goal-reorient-${token}.txt`;
const sessionId = `goal-reorient-live-${token}`;
const NOTIF_PREFIX = `reorient-smoke-${token}`;
const TANGENTIAL_WORD = 'Newsletter';
let goalId = '';
let seedCount = 0;

const notifFile = `${process.env.CLEMENTINE_HOME}/state/notifications.json`;

/** Seed a fresh relevant + tangential monitor notification (unique id each call)
 *  so that, whatever moment the resume fires, a <1s-old item sits inside the
 *  reader's "since last cycle" window. */
function seedObservations(): void {
  const now = new Date(Date.now() - 800).toISOString();
  seedCount += 1;
  addNotification({
    id: `${NOTIF_PREFIX}-relevant-${seedCount}`,
    kind: 'execution',
    title: `📩 Acme Corp: countersigned the ${token} contract`,
    body: `The Acme Corp contract you have been tracking was just countersigned. Ref ${token}.`,
    createdAt: now,
    read: false,
    silent: true,
    metadata: { needsAttention: true, source: 'inbox-monitor', account: 'inbox@acme.test', reasons: ['asks you something'] },
  });
  addNotification({
    id: `${NOTIF_PREFIX}-tangential-${seedCount}`,
    kind: 'execution',
    title: `📰 Weekly Recipes ${TANGENTIAL_WORD}: 10 dinner ideas`,
    body: 'Unrelated promotional digest — should never reach the goal.',
    createdAt: now,
    read: false,
    silent: true,
    metadata: { needsAttention: true, source: 'inbox-monitor', account: 'promos@food.test', reasons: ['a reply in your thread'] },
  });
}

function purgeSeededNotifications(): void {
  try {
    if (!existsSync(notifFile)) return;
    const all = JSON.parse(readFileSync(notifFile, 'utf-8')) as Array<{ id?: string }>;
    const kept = all.filter((n) => !(typeof n.id === 'string' && n.id.startsWith(NOTIF_PREFIX)));
    if (kept.length !== all.length) writeFileSync(notifFile, JSON.stringify(kept, null, 2), 'utf-8');
  } catch { /* best-effort */ }
}

async function cleanup() {
  try { if (goalId) { const g = getPlanProposal(goalId); if (g) { (g as any).status = 'expired'; (g as any).selfDriving = false; (g as any).parked = { at: new Date().toISOString(), reason: 'blocker', note: 'smoke cleanup' }; } } } catch { /* */ }
  try {
    const dir = `${process.env.CLEMENTINE_HOME}/state/plan-proposals`;
    if (goalId && existsSync(`${dir}/${goalId}.json`)) rmSync(`${dir}/${goalId}.json`, { force: true });
  } catch { /* */ }
  try { closePlanScope(sessionId, 'smoke cleanup'); } catch { /* */ }
  try {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(`${process.env.CLEMENTINE_HOME}/state/harness.db`);
    db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    db.close();
  } catch { /* */ }
  try { if (existsSync(file)) rmSync(file, { force: true }); } catch { /* */ }
  purgeSeededNotifications();
}

console.log(`\n=== LIVE goal re-Orient smoke (token ${token}) ===\n`);
let passedAll = false;
try {
  const auth = await configureHarnessRuntime();
  assert.ok(auth.ok, `runtime not configured: ${(auth as any).reason ?? 'unknown'}`);
  ok('harness runtime configured (real auth)');

  HarnessSession.create({ kind: 'chat', id: sessionId, title: 'goal re-orient live smoke' } as any);

  const p = surfacePlan({
    plan: {
      objective: `You are tracking real-world updates about the "Acme Corp contract". You maintain a single status file at ${file}. Each time you resume, read the "What changed since your last cycle" note in your instructions and use the write_file tool to write the text of that change line (everything after the dash, INCLUDING any token like ${token}) into ${file}. That one write is the entire task. If there is NO "What changed" note, write the word NONE into ${file} instead.`,
      steps: [{ n: 1, action: `write_file ${file} with the latest 'what changed' line`, rationale: 'the whole task', verification: null }],
      successCriteria: [`The file ${file} exists and contains the latest change line about the Acme Corp contract`],
      stages: null,
      risks: [], estimatedComplexity: 'trivial', recommendsTrackedExecution: false,
      needsUserInput: [], appliedInstructions: [],
    },
    originatingRequest: 'self-driving re-orient smoke',
    sessionId,
  });
  const goal = approvePlanProposal(p.id, { allowedTools: ['*'], autonomous: true });
  assert.ok(goal && goal.selfDriving, 'goal should be self-driving after autonomous approval');
  goalId = goal!.id;
  ok(`self-driving goal created (${goalId})`);

  enableGoalSelfDrive(goalId, { resumeEveryMs: 6000 }); // 6s cadence ⇒ 6s observation window
  info('resume cadence set to 6s; seeding observations + firing resumption passes…');

  for (let i = 1; i <= 4 && !existsSync(file); i++) {
    seedObservations(); // fresh, in-window relevant + tangential items before each pass
    await processGoalResumptions();
    info(`pass ${i}: observations seeded + resumption evaluated; waiting for the resumed turn…`);
    for (let w = 0; w < 12; w++) {
      await sleep(5000);
      const g = getPlanProposal(goalId);
      if (existsSync(file)) { info(`  file appeared: ${readFileSync(file, 'utf-8').trim().slice(0, 60)}`); break; }
      if (g?.status === 'satisfied') break;
    }
  }

  // Diagnostics + the load-bearing assertions, read from the real event log.
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(`${process.env.CLEMENTINE_HOME}/state/harness.db`, { readonly: true });
  const rows = db.prepare('SELECT type, data_json FROM events WHERE session_id = ? ORDER BY seq').all(sessionId) as Array<{ type: string; data_json: string }>;
  db.close();
  console.log(`\n  --- session diagnostics (${rows.length} events) ---`);
  let oodaInjected = 0;
  for (const r of rows) {
    let d: any = {}; try { d = JSON.parse(r.data_json); } catch { /* */ }
    if (r.type === 'ooda_cycle') { oodaInjected = Math.max(oodaInjected, Number(d.observationsInjected) || 0); console.log(`  OODA reorient observationsInjected=${d.observationsInjected} objective="${(d.objective || '').slice(0, 50)}"`); }
    else if (r.type === 'tool_called') console.log(`  TOOL ${d.tool}  ${(d.arguments || '').slice(0, 80)}`);
    else if (r.type === 'conversation_completed') console.log(`  DONE reason=${d.reason ?? '-'} summary=${(d.summary || '').slice(0, 90)}`);
    else if (r.type === 'goal_validation') console.log(`  VALIDATE pass=${d.pass} reason=${(d.reason || '').slice(0, 80)}`);
    else if (r.type === 'run_failed' || r.type === 'guardrail_tripped' || r.type === 'awaiting_user_input') console.log(`  ${r.type.toUpperCase()} ${JSON.stringify(d).slice(0, 110)}`);
  }
  console.log('  --- end diagnostics ---\n');

  const g = getPlanProposal(goalId);
  info(`final: status=${g?.status} resumeCount=${g?.resumeCount} fileExists=${existsSync(file)}`);

  assert.ok((g?.resumeCount ?? 0) >= 1, 'the goal should have self-resumed at least once');
  ok(`goal self-resumed ${g?.resumeCount}× with no human input`);

  assert.ok(oodaInjected >= 1, 'an ooda_cycle event should record observationsInjected ≥ 1 (the live reader fed the resume)');
  ok(`re-Orient injected ${oodaInjected} fresh observation(s) into a real resume (ooda_cycle telemetry)`);

  assert.ok(existsSync(file), 'the resumed model turn should have written the deliverable file');
  const contents = readFileSync(file, 'utf-8');
  assert.ok(contents.includes(token), `the model should have written the injected observation (token ${token}); got: ${contents.slice(0, 80)}`);
  ok('the real model turn ACTED on the injected observation (wrote its token into the deliverable)');

  assert.ok(!contents.includes(TANGENTIAL_WORD), `the tangential "${TANGENTIAL_WORD}" item must be filtered out; file: ${contents.slice(0, 80)}`);
  ok('the tangential observation was correctly filtered out (objective-overlap relevance held)');

  passedAll = true;
  console.log('\n=== LIVE RE-ORIENT SMOKE PASSED ===\n');
} catch (err) {
  console.error(`\n✗ LIVE RE-ORIENT SMOKE FAILED: ${(err as Error).message}\n`);
} finally {
  await cleanup();
  ok('cleaned up throwaway goal + session + file + seeded notifications (nothing left behind)');
}
process.exit(passedAll ? 0 : 1);
