/**
 * Host-owned surface for an already-frozen expected-work contract.
 *
 * The graph names topology. This module never invents a proposal and never
 * changes cardinality. It only (1) tells the carrier the contract is already
 * frozen, and (2) names a unique proven how when memory or the connected
 * catalog can do so without guessing.
 */
import { peekToolChoice } from '../../memory/tool-choice-store.js';
import { TOOL_REGISTRY } from '../../tools/tool-registry.js';
import type { AcceptedTaskWorkContractV1 } from './expected-work-contract.js';
import { loadExpectedWorkContract } from './expected-work-contract.js';
import { getTurnGraphEventForSource } from './eventlog.js';
import { turnGraphFromShadowEvent } from '../graph/turn-graph-shadow.js';
import {
  isCurrentCallableCatalogEntry,
  peekHostCapabilityCatalogFactory,
} from './host-capability-catalog-factory.js';
import {
  validatedTurnSourceStrategyBinding,
  type TurnSourceStrategyBindingV1,
} from './turn-control.js';

export const FROZEN_NODE_READ_INTENT = 'graph-node:collect-then-construct:read';
export const FROZEN_NODE_WRITE_INTENT = 'graph-node:collect-then-construct:write';

export interface FrozenNodeToolBinding {
  requirementId: string;
  identifier: string;
  source: 'source_strategy' | 'memory_pin' | 'catalog_semantic';
}

/** Provider-neutral create candidate. `bindingIdentity` distinguishes two
 * accounts/definitions that happen to expose the same operation spelling. */
export interface FrozenCatalogBindingDescriptorV1 {
  identifier: string;
  bindingIdentity: string;
  effect: 'local_write' | 'external_write' | 'read' | 'admin' | 'other';
  destinationFamily: string | null;
  destinationPosture: 'create_new' | 'named_existing' | null;
}

/** Exact-intent structural pins, never fuzzy recall of the user's sentence. */
export function frozenNodePinIntent(effect: 'read' | 'write'): string {
  return effect === 'read' ? FROZEN_NODE_READ_INTENT : FROZEN_NODE_WRITE_INTENT;
}

function healthyPinnedIdentifier(intent: string): string | null {
  const pin = peekToolChoice(intent);
  const choice = pin?.choice;
  if (!choice) return null;
  const identifier = choice.identifier?.trim();
  if (!identifier) return null;
  if ((choice.failureCount ?? 0) > (choice.successCount ?? 0)) return null;
  return identifier;
}

export function loadBoundExpectedWorkContract(
  sessionId: string | undefined,
  sourceUserSeq: number | undefined,
): AcceptedTaskWorkContractV1 | null {
  if (!sessionId || !Number.isSafeInteger(sourceUserSeq) || (sourceUserSeq ?? 0) <= 0) {
    return null;
  }
  const loaded = loadExpectedWorkContract(sessionId, sourceUserSeq as number);
  return loaded.status === 'ok' ? loaded.contract : null;
}

/** Exact single create sink from the same durable graph frozen into the work
 * contract. Multiple/no create sinks are intentionally not a binding hint. */
export function frozenCreateDestinationFamily(
  contract: AcceptedTaskWorkContractV1,
): string | null {
  const graph = turnGraphFromShadowEvent(getTurnGraphEventForSource(
    contract.identity.sessionId,
    contract.identity.sourceUserSeq,
  ));
  if (
    !graph
    || graph.graphId !== contract.graphId
    || graph.compiler.graphHash !== contract.graphHash
    || graph.identity.turn !== contract.identity.turn
  ) return null;
  const goal = graph.classification.goalConstraints;
  const destinations = goal?.destinations?.length
    ? goal.destinations
    : goal?.destination
      ? [goal.destination]
      : [];
  const createFamilies = [...new Set(destinations
    .filter((destination) => destination.posture === 'create_new')
    .map((destination) => destination.family.trim())
    .filter(Boolean))];
  return createFamilies.length === 1 ? createFamilies[0]! : null;
}

