/**
 * Stable identity for a unit of fan-out work.
 *
 * Live 2026-07-31: a prospecting run scraped six firms two or three times across
 * dispatch waves, burning the API budget it then got rate-limited on. Nothing
 * was broken — the harness simply could not tell that three dispatches were the
 * same work, because both existing matchers key on things that DRIFT:
 *
 *   - `packetKey` is minted per dispatch, so every wave produced a new one;
 *   - the item LABEL was rewritten each wave — "Colucci, Colucci & Marcus |
 *     position 12", "Colucci Colucci & Marcus, P.C. | SERP corpus", "Colucci,
 *     Colucci & Marcus, P.C." — and one firm even changed apostrophe characters
 *     between waves (d'Oliveira with a straight quote, then a curly one), which
 *     silently defeats any name-based comparison.
 *
 * What did NOT drift, in every duplicated case, was the DOMAIN. So identity is
 * the registrable host when the item carries a URL, and a hard-normalized text
 * fold otherwise. Both apostrophe forms, punctuation, and case collapse to the
 * same key, which is also the "dedupe on domain, not name" fix the run report
 * asked for — one mechanism, both defects.
 *
 * Pure and dependency-free.
 */

/** Unicode punctuation that varies between keyboards, autocorrect, and copy-paste. */
const SMART_PUNCTUATION = /[‘’‚‛′‵“”„‟″‶‐-―−]/g;

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/i;
const BARE_HOST_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|co|law|us|biz|info|dev|app|ai|gov|edu)\b/i;

function normalizeHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '');
}

/** The registrable host named by an item, or null. */
export function targetHost(item: string): string | null {
  const text = (item ?? '').trim();
  if (!text) return null;
  const url = URL_RE.exec(text)?.[0];
  if (url) {
    try {
      return normalizeHost(new URL(url).hostname) || null;
    } catch {
      /* malformed URL — fall through to the bare-host scan */
    }
  }
  const bare = BARE_HOST_RE.exec(text)?.[0];
  return bare ? normalizeHost(bare) : null;
}

/**
 * Identity key for a work item. Two dispatches with the same key are the same
 * work, however differently they were phrased. Returns '' for an item too empty
 * to identify — callers must treat '' as "no identity", never as a match.
 */
export function workerTargetIdentity(item: string): string {
  const host = targetHost(item);
  if (host) return `host:${host}`;
  const folded = (item ?? '')
    .normalize('NFKD')
    .replace(SMART_PUNCTUATION, "'")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return folded ? `text:${folded}` : '';
}

/** True when two items denote the same unit of work. */
export function sameWorkerTarget(a: string, b: string): boolean {
  const left = workerTargetIdentity(a);
  return left !== '' && left === workerTargetIdentity(b);
}
