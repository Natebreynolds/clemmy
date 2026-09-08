import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
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
  type LocalPlanningSafeMode,
  type LocalPlanningSafeModePredicate,
  type LocalPlanningSemantics,
  type ToolDecl,
} from '../../tools/tool-registry.js';
import { relaxJsonSchemaForDeferred } from '../schema-normalizer.js';
import { digestSchema } from '../../tools/tool-contract-store.js';
import { getTurnGraphEventForSource, listEvents } from './eventlog.js';

export type LocalPlanningCarrier = 'call_tool' | 'work_call';
export const AUTHORIZED_LOCAL_REGISTRY_PROVENANCE = 'authorized_local_registry' as const;

export type AuthorizedLocalPlanningConsequenceV1 =
  | LocalPlanningSemantics['consequence']
  | 'read';
export type AuthorizedLocalPlanningReversibilityV1 =
  | LocalPlanningSemantics['reversibility']
  | 'read_only';

export interface AuthorizedLocalPlanningDefinitionV1 {
  version: 1;
  provenance: typeof AUTHORIZED_LOCAL_REGISTRY_PROVENANCE;
  name: string;
  carrier: LocalPlanningCarrier;
  capabilityRef: string;
  schemaFingerprint: string;
  registrySemanticsFingerprint: string;
  envelopeFingerprint: string;
  consequence: AuthorizedLocalPlanningConsequenceV1;
  reversibility: AuthorizedLocalPlanningReversibilityV1;
  destructive: boolean;
  accountIdentity: 'local_registry:host';
  safeMode: LocalPlanningSemantics['safeMode'] | null;
  descriptor: HostCapabilityDescriptorV1;
}

/**
 * Why a registry row cannot be CITED in a plan.
 *
 * Named because the reason has to survive the disclosure boundary. It used to
 * be computed and then dropped on the floor, so a row that was merely
 * unplannable reached the model as a row that was unusable — see
 * issueAuthorizedLocalPlanningDisclosureCandidate below.
 */
export type LocalPlanningRefusalReason =
  | 'not_configured'
  | 'not_exact_registry_row'
  | 'not_declared'
  | 'not_local_write'
  | 'destructive'
  | 'irreversible_or_unknown'
  | 'carrier_mismatch'
  | 'schema_unavailable'
  | 'safe_mode_not_structural';

export type LocalPlanningDefinitionResult =
  | { ok: true; definition: AuthorizedLocalPlanningDefinitionV1; schema: Record<string, unknown> }
  | { ok: false; reason: LocalPlanningRefusalReason };

export type LocalPlanningDefinitionsResult =
  | {
      ok: true;
      definitions: readonly AuthorizedLocalPlanningDefinitionV1[];
      schema: Record<string, unknown>;
    }
  | { ok: false; reason: LocalPlanningRefusalReason };

interface ConfiguredLocalTool {
  name: string;
  parameters: unknown;
  /** Positive proof that this exact schema belongs to the generic local
   * work_call dispatcher rather than only to a first-class/call_tool surface. */
  workCallLocalDispatch?: boolean;
}

type ConfiguredLocalToolObserver = (
  name: string,
  carrier: LocalPlanningCarrier,
) => Promise<ConfiguredLocalTool | null> | ConfiguredLocalTool | null;

let observerOverride: ConfiguredLocalToolObserver | null = null;

async function defaultConfiguredLocalTool(
  name: string,
  carrier: LocalPlanningCarrier,
): Promise<ConfiguredLocalTool | null> {
  // Dynamic import avoids the registry -> local-runtime-tools -> plan-tools ->
  // semantic-boundary cycle at module evaluation time.
  //
  // A plan-bound local mutation executes inside work_call(args_json). Publish
  // that carrier's canonical deferred schema, which can faithfully represent
  // open JSON records. The first-class provider projection is intentionally
  // Codex-strict and therefore cannot be planning authority for this carrier.
  if (carrier === 'work_call') {
    const [{ getLocalToolSchemas }, { z }] = await Promise.all([
      import('../../tools/local-runtime-tools.js'),
      import('zod'),
    ]);
    const schema = getLocalToolSchemas().get(name);
    if (schema) {
      return {
        name,
        parameters: z.toJSONSchema(schema),
        workCallLocalDispatch: true,
      };
    }
    // Some registry-declared local mutations (for example the SDK-backed
    // file tools) are configured directly on the core surface rather than by
    // captureLocalTools. They have no open deferred record to recover, so the
    // exact configured schema below remains their truthful work_call contract.
  }

  // Graph-neutral first-class/call_tool observations retain the exact
  // configured model-facing surface.
  const { getCoreTools } = await import('../../tools/registry.js');
  const matches = getCoreTools()
    .map((tool) => tool as unknown as { name?: unknown; parameters?: unknown })
    .filter((tool) => tool.name === name);
  if (matches.length !== 1 || typeof matches[0]?.name !== 'string' || !matches[0].parameters) return null;
  return { name: matches[0].name, parameters: matches[0].parameters };
}

