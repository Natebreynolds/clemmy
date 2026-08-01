/** Advisory-only cost signal for large fan-outs. This module intentionally
 * contains no conversational pause or execution gate. */
/** Heavy per-item tool advisory (live 2026-07-23): a 120-account run planned a
 *  BROWSER SESSION per item — the most expensive per-item path there is — and
 *  only a mid-run human steer ("skip the screenshots") saved it. Deterministic
 *  and advisory-only (inform, never block): when a large fan-out's packet
 *  names browser/screenshot-class tools, the FIRST batch result carries one
 *  cost note nudging toward a batch API or a single reused session. */
const HEAVY_PER_ITEM_TOOL_RE = /\b(?:browser_harness_run|browser_harness|screenshot|playwright|puppeteer)\b/i;
const HEAVY_ADVISORY_MIN_ITEMS = 10;
const heavyAdvisorySessions = new Set<string>();

export function maybeHeavyPerItemToolAdvisory(
  sessionId: string | undefined,
  itemCount: number,
  packetText: string,
): string | null {
  if (!sessionId || itemCount < HEAVY_ADVISORY_MIN_ITEMS) return null;
  if (!HEAVY_PER_ITEM_TOOL_RE.test(packetText)) return null;
  if (heavyAdvisorySessions.has(sessionId)) return null;
  heavyAdvisorySessions.add(sessionId);
  return `[cost advisory] This fan-out runs a browser/screenshot-class tool PER ITEM (${itemCount} items) — the most expensive per-item path. If the goal is page content, a batch scrape API (one call for all items) or a single reused browser session is dramatically cheaper and faster. Proceeding is fine if per-item browser rendering is genuinely required; otherwise re-plan the packet now, before the batch runs.`;
}

export function _resetHeavyAdvisoryForTests(): void {
  heavyAdvisorySessions.clear();
}
