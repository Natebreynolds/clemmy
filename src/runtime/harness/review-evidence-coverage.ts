/** How much of each retained result a review actually covered.
 *
 * A reviewer is shown large results as bounded views and can open the rest.
 * Whether it did is a host fact, recorded per lookup. A verdict names the
 * results it rests on; a result shown only in part supports a statement about
 * what is absent from it, about all of it, or about how many it holds only
 * when the reviewer inspected the rest and the source itself had no further
 * page. A record count or a successful outcome is never that inspection.
 *
 * Nothing here reads the reply or the objective. Which results a verdict
 * rests on is the reviewer's typed answer; what was inspected is the host's
 * record; this module only compares the two. */
import { actionTopologyRoleFor } from '../../tools/tool-registry.js';
import type { JudgeEvidenceLookup } from './judge-evidence-tools.js';

/** The fields of a judged result row that coverage depends on. */
export interface ReviewedEvidenceRow {
  logicalToolCallId?: string;
  toolName: string;
  outcome: string;
  status?: string;
  evidenceKind?: string;
  authoringResult?: boolean;
  contentComplete?: boolean;
  contentDisposition?: string;
  resultHandleId?: string;
  contentDigest?: string;
  rawByteCount?: number;
  shownByteCount?: number;
  /** Records in the retained result's main list. */
  recordCount?: number;
  /** The source said there was nothing more to fetch for this request. */
  sourceExhausted?: boolean;
  /** A write by the same request settled after this read. */
  precedesWrite?: boolean;
  sourceLogicalToolCallId?: string;
  sourceResultHandleId?: string;
}

export type EvidenceInspection =
  /** The whole retained result was in the review. */
  | 'shown'
  /** Shown in part; the reviewer's lookups covered the rest. */
  | 'inspected'
  /** Shown in part; a criterion was checked against every record. */
  | 'queried'
  /** Shown in part; lookups covered some of the rest. */
  | 'partial'
  /** Shown in part; nothing else was opened. */
  | 'unopened';

export interface EvidenceCoverageRow {
  ref: string;
  resultHandleId?: string;
  toolName: string;
  inspection: EvidenceInspection;
  /** The source reported a further page, or never said it was complete. */
  moreAtSource: boolean;
  /** Inspection and source together support a statement about every record. */
  exhaustive: boolean;
  recordCount?: number;
  rawByteCount?: number;
  shownByteCount?: number;
  precedesWrite?: boolean;
  lookups: number;
}

export type ReviewCoverageStatus =
  /** Every result the verdict rests on was inspected in full. */
  | 'sufficient'
  /** The verdict did not say what it rests on, and results were shown in part. */
  | 'unattested'
  /** The verdict rests on a result that was not inspected in full. */
  | 'insufficient';

export interface ReviewCoverageAssessment {
  status: ReviewCoverageStatus;
  rows: EvidenceCoverageRow[];
  /** Results shown in part or with more at the source, whatever they were used for. */
  open: EvidenceCoverageRow[];
  /** Named by the verdict and not exhaustive. */
  unsupported: EvidenceCoverageRow[];
  /** Refs the verdict named that match no judged result. */
  unknownRefs: string[];
  /** What the verdict said it rests on; null when it did not say. */
  restsOn: string[] | null;
}

const succeeded = (row: ReviewedEvidenceRow): boolean => row.outcome === 'succeeded' || row.outcome === 'empty_result';

/** Results whose content can carry a business claim. Discovery, host control,
 * repeated bytes and earlier review windows are receipts, not content. */
function carriesContent(row: ReviewedEvidenceRow): boolean {
  if (!succeeded(row) || row.status !== 'verified') return false;
  if (row.contentDisposition) return false;
  if (row.authoringResult === true) return true;
  if (row.evidenceKind === 'retained_projection') return true;
  return actionTopologyRoleFor(row.toolName) !== 'control';
}

