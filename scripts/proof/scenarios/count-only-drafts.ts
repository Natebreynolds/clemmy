/**
 * count-only-drafts: the live re-baseline for the proposal-validator tax.
 *
 * The flagship live failure (2026-08-11): "draft 5 emails from this data"
 * burned 159 calls / 16 minutes and produced zero drafts — every valid
 * count-only contract contained an operation that could never be admitted
 * until the sealed-source universe seam existed. This scenario is that ask,
 * hermetic: a NATURAL count-only prompt (no manifest vocabulary, no tool
 * names) over local files only. It must finish with all five drafts on disk
 * within a hard canonical-call ceiling, without a refusal spiral.
 *
 * Ground truth is the filesystem, not the reply text — a confident summary
 * over zero files is exactly the failure this pins.
 */
import { mkdirSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { narrationCheck, openHarnessDb, sessionMetrics, stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';
import { PROOF_CLIENT_COMPLETION_TIMEOUT_MS } from '../timeouts.js';

const RECORDS = [
  { Id: 'lead-001', company: 'Harbor & Vale LLP', lastTouch: 'asked for pricing two weeks ago' },
  { Id: 'lead-002', company: 'Cedarline Physical Therapy', lastTouch: 'went quiet after the demo' },
  { Id: 'lead-003', company: 'Bright Anchor Dental', lastTouch: 'wanted a case study' },
  { Id: 'lead-004', company: 'Kestrel Roofing Co', lastTouch: 'budget freeze until this month' },
  { Id: 'lead-005', company: 'Juniper Family Law', lastTouch: 'new decision maker joined' },
];

/** Generous versus the ~6-business-call floor (1 read + 5 writes), brutal
 * versus the 159-call live incident. The re-baseline number Nathan's tag
 * standard cares about. */
const CALL_CEILING = 30;
/** A couple of pre-freeze corrections are legitimate; a spiral is not. */
const REFUSAL_CEILING = 6;

export const countOnlyDrafts: ScenarioDef = {
  name: 'count-only-drafts',
  summary: 'natural "one draft per record" ask → 5 files on disk, ≤30 canonical calls, no refusal spiral',
  async run(daemon: DaemonHandle) {
    const nonce = Date.now().toString(36);
    const workspace = path.join(daemon.home, 'proof-workspace');
    const draftsDir = path.join(workspace, 'drafts');
    const leadsFile = path.join(workspace, 'leads.json');
    mkdirSync(draftsDir, { recursive: true });
    writeFileSync(leadsFile, `${JSON.stringify(RECORDS, null, 2)}\n`, 'utf8');
    // The provisioned home sets no WORKSPACE_DIRS; claim the proof workspace
    // as the sole file-tool root so the read and the writes are in-policy.
    appendFileSync(path.join(daemon.home, '.env'), `\nWORKSPACE_DIRS=${workspace}\n`);

    const sessionId = `proof-countonly-${nonce}`;
    const startedAt = Date.now();
    const turn = await daemon.chat(
      [
        `Read the 5 lead records in ${leadsFile} and write one short follow-up draft for each lead as its own text file in ${draftsDir} — include the lead's id in its filename and tailor each draft to that lead's situation.`,
        'Local files only: no email, no connected apps, no browsing. Do not ask me anything first — do it now and tell me when all five drafts are written.',
      ].join('\n'),
      sessionId,
      PROOF_CLIENT_COMPLETION_TIMEOUT_MS,
    );
    const wallMs = Date.now() - startedAt;

    const checks: Check[] = [];
    checks.push({ name: 'HTTP 200', pass: turn.httpStatus === 200, detail: `status ${turn.httpStatus}` });
    checks.push({ name: 'reply is nonempty', pass: turn.text.trim().length > 0, detail: turn.text.slice(0, 120) });

    // Ground truth: five draft files, each traceable to a lead id.
    let files: string[] = [];
    try { files = readdirSync(draftsDir).filter((f) => !f.startsWith('.')); } catch { files = []; }
    const coveredIds = RECORDS.filter((r) => files.some((f) => f.includes(r.Id)));
    checks.push({
      name: 'all 5 drafts exist on disk, one per lead id',
      pass: coveredIds.length === RECORDS.length,
      detail: `covered ${coveredIds.length}/${RECORDS.length}; files=[${files.join(', ').slice(0, 200)}]`,
    });

    // The budget the tag standard cares about, from the durable ledger.
    const db = openHarnessDb(daemon.home);
    let calls = -1;
    let refusalEvents = 0;
    try {
      const metrics = sessionMetrics(db, turn.sessionId || sessionId);
      calls = metrics?.toolCallTotal ?? -1;
      const row = db.prepare(
        `SELECT COUNT(*) AS n FROM events
         WHERE session_id = ?
           AND (data_json LIKE '%work_contract_invalid%'
             OR data_json LIKE '%work_binding_required%'
             OR data_json LIKE '%work_contract_missing%')`,
      ).get(turn.sessionId || sessionId) as { n: number };
      refusalEvents = row?.n ?? 0;
    } finally {
      db.close();
    }
    checks.push({
      name: `canonical calls within the ${CALL_CEILING}-call ceiling`,
      pass: calls >= 0 && calls <= CALL_CEILING,
      detail: `${calls} canonical calls · wall ${(wallMs / 1000).toFixed(0)}s (live incident baseline: 159 calls / 16 min)`,
    });
    checks.push({
      name: 'no work-contract refusal spiral',
      pass: refusalEvents <= REFUSAL_CEILING,
      detail: `${refusalEvents} contract-refusal events (ceiling ${REFUSAL_CEILING})`,
    });

    checks.push(narrationCheck(turn.text));
    checks.push(stormCheck(daemon.log()));

    return {
      checks,
      latency: [{ wallMs, ttftMs: null }],
      sessionId: turn.sessionId || sessionId,
      metrics: { calls, refusalEvents, draftFiles: files.length },
    };
  },
};