function formatOperationLine(operation: AcceptedTaskWorkContractV1['operations'][number]): string {
  const coverage = operation.coverage ? ` coverage=${operation.coverage}` : '';
  const cardinality = operation.cardinality.kind === 'each'
    ? ` each:${operation.cardinality.universeId}`
    : operation.cardinality.kind === 'set'
      ? ` set:${operation.cardinality.universeId}`
      : ' once';
  const depends = operation.dependsOn.length > 0
    ? ` dependsOn=${operation.dependsOn.join(',')}`
    : '';
  return `- ${operation.id}: ${operation.effect}${coverage}${cardinality}${depends}`;
}

export function formatFrozenWorkAuthority(contract: AcceptedTaskWorkContractV1): string {
  return [
    'The host already froze this turn\'s work contract. Do not propose a new topology.',
    'Every work_call uses proposal:null and binds one of these exact requirement ids:',
    ...contract.operations.map(formatOperationLine),
  ].join('\n');
}

function descriptorsForCatalogIdentifiers(
  catalogIdentifiers: readonly string[],
): FrozenCatalogBindingDescriptorV1[] {
  const requested = new Set(catalogIdentifiers.map((name) => name.trim()).filter(Boolean));
  const descriptors: FrozenCatalogBindingDescriptorV1[] = [];
  for (const entry of peekHostCapabilityCatalogFactory()?.snapshot() ?? []) {
    const manifest = entry.manifest;
    if (!manifest || (!requested.has(entry.toolName) && !requested.has(manifest.operationId))) continue;
    if (!isCurrentCallableCatalogEntry(entry)) continue;
    descriptors.push({
      identifier: entry.toolName,
      bindingIdentity: entry.manifestDigest,
      effect: manifest.effect === 'local_write' || manifest.effect === 'external_write'
        || manifest.effect === 'read' || manifest.effect === 'admin'
        ? manifest.effect
        : 'other',
      destinationFamily: manifest.destination?.family?.trim() || null,
      destinationPosture: manifest.destination?.posture === 'create_new'
        || manifest.destination?.posture === 'named_existing'
        ? manifest.destination.posture
        : null,
    });
  }
  // Local declarations are adapter-authored descriptors. They can name a how,
  // but the later local-definition revalidation still owns execution authority.
  for (const declaration of TOOL_REGISTRY) {
    if (!requested.has(declaration.name) || !declaration.localPlanning) continue;
    descriptors.push({
      identifier: declaration.name,
      bindingIdentity: `local_registry:${declaration.name}`,
      effect: declaration.sideEffect === 'write'
        ? 'local_write'
        : declaration.sideEffect === 'read'
          ? 'read'
          : declaration.sideEffect === 'admin'
            ? 'admin'
            : 'other',
      destinationFamily: declaration.localPlanning.deliverableKind.trim() || null,
      destinationPosture: declaration.localPlanning.destinationPosture,
    });
  }
  return descriptors;
}

/** A unique sealed/adaptor-authored create capability may name the write node. */
export function uniqueCatalogCreateBinding(
  catalog: readonly (string | FrozenCatalogBindingDescriptorV1)[],
  destinationFamily: string | null | undefined,
): string | null {
  const requiredFamily = String(destinationFamily ?? '').trim();
  if (!requiredFamily) return null;
  const direct = catalog.filter((item): item is FrozenCatalogBindingDescriptorV1 => (
    typeof item !== 'string'
  ));
  const identifiers = catalog.filter((item): item is string => typeof item === 'string');
  const candidates = [...direct, ...descriptorsForCatalogIdentifiers(identifiers)];
  const creates = new Map<string, FrozenCatalogBindingDescriptorV1>();
  for (const descriptor of candidates) {
    if (
      (descriptor.effect !== 'external_write' && descriptor.effect !== 'local_write')
      || descriptor.destinationPosture !== 'create_new'
      || descriptor.destinationFamily !== requiredFamily
      || !descriptor.identifier.trim()
      || !descriptor.bindingIdentity.trim()
    ) continue;
    creates.set(descriptor.bindingIdentity, descriptor);
  }
  return creates.size === 1 ? creates.values().next().value?.identifier ?? null : null;
}

