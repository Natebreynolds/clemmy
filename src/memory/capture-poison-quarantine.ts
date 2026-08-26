import { openMemoryDb, type ConsolidatedFactKind } from './db.js';
import { isHarnessInjectedInput } from '../runtime/harness/objective-judge.js';

/**
 * Read-only inventory for the historical auto-capture leak. This deliberately
 * does not deactivate or delete anything: an operator can review exact ids and
 * provenance first, then use the ordinary memory-forget surface explicitly.
 */
export interface CapturePoisonQuarantineCandidate {
  factId: number;
  kind: ConsolidatedFactKind;
  content: string;
  sourceSessionId: string;
  sourcePath: string;
  active: boolean;
  pinned: boolean;
  trustLevel: number;
  createdAt: string;
  reason: 'trust_1_auto_capture_harness_carrier';
}

export interface CapturePoisonQuarantineReport {
  version: 1;
  scanned: number;
  candidateCount: number;
  activeCandidateCount: number;
  inactiveCandidateCount: number;
  candidates: CapturePoisonQuarantineCandidate[];
}

interface CandidateRow {
  id: number;
  kind: ConsolidatedFactKind;
  content: string;
  source_session_id: string | null;
  source_path: string | null;
  active: number;
  pinned: number;
  trust_level: number | null;
  created_at: string;
}

const CAPTURE_WRAPPERS = [
  'Clementine requirement:',
  'Standing prohibition:',
  'Standing product feedback:',
  'User preference:',
  'User explicitly asked Clementine to remember:',
  'Connected-app context:',
  'Standing instruction:',
  'Standing rule (enforced):',
] as const;

// Consolidated fact text is intentionally bounded, so a long source id can
// truncate the directive before `note in context).`. The opening itself is
// runtime-unique; the auto-capture source path and trust=1 predicates provide
// the other two independent signals used by this report.
const TRUNCATED_PROACTIVE_OUTCOME_FACT_RE =
  /^A [^\n]{1,80} you started from this conversation (?:needs your input|FAILED|NEEDS ATTENTION|just finished|is BLOCKED)\b/i;

function unwrapCaptureWrapper(content: string): string {
  let value = content.trim();
  for (const wrapper of CAPTURE_WRAPPERS) {
    if (value.toLowerCase().startsWith(wrapper.toLowerCase())) {
      value = value.slice(wrapper.length).trimStart();
      break;
    }
  }
  return value;
}

export function isTrustOneAutoCaptureHarnessCarrier(input: {
  content: string;
  sourcePath: string | null;
  trustLevel: number | null;
}): boolean {
  if (input.trustLevel !== 1) return false;
  if (!input.sourcePath || !/\/auto-capture(?:%3A|:)/i.test(input.sourcePath)) return false;
  const carrier = unwrapCaptureWrapper(input.content);
  return isHarnessInjectedInput(carrier) || TRUNCATED_PROACTIVE_OUTCOME_FACT_RE.test(carrier);
}

/** Deterministic, side-effect-free report sorted by durable fact id. */
export function buildCapturePoisonQuarantineReport(
  db = openMemoryDb(),
): CapturePoisonQuarantineReport {
  const rows = db.prepare(`
    SELECT id, kind, content, source_session_id, source_path,
           active, pinned, trust_level, created_at
      FROM consolidated_facts
     WHERE source_path IS NOT NULL
       AND source_path LIKE '%auto-capture%'
       AND trust_level = 1.0
     ORDER BY id ASC
  `).all() as CandidateRow[];

  const candidates = rows
    .filter((row) => isTrustOneAutoCaptureHarnessCarrier({
      content: row.content,
      sourcePath: row.source_path,
      trustLevel: row.trust_level,
    }))
    .map((row): CapturePoisonQuarantineCandidate => ({
      factId: row.id,
      kind: row.kind,
      content: row.content,
      sourceSessionId: row.source_session_id ?? '',
      sourcePath: row.source_path ?? '',
      active: row.active === 1,
      pinned: row.pinned === 1,
      trustLevel: row.trust_level ?? 1,
      createdAt: row.created_at,
      reason: 'trust_1_auto_capture_harness_carrier',
    }));

  const activeCandidateCount = candidates.filter((candidate) => candidate.active).length;
  return {
    version: 1,
    scanned: rows.length,
    candidateCount: candidates.length,
    activeCandidateCount,
    inactiveCandidateCount: candidates.length - activeCandidateCount,
    candidates,
  };
}
