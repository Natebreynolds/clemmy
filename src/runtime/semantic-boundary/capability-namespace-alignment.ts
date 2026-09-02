/**
 * Presentation-only provider namespace alignment.
 *
 * Namespace descriptors are authored by capability adapters. This module
 * knows nothing about providers, operation naming conventions, transports, or
 * effects. It may only refuse a selected namespace when the durable accepted
 * source explicitly names a different adapter-declared namespace. It never
 * grants capability, account, schema, or dispatch authority.
 */

export interface CapabilityNamespaceDescriptorV1 {
  version: 1;
  namespaceId: string;
  aliases: readonly string[];
}

export interface CapabilityNamespaceConflictV1 {
  requestedNamespaces: readonly string[];
  selectedNamespace: string;
}

function namespaceWords(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Single-token calendar prose. Same class as one- and two-letter aliases:
 * ordinary English, not an explicit adapter namespace. Live 2026-08-29
 * "What's on my calendar Monday" matched a Monday.com toolkit alias and
 * refused Outlook (`requested_namespaces=monday:selected_namespace=outlook`)
 * for ~20 plan_task retries. A multiword alias such as "monday com" still
 * counts as an explicit Monday.com mention.
 */
const ORDINARY_CALENDAR_PROSE = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
  'today', 'tomorrow', 'tonight', 'yesterday',
]);

function isUnambiguousNamespaceAlias(alias: string): boolean {
  if (alias.length < 3) return false;
  if (!alias.includes(' ') && ORDINARY_CALENDAR_PROSE.has(alias)) return false;
  return true;
}

function normalizedNamespaceId(value: string): string {
  return value.trim().toLowerCase().replace(/[-\s]+/g, '_');
}

function normalizedInventory(
  descriptors: readonly CapabilityNamespaceDescriptorV1[],
): Map<string, readonly string[]> {
  const aliasesById = new Map<string, Set<string>>();
  for (const descriptor of descriptors) {
    if (descriptor.version !== 1) continue;
    const namespaceId = normalizedNamespaceId(descriptor.namespaceId);
    if (!namespaceId) continue;
    const aliases = aliasesById.get(namespaceId) ?? new Set<string>();
    for (const raw of [descriptor.namespaceId, ...descriptor.aliases]) {
      const alias = namespaceWords(raw);
      if (isUnambiguousNamespaceAlias(alias)) aliases.add(alias);
    }
    if (aliases.size > 0) aliasesById.set(namespaceId, aliases);
  }
  return new Map(
    [...aliasesById.entries()].map(([id, aliases]) => [id, [...aliases].sort()]),
  );
}

export function explicitCapabilityNamespaceConflict(input: {
  acceptedText: string;
  namespaceInventory: readonly CapabilityNamespaceDescriptorV1[];
  selectedNamespaceIds: readonly string[];
}): CapabilityNamespaceConflictV1 | null {
  const inventory = normalizedInventory(input.namespaceInventory);
  if (inventory.size === 0) return null;
  const accepted = ` ${namespaceWords(input.acceptedText)} `;
  const requested = new Set<string>();
  for (const [namespaceId, aliases] of inventory) {
    if (aliases.some((alias) => accepted.includes(` ${alias} `))) {
      requested.add(namespaceId);
    }
  }
  // Provider-neutral language cannot manufacture a namespace restriction.
  if (requested.size === 0) return null;
  const selected = [...new Set(
    input.selectedNamespaceIds.map(normalizedNamespaceId).filter(Boolean),
  )].sort();
  // A request that names TWO OR MORE adapters is explicitly cross-app, and this
  // matcher only recognizes a namespace spelled the adapter's way — a user
  // naming a sheet by its URL, or informally, is invisible to it. Enforcing
  // strict scoping there refuses ordinary work with no exit: live 2026-09-02
  // (platform-49 cleanup, "check Slack ... fix the Google Sheet" with a
  // docs.google.com link) matched `slack` and `daily` but not `googlesheets`,
  // so the one namespace the task had to write to was refused as a conflict,
  // three times, until the no-progress governor ended the turn. No plan the
  // model can write satisfies that.
  //
  // So: abstain once the ask names several adapters, and keep the strict guard
  // exactly where it was built for — a SINGLE-adapter request that must not
  // quietly fan out to an unnamed provider (ask for Outlook, get Slack).
  if (requested.size > 1) return null;
  const conflict = selected.find((namespaceId) => !requested.has(namespaceId));
  return conflict
    ? {
        requestedNamespaces: [...requested].sort(),
        selectedNamespace: conflict,
      }
    : null;
}