export function resolveFrozenNodeBindings(input: {
  contract: AcceptedTaskWorkContractV1;
  catalogIdentifiers?: readonly string[];
  catalogDescriptors?: readonly FrozenCatalogBindingDescriptorV1[];
  destinationFamily?: string | null;
  sourceStrategyBinding?: TurnSourceStrategyBindingV1;
}): FrozenNodeToolBinding[] {
  const bindings: FrozenNodeToolBinding[] = [];
  const sourceStrategyBinding = validatedTurnSourceStrategyBinding(input.sourceStrategyBinding);
  const primarySourceName = sourceStrategyBinding?.primary.capabilityId
    .match(/^capability:[^:]+:(.+)$/)?.[1]?.trim();
  const collectThenConstruct = input.contract.plannerSource === 'deterministic'
    && input.contract.operations.some((operation) => operation.effect === 'read')
    && input.contract.operations.some((operation) => operation.effect !== 'read')
    && input.contract.operations.every((operation) => (
      operation.effect === 'read' || operation.cardinality.kind === 'once'
    ));
  if (!collectThenConstruct) return bindings;

  for (const operation of input.contract.operations) {
    if (operation.effect === 'read') {
      // Explicit source selection outranks a generic healthy graph-node pin.
      // The latter may describe yesterday's provider (the exact live failure
      // was a DataForSEO pin surviving after the user chose Apify).
      if (primarySourceName) {
        bindings.push({
          requirementId: operation.id,
          identifier: primarySourceName,
          source: 'source_strategy',
        });
        continue;
      }
      const identifier = healthyPinnedIdentifier(frozenNodePinIntent('read'));
      if (identifier) {
        bindings.push({
          requirementId: operation.id,
          identifier,
          source: 'memory_pin',
        });
      }
      continue;
    }
    const writePin = healthyPinnedIdentifier(frozenNodePinIntent('write'));
    if (writePin) {
      bindings.push({
        requirementId: operation.id,
        identifier: writePin,
        source: 'memory_pin',
      });
      continue;
    }
    const catalog = uniqueCatalogCreateBinding(
      [...(input.catalogIdentifiers ?? []), ...(input.catalogDescriptors ?? [])],
      input.destinationFamily,
    );
    if (catalog) {
      bindings.push({
        requirementId: operation.id,
        identifier: catalog,
        source: 'catalog_semantic',
      });
    }
  }
  return bindings;
}

export function formatFrozenNodeBindings(bindings: readonly FrozenNodeToolBinding[]): string {
  if (bindings.length === 0) return '';
  return [
    'Host-bound how for these frozen nodes (use this exact inner name; do not rediscover):',
    ...bindings.map((binding) => `- ${binding.requirementId}: ${binding.identifier}`),
  ].join('\n');
}

export function formatFrozenWorkCallDescription(input: {
  frozenContract?: AcceptedTaskWorkContractV1 | null;
  catalogIdentifiers?: readonly string[];
  catalogDescriptors?: readonly FrozenCatalogBindingDescriptorV1[];
  destinationFamily?: string | null;
  sourceStrategyBinding?: TurnSourceStrategyBindingV1;
}): string | null {
  if (!input.frozenContract) return null;
  const bindings = resolveFrozenNodeBindings({
    contract: input.frozenContract,
    catalogIdentifiers: input.catalogIdentifiers,
    catalogDescriptors: input.catalogDescriptors,
    destinationFamily: input.destinationFamily,
    sourceStrategyBinding: input.sourceStrategyBinding,
  });
  return [
    formatFrozenWorkAuthority(input.frozenContract),
    formatFrozenNodeBindings(bindings),
  ].filter(Boolean).join(' ');
}
