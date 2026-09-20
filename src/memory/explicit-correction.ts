/** Preserve correction intent when a curated memory paraphrases the user's
 * "Correction:" as an explicit replacement of a previous saved convention. */
export function isExplicitCorrectionText(text: string): boolean {
  return /\bcorrection\b|\b(?:wrong|incorrect|stale|outdated)\b.{0,120}\b(?:actually|instead|correct|use|valid)\b|\b(?:actually|instead|no longer)\b.{0,120}\b(?:wrong|incorrect|stale|outdated|valid|current|correct)\b|\b(?:replaces?|replacing|supersedes?)\s+(?:(?:the|my|our|a|an)\s+)?(?:previous|prior|old|saved)\b/i.test(text);
}
