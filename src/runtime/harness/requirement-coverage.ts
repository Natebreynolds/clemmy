/**
 * Source-bound requirement coverage. Empty, false, missing, and null are not
 * interchangeable postures. Unresolved material requirements refuse admission.
 */
import { createHash } from 'node:crypto';
import { destinationsOf, type AcceptedGoalV1 } from '../graph/accepted-goal.js';

export const REQUIREMENT_COVERAGE_VERSION = 1 as const;

export type CoveragePosture = 'specified' | 'none' | 'unresolved' | 'delegated';

export type CoverageKind =
  | 'objective'
  | 'projection'
  | 'destination'
  | 'transform'
  | 'cardinality'
  | 'verification'
  | 'dependency';

export interface CoverageEntryV1 {
  kind: CoverageKind;
  posture: CoveragePosture;
  note?: string;
}

export interface RequirementCoverageContractV1 {
  version: typeof REQUIREMENT_COVERAGE_VERSION;
  sourceUserSeq: number;
  entries: CoverageEntryV1[];
  digest: string;
}

export type CoverageAdmission =
  | { ok: true; coverage: RequirementCoverageContractV1 }
  | { ok: false; coverage: RequirementCoverageContractV1; unresolved: CoverageKind[] };

function digestOf(entries: readonly CoverageEntryV1[], sourceUserSeq: number): string {
  return createHash('sha256').update(JSON.stringify({ sourceUserSeq, entries })).digest('hex');
}

function analysisRequested(text: string): boolean {
  return /\b(?:derive|analy[sz]e|rank|transform|summarize|audit)\b/i.test(text);
}

export function admitRequirementCoverage(input: {
  sourceUserSeq: number;
  acceptedText: string;
  goal: Pick<AcceptedGoalV1, 'construct' | 'collection' | 'destinations' | 'destination' | 'route'>;
  openDependency?: boolean;
}): CoverageAdmission {
  const sinks = destinationsOf(input.goal);
  const projection = input.goal.collection?.projection ?? [];
  const collect = input.goal.construct === 'collect_then_construct'
    || (input.goal.collection?.count ?? 0) >= 1
    || input.goal.collection?.completeness === 'exhaust';
  const wantsAnalysis = analysisRequested(input.acceptedText);
  const identitySpecified = (input.goal.collection?.identityFields?.length ?? 0) > 0;
  const entries: CoverageEntryV1[] = [
    {
      kind: 'objective',
      posture: input.acceptedText.trim() ? 'specified' : 'unresolved',
    },
    {
      kind: 'projection',
      posture: !collect
        ? 'none'
        : projection.length > 0
          ? 'specified'
          : 'unresolved',
      ...(projection.length > 0 ? { note: projection.join(',') } : {}),
    },
    {
      kind: 'destination',
      posture: sinks.length > 0
        ? 'specified'
        : input.goal.construct === 'none' || input.goal.route === 'retrieve' || input.goal.route === 'direct_reply'
          ? 'none'
          : 'unresolved',
    },
    {
      kind: 'transform',
      posture: !wantsAnalysis
        ? 'none'
        : identitySpecified || sinks.length > 1 || collect
          ? 'specified'
          : 'unresolved',
    },
    {
      kind: 'cardinality',
      posture: input.goal.collection?.completeness === 'exhaust'
        || (input.goal.collection?.count ?? 0) > 0
        ? 'specified'
        : collect
          ? 'unresolved'
          : 'none',
    },
    {
      kind: 'verification',
      posture: sinks.length > 0 ? 'specified' : 'none',
    },
    {
      kind: 'dependency',
      posture: input.openDependency ? 'delegated' : 'none',
    },
  ];
  const coverage: RequirementCoverageContractV1 = {
    version: REQUIREMENT_COVERAGE_VERSION,
    sourceUserSeq: input.sourceUserSeq,
    entries,
    digest: digestOf(entries, input.sourceUserSeq),
  };
  const unresolved = entries.filter((entry) => entry.posture === 'unresolved').map((entry) => entry.kind);
  if (unresolved.length > 0) return { ok: false, coverage, unresolved };
  return { ok: true, coverage };
}
