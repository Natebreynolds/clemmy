const SAVED_MEMORY_CORRECTION_LEADER_RE = /^\s*(?:small\s+)?correction\s+to\s+(?:my|our|the)\s+(?:saved|stored)\s+(?:[a-z-]+\s+){0,3}(?:preferences?|rules?|facts?|memory|conventions?)\b[^:\n]{0,240}:\s*/i;

export function savedMemoryCorrectionClaim(text: string): string | null {
  const leader = SAVED_MEMORY_CORRECTION_LEADER_RE.exec(text);
  return leader ? text.slice(leader[0].length).trim() : null;
}