function rowRefs(row: ReviewedEvidenceRow): string[] {
  return [row.logicalToolCallId, row.resultHandleId]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

/** Whether a set of half-open ranges covers [0, total). */
function covers(ranges: ReadonlyArray<readonly [number, number]>, total: number): boolean {
  if (total <= 0) return true;
  let reached = 0;
  for (const [start, end] of [...ranges].sort((left, right) => left[0] - right[0])) {
    if (start > reached) return false;
    reached = Math.max(reached, end);
    if (reached >= total) return true;
  }
  return reached >= total;
}

function inspectionOf(row: ReviewedEvidenceRow, lookups: readonly JudgeEvidenceLookup[]): { inspection: EvidenceInspection; lookups: number } {
  if (row.contentComplete === true) return { inspection: 'shown', lookups: 0 };
  const refs = new Set(rowRefs(row));
  const mine = lookups.filter((lookup) => refs.has(lookup.ref) && !lookup.refused);
  if (mine.length === 0) return { inspection: 'unopened', lookups: 0 };
  const opened = mine.filter((lookup) => lookup.tool === 'open_evidence'
    && typeof lookup.charStart === 'number' && typeof lookup.charEnd === 'number' && typeof lookup.charTotal === 'number');
  if (opened.length > 0 && covers(opened.map((lookup) => [lookup.charStart!, lookup.charEnd!] as const), opened[0]!.charTotal!)) {
    return { inspection: 'inspected', lookups: mine.length };
  }
  const queries = mine.filter((lookup) => lookup.tool === 'query_evidence' && typeof lookup.recordsTotal === 'number');
  // Pages of the same unfiltered list add up. A page returns whole records
  // only, so the range returned is the range read.
  const paged = new Map<string, Array<readonly [number, number]>>();
  for (const query of queries) {
    if (query.filter) continue;
    const key = `${query.recordPath ?? ''}:${query.recordsTotal}`;
    const start = query.offset ?? 0;
    paged.set(key, [...(paged.get(key) ?? []), [start, start + (query.recordsReturned ?? 0)] as const]);
  }
  for (const [key, ranges] of paged) {
    if (covers(ranges, Number(key.slice(key.lastIndexOf(':') + 1)))) return { inspection: 'inspected', lookups: mine.length };
  }
  // A filter is evaluated against every record and reports the true match
  // count, so the criterion was checked exhaustively even though the records
  // outside it were not returned.
  if (queries.some((query) => query.filter)) return { inspection: 'queried', lookups: mine.length };
  return { inspection: 'partial', lookups: mine.length };
}

/** Coverage of every judged result that can carry a claim. */
export function reviewEvidenceCoverage(
  results: readonly ReviewedEvidenceRow[],
  lookups: readonly JudgeEvidenceLookup[] = [],
): EvidenceCoverageRow[] {
  const rows: EvidenceCoverageRow[] = [];
  for (const row of results) {
    if (!carriesContent(row)) continue;
    const ref = row.logicalToolCallId ?? row.resultHandleId;
    if (!ref) continue;
    const { inspection, lookups: used } = inspectionOf(row, lookups);
    // A retained projection is a selected view of another result; whether the
    // source had more pages is a fact about that source row, not this one.
    const moreAtSource = row.evidenceKind === 'retained_projection' ? false : row.sourceExhausted === false;
    rows.push({
      ref,
      ...(row.resultHandleId ? { resultHandleId: row.resultHandleId } : {}),
      toolName: row.toolName,
      inspection,
      moreAtSource,
      exhaustive: !moreAtSource && (inspection === 'shown' || inspection === 'inspected' || inspection === 'queried'),
      ...(typeof row.recordCount === 'number' ? { recordCount: row.recordCount } : {}),
      ...(typeof row.rawByteCount === 'number' ? { rawByteCount: row.rawByteCount } : {}),
      ...(typeof row.shownByteCount === 'number' ? { shownByteCount: row.shownByteCount } : {}),
      ...(row.precedesWrite ? { precedesWrite: true } : {}),
      lookups: used,
    });
  }
  // A complete retained projection of a source result is its inspection: the
  // answerer read the rest, and the review was shown that read whole.
  for (const row of results) {
    if (row.evidenceKind !== 'retained_projection' || row.contentComplete !== true || !succeeded(row)) continue;
    const sources = new Set([row.sourceLogicalToolCallId, row.sourceResultHandleId].filter(Boolean));
    if (sources.size === 0) continue;
    for (const covered of rows) {
      if (covered.inspection !== 'unopened' && covered.inspection !== 'partial') continue;
      if (!sources.has(covered.ref) && !(covered.resultHandleId && sources.has(covered.resultHandleId))) continue;
      covered.inspection = 'queried';
      covered.exhaustive = !covered.moreAtSource;
    }
  }
  return rows;
}

const RESTS_ON_LINE = /^\s*RESTS ON\s*[:\-]\s*(.*)$/im;

/** The results a verdict says it rests on. Null when the verdict did not say;
 * an empty list when it said none. Refs are matched exactly, never guessed. */
export function parseRestsOn(finalOutput: unknown): string[] | null {
  const match = RESTS_ON_LINE.exec(String(finalOutput ?? ''));
  if (!match) return null;
  const listed = (match[1] ?? '').trim();
  if (!listed || /^none\b/i.test(listed)) return [];
  return [...new Set(listed.split(/[\s,;]+/).map((ref) => ref.replace(/^[`"'[(]+|[`"'\]).]+$/g, '')).filter(Boolean))];
}

/** Compare what a verdict rests on with what the review inspected. */
export function assessReviewCoverage(input: {
  results: readonly ReviewedEvidenceRow[];
  lookups?: readonly JudgeEvidenceLookup[];
  restsOn: readonly string[] | null;
}): ReviewCoverageAssessment {
  const rows = reviewEvidenceCoverage(input.results, input.lookups ?? []);
  const open = rows.filter((row) => !row.exhaustive);
  const restsOn = input.restsOn === null ? null : [...input.restsOn];
  if (restsOn === null) {
    return { status: open.length > 0 ? 'unattested' : 'sufficient', rows, open, unsupported: [], unknownRefs: [], restsOn };
  }
  const byRef = new Map<string, EvidenceCoverageRow>();
  for (const row of rows) {
    byRef.set(row.ref, row);
    if (row.resultHandleId) byRef.set(row.resultHandleId, row);
  }
  // A repeated read is listed by receipt and shown once, under the call that
  // first returned those bytes. Resting on the repeat is resting on that view.
  const byDigest = new Map<string, EvidenceCoverageRow>();
  for (const result of input.results) {
    const shown = result.contentDigest && !result.contentDisposition ? byRef.get(result.logicalToolCallId ?? '') : undefined;
    if (shown && !byDigest.has(result.contentDigest!)) byDigest.set(result.contentDigest!, shown);
  }
  for (const result of input.results) {
    if (result.contentDisposition !== 'duplicate_content' || !result.contentDigest) continue;
    const shown = byDigest.get(result.contentDigest);
    if (shown) for (const ref of rowRefs(result)) if (!byRef.has(ref)) byRef.set(ref, shown);
  }
  const known = new Set(input.results.flatMap(rowRefs));
  const unsupported: EvidenceCoverageRow[] = [];
  const unknownRefs: string[] = [];
  for (const ref of restsOn) {
    const row = byRef.get(ref);
    if (row) {
      if (!row.exhaustive && !unsupported.includes(row)) unsupported.push(row);
    } else if (!known.has(ref)) {
      unknownRefs.push(ref);
    }
  }
  return { status: unsupported.length > 0 ? 'insufficient' : 'sufficient', rows, open, unsupported, unknownRefs, restsOn };
}

function describeRow(row: EvidenceCoverageRow): string {
  const size = typeof row.shownByteCount === 'number' && typeof row.rawByteCount === 'number'
    ? `${row.shownByteCount} of ${row.rawByteCount} bytes shown` : 'shown in part';
  const records = typeof row.recordCount === 'number' ? `; ${row.recordCount} records` : '';
  const inspected = row.inspection === 'unopened' ? 'nothing else opened'
    : row.inspection === 'partial' ? `${row.lookups} lookup(s), not covering the rest`
      : row.inspection === 'queried' ? 'every record checked against a criterion'
        : row.inspection === 'inspected' ? 'the rest opened' : 'shown whole';
  return `${row.ref} (${row.toolName}): ${row.inspection === 'shown' ? 'shown whole' : size}${records}; ${inspected}`
    + (row.moreAtSource ? '; the source reported more results than this call returned, or did not say it was complete' : '')
    + (row.precedesWrite ? '; read before a write by this request' : '');
}

/** Listed with the review evidence, so the reviewer knows before it rules
 * which results it has only in part. Undefined when every result is whole. */
export function reviewCoverageLedger(results: readonly ReviewedEvidenceRow[]): string | undefined {
  const open = reviewEvidenceCoverage(results).filter((row) => !row.exhaustive);
  if (open.length === 0) return undefined;
  return [
    'RESULTS YOU HAVE ONLY IN PART (host record):',
    ...open.map((row) => `- ${describeRow(row)}`),
    'A count of records, a successful outcome or a matching schema says nothing about what those records contain.',
  ].join('\n');
}

/** The one follow-up a reviewer receives when its accepted verdict rests on a
 * result it did not inspect in full. */
export function reviewCoverageFollowUp(assessment: ReviewCoverageAssessment): string {
  const rows = assessment.status === 'unattested' ? assessment.open : assessment.unsupported;
  return [
    'COVERAGE CHECK (host record of this review):',
    assessment.status === 'unattested'
      ? 'Your verdict did not say which results it rests on. These were shown to you only in part:'
      : 'Your verdict rests on these results, which you have not inspected in full:',
    ...rows.map((row) => `- ${describeRow(row)}`),
    ...(assessment.unknownRefs.length ? [`These refs match no result under review: ${assessment.unknownRefs.join(', ')}.`] : []),
    '',
    'Decide whether the response, or your verdict, states that something is absent from one of these results, is true of all of it, or counts what it holds. If so, inspect that result now with the evidence tools: query every record for the criterion, or open the rest.',
    'Where a result reports more at its source, no inspection of what was returned can show what the source holds beyond it.',
    'Then give the verdict again in the required format, with its RESTS ON line. When the response makes such a statement and what you inspected does not support it, the verdict is CORRECT, quoting the words.',
  ].join('\n');
}

/** The finding sent back for correction when a reviewer accepted work on a
 * result it never inspected in full, even after being asked to. Written for
 * the assistant that will correct the reply. */
export function reviewCoverageFinding(assessment: ReviewCoverageAssessment): string {
  return assessment.unsupported.map((row, index) => {
    const limit = row.moreAtSource
      ? 'the source reported more results than the call returned, or did not say it was complete'
      : typeof row.recordCount === 'number'
        ? `it holds ${row.recordCount} records and only part of it was read`
        : 'only part of it was read';
    return `(${index + 1}) The review rests on ${row.toolName} [${row.ref}], but ${limit}. `
      + 'Check every record for what the response states (query the retained result, or fetch the remaining pages), '
      + 'or say plainly what was checked and what was not.';
  }).join(' ');
}
