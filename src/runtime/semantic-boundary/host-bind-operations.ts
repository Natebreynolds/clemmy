/**
 * HOST-BIND — bind what admission already decided.
 *
 * Live 2026-08-19 sess-mszlpidc: semantics ADMITTED collect_then_construct
 * (N=5, create_new google_sheets, judge entailed) and left `operations: []`
 * ("pending resolution"). The compiler drew retrieve→fanout→reduce→execute as
 * SHADOW labels, every operationId null, and dispatch fell through to the
 * vendor pipe — which spent its first action on a refused tool_search. An
 * admitted act construct with no bound operations is a HOST bind failure, not
 * a user question and not a reason to send the model hunting.
 *
 * This module is the host's bind pass: from the catalog registered for THIS
 * source (proof-provisioned, connected, schema-frozen), select the
 * goal-carrying capabilities — a read that can return the set, a write whose
 * frozen schema accepts the collected rows, the host projection between them,
 * and the read-back on the created resource — and synthesize the exact
 * operations shape the compiler already binds. Selection is schema-grounded
 * (compileProofProviderArgs must succeed on a probe), family-checked for the
 * destination, and NEVER falls back to cross-goal recency: a proven Slack
 * send from a cron workflow does not carry a spreadsheet goal. When the
 * catalog cannot carry the goal, return null — the dispatcher fails CLOSED
 * as blocked instead of tool_search theater.
 */
import type { RegisteredHostCapability } from '../harness/host-capability-catalog-factory.js';
import { catalogEntriesForAcceptedSource } from '../harness/indexed-capability-catalog.js';
import { getCachedToolSchema } from '../../tools/composio-schema-cache.js';
import { compileProofProviderArgs } from '../harness/proof-provider-args.js';
import type { GraphNodeInvocationEnvelopeV1 } from '../harness/graph-node-envelope.js';

export interface HostBoundOperation {
  id: string;
  role: string;
  requestedEffect: 'read' | 'host_only' | 'external_write' | 'local_write';
  capabilityRef: string;
  dependsOn: readonly string[];
  evidence: readonly string[];
}

const ACT_CONSTRUCTS = new Set(['collect_then_construct', 'fanout', 'collect', 'single_act']);

export function normalizedFamily(family: string | undefined): string {
  const value = (family ?? '').trim().toLowerCase();
  if (!value) return '';
  return /sheet|workbook|excel|spreadsheet/.test(value) ? 'workbook' : value;
}

function probeEnvelope(input: {
  objective: string;
  count?: number;
  fields?: readonly string[];
  predecessors?: GraphNodeInvocationEnvelopeV1['predecessors'];
}): GraphNodeInvocationEnvelopeV1 {
  return {
    version: 1,
    identity: { sessionId: 'host-bind-probe', sourceUserSeq: 0, acceptedTaskId: 'task:host-bind-probe#0' },
    goal: { objective: input.objective, revision: 0, criteria: [] },
    node: { id: 'probe', role: 'probe' },
    cardinality: input.count
      ? { count: input.count, fields: [...(input.fields ?? [])] }
      : null,
    predecessors: input.predecessors ?? [],
    expectedOutput: { kind: 'evidence' },
    binding: { capabilityId: 'probe', manifestDigest: 'probe', schemaDigest: 'probe', effect: 'read' },
  } as GraphNodeInvocationEnvelopeV1;
}

function schemaOf(entry: RegisteredHostCapability): Record<string, unknown> | null {
  const schema = getCachedToolSchema(entry.toolName);
  return schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : null;
}

function hasRole(entry: RegisteredHostCapability, role: string): boolean {
  return entry.advisoryRoles?.includes(role) === true;
}

/**
 * Synthesize bound operations for an admitted act construct whose proposal
 * left operations empty. Returns null when the registered catalog cannot
 * carry the goal — the caller must fail closed, never fall to legacy.
 */
