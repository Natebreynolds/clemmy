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

const gatewayPredicates: Array<(toolName: string) => boolean> = [];

/** A provider registers how to recognize its own gateway tool name (the
 * direct carrier a sealed workflow step calls), without the kernel naming it. */
export function registerCarrierGatewayPredicate(predicate: (toolName: string) => boolean): void {
  if (!gatewayPredicates.includes(predicate)) gatewayPredicates.push(predicate);
}

export function isRegisteredCarrierGateway(toolName: string): boolean {
  return gatewayPredicates.some((predicate) => predicate(toolName));
}

/** Complete a DIRECT gateway call (`tool = <gateway>`, `args = <inner>`), the
 * shape a sealed workflow step uses, by lifting it into the wrapper form the
 * completers understand and lowering the result back. */
export function completeDirectCarrierArguments(
  toolName: string,
  argumentsJson: string,
  provenEntries: readonly ProvenCompletionEntry[],
): CarrierCompletion | null {
  const completed = completeCarrierArguments(
    JSON.stringify({ name: toolName, args_json: argumentsJson }),
    provenEntries,
  );
  if (!completed) return null;
  try {
    const outer = JSON.parse(completed.argumentsJson) as { args_json?: unknown };
    if (typeof outer.args_json !== 'string') return null;
    return { ...completed, argumentsJson: outer.args_json };
  } catch {
    return null;
  }
}