async function configuredLocalTool(
  name: string,
  carrier: LocalPlanningCarrier,
): Promise<ConfiguredLocalTool | null> {
  const configured = await (observerOverride ?? defaultConfiguredLocalTool)(name, carrier);
  if (!configured) return null;
  // The override is an isolated-test replacement for the exact configured
  // surface. Treat a work_call observation from that seam as the same positive
  // carrier fact without expanding the production fallback above.
  return observerOverride && carrier === 'work_call'
    ? { ...configured, workCallLocalDispatch: configured.workCallLocalDispatch ?? true }
    : configured;
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

function schemaAllowsExact(schema: unknown, expected: string | number | boolean | null): boolean {
  if (!isRecord(schema)) return false;
  if (expected === null && schema.type === 'null') return true;
  if (Object.hasOwn(schema, 'const')) return schema.const === expected;
  if (Array.isArray(schema.enum)) return schema.enum.some((value) => value === expected);
  if (typeof expected === 'string' && schema.type === 'string') return true;
  if (typeof expected === 'boolean' && schema.type === 'boolean') return true;
  if (
    typeof expected === 'number'
    && (schema.type === 'number' || (schema.type === 'integer' && Number.isInteger(expected)))
  ) return true;
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
  const safeMode = semantics.safeMode;
  if (!safeMode) return semantics.reversibility === 'reversible' && !semantics.destructive;
  if (!safeToken(safeMode.id)) return false;
  const properties = isRecord(schema.properties) ? schema.properties : null;
  if (!properties) return false;
  const predicates: readonly LocalPlanningSafeModePredicate[] = safeMode.alternatives?.length
    ? safeMode.alternatives
    : [safeMode];
  return predicates.length > 0 && predicates.every((predicate) => {
    for (const [field, expected] of Object.entries(predicate.requiredEquals)) {
      if (!Object.hasOwn(properties, field) || !schemaAllowsExact(properties[field], expected)) return false;
    }
    const nullEquivalent = new Set(predicate.nullEquivalentToRequired ?? []);
    if (nullEquivalent.size !== (predicate.nullEquivalentToRequired?.length ?? 0)) return false;
    for (const field of nullEquivalent) {
      if (
        !Object.hasOwn(predicate.requiredEquals, field)
        || !Object.hasOwn(properties, field)
        || !schemaAllowsExact(properties[field], null)
      ) return false;
    }
    for (const field of predicate.absentOrNull ?? []) {
      if (!Object.hasOwn(properties, field)) return false;
    }
    for (const [field, values] of Object.entries(predicate.allowedValues ?? {})) {
      if (
        !Object.hasOwn(properties, field)
        || values.length === 0
        || !values.every((value) => schemaAllowsExact(properties[field], value))
      ) return false;
    }
    return true;
  });
}

function declaredMutationSemantics(declaration: ToolDecl): readonly LocalPlanningSemantics[] {
  return [
    ...(declaration.localPlanning ? [declaration.localPlanning] : []),
    ...(declaration.localPlanningVariants ?? []),
  ];
}

function explicitVariantSemanticsAreClosed(declaration: ToolDecl): boolean {
  const variants = declaration.localPlanningVariants ?? [];
  if (variants.length === 0) return true;
  const all = declaredMutationSemantics(declaration);
  const ids = all.map((semantics) => safeToken(semantics.safeMode?.id ?? ''));
  return all.length > 1
    && ids.every((id): id is string => id !== null)
    && new Set(ids).size === ids.length;
}

function declarationCanEnterLocalPlanningMutation(declaration: ToolDecl): boolean {
  const semantics = declaredMutationSemantics(declaration);
  const legacySafe = semantics.length === 1
    && semantics[0]!.destructive === false
    && (semantics[0]!.reversibility === 'reversible' || semantics[0]!.reversibility === 'create_only');
  const exactVariants = semantics.length > 1
    && explicitVariantSemanticsAreClosed(declaration)
    && semantics.every((variant) => variant.reversibility !== 'unknown' && variant.safeMode !== undefined);
  return declaration.sideEffect === 'write'
    && declaration.runtimeEffect !== 'host_only'
    && (legacySafe || exactVariants);
}

function declarationCanEnterLocalPlanningRead(declaration: ToolDecl): boolean {
  return declaration.sideEffect === 'read'
    && (declaration.projectEffect === 'read' || declaration.localPlanningRead === true)
    && declaration.runtimeEffect !== 'host_only';
}

/** An explicit native read-plan declaration, distinct from project eligibility.
 * Exact configured schema/carrier proof is still required before publication. */
export function isRegistryDeclaredNativePlanningRead(name: string): boolean {
  const matches = TOOL_REGISTRY.filter((entry) => entry.name === name.trim());
  return matches.length === 1 && matches[0]!.localPlanningRead === true
    && declarationCanEnterLocalPlanningRead(matches[0]!);
}

function declarationCanEnterLocalPlanning(declaration: ToolDecl): boolean {
  return declarationCanEnterLocalPlanningRead(declaration)
    || declarationCanEnterLocalPlanningMutation(declaration);
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
export function isRegistryDeclaredLocalPlanningCapability(name: string): boolean {
  const exact = name.trim();
  if (!exact) return false;
  const matches = TOOL_REGISTRY.filter((entry) => entry.name === exact);
  return matches.length === 1 && declarationCanEnterLocalPlanning(matches[0]!);
}

/** Current work_call routing eligibility. Read declarations need the
 * additional positive fact that the generic local dispatcher owns an exact
 * schema for this name; mutation compatibility retains its existing core-tool
 * fallback and is still revalidated by `observeCurrentLocalPlanningDefinition`.
 */
export function isWorkCallConfiguredLocalPlanningCapability(
  name: string,
  workCallConfiguredNames: ReadonlySet<string>,
): boolean {
  return isRegistryDeclaredLocalPlanningMutation(name)
    || (
      isRegistryDeclaredLocalPlanningCapability(name)
      && workCallConfiguredNames.has(name.trim())
    );
}

/** Compatibility predicate for callers that specifically mean mutation. */
export function isRegistryDeclaredLocalPlanningMutation(name: string): boolean {
  const exact = name.trim();
  if (!exact) return false;
  const matches = TOOL_REGISTRY.filter((entry) => entry.name === exact);
  return matches.length === 1 && declarationCanEnterLocalPlanningMutation(matches[0]!);
}

/**
 * Recover the exact local names already selected into this source's durable
 * graph. This is a carrier-routing fact only: a matching row cannot grant plan,
 * consent, or execution authority, and every later boundary still revalidates
 * the full local definition. Keeping this synchronous lets both local carrier
 * factories preserve graph-neutral controls while routing restart/replay of a
 * selected local requirement back through work_call.
 */
export function durableSelectedLocalPlanningCapabilityNames(input: {
  sessionId: string;
  sourceUserSeq: number;
  workCallConfiguredNames?: ReadonlySet<string>;
}): ReadonlySet<string> {
  try {
    const workCallConfiguredNames = input.workCallConfiguredNames ?? new Set<string>();
    const graphEvent = getTurnGraphEventForSource(input.sessionId, input.sourceUserSeq);
    const graph = graphEvent?.data.graph;
    if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return new Set();
    const nodes = Array.isArray((graph as Record<string, unknown>).nodes)
      ? (graph as Record<string, unknown>).nodes as unknown[]
      : [];
    const selectedEffectsByRef = new Map<string, Set<string>>();
    for (const rawNode of nodes) {
      if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) continue;
      const rawEffect = (rawNode as Record<string, unknown>).effect;
      const nodeEffect = isRecord(rawEffect) && typeof rawEffect.kind === 'string'
        ? rawEffect.kind
        : '';
      if (nodeEffect !== 'read' && nodeEffect !== 'local_write') continue;
      const capabilities = Array.isArray((rawNode as Record<string, unknown>).capabilities)
        ? (rawNode as Record<string, unknown>).capabilities as unknown[]
        : [];
      for (const rawCapability of capabilities) {
        if (!rawCapability || typeof rawCapability !== 'object' || Array.isArray(rawCapability)) continue;
        const capability = rawCapability as Record<string, unknown>;
        if (capability.kind !== 'tool' || capability.resolution !== 'explicit') continue;
        for (const ref of Array.isArray(capability.names) ? capability.names : []) {
          if (typeof ref !== 'string' || !ref.startsWith('cap:local:')) continue;
          const effects = selectedEffectsByRef.get(ref) ?? new Set<string>();
          effects.add(nodeEffect);
          selectedEffectsByRef.set(ref, effects);
        }
      }
    }
    if (selectedEffectsByRef.size === 0) return new Set();
    const selectedNames = new Set<string>();
    for (const event of listEvents(input.sessionId, { types: ['capability_discovered'] })) {
      if (event.data.sourceUserSeq !== input.sourceUserSeq) continue;
      const rows = Array.isArray(event.data.capabilities) ? event.data.capabilities : [];
      for (const rawRow of rows) {
        if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) continue;
        const row = rawRow as Record<string, unknown>;
        const authority = row.localAuthority;
        if (!minimallyValidDurableDefinition(authority)) continue;
        const definition = authority;
        const name = typeof definition.name === 'string' ? definition.name.trim() : '';
        const ref = typeof definition.capabilityRef === 'string' ? definition.capabilityRef : '';
        const selectedEffects = selectedEffectsByRef.get(ref);
        const expectedEffectClass = definition.descriptor.effect === 'read' ? 'read' : 'write';
        if (
          row.providerKind === AUTHORIZED_LOCAL_REGISTRY_PROVENANCE
          && definition.provenance === AUTHORIZED_LOCAL_REGISTRY_PROVENANCE
          && definition.carrier === 'work_call'
          && row.identifier === name
          && row.capabilityRef === ref
          && row.effectClass === expectedEffectClass
          && selectedEffects?.size === 1
          && selectedEffects.has(definition.descriptor.effect)
          && isWorkCallConfiguredLocalPlanningCapability(
            name,
            workCallConfiguredNames,
          )
        ) selectedNames.add(name);
      }
    }
    return selectedNames;
  } catch {
    return new Set();
  }
}

