/**
 * Smoke: the unified report-back (Move 4).
 *
 * Proves that EVERY async lane (background task + workflow run) reports back to
 * the origin conversation through ONE mechanism (deliverOutcome) with the SAME
 * card structure — done / blocked / failed — and that delivery is idempotent.
 * Runs against a throwaway CLEMENTINE_HOME; no daemon, no model, no network.
 *
 * Run: npx tsx scripts/smoke-unified-report-back.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-smoke-reportback-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  createBackgroundTask,
  markBackgroundTaskDone,
  markBackgroundTaskBlocked,
  markBackgroundTaskFailed,
} = await import('../src/execution/background-tasks.js');
const { enqueueWorkflowOutcomeTurn } = await import('../src/execution/workflow-runner.js');
const { SessionStore } = await import('../src/memory/session-store.js');

function show(sessionId: string, label: string): void {
  const turns = new SessionStore().get(sessionId).turns
    .filter((t) => typeof t.text === 'string' && (t.text.startsWith('[background task ') || t.text.startsWith('[workflow run ')));
  console.log(`\n────────── ${label} (origin session: ${sessionId}) ──────────`);
  for (const t of turns) console.log(`\n[role=${t.role}]\n${t.text}`);
}

let pass = 0;
let fail = 0;
const check = (cond: boolean, msg: string) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };

// ── Background lane ─────────────────────────────────────────────────────────
const S = 'sess-smoke-bg';
const done = createBackgroundTask({ title: 'Send the weekly digest', prompt: 'do it', originSessionId: S });
markBackgroundTaskDone(done.id, 'Sent the digest to 42 recipients. /exports/digest-2026-06-03.html');

const blocked = createBackgroundTask({ title: 'Sync Airtable CRM', prompt: 'do it', originSessionId: S });
markBackgroundTaskBlocked(blocked.id, 'Airtable base not created (workspace 404)', 'tried to create the base, got 404');

const failed = createBackgroundTask({ title: 'Pull SEO metrics', prompt: 'do it', originSessionId: S });
markBackgroundTaskFailed(failed.id, 'DataForSEO returned HTTP 500 after 3 retries', 'failed');

show(S, 'BACKGROUND LANE');

// ── Workflow lane (same origin session) ─────────────────────────────────────
const W = 'sess-smoke-wf';
enqueueWorkflowOutcomeTurn({ id: 'wf-aaa', workflow: 'morning-prep' as never, originSessionId: W }, 'morning-prep', 'done', 'Prepared 8 prospect briefs. /exports/briefs/');
enqueueWorkflowOutcomeTurn({ id: 'wf-bbb', workflow: 'enrich-crm' as never, originSessionId: W }, 'enrich-crm', 'blocked', 'Step 2 flagged 3 prospects missing contact emails');
enqueueWorkflowOutcomeTurn({ id: 'wf-ccc', workflow: 'deploy-site' as never, originSessionId: W }, 'deploy-site', 'failed', 'netlify deploy exited non-zero');

show(W, 'WORKFLOW LANE');

// ── Assertions ──────────────────────────────────────────────────────────────
const bgTurns = new SessionStore().get(S).turns.filter((t) => typeof t.text === 'string' && t.text.startsWith('[background task '));
const wfTurns = new SessionStore().get(W).turns.filter((t) => typeof t.text === 'string' && t.text.startsWith('[workflow run '));

check(bgTurns.length === 3, 'background lane delivered 3 outcome cards');
check(wfTurns.length === 3, 'workflow lane delivered 3 outcome cards');
check(bgTurns.every((t) => t.role === 'user'), 'all outcome turns are role:user (re-enter the conversation)');
check(bgTurns.some((t) => /completed]/.test(t.text)) && bgTurns.some((t) => /BLOCKED]/.test(t.text)) && bgTurns.some((t) => /FAILED]/.test(t.text)), 'background covers done/blocked/failed');
check(wfTurns.some((t) => /completed]/.test(t.text)) && wfTurns.some((t) => /needs attention]/.test(t.text)) && wfTurns.some((t) => /FAILED]/.test(t.text)), 'workflow covers done/needs-attention/failed');
// Both lanes share the same body grammar: a trailing parenthetical guidance.
check([...bgTurns, ...wfTurns].every((t) => /\(.+\)\s*$/.test(t.text.trim())), 'every card shares the same structure (guidance parenthetical)');

// Idempotency: re-deliver the done task — must NOT double-post.
markBackgroundTaskDone(done.id, 'Sent the digest to 42 recipients.');
const afterRetry = new SessionStore().get(S).turns.filter((t) => typeof t.text === 'string' && t.text.startsWith(`[background task ${done.id} `));
check(afterRetry.length === 1, 'idempotent — a retried completion does not double-post');

console.log(`\n══════════════════════════════════════════════════════════════`);
console.log(`Unified report-back smoke: ${pass} checks passed, ${fail} failed.`);
rmSync(TMP_HOME, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
