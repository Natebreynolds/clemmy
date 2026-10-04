/** Settings → Models wording for the quick-check role. Both apps use these strings. */
export const QUICK_ROLE_WORDS = {
  title: 'Quick checks',
  explain: 'Reads what a message asks before work starts, such as whether it continues an earlier task. A fast model keeps these checks from slowing your reply.',
  /** The note beside Automatic: what Clem picks when the owner has not. */
  automatic: 'Automatic uses a fast model from the same provider as Does the work.',
} as const;

/** What the daemon says about the checker: whether it is independent of the
 *  work, whether it could be, and what an Automatic backup would use. */
export interface CheckerFacts {
  reviewsOwnFamily: boolean;
  otherFamilyConnected: boolean;
  automaticBackups: Array<{ modelId: string; provider: string }>;
}

/** Settings → Models wording for Checks the work and its backup. Both apps use these strings. */
export const CHECKER_ROLE_WORDS = {
  /** Beside Automatic when the checker comes from another provider. */
  automaticIndependent: 'Automatic uses a fast model from a different provider than the one doing the work.',
  /** When the owner's choice leaves the checker reviewing its own provider's
   *  work although another provider could check it. */
  sameFamilyWarning: 'The checker comes from the same provider as the work, so the check is less independent. Pick a checker from a different provider.',
  /** The backup on Automatic when nothing else could stand in. */
  backupNone: 'Nothing else is connected that could stand in, so a review the checker cannot finish is reported as not checked.',
} as const;

const CHECKER_FAMILY_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

/** Beside Automatic when only the work's own provider is connected. */
export function checkerOnlyProviderText(provider: string): string {
  const name = CHECKER_FAMILY_NAME[provider] ?? 'your API-key provider';
  return `Only ${name} is connected, so the same provider does the work and checks it. Connect another provider for a more independent check.`;
}

/** The note beside Automatic for Checks the work, or null when the warning
 *  below says it instead. */
export function checkerAutomaticText(facts: CheckerFacts | null | undefined, checkerProvider: string): string | null {
  if (!facts || !facts.reviewsOwnFamily) return CHECKER_ROLE_WORDS.automaticIndependent;
  return facts.otherFamilyConnected ? null : checkerOnlyProviderText(checkerProvider);
}

/** A warning only when another provider could check the work and the checker
 *  reviews its own provider's work anyway. */
export function checkerSameFamilyWarning(facts: CheckerFacts | null | undefined): string | null {
  return facts?.reviewsOwnFamily && facts.otherFamilyConnected ? CHECKER_ROLE_WORDS.sameFamilyWarning : null;
}

/** The Automatic backup's option label: the model it would use, or that there is none. */
export function checkerBackupAutomaticLabel(facts: CheckerFacts | null | undefined, name: (modelId: string) => string): string {
  if (!facts) return 'Automatic';
  const first = facts.automaticBackups[0];
  return first ? `Automatic · ${name(first.modelId)}` : 'Automatic · nothing else connected';
}

/** Under Checks the work once Jev, the typed fast checker, has answered first. */
export function jevFirstChecksText(count: number): string {
  return `Jev answered first on ${count} ${count === 1 ? 'check' : 'checks'}; this model backs it up.`;
}
