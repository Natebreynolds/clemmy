/**
 * Read the harness's own freshness notice out of its command output.
 *
 * The harness prints `update available: 0.1.0 -> 0.1.8` from doctor and smoke
 * runs. Parsing that is deliberately the ONLY source of truth here: keeping a
 * latest-version list in the console would go stale beside the tool it
 * describes, and the tool already knows.
 */
export function browserHarnessUpdateNotice(output: string): { from: string; to: string } | null {
  const match = /update available:\s*([0-9][\w.-]*)\s*->\s*([0-9][\w.-]*)/i.exec(output ?? '');
  return match ? { from: match[1]!, to: match[2]! } : null;
}
