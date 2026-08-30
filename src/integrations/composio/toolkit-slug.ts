import { CURATED_TOOLKITS, listCachedToolkits, peekConnectedToolkits } from './client.js';

import type {
  CapabilityNamespaceDescriptorV1,
} from '../../runtime/semantic-boundary/capability-namespace-alignment.js';

function genericToolkitOfSlug(toolSlug: string): string {
  return toolSlug.trim().toLowerCase().replace(/[-\s]+/g, '_').split('_')[0] ?? '';
}

function normalizedToolkit(value: string): string {
  return value.trim().toLowerCase().replace(/[-\s]+/g, '_');
}

/** Adapter-owned presentation namespaces for source/capability alignment.
 * These names can only veto a mismatched plan; they are never execution or
 * discovery authority. The live cached catalog extends the bootstrap list, so
 * the semantic kernel does not need a provider-name allowlist. */
export function listRegisteredToolkitNamespaces(): CapabilityNamespaceDescriptorV1[] {
  const byId = new Map<string, Set<string>>();
  for (const toolkit of [...CURATED_TOOLKITS, ...listCachedToolkits()]) {
    const namespaceId = normalizedToolkit(toolkit.slug);
    if (!namespaceId) continue;
    const aliases = byId.get(namespaceId) ?? new Set<string>();
    const displayName = 'displayName' in toolkit ? toolkit.displayName : toolkit.name;
    const declaredAliases = 'namespaceAliases' in toolkit
      && Array.isArray(toolkit.namespaceAliases)
      ? toolkit.namespaceAliases
      : [];
    for (const alias of [
      toolkit.slug.replace(/_/g, ' '),
      displayName,
      ...displayName.split('/'),
      ...declaredAliases,
    ]) {
      if (alias.trim()) aliases.add(alias.trim());
    }
    byId.set(namespaceId, aliases);
  }
  // A newly connected open-catalog toolkit can be usable before the broader
  // catalog cache has ever been written. Its provider-owned connection slug is
  // still an exact namespace identity; include that slug without inventing a
  // display name from operation text.
  for (const connection of peekConnectedToolkits()) {
    const namespaceId = normalizedToolkit(connection.slug);
    if (!namespaceId) continue;
    const aliases = byId.get(namespaceId) ?? new Set<string>();
    aliases.add(connection.slug.replace(/_/g, ' '));
    byId.set(namespaceId, aliases);
  }
  return [...byId.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([namespaceId, aliases]) => ({
      version: 1,
      namespaceId,
      aliases: [...aliases].sort(),
    }));
}

/** Exact adapter-declared namespace for one operation, or null when the
 * current provider inventory cannot prove the prefix. */
export function registeredToolkitNamespaceOfOperation(toolSlug: string): string | null {
  const normalizedTool = normalizedToolkit(toolSlug);
  if (!normalizedTool) return null;
  return listRegisteredToolkitNamespaces()
    .map((entry) => entry.namespaceId)
    .sort((left, right) => right.length - left.length)
    .find((namespaceId) => (
      normalizedTool === namespaceId || normalizedTool.startsWith(`${namespaceId}_`)
    )) ?? null;
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
  const normalized = normalizedToolkit(value);
  if (!normalized) return false;
  return listRegisteredToolkitNamespaces()
    .some((entry) => entry.namespaceId === normalized);
}

export function registeredToolkitOfSlug(toolSlug: string): string {
  return registeredToolkitNamespaceOfOperation(toolSlug) ?? genericToolkitOfSlug(toolSlug);
}
