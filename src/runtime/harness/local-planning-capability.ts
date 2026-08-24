/**
 * Exact Clementine-local planning authority.
 *
 * This module turns one tool_search result into a citable plan_task descriptor
 * only when all of the authority-bearing facts come from the host: the exact
 * configured tool, its current deferred-call schema, its current carrier, and
 * an explicit structural registry declaration.  It does not approve or invoke
 * anything.  Dispatch and consent remain later, independent boundaries.
 */
import type { HostCapabilityDescriptorV1 } from '../semantic-boundary/turn-semantic-proposal.js';
import {
  TOOL_REGISTRY,
  type LocalPlanningSemantics,
  type ToolDecl,
} from '../../tools/tool-registry.js';
import { relaxJsonSchemaForDeferred } from '../schema-normalizer.js';
import { digestSchema } from '../../tools/tool-contract-store.js';
import { getTurnGraphEventForSource, listEvents } from './eventlog.js';

export type LocalPlanningCarrier = 'call_tool' | 'work_call';
export const AUTHORIZED_LOCAL_REGISTRY_PROVENANCE = 'authorized_local_registry' as const;

export interface AuthorizedLocalPlanningDefinitionV1 {
  version: 1;
  provenance: typeof AUTHORIZED_LOCAL_REGISTRY_PROVENANCE;
  name: string;
  carrier: LocalPlanningCarrier;
  capabilityRef: string;
  schemaFingerprint: string;
  registrySemanticsFingerprint: string;
  envelopeFingerprint: string;
  consequence: LocalPlanningSemantics['consequence'];
  reversibility: LocalPlanningSemantics['reversibility'];
  destructive: boolean;
  accountIdentity: 'local_registry:host';
  safeMode: LocalPlanningSemantics['safeMode'] | null;
  descriptor: HostCapabilityDescriptorV1;
}

export type LocalPlanningDefinitionResult =
  | { ok: true; definition: AuthorizedLocalPlanningDefinitionV1; schema: Record<string, unknown> }
  | {
      ok: false;
      reason:
        | 'not_configured'
        | 'not_exact_registry_row'
        | 'not_declared'
        | 'not_local_write'
        | 'destructive'
        | 'irreversible_or_unknown'
        | 'carrier_mismatch'
        | 'schema_unavailable'
        | 'safe_mode_not_structural';
    };

interface ConfiguredLocalTool {
  name: string;
  parameters: unknown;
}

type ConfiguredLocalToolObserver = (
  name: string,
) => Promise<ConfiguredLocalTool | null> | ConfiguredLocalTool | null;

let observerOverride: ConfiguredLocalToolObserver | null = null;

async function defaultConfiguredLocalTool(name: string): Promise<ConfiguredLocalTool | null> {
  // Dynamic import avoids the registry -> local-runtime-tools -> plan-tools ->
  // semantic-boundary cycle at module evaluation time. getCoreTools is the
  // actual in-process configured surface used by both primary lanes.
  const { getCoreTools } = await import('../../tools/registry.js');
  const matches = getCoreTools()
    .map((tool) => tool as unknown as { name?: unknown; parameters?: unknown })
    .filter((tool) => tool.name === name);
  if (matches.length !== 1 || typeof matches[0]?.name !== 'string' || !matches[0].parameters) return null;
  return { name: matches[0].name, parameters: matches[0].parameters };
}

async function configuredLocalTool(name: string): Promise<ConfiguredLocalTool | null> {
  return (observerOverride ?? defaultConfiguredLocalTool)(name);
}

/** Test-only exact surface replacement. It changes no registry semantics. */
export function _setConfiguredLocalPlanningToolObserverForTests(
  observer: ConfiguredLocalToolObserver | null,
): void {
  observerOverride = observer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeToken(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._/-]+/g, '_');
  return normalized && /^[a-z0-9][a-z0-9._/-]{0,63}$/.test(normalized) ? normalized : null;
}

function schemaAllowsExact(schema: unknown, expected: string | number | boolean): boolean {
  if (!isRecord(schema)) return false;
  if (schema.const === expected) return true;
  if (Array.isArray(schema.enum) && schema.enum.some((value) => value === expected)) return true;
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.some((branch) => schemaAllowsExact(branch, expected))) return true;
  }
  return false;
}

