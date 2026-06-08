/**
 * Live smoke for the natural-voice workflow report-back.
 * Calls the real fast model via the harness runtime on real-shaped report
 * bodies and prints what Clementine would actually say to the user.
 *
 *   npx tsx scripts/smoke-voice-rewrite.ts
 *
 * Verifies: (1) a routine no-op triage is warmed AND flagged nothingHappened
 * (so it goes dashboard-only), (2) a run that did work is warm but NOT a no-op,
 * (3) a failure is warm, honest, keeps its `apply fix <id>` step, and is never
 * a no-op.
 */
import { configureHarnessRuntime } from '../src/runtime/harness/codex-client.js';
import { rewriteInClementineVoice } from '../src/execution/voice-rewrite.js';

const NOOP_TRIAGE = `Outlook triage complete.

No qualifying unread Inbox emails were found using the bounded UTC filter window (last 24h). 0 messages matched the triage criteria. No actions were taken. Next scheduled run: tomorrow 08:00.`;

const DID_WORK_TRIAGE = `Outlook triage complete.

Processed 4 unread Inbox messages. 2 archived as newsletters, 1 categorized as Finance, 1 flagged as needing your reply: "Contract renewal — Acme (due Fri)" from j.smith@acme.com. No drafts were sent.`;

const FAILURE = `Workflow "Daily SEO baseline" failed at step 2 (fetch_metrics).

Error: DataForSEO request returned status_code 40501 (rate limit exceeded) after 3 retries. The run was aborted before producing a report.

Self-heal proposed a fix. Reply \`apply fix seo-4f2a\` to retry with backoff.`;

async function main() {
  const configured = await configureHarnessRuntime();
  if (!configured.ok) {
    console.error(`✗ harness runtime not configured: ${configured.reason}`);
    process.exit(1);
  }

  const cases: Array<{ label: string; body: string; lane: 'done' | 'blocked' | 'failed'; expectNoOp: boolean }> = [
    { label: 'no-op triage (should be silent)', body: NOOP_TRIAGE, lane: 'done', expectNoOp: true },
    { label: 'triage that did work', body: DID_WORK_TRIAGE, lane: 'done', expectNoOp: false },
    { label: 'workflow failure', body: FAILURE, lane: 'failed', expectNoOp: false },
  ];

  let failures = 0;
  for (const c of cases) {
    const out = await rewriteInClementineVoice(c.body, { workflowName: 'smoke', lane: c.lane });
    const noOpOk = out.nothingHappened === c.expectNoOp;
    // For the failure case, the retry step must survive the rewrite.
    const retryOk = c.lane !== 'failed' || /apply fix seo-4f2a/.test(out.message);
    const changed = out.message.trim() !== c.body.trim();
    console.log(`\n================ ${c.label} ================`);
    console.log(`lane=${c.lane}  nothingHappened=${out.nothingHappened} (expected ${c.expectNoOp}) ${noOpOk ? '✓' : '✗'}`);
    console.log(`rewritten=${changed ? 'yes' : 'NO (fell back to original)'}  retryStepKept=${retryOk ? '✓' : '✗ MISSING'}`);
    console.log('---');
    console.log(out.message);
    if (!noOpOk) { console.error(`  ✗ nothingHappened mismatch`); failures++; }
    if (!retryOk) { console.error(`  ✗ apply-fix step dropped`); failures++; }
  }

  console.log(`\n${failures === 0 ? '✓ all voice checks passed' : `✗ ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
