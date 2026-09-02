/**
 * Leaf registry for provider carrier completers: no imports, so providers and
 * the neutral seam can both depend on it without a module cycle.
 */
export interface ProvenCompletionEntry {
  kind: string;
  identifier: string;
  effectClass?: string;
}

export interface CarrierCompletion {
  argumentsJson: string;
  toolSlug: string;
  changes: string[];
}

export type CarrierCompleter = (
  argumentsJson: string,
  provenEntries: readonly ProvenCompletionEntry[],
) => CarrierCompletion | null;

const completers: CarrierCompleter[] = [];

export function registerCarrierCompleter(completer: CarrierCompleter): void {
  if (!completers.includes(completer)) completers.push(completer);
}

/** The first registered provider completer that recognizes the carrier wins;
 * null when no provider claims the shape. */
export function completeCarrierArguments(
  argumentsJson: string,
  provenEntries: readonly ProvenCompletionEntry[],
): CarrierCompletion | null {
  for (const completer of completers) {
    const completed = completer(argumentsJson, provenEntries);
    if (completed) return completed;
  }
  return null;
}