function structurallyCarriesSafeMode(
  schema: Record<string, unknown>,
  semantics: LocalPlanningSemantics,
): boolean {
  if (semantics.reversibility !== 'create_only') return semantics.safeMode === undefined;
  const safeMode = semantics.safeMode;
  if (!safeMode || !safeToken(safeMode.id)) return false;
  const properties = isRecord(schema.properties) ? schema.properties : null;
  if (!properties) return false;
  for (const [field, expected] of Object.entries(safeMode.requiredEquals)) {
    if (!Object.hasOwn(properties, field) || !schemaAllowsExact(properties[field], expected)) return false;
  }
  for (const field of safeMode.absentOrNull ?? []) {
    if (!Object.hasOwn(properties, field)) return false;
  }
  return true;
}

function declarationCanEnterLocalPlanning(declaration: ToolDecl): boolean {
  const semantics = declaration.localPlanning;
  return declaration.sideEffect === 'write'
    && declaration.runtimeEffect !== 'host_only'
    && semantics !== undefined
    && semantics.destructive === false
    && (semantics.reversibility === 'reversible' || semantics.reversibility === 'create_only');
}

/**
 * Routing eligibility only; this is not planning authority.  The exact current
 * schema and the complete registry/envelope fingerprints are still required by
 * `observeCurrentLocalPlanningDefinition` before a ref can be issued.
 *
 * Every plan-bound mutation uses work_call, including tools whose ordinary
 * graph-neutral topology role is `control`. work_call is the single generic
 * carrier that binds a frozen requirement and reserves its once-cardinality
 * before any inner body can run. The tool's direct/call_tool control surface is
 * deliberately unchanged for graph-neutral uses.
 */
export function isRegistryDeclaredLocalPlanningMutation(name: string): boolean {
  const exact = name.trim();
  if (!exact) return false;
  const matches = TOOL_REGISTRY.filter((entry) => entry.name === exact);
  return matches.length === 1 && declarationCanEnterLocalPlanning(matches[0]!);
}

/**
 * Recover the exact local names already selected into this source's durable
 * graph. This is a carrier-routing fact only: a matching row cannot grant plan,
 * consent, or execution authority, and every later boundary still revalidates
 * the full local definition. Keeping this synchronous lets both local carrier
 * factories preserve graph-neutral controls while routing restart/replay of a
 * selected local requirement back through work_call.
 */
export function durableSelectedLocalPlanningMutationNames(input: {
  sessionId: string;
  sourceUserSeq: number;
}): ReadonlySet<string> {
  try {
    const graphEvent = getTurnGraphEventForSource(input.sessionId, input.sourceUserSeq);
    const graph = graphEvent?.data.graph;
    if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return new Set();
    const nodes = Array.isArray((graph as Record<string, unknown>).nodes)
      ? (graph as Record<string, unknown>).nodes as unknown[]
      : [];
    const selectedRefs = new Set<string>();
    for (const rawNode of nodes) {
      if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) continue;
      const capabilities = Array.isArray((rawNode as Record<string, unknown>).capabilities)
        ? (rawNode as Record<string, unknown>).capabilities as unknown[]
        : [];
      for (const rawCapability of capabilities) {
        if (!rawCapability || typeof rawCapability !== 'object' || Array.isArray(rawCapability)) continue;
        const capability = rawCapability as Record<string, unknown>;
        if (capability.kind !== 'tool' || capability.resolution !== 'explicit') continue;
        for (const ref of Array.isArray(capability.names) ? capability.names : []) {
          if (typeof ref === 'string' && ref.startsWith('cap:local:')) selectedRefs.add(ref);
        }
      }
    }
    if (selectedRefs.size === 0) return new Set();
    const selectedNames = new Set<string>();
    for (const event of listEvents(input.sessionId, { types: ['capability_discovered'] })) {
      if (event.data.sourceUserSeq !== input.sourceUserSeq) continue;
      const rows = Array.isArray(event.data.capabilities) ? event.data.capabilities : [];
      for (const rawRow of rows) {
        if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) continue;
        const row = rawRow as Record<string, unknown>;
        const authority = row.localAuthority;
        if (!authority || typeof authority !== 'object' || Array.isArray(authority)) continue;
        const definition = authority as Record<string, unknown>;
        const name = typeof definition.name === 'string' ? definition.name.trim() : '';
        const ref = typeof definition.capabilityRef === 'string' ? definition.capabilityRef : '';
        if (
          row.providerKind === AUTHORIZED_LOCAL_REGISTRY_PROVENANCE
          && definition.provenance === AUTHORIZED_LOCAL_REGISTRY_PROVENANCE
          && definition.carrier === 'work_call'
          && row.identifier === name
          && row.capabilityRef === ref
          && selectedRefs.has(ref)
          && isRegistryDeclaredLocalPlanningMutation(name)
        ) selectedNames.add(name);
      }
    }
    return selectedNames;
  } catch {
    return new Set();
  }
}