export function synthesizeConstructOperations(goal: {
  construct: string;
  objective: string;
  destinationFamily?: string;
  destinationFamilies?: readonly string[];
  effectCeiling: string;
  count?: number;
  fields?: readonly string[];
  /** The accepted source whose PROOF scopes the selectable catalog. */
  identity: { sessionId: string; sourceUserSeq: number };
}): HostBoundOperation[] | null {
  try {
    if (!ACT_CONSTRUCTS.has(goal.construct)) return null;
    if (goal.effectCeiling !== 'external_write' && goal.effectCeiling !== 'local_write' && goal.effectCeiling !== 'admin') {
      // A construct that creates a destination needs write authority admitted.
      return null;
    }
    // THIS source's catalog: frozen snapshot ∩ adapter-attested entries
    // selected for this accepted source (connected registry / this-turn
    // resolution). Index hits are not bind authority.
    const entries = catalogEntriesForAcceptedSource({
      sessionId: goal.identity.sessionId,
      sourceUserSeq: goal.identity.sourceUserSeq,
      objective: goal.objective,
    });
    const wantedFamilies = [
      ...new Set(
        (goal.destinationFamilies && goal.destinationFamilies.length > 0
          ? goal.destinationFamilies
          : goal.destinationFamily
            ? [goal.destinationFamily]
            : []).map((family) => normalizedFamily(family)).filter(Boolean),
      ),
    ];
    const wantedFamily = wantedFamilies[0] ?? '';

    const searchRead = entries.find((entry) => {
      if (entry.effect !== 'read' || !(hasRole(entry, 'source') || hasRole(entry, 'collection'))) return false;
      const schema = schemaOf(entry);
      if (!schema) return false;
      return compileProofProviderArgs({
        schema,
        role: 'source',
        effect: 'read',
        payload: undefined,
        envelope: probeEnvelope({ objective: goal.objective, count: goal.count, fields: goal.fields }),
      }) !== null;
    });

    const rowCreate = entries.find((entry) => {
      if (entry.effect !== 'external_write' && entry.effect !== 'local_write') return false;
      if (!(hasRole(entry, 'create') || hasRole(entry, 'destination'))) return false;
      const entryFamily = normalizedFamily(entry.destination?.family ?? entry.manifest?.destination?.family);
      if (wantedFamily && entryFamily && entryFamily !== wantedFamily) return false;
      const schema = schemaOf(entry);
      if (!schema) return false;
      // The goal's collection must land in this write: the frozen schema has
      // to accept the collected rows (an array member or a JSON-string member).
      return compileProofProviderArgs({
        schema,
        role: 'create',
        effect: 'external_write',
        payload: [{ probe: 'row' }],
        envelope: probeEnvelope({ objective: goal.objective, count: goal.count, fields: goal.fields }),
      }) !== null;
    });

    const transform = entries.find((entry) => entry.effect === 'host_only'
      && (hasRole(entry, 'transform') || hasRole(entry, 'extract')));

    const readback = entries.find((entry) => {
      if (entry.effect !== 'read' || !hasRole(entry, 'readback')) return false;
      const schema = schemaOf(entry);
      if (!schema) return false;
      return compileProofProviderArgs({
        schema,
        role: 'readback',
        effect: 'read',
        payload: undefined,
        envelope: probeEnvelope({
          objective: goal.objective,
          predecessors: [{ nodeId: 'probe-create', role: 'create', value: { id: 'probe-id' } }],
        }),
      }) !== null;
    });

    if (!searchRead || !rowCreate || !transform || !readback) return null;
    const writeForFamily = (family: string) => entries.find((entry) => {
      if (entry.effect !== 'external_write' && entry.effect !== 'local_write') return false;
      if (!(hasRole(entry, 'create') || hasRole(entry, 'destination'))) return false;
      const entryFamily = normalizedFamily(entry.destination?.family ?? entry.manifest?.destination?.family);
      if (family && entryFamily && entryFamily !== family) return false;
      const schema = schemaOf(entry);
      if (!schema) return false;
      return compileProofProviderArgs({
        schema,
        role: 'create',
        effect: 'external_write',
        payload: [{ probe: 'row' }],
        envelope: probeEnvelope({ objective: goal.objective, count: goal.count, fields: goal.fields }),
      }) !== null;
    });
    const writeEffectOf = (entry: typeof rowCreate): HostBoundOperation['requestedEffect'] => (
      entry.effect === 'local_write' ? 'local_write' : 'external_write'
    );
    const operations: HostBoundOperation[] = [
      { id: 'op-source', role: 'source', requestedEffect: 'read', capabilityRef: searchRead.capabilityId, dependsOn: [], evidence: ['source-locator'] },
      { id: 'op-collect', role: 'collection', requestedEffect: 'read', capabilityRef: searchRead.capabilityId, dependsOn: ['op-source'], evidence: ['collection'] },
      { id: 'op-transform', role: 'transform', requestedEffect: 'host_only', capabilityRef: transform.capabilityId, dependsOn: ['op-collect'], evidence: ['lineage'] },
    ];
    const families = wantedFamilies.length > 0 ? wantedFamilies : [wantedFamily];
    let previousWriteId = 'op-transform';
    const usedCreateIds = new Set<string>();
    for (const [index, family] of families.entries()) {
      const create = index === 0 ? rowCreate : writeForFamily(family);
      if (!create || (usedCreateIds.has(create.capabilityId) && index > 0)) {
        if (index === 0) continue;
        return null;
      }
      usedCreateIds.add(create.capabilityId);
      const writeId = index === 0 ? 'op-write' : `op-write-${index}`;
      const readbackId = index === 0 ? 'op-readback' : `op-readback-${index}`;
      operations.push({
        id: writeId,
        role: 'destination',
        requestedEffect: writeEffectOf(create),
        capabilityRef: create.capabilityId,
        dependsOn: index === 0 ? ['op-transform'] : ['op-transform', previousWriteId],
        evidence: ['create-receipt'],
      });
      operations.push({
        id: readbackId,
        role: 'readback',
        requestedEffect: 'read',
        capabilityRef: readback.capabilityId,
        dependsOn: [writeId],
        evidence: ['readback'],
      });
      previousWriteId = writeId;
    }
    if (!operations.some((operation) => operation.role === 'destination')) return null;
    return operations;
  } catch {
    // Bind failure is a blocked outcome for the dispatcher, never a crash.
    return null;
  }
}