/** Compatibility recovery for mutation-only consumers. */
export function durableSelectedLocalPlanningMutationNames(input: {
  sessionId: string;
  sourceUserSeq: number;
}): ReadonlySet<string> {
  return new Set(
    [...durableSelectedLocalPlanningCapabilityNames(input)]
      .filter((name) => isRegistryDeclaredLocalPlanningMutation(name)),
  );
}

function expectedCarrier(_declaration: ToolDecl): LocalPlanningCarrier {
  return 'work_call';
}

function normalizedSafeModePredicate(
  predicate: LocalPlanningSafeModePredicate,
): LocalPlanningSafeModePredicate {
  return {
    requiredEquals: { ...predicate.requiredEquals },
    ...(predicate.nullEquivalentToRequired
      ? {
          nullEquivalentToRequired: [...new Set(
            predicate.nullEquivalentToRequired
              .map((field) => field.trim())
              .filter(Boolean),
          )],
        }
      : {}),
    ...(predicate.absentOrNull
      ? {
          absentOrNull: [...new Set(
            predicate.absentOrNull.map((field) => field.trim()).filter(Boolean),
          )],
        }
      : {}),
    ...(predicate.allowedValues
      ? {
          allowedValues: Object.fromEntries(
            Object.entries(predicate.allowedValues)
              .map(([field, values]) => [field.trim(), [...new Set(values)] as const] as const)
              .filter(([field]) => Boolean(field)),
          ),
        }
      : {}),
  };
}