function expectedCarrier(_declaration: ToolDecl): LocalPlanningCarrier {
  return 'work_call';
}

function normalizedSemantics(semantics: LocalPlanningSemantics): LocalPlanningSemantics {
  return {
    consequence: semantics.consequence,
    reversibility: semantics.reversibility,
    destructive: semantics.destructive,
    purpose: semantics.purpose.trim(),
    inputKind: semantics.inputKind.trim(),
    outputKind: semantics.outputKind.trim(),
    deliverableKind: semantics.deliverableKind.trim(),
    destinationPosture: semantics.destinationPosture,
    advisoryRoles: [...new Set(semantics.advisoryRoles.map((role) => role.trim()).filter(Boolean))],
    ...(semantics.safeMode
      ? {
          safeMode: {
            id: semantics.safeMode.id.trim(),
            requiredEquals: { ...semantics.safeMode.requiredEquals },
            ...(semantics.safeMode.absentOrNull
              ? { absentOrNull: [...semantics.safeMode.absentOrNull] }
              : {}),
          },
        }
      : {}),
  };
}

/** Pure structural derivation, exported so future built-ins can prove they fit
 * the same rule without adding their names to a second policy list. */
export function deriveLocalPlanningDefinition(input: {
  declaration: ToolDecl;
  schema: Record<string, unknown>;
  carrier: LocalPlanningCarrier;
}): LocalPlanningDefinitionResult {
  const name = input.declaration.name.trim();
  if (!name) return { ok: false, reason: 'not_exact_registry_row' };
  const semantics = input.declaration.localPlanning;
  if (!semantics) return { ok: false, reason: 'not_declared' };
  if (input.declaration.sideEffect !== 'write' || input.declaration.runtimeEffect === 'host_only') {
    return { ok: false, reason: 'not_local_write' };
  }
  if (semantics.destructive) return { ok: false, reason: 'destructive' };
  if (semantics.reversibility !== 'reversible' && semantics.reversibility !== 'create_only') {
    return { ok: false, reason: 'irreversible_or_unknown' };
  }
  if (input.carrier !== expectedCarrier(input.declaration)) {
    return { ok: false, reason: 'carrier_mismatch' };
  }
  if (!isRecord(input.schema)) return { ok: false, reason: 'schema_unavailable' };
  const normalized = normalizedSemantics(semantics);
  if (!structurallyCarriesSafeMode(input.schema, normalized)) {
    return { ok: false, reason: 'safe_mode_not_structural' };
  }

  const variant = safeToken(normalized.safeMode?.id ?? 'reversible');
  const nameToken = safeToken(name);
  if (!variant || !nameToken) return { ok: false, reason: 'not_exact_registry_row' };
  const capabilityRef = `cap:local:${nameToken}:${variant}`;
  const schemaFingerprint = digestSchema(input.schema);
  const registrySemanticsFingerprint = digestSchema({
    version: 1,
    name,
    sideEffect: input.declaration.sideEffect,
    actionTopologyRole: input.declaration.actionTopologyRole ?? 'business',
    semantics: normalized,
  });
  const envelopeFingerprint = digestSchema({
    version: 1,
    provenance: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
    name,
    carrier: input.carrier,
    schemaFingerprint,
    registrySemanticsFingerprint,
  });
  const descriptor: HostCapabilityDescriptorV1 = Object.freeze({
    id: capabilityRef,
    effect: 'local_write',
    purpose: normalized.purpose,
    acceptedInputKinds: ['evidence', normalized.inputKind],
    producedOutputKinds: ['evidence', normalized.outputKind],
    applicableDeliverableKinds: ['evidence', normalized.deliverableKind],
    inputShape: normalized.inputKind,
    outputShape: normalized.outputKind,
    outputKind: normalized.outputKind,
    deliverableKind: normalized.deliverableKind,
    destinationPosture: normalized.destinationPosture,
    evidenceKinds: ['local_commit_receipt'],
    handleRequired: normalized.destinationPosture !== null,
    readbackRequired: false,
    accountScope: 'local_registry:host',
    manifestDigest: digestSchema({
      version: 1,
      provenance: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
      capabilityRef,
      envelopeFingerprint,
    }),
    advisoryRoles: [...normalized.advisoryRoles],
  });
  return {
    ok: true,
    schema: input.schema,
    definition: Object.freeze({
      version: 1,
      provenance: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
      name,
      carrier: input.carrier,
      capabilityRef,
      schemaFingerprint,
      registrySemanticsFingerprint,
      envelopeFingerprint,
      consequence: normalized.consequence,
      reversibility: normalized.reversibility,
      destructive: false,
      accountIdentity: 'local_registry:host',
      safeMode: normalized.safeMode ? Object.freeze({ ...normalized.safeMode }) : null,
      descriptor,
    }),
  };
}

