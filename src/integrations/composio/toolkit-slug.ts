import { CURATED_TOOLKITS, listCachedToolkits } from './client.js';

function genericToolkitOfSlug(toolSlug: string): string {
  return toolSlug.trim().toLowerCase().replace(/[-\s]+/g, '_').split('_')[0] ?? '';
}

/**
 * Resolve a Composio action to the longest registered toolkit prefix.
 * Multiword providers such as `one_drive` must not collapse to `one`; unknown
 * providers retain the generic first-token fallback for open-ended discovery.
 */
/**
 * Exact membership: is this token itself a registered provider toolkit?
 *
 * `registeredToolkitOfSlug` always returns something (it falls back to the
 * first token), so it cannot answer this. Callers that must distinguish a
 * curated provider namespace from an arbitrary user-chosen name — e.g. a
 * native MCP server slug, which is whatever the user called the server — need
 * exact membership, not a longest-prefix guess.
 */
export function isRegisteredToolkitSlug(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (!normalized) return false;
  return [...CURATED_TOOLKITS, ...listCachedToolkits()]
    .some((entry) => entry.slug.trim().toLowerCase().replace(/[-\s]+/g, '_') === normalized);
}

export function registeredToolkitOfSlug(toolSlug: string): string {
  const normalizedTool = toolSlug.trim().toLowerCase().replace(/[-\s]+/g, '_');
  const known = [...new Set(
    [...CURATED_TOOLKITS, ...listCachedToolkits()]
      .map((entry) => entry.slug.trim().toLowerCase().replace(/[-\s]+/g, '_'))
      .filter(Boolean),
  )].sort((a, b) => b.length - a.length);
  return known.find((slug) =>
    normalizedTool === slug || normalizedTool.startsWith(`${slug}_`))
    ?? genericToolkitOfSlug(toolSlug);
}
