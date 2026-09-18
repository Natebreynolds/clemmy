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
import {
  isCurrentCallableCatalogEntry,
  peekHostCapabilityCatalogFactory,
} from '../runtime/harness/host-capability-catalog-factory.js';
import type { CapabilityProviderKind } from '../runtime/harness/capability-manifest.js';
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

/** Is this name a REVIEWED CLI read — an operation performed by a local binary,
 *  never by a provider connection? Uppercasing such a name can make it look
 *  like a composio slug (`salesforce_sf_soql_query` → `SALESFORCE_SF_SOQL_QUERY`,
 *  whose leading token is a registered toolkit), which is how a local CLI read
 *  came to be refused for having "no current salesforce connection". */
export function isReviewedCliOperationName(name: string): boolean {
  const candidate = name.trim();
  if (!candidate) return false;
  try {
    for (const descriptor of listReviewedCliReadDescriptors()) {
      if (descriptor.operationId && sameOperationName(descriptor.operationId, candidate)) return true;
    }
  } catch { /* no provisioned reviewed-read registry here */ }
  try {
    for (const entry of CLI_CATALOG) {
      for (const read of catalogReviewedReadsOf(entry)) {
        if (read.operationId && sameOperationName(read.operationId, candidate)) return true;
      }
    }
  } catch { /* the shipped catalog names no operation here */ }
  return false;
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

/**
 * THE ONE QUESTION. What is this operation, and what performs it?
 *
 * Answered from what an operation DECLARES — the reviewed-read descriptor
 * registry, the shipped CLI catalog, and the current callable catalog — never
 * from how its name is spelled. The 21 shape tests catalogued in
 * docs/SPELLING-IS-NOT-IDENTITY-PLAN-2026-09-18.md each collapse into a call
 * to this, branching on the declared `providerKind` / `effect`.
 *
 * There is deliberately NO shape fallback. A name no registry carries is not an
 * operation; inventing one from spelling is the defect this replaces. Callers
 * that still need "does this look like a composio slug" for a composio-only
 * path keep `looksLikeProviderOperationName` — narrow, and never a universal
 * type test.
 */
export interface OperationIdentityV1 {
  readonly operationId: string;
  readonly providerKind: CapabilityProviderKind;
  readonly effect: string;
}

export function operationIdentity(name: string): OperationIdentityV1 | null {
  const candidate = String(name ?? '').trim();
  if (!candidate) return null;

  // A current callable entry is the richest answer: it carries the manifest
  // that declares both carrier and effect.
  try {
    const current = (peekHostCapabilityCatalogFactory()?.snapshot() ?? [])
      .filter(isCurrentCallableCatalogEntry)
      .filter((entry) => sameOperationName(entry.manifest.operationId, candidate));
    // Two current entries for one operation are two ACCOUNTS. They agree on
    // identity when they agree on carrier and effect; disagreement fails closed
    // rather than choosing.
    if (current.length > 0) {
      const kinds = new Set(current.map((entry) => entry.manifest.providerKind));
      const effects = new Set(current.map((entry) => entry.manifest.effect));
      if (kinds.size === 1 && effects.size === 1) {
        const entry = current[0]!;
        return Object.freeze({
          operationId: entry.manifest.operationId,
          providerKind: entry.manifest.providerKind,
          effect: entry.manifest.effect,
        });
      }
      return null;
    }
  } catch { /* no callable catalog here */ }

  // A reviewed CLI read is an operation before it is ever provisioned into the
  // catalog: the descriptor registry and the shipped catalog both declare it,
  // and both declare effect 'read' explicitly.
  try {
    for (const descriptor of listReviewedCliReadDescriptors()) {
      if (descriptor.operationId && sameOperationName(descriptor.operationId, candidate)) {
        return Object.freeze({
          operationId: descriptor.operationId,
          providerKind: 'reviewed_cli' as const,
          effect: descriptor.effect,
        });
      }
    }
  } catch { /* no provisioned reviewed-read registry here */ }
  try {
    for (const entry of CLI_CATALOG) {
      for (const read of catalogReviewedReadsOf(entry)) {
        if (read.operationId && sameOperationName(read.operationId, candidate)) {
          return Object.freeze({
            operationId: read.operationId,
            providerKind: 'reviewed_cli' as const,
            effect: 'read',
          });
        }
      }
    }
  } catch { /* the shipped catalog names no operation here */ }

  return null;
}

/**
 * The carrier that performs an operation, from what its manifest DECLARES.
 *
 * One table, defined once, replacing the per-site guesses that read a carrier
 * out of a name's spelling. `provider_carrier` is the composio gateway;
 * everything else the host performs locally reaches execution through the
 * call_tool dispatcher. A caller that has no local dispatcher mounted must
 * mount one — it must not re-derive a different answer from the name.
 */
export function carrierForProviderKind(
  providerKind: CapabilityProviderKind,
): 'call_tool' | 'provider_carrier' {
  return providerKind === 'composio' ? 'provider_carrier' : 'call_tool';
}
