/**
 * Host-owned surface for an already-frozen expected-work contract.
 *
 * The graph names topology. This module never invents a proposal and never
 * changes cardinality. It only (1) tells the carrier the contract is already
 * frozen, and (2) names a unique proven how when memory or the connected
 * catalog can do so without guessing.
 */
import { documentedComposioOperationSemantic } from '../../integrations/composio/operation-semantics.js';
import { peekToolChoice } from '../../memory/tool-choice-store.js';
import type { AcceptedTaskWorkContractV1 } from './expected-work-contract.js';
import { loadExpectedWorkContract } from './expected-work-contract.js';
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

/** A unique connected create-from-set tool may name the write node. */
export function uniqueCatalogCreateBinding(
  catalogIdentifiers: readonly string[],
): string | null {
  const creates = new Map<string, string>();
  for (const name of catalogIdentifiers) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const semantic = documentedComposioOperationSemantic(trimmed);
    if (semantic?.consequence !== 'create' || !semantic.rootArtifact) continue;
    const family = `${semantic.rootArtifact.provider}:${semantic.rootArtifact.kind}`;
    if (!creates.has(family)) creates.set(family, trimmed);
  }
  return creates.size === 1 ? creates.values().next().value ?? null : null;
}

export function resolveFrozenNodeBindings(input: {
  contract: AcceptedTaskWorkContractV1;
  catalogIdentifiers?: readonly string[];
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
    const catalog = uniqueCatalogCreateBinding(input.catalogIdentifiers ?? []);
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
  sourceStrategyBinding?: TurnSourceStrategyBindingV1;
}): string | null {
  if (!input.frozenContract) return null;
  const bindings = resolveFrozenNodeBindings({
    contract: input.frozenContract,
    catalogIdentifiers: input.catalogIdentifiers,
    sourceStrategyBinding: input.sourceStrategyBinding,
  });
  return [
    formatFrozenWorkAuthority(input.frozenContract),
    formatFrozenNodeBindings(bindings),
  ].filter(Boolean).join(' ');
}
