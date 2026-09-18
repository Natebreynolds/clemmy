/**
 * IS THIS NAME AN OPERATION? — asked of the registries that own operation
 * identity, never of the spelling.
 *
 * Five places had independently decided this by SHAPE, each matching
 * UPPER_SNAKE because that is how composio slugs are spelled: the creation-test
 * gate, the step tool-surface lock, the explicit-operation catalog preparer,
 * and tool_search's own named-operation detection. A reviewed CLI read is
 * lower_snake (`salesforce_sf_soql_query`), so every one of them silently
 * classified it as "not an operation" — and each failure looked different:
 * a workflow that enabled without validating, a step advertised zero tools, a
 * search that answered an exact id with `space_save`.
 *
 * Keep the answer here so the NEXT carrier is covered by construction. Shape
 * survives only as the fallback for names no registry knows yet.
 */
import { listReviewedCliReadDescriptors } from '../runtime/harness/reviewed-cli-read-config.js';
import { currentManifestOperationContract } from '../runtime/harness/current-manifest-operation-semantics.js';
import { CLI_CATALOG, catalogReviewedReadsOf } from '../integrations/cli-catalog/catalog.js';

/** Operation ids are compared as identities: case-insensitive, trimmed. */
export function sameOperationName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** Composio-style provider slugs, kept as the fallback for names no registry
 *  carries yet (a freshly discovered action, an unconfigured toolkit). */
export function looksLikeProviderOperationName(name: string): boolean {
  return /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(name.trim());
}

/** Does a registry carry an operation by this exact name? Best-effort and
 *  sync: a registry that cannot be read here simply identifies nothing. */
export function isKnownOperationName(name: string): boolean {
  const candidate = name.trim();
  if (!candidate) return false;
  try {
    for (const descriptor of listReviewedCliReadDescriptors()) {
      if (descriptor.operationId && sameOperationName(descriptor.operationId, candidate)) return true;
    }
  } catch { /* no provisioned reviewed-read registry here */ }
  try {
    // The shipped CLI catalog declares its reviewed reads in source, so this
    // answer does not depend on a home having been reconciled yet.
    for (const entry of CLI_CATALOG) {
      for (const read of catalogReviewedReadsOf(entry)) {
        if (read.operationId && sameOperationName(read.operationId, candidate)) return true;
      }
    }
  } catch { /* the shipped catalog names no operation here */ }
  try {
    return Boolean(currentManifestOperationContract(candidate));
  } catch {
    return false;
  }
}

/** The operation a query names outright, if any. A registry-known name wins;
 *  otherwise a provider-slug-shaped token, preserving the previous behaviour
 *  for operations no registry carries yet. Returns '' when none. */
export function operationNamedInQuery(query: string): string {
  const tokens = query.match(/[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+/g) ?? [];
  for (const token of tokens) {
    if (isKnownOperationName(token)) return token;
  }
  for (const token of tokens) {
    // The original detector required two or more underscores for a slug.
    if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}$/.test(token)) return token;
  }
  return '';
}