function normalizedSafeMode(safeMode: LocalPlanningSafeMode): LocalPlanningSafeMode {
  return {
    id: safeMode.id.trim(),
    ...normalizedSafeModePredicate(safeMode),
    ...(safeMode.alternatives
      ? { alternatives: safeMode.alternatives.map(normalizedSafeModePredicate) }
      : {}),
  };
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
    ...(semantics.destinationPostures
      ? { destinationPostures: [...semantics.destinationPostures] }
      : {}),
    advisoryRoles: [...new Set(semantics.advisoryRoles.map((role) => role.trim()).filter(Boolean))],
    ...(semantics.safeMode
      ? { safeMode: normalizedSafeMode(semantics.safeMode) }
      : {}),
  };
}

function deriveLocalPlanningDefinitionForSemantics(input: {
  declaration: ToolDecl;
  schema: Record<string, unknown>;
  carrier: LocalPlanningCarrier;
  semantics?: LocalPlanningSemantics;
  allowHighRiskVariant?: boolean;
}): LocalPlanningDefinitionResult {
  const name = input.declaration.name.trim();
  if (!name) return { ok: false, reason: 'not_exact_registry_row' };
  const readOnly = declarationCanEnterLocalPlanningRead(input.declaration);
  const semantics = input.semantics ?? input.declaration.localPlanning;
  if (!readOnly && !semantics) return { ok: false, reason: 'not_declared' };
  if (
    !readOnly
    && (input.declaration.sideEffect !== 'write' || input.declaration.runtimeEffect === 'host_only')
  ) {
    return { ok: false, reason: 'not_local_write' };
  }
  if (!readOnly && semantics!.destructive && !input.allowHighRiskVariant) {
    return { ok: false, reason: 'destructive' };
  }
  if (
    !readOnly
    && (
      semantics!.reversibility === 'unknown'
      || (
        !input.allowHighRiskVariant
        && semantics!.reversibility !== 'reversible'
        && semantics!.reversibility !== 'create_only'
      )
    )
  ) {
    return { ok: false, reason: 'irreversible_or_unknown' };
  }
  if (input.carrier !== expectedCarrier(input.declaration)) {
    return { ok: false, reason: 'carrier_mismatch' };
  }
  if (!isRecord(input.schema)) return { ok: false, reason: 'schema_unavailable' };
  const normalized = readOnly ? null : normalizedSemantics(semantics!);
  if (normalized && !structurallyCarriesSafeMode(input.schema, normalized)) {
    return { ok: false, reason: 'safe_mode_not_structural' };
  }

  const variant = safeToken(readOnly ? 'read' : normalized!.safeMode?.id ?? 'reversible');
  const nameToken = safeToken(name);
  if (!variant || !nameToken) return { ok: false, reason: 'not_exact_registry_row' };
  const capabilityRef = `cap:local:${nameToken}:${variant}`;
  const schemaFingerprint = digestSchema(input.schema);
  // Preserve the historical v1 mutation bytes exactly. Read definitions use a
  // separate structural projection whose projectEffect and runtime posture are
  // load-bearing; the exact configured schema/carrier completes (but never
  // replaces) that registry proof.
  const readPurpose = input.declaration.description?.trim() || 'Read Clementine-local state.';
  const registrySemanticsFingerprint = readOnly
    ? digestSchema({
        version: 1,
        name,
        sideEffect: input.declaration.sideEffect,
        projectEffect: input.declaration.projectEffect,
        // Absent declarations preserve the historical project-read fingerprint.
        ...(input.declaration.localPlanningRead === true ? { localPlanningRead: true } : {}),
        runtimeEffect: input.declaration.runtimeEffect ?? null,
        actionTopologyRole: input.declaration.actionTopologyRole ?? 'business',
        readOnly: {
          consequence: 'read',
          reversibility: 'read_only',
          destructive: false,
          purpose: readPurpose,
          destinationPosture: null,
        },
      })
    : digestSchema({
        version: 1,
        name,
        sideEffect: input.declaration.sideEffect,
        actionTopologyRole: input.declaration.actionTopologyRole ?? 'business',
        semantics: normalized,
        localExecution: input.declaration.localExecution ?? null,
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
    effect: readOnly ? 'read' : 'local_write',
    purpose: readOnly ? readPurpose : normalized!.purpose,
    acceptedInputKinds: readOnly ? ['request', 'evidence'] : ['evidence', normalized!.inputKind],
    producedOutputKinds: readOnly ? ['evidence'] : ['evidence', normalized!.outputKind],
    applicableDeliverableKinds: readOnly ? ['evidence'] : ['evidence', normalized!.deliverableKind],
    inputShape: readOnly ? 'request' : normalized!.inputKind,
    outputShape: readOnly ? 'evidence' : normalized!.outputKind,
    outputKind: readOnly ? 'evidence' : normalized!.outputKind,
    deliverableKind: readOnly ? 'evidence' : normalized!.deliverableKind,
    destinationPosture: readOnly ? null : normalized!.destinationPosture,
    ...(!readOnly && normalized!.destinationPostures
      ? { destinationPostures: normalized!.destinationPostures }
      : {}),
    evidenceKinds: readOnly ? ['tool_result'] : ['local_commit_receipt'],
    handleRequired: readOnly ? false : normalized!.destinationPosture !== null,
    readbackRequired: false,
    accountScope: 'local_registry:host',
    manifestDigest: digestSchema({
      version: 1,
      provenance: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
      capabilityRef,
      envelopeFingerprint,
    }),
    advisoryRoles: readOnly ? ['source', 'collection', 'read'] : [...normalized!.advisoryRoles],
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
      consequence: readOnly ? 'read' : normalized!.consequence,
      reversibility: readOnly ? 'read_only' : normalized!.reversibility,
      destructive: readOnly ? false : normalized!.destructive,
      accountIdentity: 'local_registry:host',
      safeMode: normalized?.safeMode ? Object.freeze({ ...normalized.safeMode }) : null,
      descriptor,
    }),
  };
}