export async function observeCurrentLocalPlanningDefinition(input: {
  name: string;
  carrier: LocalPlanningCarrier;
}): Promise<LocalPlanningDefinitionResult> {
  const name = input.name.trim();
  const declaration = TOOL_REGISTRY.find((entry) => entry.name === name);
  if (!declaration) return { ok: false, reason: 'not_exact_registry_row' };
  const configured = await configuredLocalTool(name);
  if (!configured || configured.name !== name) return { ok: false, reason: 'not_configured' };
  const schema = relaxJsonSchemaForDeferred(configured.parameters);
  if (!isRecord(schema)) return { ok: false, reason: 'schema_unavailable' };
  return deriveLocalPlanningDefinition({ declaration, schema, carrier: input.carrier });
}

export interface AuthorizedLocalPlanningDisclosureCandidate {
  name: string;
  carrier: LocalPlanningCarrier;
  schema: Record<string, unknown>;
  sourceKind: typeof AUTHORIZED_LOCAL_REGISTRY_PROVENANCE;
}

const issuedCandidates = new WeakMap<object, AuthorizedLocalPlanningDefinitionV1>();

/** Issue one opaque candidate from one exact scoped tool_search row. */
export async function issueAuthorizedLocalPlanningDisclosureCandidate(input: {
  name: string;
  carrier: LocalPlanningCarrier;
  configuredNames: ReadonlySet<string>;
}): Promise<AuthorizedLocalPlanningDisclosureCandidate | null> {
  const name = input.name.trim();
  if (!name || !input.configuredNames.has(name)) return null;
  const observed = await observeCurrentLocalPlanningDefinition({ name, carrier: input.carrier });
  if (!observed.ok) return null;
  const candidate: AuthorizedLocalPlanningDisclosureCandidate = Object.freeze({
    name,
    carrier: input.carrier,
    schema: observed.schema,
    sourceKind: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
  });
  issuedCandidates.set(candidate, observed.definition);
  return candidate;
}

/** Model/candidate bytes cannot manufacture this WeakMap-backed fact. */
export function inspectAuthorizedLocalPlanningDisclosureCandidate(
  candidate: object,
): AuthorizedLocalPlanningDefinitionV1 | null {
  return issuedCandidates.get(candidate) ?? null;
}

function definitionsEqual(
  left: AuthorizedLocalPlanningDefinitionV1,
  right: AuthorizedLocalPlanningDefinitionV1,
): boolean {
  return left.capabilityRef === right.capabilityRef
    && left.schemaFingerprint === right.schemaFingerprint
    && left.registrySemanticsFingerprint === right.registrySemanticsFingerprint
    && left.envelopeFingerprint === right.envelopeFingerprint
    && left.name === right.name
    && left.carrier === right.carrier
    && JSON.stringify(left.descriptor) === JSON.stringify(right.descriptor);
}

export async function revalidateLocalPlanningDefinition(
  prior: AuthorizedLocalPlanningDefinitionV1,
): Promise<{ ok: true; definition: AuthorizedLocalPlanningDefinitionV1 } | { ok: false; reason: string }> {
  if (
    prior.version !== 1
    || prior.provenance !== AUTHORIZED_LOCAL_REGISTRY_PROVENANCE
    || prior.accountIdentity !== 'local_registry:host'
    || prior.destructive !== false
    || !['reversible', 'create_only'].includes(prior.reversibility)
  ) return { ok: false, reason: 'invalid_local_planning_definition' };
  const current = await observeCurrentLocalPlanningDefinition({
    name: prior.name,
    carrier: prior.carrier,
  });
  if (!current.ok) return { ok: false, reason: `local_planning_${current.reason}` };
  if (!definitionsEqual(prior, current.definition)) {
    return { ok: false, reason: 'local_planning_surface_changed' };
  }
  return { ok: true, definition: current.definition };
}

export type DurableAuthorizedLocalPlanningDefinitionResult =
  | { ok: true; definition: AuthorizedLocalPlanningDefinitionV1 }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'invalid_durable_definition'
        | 'ambiguous_durable_definition'
        | 'surface_changed';
      detail?: string;
    };

