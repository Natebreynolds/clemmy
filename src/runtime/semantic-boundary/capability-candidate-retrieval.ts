/**
 * Host-owned bounded candidate retrieval. Ranking uses sealed kind/purpose
 * contracts only. User phrasing never authorizes or selects a provider.
 */
import type { HostCapabilityDescriptorV1 } from './turn-semantic-proposal.js';
import { boundHostCapabilityDescriptors } from './turn-semantic-proposal.js';

export const BETA_CANDIDATE_LIMIT = 8;

const VERTICAL_PURPOSE_RANK: Record<string, number> = {
  locate_source: 50,
  /** The single direct read (single_act lookup) ranks beside source location. */
  lookup_records: 45,
  collect_records: 40,
  project_records: 30,
  persist_collection: 20,
  verify_created_resource: 10,
};

function scoreDescriptor(descriptor: HostCapabilityDescriptorV1): number {
  const purpose = VERTICAL_PURPOSE_RANK[descriptor.purpose] ?? 0;
  const kinds = descriptor.producedOutputKinds.length + descriptor.acceptedInputKinds.length;
  return purpose * 100 + kinds;
}

export function selectRelevantCapabilityDescriptors(
  descriptors: readonly HostCapabilityDescriptorV1[],
  limit = BETA_CANDIDATE_LIMIT,
): HostCapabilityDescriptorV1[] {
  const ranked = [...descriptors].sort((left, right) => {
    const delta = scoreDescriptor(right) - scoreDescriptor(left);
    if (delta !== 0) return delta;
    return left.id.localeCompare(right.id);
  });
  return boundHostCapabilityDescriptors(ranked.slice(0, limit));
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