/** Pure structural derivation, exported so future built-ins can prove they fit
 * the same rule without adding their names to a second policy list. The
 * compatibility singular returns the registry-primary variant; callers that
 * bind model-filled arguments must use the plural surface and select exactly
 * one ref. */
export function deriveLocalPlanningDefinition(input: {
  declaration: ToolDecl;
  schema: Record<string, unknown>;
  carrier: LocalPlanningCarrier;
}): LocalPlanningDefinitionResult {
  const derived = deriveLocalPlanningDefinitions(input);
  if (!derived.ok) return derived;
  const definition = derived.definitions[0];
  return definition
    ? { ok: true, definition, schema: derived.schema }
    : { ok: false, reason: 'not_declared' };
}

export function deriveLocalPlanningDefinitions(input: {
  declaration: ToolDecl;
  schema: Record<string, unknown>;
  carrier: LocalPlanningCarrier;
}): LocalPlanningDefinitionsResult {
  const readOnly = declarationCanEnterLocalPlanningRead(input.declaration);
  const semantics = declaredMutationSemantics(input.declaration);
  if (readOnly) {
    const result = deriveLocalPlanningDefinitionForSemantics(input);
    return result.ok
      ? { ok: true, definitions: Object.freeze([result.definition]), schema: result.schema }
      : result;
  }
  if (semantics.length === 0) {
    return { ok: false, reason: 'not_declared' };
  }
  const hasExplicitVariants = (input.declaration.localPlanningVariants?.length ?? 0) > 0;
  if (hasExplicitVariants && !explicitVariantSemanticsAreClosed(input.declaration)) {
    return { ok: false, reason: 'safe_mode_not_structural' };
  }
  const definitions: AuthorizedLocalPlanningDefinitionV1[] = [];
  for (const variant of semantics) {
    const result = deriveLocalPlanningDefinitionForSemantics({
      ...input,
      semantics: variant,
      allowHighRiskVariant: hasExplicitVariants,
    });
    if (!result.ok) return result;
    definitions.push(result.definition);
  }
  if (
    definitions.length === 0
    || new Set(definitions.map((definition) => definition.capabilityRef)).size !== definitions.length
  ) return { ok: false, reason: 'not_exact_registry_row' };
  return {
    ok: true,
    definitions: Object.freeze(definitions),
    schema: input.schema,
  };
}

