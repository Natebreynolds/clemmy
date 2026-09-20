/** Preserve the index's relevance scale. Ambient context should not promote a
 * weak recent artifact into evidence merely because it is a deliverable.
 * Targeted memory searches retain weak candidates for deliberate inspection.
 */
export function deliverableRecallScore(score: number, missing: boolean, ambient: boolean): number | null {
  if (!Number.isFinite(score)) return null;
  const calibrated = Math.max(0, Math.min(missing ? 0.4 : 0.95, score));
  // A relevant missing file is useful negative evidence (do not search for it
  // again). Apply relevance admission before capping its confidence.
  return ambient && score < 0.45 ? null : calibrated;
}

/** An explicitly named artifact is relevant regardless of surrounding prose.
 * Do not match a filename prefix or a token inside another path/name.
 */
export function explicitlyNamesDeliverable(query: string, target: string): boolean {
  if (target.length < 4) return false;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s"'\x60(])${escaped}(?=$|[\\s"'\x60),;:!?]|\\.(?:\\s|$))`, 'i').test(query);
}
