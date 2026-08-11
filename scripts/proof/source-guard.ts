export const DIRTY_DEV_EVIDENCE_BANNER =
  '⚠️  DEV EVIDENCE ONLY — sourceClean=false — results are not release or tag evidence.';

export type ProofSourceGuardDecision =
  | {
      allowed: true;
      sourceClean: true;
      devEvidence: false;
    }
  | {
      allowed: true;
      sourceClean: false;
      devEvidence: true;
      warning: string;
    }
  | {
      allowed: false;
      sourceClean: false;
      devEvidence: false;
      error: string;
    };

/**
 * Keep release proof fail-closed while permitting an explicit working-tree run
 * for development feedback. Dirty development runs remain visibly ineligible
 * as release/tag evidence and retain sourceClean=false in their report.
 */
export function decideProofSourceGuard(
  dirtyStatus: string,
  allowDirtyDev: boolean,
): ProofSourceGuardDecision {
  const dirty = dirtyStatus.trim();
  if (!dirty) {
    return { allowed: true, sourceClean: true, devEvidence: false };
  }
  if (allowDirtyDev) {
    return {
      allowed: true,
      sourceClean: false,
      devEvidence: true,
      warning: DIRTY_DEV_EVIDENCE_BANNER,
    };
  }
  return {
    allowed: false,
    sourceClean: false,
    devEvidence: false,
    error: `Live proof requires one reproducible candidate commit. Commit the intended source first (no tag required).\n${dirty.slice(0, 4_000)}`,
  };
}