export async function observeCurrentLocalPlanningDefinition(input: {
  name: string;
  carrier: LocalPlanningCarrier;
}): Promise<LocalPlanningDefinitionResult> {
  const name = input.name.trim();
  const declarations = TOOL_REGISTRY.filter((entry) => entry.name === name);
  if (declarations.length !== 1) return { ok: false, reason: 'not_exact_registry_row' };
  const declaration = declarations[0]!;
  const configured = await configuredLocalTool(name, input.carrier);
  if (!configured || configured.name !== name) return { ok: false, reason: 'not_configured' };
  if (
    declarationCanEnterLocalPlanningRead(declaration)
    && input.carrier === 'work_call'
    && configured.workCallLocalDispatch !== true
  ) return { ok: false, reason: 'not_configured' };
  const schema = relaxJsonSchemaForDeferred(configured.parameters);
  if (!isRecord(schema)) return { ok: false, reason: 'schema_unavailable' };
  const observed = deriveLocalPlanningDefinitions({ declaration, schema, carrier: input.carrier });
  if (!observed.ok) return observed;
  const definition = observed.definitions[0];
  return definition
    ? { ok: true, definition, schema: observed.schema }
    : { ok: false, reason: 'not_declared' };
}

export async function observeCurrentLocalPlanningDefinitions(input: {
  name: string;
  carrier: LocalPlanningCarrier;
}): Promise<LocalPlanningDefinitionsResult> {
  const name = input.name.trim();
  const declarations = TOOL_REGISTRY.filter((entry) => entry.name === name);
  if (declarations.length !== 1) return { ok: false, reason: 'not_exact_registry_row' };
  const declaration = declarations[0]!;
  const configured = await configuredLocalTool(name, input.carrier);
  if (!configured || configured.name !== name) return { ok: false, reason: 'not_configured' };
  if (
    declarationCanEnterLocalPlanningRead(declaration)
    && input.carrier === 'work_call'
    && configured.workCallLocalDispatch !== true
  ) return { ok: false, reason: 'not_configured' };
  const schema = relaxJsonSchemaForDeferred(configured.parameters);
  if (!isRecord(schema)) return { ok: false, reason: 'schema_unavailable' };
  return deriveLocalPlanningDefinitions({ declaration, schema, carrier: input.carrier });
}

