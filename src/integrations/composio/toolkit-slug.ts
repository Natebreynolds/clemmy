import { CURATED_TOOLKITS, listCachedToolkits } from './client.js';

function genericToolkitOfSlug(toolSlug: string): string {
  return toolSlug.trim().toLowerCase().replace(/[-\s]+/g, '_').split('_')[0] ?? '';
}

/**
 * Resolve a Composio action to the longest registered toolkit prefix.
 * Multiword providers such as `one_drive` must not collapse to `one`; unknown
 * providers retain the generic first-token fallback for open-ended discovery.
 */
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