function minimallyValidDurableDefinition(
  value: unknown,
): value is AuthorizedLocalPlanningDefinitionV1 {
  if (!isRecord(value)) return false;
  return value.version === 1
    && value.provenance === AUTHORIZED_LOCAL_REGISTRY_PROVENANCE
    && typeof value.name === 'string'
    && value.name.trim().length > 0
    && value.carrier === 'work_call'
    && typeof value.capabilityRef === 'string'
    && value.capabilityRef.startsWith('cap:local:')
    && typeof value.schemaFingerprint === 'string'
    && /^[a-f0-9]{64}$/i.test(value.schemaFingerprint)
    && typeof value.registrySemanticsFingerprint === 'string'
    && /^[a-f0-9]{64}$/i.test(value.registrySemanticsFingerprint)
    && typeof value.envelopeFingerprint === 'string'
    && /^[a-f0-9]{64}$/i.test(value.envelopeFingerprint)
    && (value.reversibility === 'reversible' || value.reversibility === 'create_only')
    && value.destructive === false
    && value.accountIdentity === 'local_registry:host'
    && isRecord(value.descriptor)
    && value.descriptor.id === value.capabilityRef
    && value.descriptor.effect === 'local_write'
    && value.descriptor.accountScope === 'local_registry:host'
    && typeof value.descriptor.manifestDigest === 'string'
    && /^[a-f0-9]{64}$/i.test(value.descriptor.manifestDigest);
}

/**
 * Reopen one exact source-bound local definition for a later read-only
 * admission boundary (for example consent preparation). This performs no
 * policy decision: it proves the durable disclosure row and then revalidates
 * the exact current configured name/schema/registry envelope.
 */
export async function loadDurableAuthorizedLocalPlanningDefinition(input: {
  sessionId: string;
  sourceUserSeq: number;
  capabilityRef: string;
}): Promise<DurableAuthorizedLocalPlanningDefinitionResult> {
  const ref = input.capabilityRef.trim();
  if (!ref) return { ok: false, reason: 'not_found' };
  const definitions: AuthorizedLocalPlanningDefinitionV1[] = [];
  let sawMalformedMatch = false;
  try {
    for (const event of listEvents(input.sessionId, { types: ['capability_discovered'] })) {
      if (event.data.sourceUserSeq !== input.sourceUserSeq) continue;
      const rows = Array.isArray(event.data.capabilities) ? event.data.capabilities : [];
      for (const rawRow of rows) {
        if (!isRecord(rawRow) || rawRow.capabilityRef !== ref) continue;
        if (rawRow.providerKind !== AUTHORIZED_LOCAL_REGISTRY_PROVENANCE) continue;
        const definition = rawRow.localAuthority;
        if (!minimallyValidDurableDefinition(definition)) {
          sawMalformedMatch = true;
          continue;
        }
        if (
          rawRow.kind !== AUTHORIZED_LOCAL_REGISTRY_PROVENANCE
          || rawRow.identifier !== definition.name
          || rawRow.schemaFingerprint !== definition.schemaFingerprint
          || rawRow.manifestDigest !== definition.descriptor.manifestDigest
          || rawRow.accountIdentity !== definition.accountIdentity
        ) {
          sawMalformedMatch = true;
          continue;
        }
        definitions.push(definition);
      }
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid_durable_definition',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (definitions.length === 0) {
    return { ok: false, reason: sawMalformedMatch ? 'invalid_durable_definition' : 'not_found' };
  }
  const first = definitions[0]!;
  if (definitions.some((definition) => (
    definition.envelopeFingerprint !== first.envelopeFingerprint
    || JSON.stringify(definition) !== JSON.stringify(first)
  ))) return { ok: false, reason: 'ambiguous_durable_definition' };
  const revalidated = await revalidateLocalPlanningDefinition(first);
  if (!revalidated.ok) {
    return { ok: false, reason: 'surface_changed', detail: revalidated.reason };
  }
  return { ok: true, definition: revalidated.definition };
}

/** Argument-shape helper for the later consent/dispatch boundary. This module
 * does not call it to approve work; it merely preserves the declared mode. */
export function localPlanningArgumentsMatch(
  definition: AuthorizedLocalPlanningDefinitionV1,
  args: unknown,
): boolean {
  if (!definition.safeMode) return true;
  if (!isRecord(args)) return false;
  for (const [field, expected] of Object.entries(definition.safeMode.requiredEquals)) {
    if (args[field] !== expected) return false;
  }
  for (const field of definition.safeMode.absentOrNull ?? []) {
    if (args[field] !== undefined && args[field] !== null) return false;
  }
  return true;
}