export interface AuthorizedLocalPlanningDisclosureCandidate {
  name: string;
  carrier: LocalPlanningCarrier;
  schema: Record<string, unknown>;
  sourceKind: typeof AUTHORIZED_LOCAL_REGISTRY_PROVENANCE;
  /** Host-authored planning choices for one configured operation. These are
   * display metadata only; the WeakMap seal below is still the authority. */
  capabilityVariants: readonly {
    variantId: string;
    capabilityRef: string;
    reversibility: AuthorizedLocalPlanningReversibilityV1;
    destructive: boolean;
    destinationPosture: 'create_new' | 'named_existing' | null;
  }[];
}

const issuedCandidates = new WeakMap<object, readonly AuthorizedLocalPlanningDefinitionV1[]>();

/** A row that exists but cannot be cited, and the reason it cannot. */
export interface AuthorizedLocalPlanningDisclosureRefusal {
  refused: LocalPlanningRefusalReason;
}

export type AuthorizedLocalPlanningDisclosureOutcome =
  | AuthorizedLocalPlanningDisclosureCandidate
  | AuthorizedLocalPlanningDisclosureRefusal
  | null;

/**
 * Issue one opaque candidate from one exact scoped tool_search row, or say why
 * not.
 *
 * NOT-CITABLE IS NOT NOT-USABLE. Failing this gate is precisely what leaves a
 * control or registry read reachable through call_tool (orchestrator.ts routes
 * exactly those names to the control dispatcher), so a refusal here describes
 * the PLAN, never the tool. Returning bare null erased that distinction: the
 * caller dropped the row, tool_search stamped a flat
 * `unsupported_unmaterialized` on a payload whose own carrier field said
 * `call_tool`, and the model was told to walk away from a tool it was holding
 * with a full schema. Live 2026-08-27 (seq 90427): space_get, space_get_runner
 * and space_edit_runner were disclosed exactly that way; the model fabricated
 * four capability refs rather than call any of them, and the turn blocked.
 *
 * `null` still means ABSENT — the name is not on this turn's surface at all.
 * That is a different fact from "present and not citable" and stays distinct.
 */
export async function issueAuthorizedLocalPlanningDisclosureCandidate(input: {
  name: string;
  carrier: LocalPlanningCarrier;
  configuredNames: ReadonlySet<string>;
}): Promise<AuthorizedLocalPlanningDisclosureOutcome> {
  const name = input.name.trim();
  if (!name || !input.configuredNames.has(name)) return null;
  // A native contextual reader keeps its current call_tool invocation. Its
  // separately selected Plan operation uses the canonical work_call contract;
  // publishing that future contract must not reroute today's contextual read.
  const planningCarrier = input.carrier === 'call_tool' && isRegistryDeclaredNativePlanningRead(name)
    ? 'work_call' : input.carrier;
  const observed = await observeCurrentLocalPlanningDefinitions({ name, carrier: planningCarrier });
  if (!observed.ok) return { refused: observed.reason };
  const candidate: AuthorizedLocalPlanningDisclosureCandidate = Object.freeze({
    name,
    carrier: planningCarrier,
    schema: observed.schema,
    sourceKind: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
    capabilityVariants: Object.freeze(observed.definitions.map((definition) => Object.freeze({
      variantId: definition.safeMode?.id ?? 'reversible',
      capabilityRef: definition.capabilityRef,
      reversibility: definition.reversibility,
      destructive: definition.destructive,
      destinationPosture: definition.descriptor.destinationPosture,
    }))),
  });
  issuedCandidates.set(candidate, observed.definitions);
  return candidate;
}

/** Model/candidate bytes cannot manufacture this WeakMap-backed fact. */
export function inspectAuthorizedLocalPlanningDisclosureCandidate(
  candidate: object,
): AuthorizedLocalPlanningDefinitionV1 | null {
  return issuedCandidates.get(candidate)?.[0] ?? null;
}

/** Plural sealed inspection for argument-dependent capability variants. */
export function inspectAuthorizedLocalPlanningDisclosureCandidates(
  candidate: object,
): readonly AuthorizedLocalPlanningDefinitionV1[] | null {
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
    && left.consequence === right.consequence
    && left.reversibility === right.reversibility
    && left.destructive === right.destructive
    && closedCanonicalJson(left.safeMode) === closedCanonicalJson(right.safeMode)
    && closedCanonicalJson(left.descriptor) === closedCanonicalJson(right.descriptor);
}

