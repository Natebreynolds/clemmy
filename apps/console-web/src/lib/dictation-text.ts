/** Joins dictated words onto the draft the owner had when they started. */
export function dictatedDraft(base: string, heard: string): string {
  const words = heard.trim();
  if (!words) return base;
  return `${base}${base && !/\s$/.test(base) ? ' ' : ''}${words}`;
}
