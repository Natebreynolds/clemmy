/**
 * Host-owned bounded candidate retrieval. The shown set is the attested
 * catalog, stably ordered by id, then byte-bounded. User phrasing never
 * authorizes or selects a provider, and purpose ranks never hide a contract.
 */
import type { HostCapabilityDescriptorV1 } from './turn-semantic-proposal.js';
import { boundHostCapabilityDescriptors } from './turn-semantic-proposal.js';

export const BETA_CANDIDATE_LIMIT = 32;

export function selectRelevantCapabilityDescriptors(
  descriptors: readonly HostCapabilityDescriptorV1[],
  limit = BETA_CANDIDATE_LIMIT,
): HostCapabilityDescriptorV1[] {
  const stable = [...descriptors].sort((left, right) => left.id.localeCompare(right.id));
  return boundHostCapabilityDescriptors(stable.slice(0, limit));
}

export function hostViewCatalogFromDescriptors(
  descriptors: readonly HostCapabilityDescriptorV1[],
  limit = BETA_CANDIDATE_LIMIT,
): {
  capabilities: HostCapabilityDescriptorV1[];
  capabilityIds: string[];
} {
  const capabilities = selectRelevantCapabilityDescriptors(descriptors, limit);
  return {
    capabilities,
    capabilityIds: capabilities.map((entry) => entry.id),
  };
}