export async function revalidateLocalPlanningDefinition(
  prior: AuthorizedLocalPlanningDefinitionV1,
): Promise<{ ok: true; definition: AuthorizedLocalPlanningDefinitionV1 } | { ok: false; reason: string }> {
  if (
    prior.version !== 1
    || prior.provenance !== AUTHORIZED_LOCAL_REGISTRY_PROVENANCE
    || prior.accountIdentity !== 'local_registry:host'
    || (
      prior.descriptor.effect === 'read'
        ? prior.consequence !== 'read'
          || prior.reversibility !== 'read_only'
          || prior.destructive !== false
          || prior.safeMode !== null
          || prior.descriptor.destinationPosture !== null
        : prior.descriptor.effect !== 'local_write'
          || !['reversible', 'create_only', 'irreversible'].includes(prior.reversibility)
          || (prior.reversibility === 'irreversible' && prior.safeMode === null)
    )
  ) return { ok: false, reason: 'invalid_local_planning_definition' };
  const current = await observeCurrentLocalPlanningDefinitions({
    name: prior.name,
    carrier: prior.carrier,
  });
  if (!current.ok) return { ok: false, reason: `local_planning_${current.reason}` };
  const matches = current.definitions.filter((definition) => definitionsEqual(prior, definition));
  if (matches.length !== 1) {
    return { ok: false, reason: 'local_planning_surface_changed' };
  }
  return { ok: true, definition: matches[0]! };
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
    && isRecord(value.descriptor)
    && (
      value.descriptor.effect === 'read'
        ? value.consequence === 'read'
          && value.reversibility === 'read_only'
          && value.safeMode === null
          && value.descriptor.destinationPosture === null
        : value.descriptor.effect === 'local_write'
          && ['reversible', 'create_only', 'irreversible'].includes(String(value.reversibility))
          && (value.reversibility !== 'irreversible' || isRecord(value.safeMode))
    )
    && typeof value.destructive === 'boolean'
    && value.accountIdentity === 'local_registry:host'
    && value.descriptor.id === value.capabilityRef
    && (value.descriptor.effect === 'read' || value.descriptor.effect === 'local_write')
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
function readDurableAuthorizedLocalPlanningDefinition(input: {
  sessionId: string;
  sourceUserSeq: number;
  capabilityRef: string;
}): DurableAuthorizedLocalPlanningDefinitionResult {
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
  return { ok: true, definition: first };
}

export async function loadDurableAuthorizedLocalPlanningDefinition(input: {
  sessionId: string;
  sourceUserSeq: number;
  capabilityRef: string;
}): Promise<DurableAuthorizedLocalPlanningDefinitionResult> {
  const prior = readDurableAuthorizedLocalPlanningDefinition(input);
  if (!prior.ok) return prior;
  const revalidated = await revalidateLocalPlanningDefinition(prior.definition);
  if (!revalidated.ok) {
    return { ok: false, reason: 'surface_changed', detail: revalidated.reason };
  }
  return { ok: true, definition: revalidated.definition };
}

/** Synchronous nomination only. The host binds this exact source/ref/target;
 * consent must still reopen and revalidate the current configured definition
 * before it can authorize dispatch. This cannot acquire a new local tool. */
export function nominateDisclosedLocalPlanningDefinition(input: {
  sessionId: string;
  sourceUserSeq: number;
  capabilityRef: string;
  operationId: string;
  effect: string;
  args: unknown;
}): AuthorizedLocalPlanningDefinitionV1 | null {
  const loaded = readDurableAuthorizedLocalPlanningDefinition(input);
  return loaded.ok
    && loaded.definition.name === input.operationId
    && loaded.definition.descriptor.effect === input.effect
    && localPlanningArgumentsMatch(loaded.definition, input.args)
    ? loaded.definition
    : null;
}

/** Argument-shape helper for the later consent/dispatch boundary. This module
 * does not call it to approve work; it merely preserves the declared mode. */
export function localPlanningArgumentsMatch(
  definition: AuthorizedLocalPlanningDefinitionV1,
  args: unknown,
): boolean {
  if (!definition.safeMode) return true;
  if (!isRecord(args)) return false;
  const predicates: readonly LocalPlanningSafeModePredicate[] = definition.safeMode.alternatives?.length
    ? definition.safeMode.alternatives
    : [definition.safeMode];
  return predicates.some((predicate) => {
    const nullEquivalent = new Set(predicate.nullEquivalentToRequired ?? []);
    for (const [field, expected] of Object.entries(predicate.requiredEquals)) {
      if (args[field] !== expected && !(args[field] === null && nullEquivalent.has(field))) return false;
    }
    for (const field of predicate.absentOrNull ?? []) {
      if (args[field] !== undefined && args[field] !== null) return false;
    }
    for (const [field, allowed] of Object.entries(predicate.allowedValues ?? {})) {
      if (!allowed.some((value) => args[field] === value)) return false;
    }
    return true;
  });
}
