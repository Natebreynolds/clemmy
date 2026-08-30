/**
 * Close one already-current external definition against the exact manifest
 * that materialized it, then project provider-neutral consent risk.
 *
 * This module performs no provider I/O and makes no consent decision. Composio
 * and native MCP adapters supply the same closed definition shape after their
 * normal live refresh/materialization checks. The loader preserves both
 * identity schemes involved at that boundary:
 *
 * - `manifestDefinitionFingerprint` is the materializer-owned fingerprint and
 *   must byte-match the current manifest. Its recipe may legitimately differ
 *   by carrier (for example, a schema fingerprint versus a complete tools/list
 *   definition fingerprint).
 * - `schemaDigest` is always the full sha256 of the canonical input schema and
 *   is independently recomputed here. A carrier cannot pair changed schema
 *   bytes with a stale materializer fingerprint.
 *
 * Provider/tool names are identity data only. Classification receives the
 * operation-only `semanticName` and normalized declared hints; there are no
 * provider or operation allowlists here.
 */
import { createHash } from 'node:crypto';

import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import {
  capabilityManifestDigest,
  parseCapabilityManifestOperationSemantics,
  validateCapabilityManifestV1,
  type CapabilityManifestV1,
} from './capability-manifest.js';
import {
  canonicalCatalogIdentityOf,
  isCurrentCallableCatalogEntry,
  peekHostCapabilityCatalogFactory,
  type HostCapabilityCatalogFactory,
} from './host-capability-catalog-factory.js';
import {
  peekCapabilityManifestStore,
  resolveCapabilityManifestStore,
  type CapabilityManifestStore,
} from './capability-manifest-store.js';
import {
  createProductionCapabilityAdapter,
  observationMatchesManifest,
  peekProductionCapabilityAdapter,
  type LiveCapabilityObserver,
} from './production-capability-adapter.js';
import {
  independentlyObserveCapability,
  observationIsFresh,
} from './independent-capability-observation.js';
import {
  EXTERNAL_CAPABILITY_RISK_INPUT_VERSION,
  projectExternalCapabilityRiskV1,
  type ExternalCapabilityEffect,
  type ExternalCapabilityProviderKind,
  type ExternalCapabilityRiskInputV1,
  type ExternalCapabilityRiskProjectionV1,
  type ExternalCapabilityRiskRefusal,
} from './external-capability-risk.js';
import type {
  CapabilityRiskAttestationV1,
  InteractiveConsentDestination,
} from './interactive-consent-policy.js';

export const EXTERNAL_CAPABILITY_RISK_LOADER_VERSION = 1 as const;
export const EXTERNAL_CAPABILITY_CALL_SIGNAL_VERSION = 1 as const;

export type ExternalCapabilityBehaviorHintsV1 =
  ExternalCapabilityRiskInputV1['behaviorHints'];

/**
 * Host-owned copy of one definition that the carrier has just observed and
 * the materializer has bound. `semanticName` excludes the configured
 * server/toolkit namespace; adapters derive it from their parsed live
 * definition, never from model prose.
 */
export interface CurrentExternalCapabilityDefinitionV1 {
  version: typeof EXTERNAL_CAPABILITY_RISK_LOADER_VERSION;
  providerKind: ExternalCapabilityProviderKind;
  providerIdentity: string;
  providerVersion: string;
  operationId: string;
  operationVersion: string;
  accountId: string;
  /** Exact fingerprint used by the manifest materializer. */
  manifestDefinitionFingerprint: string;
  /** Full sha256 of `inputSchema` under closed canonical JSON. */
  schemaDigest: string;
  inputSchema: Readonly<Record<string, unknown>>;
  semanticName: string;
  /** Only carrier-declared, structurally normalized hints belong here. */
  behaviorHints: ExternalCapabilityBehaviorHintsV1;
}

export interface LoadExternalCapabilityRiskAttestationInputV1 {
  version: typeof EXTERNAL_CAPABILITY_RISK_LOADER_VERSION;
  manifest: CapabilityManifestV1;
  currentDefinition: CurrentExternalCapabilityDefinitionV1;
  /** Exact destination derived by the host from the bound call. */
  destination: InteractiveConsentDestination;
  /** Exact argument-derived signals, never model-authored labels. */
  callSignals: ExternalCapabilityRiskInputV1['callSignals'];
  safety: CapabilityRiskAttestationV1['safety'];
}

export interface ExternalCapabilityRiskAttestationV1 {
  version: typeof EXTERNAL_CAPABILITY_RISK_LOADER_VERSION;
  manifest: {
    version: CapabilityManifestV1['version'];
    manifestId: string;
    manifestDigest: string;
    definitionFingerprint: string;
    providerKind: ExternalCapabilityProviderKind;
    providerIdentity: string;
    providerVersion: string;
    operationId: string;
    operationVersion: string;
    accountId: string;
    effect: ExternalCapabilityEffect;
  };
  currentDefinition: {
    definitionDigest: string;
    manifestDefinitionFingerprint: string;
    schemaDigest: string;
    providerKind: ExternalCapabilityProviderKind;
    providerIdentity: string;
    providerVersion: string;
    operationId: string;
    operationVersion: string;
    accountId: string;
    semanticName: string;
    behaviorHints: ExternalCapabilityBehaviorHintsV1;
  };
  projection: ExternalCapabilityRiskProjectionV1;
}

export type ExternalCapabilityRiskLoaderRefusal =
  | 'malformed_input'
  | 'manifest_not_current'
  | 'unsupported_provider'
  | 'unsupported_effect'
  | 'identity_mismatch'
  | 'definition_drift'
  | 'schema_drift'
  | 'destination_mismatch'
  | 'hint_conflict'
  | ExternalCapabilityRiskRefusal;

export type LoadExternalCapabilityRiskAttestationResultV1 =
  | { ok: true; attestation: ExternalCapabilityRiskAttestationV1 }
  | { ok: false; reason: ExternalCapabilityRiskLoaderRefusal };

/** Exact durable catalog binding already reopened by work_call preparation. */
export interface CatalogManifestExternalRiskBindingV1 {
  bindingKind: 'catalog_manifest';
  capabilityId: string;
  providerInputSchemaDigest?: string;
  schemaFingerprint: string;
  accountId: string;
  invokePortId: string;
  operationId: string;
  manifestId: string;
  manifestDigest: string;
  effect: string;
}

export interface LoadCatalogManifestExternalRiskAttestationInputV1 {
  version: typeof EXTERNAL_CAPABILITY_RISK_LOADER_VERSION;
  binding: CatalogManifestExternalRiskBindingV1;
  inputSchema: unknown;
  destination: InteractiveConsentDestination;
  callSignals: ExternalCapabilityRiskInputV1['callSignals'];
  safety: CapabilityRiskAttestationV1['safety'];
}

/** Test seam. Production omits it and reopens the installed owners. */
export interface CatalogManifestExternalRiskAuthorityV1 {
  manifestStore: CapabilityManifestStore;
  catalogFactory: HostCapabilityCatalogFactory;
  observe: LiveCapabilityObserver;
}

export type CatalogManifestExternalRiskRefusal =
  | ExternalCapabilityRiskLoaderRefusal
  | 'catalog_binding_mismatch'
  | 'manifest_unavailable'
  | 'schema_authority_missing'
  | 'current_definition_unavailable';

export type LoadCatalogManifestExternalRiskAttestationResultV1 =
  | { ok: true; attestation: ExternalCapabilityRiskAttestationV1 }
  | { ok: false; reason: CatalogManifestExternalRiskRefusal };

export interface DeriveExternalCapabilityCallSignalsInputV1 {
  version: typeof EXTERNAL_CAPABILITY_CALL_SIGNAL_VERSION;
  /** The exact provider schema selected by its durable full digest. */
  inputSchema: unknown;
  /** Exact normalized provider arguments paired with `inputSchema`. */
  arguments: unknown;
}

export type ExternalCapabilityCallSignalResolution =
  | 'affirmative'
  | 'resolved_non_affirmative'
  | 'not_exposed';

export type DeriveExternalCapabilityCallSignalsResultV1 =
  | {
      status: 'projected';
      resolution: ExternalCapabilityCallSignalResolution;
      callSignals: { outboundDelivery: true | null };
    }
  | {
      status: 'unknown';
      reason: 'malformed_input' | 'ambiguous_schema' | 'unresolved_delivery_signal';
      callSignals: { outboundDelivery: null };
    };

const SHA256 = /^[a-f0-9]{64}$/i;
const MAX_IDENTITY_BYTES = 2_048;
const CLOSED_INPUT_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 100_000,
  maxStringBytes: 1_048_576,
  maxTotalBytes: 2_097_152,
});
const CALL_SIGNAL_CLOSED_LIMITS = Object.freeze({
  maxDepth: 64,
  maxNodes: 200_000,
  maxStringBytes: 1_048_576,
  maxTotalBytes: 4_194_304,
});
const TOP_LEVEL_KEYS = new Set([
  'version',
  'manifest',
  'currentDefinition',
  'destination',
  'callSignals',
  'safety',
]);
const CURRENT_DEFINITION_KEYS = new Set([
  'version',
  'providerKind',
  'providerIdentity',
  'providerVersion',
  'operationId',
  'operationVersion',
  'accountId',
  'manifestDefinitionFingerprint',
  'schemaDigest',
  'inputSchema',
  'semanticName',
  'behaviorHints',
]);
const HINT_KEYS = new Set(['readOnly', 'destructive', 'idempotent', 'openWorld']);
const CALL_SIGNAL_KEYS = new Set(['outboundDelivery']);
const DESTINATION_KEYS = new Set(['digest', 'posture']);
const MANIFEST_KEYS = new Set([
  'version',
  'manifestId',
  'providerKind',
  'operationId',
  'providerIdentity',
  'providerVersion',
  'operationVersion',
  'definitionFingerprint',
  'externalDefinition',
  'effect',
  'operationSemantics',
  'destination',
  'accountId',
  'idempotency',
  'reconciliation',
  'outputContract',
  'purpose',
  'acceptedInputKinds',
  'producedOutputKinds',
  'applicableDeliverableKinds',
  'evidenceContract',
  'continuationContract',
  'readbackContract',
  'provenance',
  'lifecycle',
  'advisoryRoles',
  'delegatedFrom',
  'argumentCompiler',
  'invokePortId',
  'reconcilePortId',
]);
const PROVIDER_KINDS = new Set<ExternalCapabilityProviderKind>(['composio', 'native_mcp']);
const EFFECTS = new Set<ExternalCapabilityEffect>(['read', 'external_write', 'admin']);
const DESTINATION_POSTURES = new Set<InteractiveConsentDestination['posture']>([
  'create_new', 'named_existing', 'not_applicable',
]);
const CALL_SIGNAL_INPUT_KEYS = new Set(['version', 'inputSchema', 'arguments']);
const OUTBOUND_ARGUMENT_ACTIONS = new Set([
  'SEND', 'PUBLISH', 'NOTIFY', 'INVITE', 'DELIVER', 'DISPATCH',
  'BROADCAST', 'FORWARD', 'SHARE',
]);
const OUTBOUND_ARGUMENT_CONTEXT = new Set([
  'NOW', 'AT', 'TO', 'WITH', 'ON', 'AFTER', 'BEFORE', 'AUTO', 'AUTOMATICALLY',
  'SHOULD', 'DO', 'ENABLE', 'ENABLED',
  'NOTIFICATION', 'NOTIFICATIONS', 'RECIPIENT', 'RECIPIENTS', 'ATTENDEE',
  'ATTENDEES', 'USER', 'USERS', 'MEMBER', 'MEMBERS', 'CHANNEL', 'CHANNELS',
  'SUBSCRIBER', 'SUBSCRIBERS', 'FOLLOWER', 'FOLLOWERS', 'MESSAGE', 'MESSAGES',
  'EMAIL', 'EMAILS',
]);
const OUTBOUND_ENUM_VALUES = new Set([
  'SEND', 'SENT', 'PUBLISH', 'PUBLISHED', 'NOTIFY', 'NOTIFIED', 'INVITE',
  'INVITED', 'DELIVER', 'DELIVERED', 'DISPATCH', 'DISPATCHED', 'BROADCAST',
  'FORWARD', 'FORWARDED', 'SHARE', 'SHARED',
]);

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

/** Full provider-input-schema identity shared by both carrier materializers. */
export function canonicalExternalInputSchemaDigestV1(schema: unknown): string | null {
  try {
    if (!isRecord(schema)) return null;
    return sha256(closedCanonicalJson(schema, CLOSED_INPUT_LIMITS));
  } catch {
    return null;
  }
}

type ArgumentSignalSurfaceKind = 'boolean' | 'enum' | 'path' | 'unknown';

interface ArgumentSignalSurface {
  path: string[];
  kind: ArgumentSignalSurfaceKind;
  enumValues?: unknown[];
}

interface ArgumentSignalSchemaScan {
  surfaces: Map<string, ArgumentSignalSurface>;
  malformed: boolean;
  ambiguous: boolean;
}

function argumentTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

function outboundEnumValue(value: unknown): boolean {
  return typeof value === 'string'
    && argumentTokens(value).some((token) => OUTBOUND_ENUM_VALUES.has(token));
}

function pathHasOutboundAction(path: readonly string[]): boolean {
  return path.some((part) => {
    const tokens = argumentTokens(part);
    const actionIndex = tokens.findIndex((token) => OUTBOUND_ARGUMENT_ACTIONS.has(token));
    return actionIndex >= 0
      && tokens.every((token, index) => (
        index === actionIndex || OUTBOUND_ARGUMENT_CONTEXT.has(token)
      ));
  });
}

function genericOutboundPath(path: readonly string[]): boolean {
  if (path.length === 0) return false;
  const ancestorExact = path.slice(0, -1).some((part) => {
    const tokens = argumentTokens(part);
    return tokens.length === 1 && OUTBOUND_ARGUMENT_ACTIONS.has(tokens[0]!);
  });
  if (ancestorExact) return true;
  const tokens = argumentTokens(path[path.length - 1]!);
  return tokens.length > 0
    && OUTBOUND_ARGUMENT_ACTIONS.has(tokens[0]!)
    && tokens.slice(1).every((token) => OUTBOUND_ARGUMENT_CONTEXT.has(token));
}

function schemaAllowsType(schema: Record<string, unknown>, expected: string): boolean {
  const declared = schema.type;
  return declared === expected
    || (Array.isArray(declared) && declared.includes(expected));
}

function validSchemaType(value: unknown): boolean {
  const allowed = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
  return value === undefined
    || (typeof value === 'string' && allowed.has(value))
    || (Array.isArray(value)
      && value.length > 0
      && value.every((entry) => typeof entry === 'string' && allowed.has(entry)));
}

function localSchemaRef(root: Record<string, unknown>, reference: string): unknown | null {
  if (!reference.startsWith('#/')) return null;
  let current: unknown = root;
  for (const encoded of reference.slice(2).split('/')) {
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isRecord(current) || !Object.hasOwn(current, key)) return null;
    current = current[key];
  }
  return current;
}

function addArgumentSignalSurface(
  scan: ArgumentSignalSchemaScan,
  surface: ArgumentSignalSurface,
): void {
  const enumDigest = surface.enumValues
    ? sha256(closedCanonicalJson(surface.enumValues, CALL_SIGNAL_CLOSED_LIMITS))
    : '';
  scan.surfaces.set(`${surface.path.join('\0')}\0${surface.kind}\0${enumDigest}`, surface);
}

function scanArgumentSignalSchema(input: {
  schema: unknown;
  root: Record<string, unknown>;
  path: string[];
  refs: Set<string>;
  scan: ArgumentSignalSchemaScan;
  depth: number;
}): void {
  if (input.depth > 64) {
    input.scan.ambiguous = true;
    return;
  }
  if (typeof input.schema === 'boolean') return;
  if (!isRecord(input.schema)) {
    input.scan.malformed = true;
    return;
  }
  const schema = input.schema;
  if (!validSchemaType(schema.type)) input.scan.malformed = true;
  if (schema.required !== undefined && (
    !Array.isArray(schema.required)
    || !schema.required.every((entry) => typeof entry === 'string')
  )) input.scan.malformed = true;

  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== 'string' || input.refs.has(schema.$ref)) {
      input.scan.ambiguous = true;
    } else {
      const resolved = localSchemaRef(input.root, schema.$ref);
      if (resolved === null) input.scan.ambiguous = true;
      else {
        const refs = new Set(input.refs);
        refs.add(schema.$ref);
        scanArgumentSignalSchema({
          ...input,
          schema: resolved,
          refs,
          depth: input.depth + 1,
        });
      }
    }
  }

  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      input.scan.malformed = true;
    } else if (input.path.length > 0 && schema.enum.some(outboundEnumValue)) {
      addArgumentSignalSurface(input.scan, {
        path: [...input.path],
        kind: 'enum',
        enumValues: [...schema.enum],
      });
    }
  }

  const properties = schema.properties;
  if (properties !== undefined && !isRecord(properties)) {
    input.scan.malformed = true;
  } else if (isRecord(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      const path = [...input.path, name];
      if (typeof child === 'boolean') {
        if (pathHasOutboundAction(path)) {
          addArgumentSignalSurface(input.scan, { path, kind: 'unknown' });
        }
        continue;
      }
      if (!isRecord(child)) {
        input.scan.malformed = true;
        continue;
      }
      if (pathHasOutboundAction(path) && schemaAllowsType(child, 'boolean')) {
        addArgumentSignalSurface(input.scan, { path, kind: 'boolean' });
      } else if (
        genericOutboundPath(path)
        && !isRecord(child.properties)
        && (
          schemaAllowsType(child, 'string')
          || schemaAllowsType(child, 'array')
          || schemaAllowsType(child, 'object')
        )
      ) {
        addArgumentSignalSurface(input.scan, { path, kind: 'path' });
      }
      scanArgumentSignalSchema({
        ...input,
        schema: child,
        path,
        depth: input.depth + 1,
      });
    }
  }

  if (schema.items !== undefined) {
    if (typeof schema.items !== 'boolean' && !isRecord(schema.items)) {
      input.scan.malformed = true;
    } else {
      scanArgumentSignalSchema({
        ...input,
        schema: schema.items,
        path: [...input.path, '*'],
        depth: input.depth + 1,
      });
    }
  }

  for (const keyword of ['allOf', 'anyOf', 'oneOf', 'then', 'else'] as const) {
    const value = schema[keyword];
    if (value === undefined) continue;
    const alternatives = keyword === 'then' || keyword === 'else' ? [value] : value;
    if (!Array.isArray(alternatives) || alternatives.length === 0) {
      input.scan.malformed = true;
      continue;
    }
    for (const alternative of alternatives) {
      if (typeof alternative !== 'boolean' && !isRecord(alternative)) {
        input.scan.malformed = true;
        continue;
      }
      scanArgumentSignalSchema({
        ...input,
        schema: alternative,
        depth: input.depth + 1,
      });
    }
  }
  if (schema.patternProperties !== undefined || schema.dependentSchemas !== undefined) {
    input.scan.ambiguous = true;
  }
}

function explicitAffirmativeArgument(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') {
    const normalized = value.trim().toUpperCase();
    return normalized.length > 0
      && !new Set(['FALSE', 'OFF', 'NO', 'NONE', 'NULL', 'DRAFT', 'DISABLED']).has(normalized);
  }
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  return isRecord(value) && Object.keys(value).length > 0;
}

function declarationSchemas(input: {
  schema: unknown;
  root: Record<string, unknown>;
  refs: Set<string>;
  depth: number;
}): Record<string, unknown>[] {
  if (input.depth > 64 || !isRecord(input.schema)) return [];
  const schemas = [input.schema];
  const reference = input.schema.$ref;
  if (typeof reference === 'string' && !input.refs.has(reference)) {
    const resolved = localSchemaRef(input.root, reference);
    if (resolved !== null) {
      const refs = new Set(input.refs);
      refs.add(reference);
      schemas.push(...declarationSchemas({
        schema: resolved,
        root: input.root,
        refs,
        depth: input.depth + 1,
      }));
    }
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf', 'then', 'else'] as const) {
    const value = input.schema[keyword];
    if (value === undefined) continue;
    const alternatives = keyword === 'then' || keyword === 'else' ? [value] : value;
    if (!Array.isArray(alternatives)) continue;
    for (const alternative of alternatives) {
      schemas.push(...declarationSchemas({
        schema: alternative,
        root: input.root,
        refs: new Set(input.refs),
        depth: input.depth + 1,
      }));
    }
  }
  return schemas;
}

function containsUndeclaredOutboundArgument(input: {
  schema: unknown;
  root: Record<string, unknown>;
  args: unknown;
  path: string[];
  refs: Set<string>;
  depth: number;
}): boolean {
  const declarations = declarationSchemas({
    schema: input.schema,
    root: input.root,
    refs: input.refs,
    depth: input.depth,
  });
  if (Array.isArray(input.args)) {
    const items = declarations.flatMap((schema) => (
      schema.items === undefined ? [] : [schema.items]
    ));
    if (items.length === 0) {
      return input.args.some((value) => (
        containsUndeclaredOutboundArgument({
          schema: null,
          root: input.root,
          args: value,
          path: [...input.path, '*'],
          refs: new Set(input.refs),
          depth: input.depth + 1,
        })
      ));
    }
    return input.args.some((value) => items.every((schema) => (
      containsUndeclaredOutboundArgument({
        schema,
        root: input.root,
        args: value,
        path: [...input.path, '*'],
        refs: new Set(input.refs),
        depth: input.depth + 1,
      })
    )));
  }
  if (!isRecord(input.args)) return false;
  for (const [key, value] of Object.entries(input.args)) {
    const path = [...input.path, key];
    const children = declarations.flatMap((schema) => (
      isRecord(schema.properties) && Object.hasOwn(schema.properties, key)
        ? [schema.properties[key]]
        : []
    ));
    if (children.length === 0) {
      if (genericOutboundPath(path) && explicitAffirmativeArgument(value)) return true;
      if (containsUndeclaredOutboundArgument({
        schema: null,
        root: input.root,
        args: value,
        path,
        refs: new Set(input.refs),
        depth: input.depth + 1,
      })) return true;
      continue;
    }
    if (children.every((schema) => containsUndeclaredOutboundArgument({
      schema,
      root: input.root,
      args: value,
      path,
      refs: new Set(input.refs),
      depth: input.depth + 1,
    }))) return true;
  }
  return false;
}

interface ArgumentPathValues {
  values: unknown[];
  missing: boolean;
  invalid: boolean;
}

function argumentValuesAtPath(value: unknown, path: readonly string[]): ArgumentPathValues {
  let current: unknown[] = [value];
  let missing = false;
  let invalid = false;
  for (const part of path) {
    const next: unknown[] = [];
    for (const candidate of current) {
      if (part === '*') {
        if (!Array.isArray(candidate)) {
          invalid = true;
          continue;
        }
        next.push(...candidate);
        continue;
      }
      if (!isRecord(candidate)) {
        invalid = true;
        continue;
      }
      if (!Object.hasOwn(candidate, part)) {
        missing = true;
        continue;
      }
      next.push(candidate[part]);
    }
    current = next;
  }
  return { values: current, missing, invalid };
}

type ArgumentSignalValue = 'affirmative' | 'non_affirmative' | 'unknown';

function enumValueEquals(left: unknown, right: unknown): boolean {
  try {
    return closedCanonicalJson(left, CALL_SIGNAL_CLOSED_LIMITS)
      === closedCanonicalJson(right, CALL_SIGNAL_CLOSED_LIMITS);
  } catch {
    return false;
  }
}

function evaluateArgumentSignalSurface(
  surface: ArgumentSignalSurface,
  args: Record<string, unknown>,
): ArgumentSignalValue {
  if (surface.kind === 'unknown') return 'unknown';
  const found = argumentValuesAtPath(args, surface.path);
  if (found.invalid || found.missing || found.values.length === 0) return 'unknown';
  if (surface.kind === 'boolean') {
    if (found.values.some((value) => value === true)) return 'affirmative';
    return found.values.every((value) => value === false || value === null)
      ? 'non_affirmative'
      : 'unknown';
  }
  if (surface.kind === 'enum') {
    const declared = surface.enumValues ?? [];
    const matched = found.values.map((value) => declared.find((entry) => enumValueEquals(entry, value)));
    if (matched.some((value) => value === undefined)) return 'unknown';
    return matched.some(outboundEnumValue) ? 'affirmative' : 'non_affirmative';
  }
  if (found.values.some(explicitAffirmativeArgument)) return 'affirmative';
  return 'non_affirmative';
}

/**
 * Derive only argument-dependent outbound delivery evidence. The operation
 * classifier still owns name/manifest semantics. This function can raise an
 * exact call to outbound, but it never fabricates `false` from an absent field.
 * A schema-exposed delivery control that is missing, malformed, or ambiguous
 * returns `unknown` so the consent adapter repairs instead of auto-lowering an
 * ordinary mutation.
 */
export function deriveExternalCapabilityCallSignalsV1(
  raw: unknown,
): DeriveExternalCapabilityCallSignalsResultV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(closedCanonicalJson(raw, CALL_SIGNAL_CLOSED_LIMITS)) as unknown;
  } catch {
    return {
      status: 'unknown', reason: 'malformed_input', callSignals: { outboundDelivery: null },
    };
  }
  if (
    !isRecord(parsed)
    || !hasExactKeys(parsed, CALL_SIGNAL_INPUT_KEYS)
    || parsed.version !== EXTERNAL_CAPABILITY_CALL_SIGNAL_VERSION
    || !isRecord(parsed.inputSchema)
    || !isRecord(parsed.arguments)
  ) return {
    status: 'unknown', reason: 'malformed_input', callSignals: { outboundDelivery: null },
  };

  const scan: ArgumentSignalSchemaScan = {
    surfaces: new Map(),
    malformed: false,
    ambiguous: false,
  };
  scanArgumentSignalSchema({
    schema: parsed.inputSchema,
    root: parsed.inputSchema,
    path: [],
    refs: new Set(),
    scan,
    depth: 0,
  });
  if (scan.malformed) return {
    status: 'unknown', reason: 'malformed_input', callSignals: { outboundDelivery: null },
  };
  if (
    scan.ambiguous
    || containsUndeclaredOutboundArgument({
      schema: parsed.inputSchema,
      root: parsed.inputSchema,
      args: parsed.arguments,
      path: [],
      refs: new Set(),
      depth: 0,
    })
  ) return {
    status: 'unknown', reason: 'ambiguous_schema', callSignals: { outboundDelivery: null },
  };

  const byPath = new Map<string, ArgumentSignalValue[]>();
  for (const surface of scan.surfaces.values()) {
    const key = surface.path.join('\0');
    const values = byPath.get(key) ?? [];
    values.push(evaluateArgumentSignalSurface(surface, parsed.arguments));
    byPath.set(key, values);
  }
  const pathResults: ArgumentSignalValue[] = [];
  for (const values of byPath.values()) {
    const unique = new Set(values);
    pathResults.push(unique.size === 1 ? values[0]! : 'unknown');
  }
  if (pathResults.includes('affirmative')) return {
    status: 'projected',
    resolution: 'affirmative',
    callSignals: { outboundDelivery: true },
  };
  if (pathResults.includes('unknown')) return {
    status: 'unknown',
    reason: 'unresolved_delivery_signal',
    callSignals: { outboundDelivery: null },
  };
  return {
    status: 'projected',
    resolution: pathResults.length > 0 ? 'resolved_non_affirmative' : 'not_exposed',
    callSignals: { outboundDelivery: null },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedNonBlank(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && Buffer.byteLength(value, 'utf8') <= MAX_IDENTITY_BYTES;
}

function nullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean';
}

function validHints(value: unknown): value is ExternalCapabilityBehaviorHintsV1 {
  return isRecord(value)
    && hasExactKeys(value, HINT_KEYS)
    && nullableBoolean(value.readOnly)
    && nullableBoolean(value.destructive)
    && nullableBoolean(value.idempotent)
    && nullableBoolean(value.openWorld);
}

function validDestination(value: unknown): value is InteractiveConsentDestination {
  return isRecord(value)
    && hasExactKeys(value, DESTINATION_KEYS)
    && typeof value.digest === 'string'
    && SHA256.test(value.digest)
    && typeof value.posture === 'string'
    && DESTINATION_POSTURES.has(value.posture as InteractiveConsentDestination['posture']);
}

function closedInput(raw: unknown): LoadExternalCapabilityRiskAttestationInputV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(closedCanonicalJson(raw, CLOSED_INPUT_LIMITS)) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, TOP_LEVEL_KEYS)) return null;
  if (parsed.version !== EXTERNAL_CAPABILITY_RISK_LOADER_VERSION) return null;
  if (!isRecord(parsed.manifest) || !hasOnlyKeys(parsed.manifest, MANIFEST_KEYS)) return null;

  const definition = parsed.currentDefinition;
  if (
    !isRecord(definition)
    || !hasExactKeys(definition, CURRENT_DEFINITION_KEYS)
    || definition.version !== EXTERNAL_CAPABILITY_RISK_LOADER_VERSION
    || typeof definition.providerKind !== 'string'
    || !PROVIDER_KINDS.has(definition.providerKind as ExternalCapabilityProviderKind)
    || !boundedNonBlank(definition.providerIdentity)
    || !boundedNonBlank(definition.providerVersion)
    || !boundedNonBlank(definition.operationId)
    || !boundedNonBlank(definition.operationVersion)
    || !boundedNonBlank(definition.accountId)
    || !boundedNonBlank(definition.manifestDefinitionFingerprint)
    || typeof definition.schemaDigest !== 'string'
    || !SHA256.test(definition.schemaDigest)
    || !isRecord(definition.inputSchema)
    || !boundedNonBlank(definition.semanticName)
    || !validHints(definition.behaviorHints)
  ) return null;

  if (
    !validDestination(parsed.destination)
    || !isRecord(parsed.callSignals)
    || !hasExactKeys(parsed.callSignals, CALL_SIGNAL_KEYS)
    || !nullableBoolean(parsed.callSignals.outboundDelivery)
  ) return null;

  return parsed as unknown as LoadExternalCapabilityRiskAttestationInputV1;
}

function manifestEffect(
  manifest: CapabilityManifestV1,
): ExternalCapabilityEffect | null {
  return EFFECTS.has(manifest.effect as ExternalCapabilityEffect)
    ? manifest.effect as ExternalCapabilityEffect
    : null;
}

function identityMatches(input: {
  manifest: CapabilityManifestV1;
  definition: CurrentExternalCapabilityDefinitionV1;
}): boolean {
  return input.manifest.providerKind === input.definition.providerKind
    && input.manifest.providerIdentity === input.definition.providerIdentity
    && input.manifest.providerVersion === input.definition.providerVersion
    && input.manifest.operationId === input.definition.operationId
    && input.manifest.operationVersion === input.definition.operationVersion
    && input.manifest.accountId === input.definition.accountId;
}

/**
 * Produce risk evidence only. A caller still has to combine this with the
 * accepted-work source, exact logical call, arguments, destination, readiness,
 * and crossing state before invoking interactive-consent-policy.
 */
export function loadExternalCapabilityRiskAttestationV1(
  raw: unknown,
): LoadExternalCapabilityRiskAttestationResultV1 {
  const input = closedInput(raw);
  if (!input) return { ok: false, reason: 'malformed_input' };

  // `closedInput` has recursively proved the original value contains only
  // plain data properties. Keep the original manifest object for its existing
  // authority digest: capabilityManifestDigest predates the closed encoder and
  // preserves nested object insertion order. Re-serializing through sorted
  // canonical JSON and then hashing would silently invent a different manifest
  // identity even though the closed bytes are semantically identical.
  const originalManifest = (raw as LoadExternalCapabilityRiskAttestationInputV1).manifest;
  const checked = validateCapabilityManifestV1(originalManifest);
  if (!checked.ok) return { ok: false, reason: 'manifest_not_current' };
  const manifest = checked.manifest;
  const definition = input.currentDefinition;
  if (!PROVIDER_KINDS.has(manifest.providerKind as ExternalCapabilityProviderKind)) {
    return { ok: false, reason: 'unsupported_provider' };
  }
  const effect = manifestEffect(manifest);
  if (!effect) return { ok: false, reason: 'unsupported_effect' };
  if (!identityMatches({ manifest, definition })) {
    return { ok: false, reason: 'identity_mismatch' };
  }
  if (manifest.definitionFingerprint !== definition.manifestDefinitionFingerprint) {
    return { ok: false, reason: 'definition_drift' };
  }

  let schemaBytes: string;
  try {
    schemaBytes = closedCanonicalJson(definition.inputSchema, CLOSED_INPUT_LIMITS);
  } catch {
    return { ok: false, reason: 'malformed_input' };
  }
  const schemaDigest = sha256(schemaBytes);
  if (schemaDigest.toLowerCase() !== definition.schemaDigest.toLowerCase()) {
    return { ok: false, reason: 'schema_drift' };
  }

  const manifestPosture = manifest.destination?.posture ?? 'not_applicable';
  if (manifestPosture !== input.destination.posture) {
    return { ok: false, reason: 'destination_mismatch' };
  }
  if (
    definition.behaviorHints.readOnly === true
    && definition.behaviorHints.destructive === true
  ) return { ok: false, reason: 'hint_conflict' };

  const manifestDigest = capabilityManifestDigest(manifest);
  const definitionDigest = sha256(closedCanonicalJson({
    domain: 'current-external-capability-definition',
    version: EXTERNAL_CAPABILITY_RISK_LOADER_VERSION,
    providerKind: definition.providerKind,
    providerIdentity: definition.providerIdentity,
    providerVersion: definition.providerVersion,
    operationId: definition.operationId,
    operationVersion: definition.operationVersion,
    accountId: definition.accountId,
    manifestDefinitionFingerprint: definition.manifestDefinitionFingerprint,
    schemaDigest,
    inputSchema: definition.inputSchema,
    semanticName: definition.semanticName,
    behaviorHints: definition.behaviorHints,
  }, CLOSED_INPUT_LIMITS));
  // The projector's historical field is a single schema fingerprint shared by
  // manifest and live definition. Bind both exact identities into one digest
  // without pretending the carrier's manifest fingerprint is itself a schema
  // hash (native MCP fingerprints the complete definition).
  const riskBindingFingerprint = sha256(closedCanonicalJson({
    domain: 'external-capability-risk-definition-binding',
    version: EXTERNAL_CAPABILITY_RISK_LOADER_VERSION,
    manifestDefinitionFingerprint: definition.manifestDefinitionFingerprint,
    schemaDigest,
  }));
  const projection = projectExternalCapabilityRiskV1({
    version: EXTERNAL_CAPABILITY_RISK_INPUT_VERSION,
    manifest: {
      manifestVersion: manifest.version,
      manifestId: manifest.manifestId,
      manifestDigest,
      providerKind: definition.providerKind,
      providerIdentity: manifest.providerIdentity,
      providerVersion: manifest.providerVersion,
      operationId: manifest.operationId,
      operationVersion: manifest.operationVersion,
      schemaFingerprint: riskBindingFingerprint,
      accountId: manifest.accountId,
      effect,
      destination: input.destination,
    },
    liveDefinition: {
      definitionDigest,
      providerKind: definition.providerKind,
      providerIdentity: definition.providerIdentity,
      providerVersion: definition.providerVersion,
      operationId: definition.operationId,
      operationVersion: definition.operationVersion,
      schemaFingerprint: riskBindingFingerprint,
      accountId: definition.accountId,
      semanticName: definition.semanticName,
    },
    behaviorHints: definition.behaviorHints,
    callSignals: input.callSignals,
    documentedSemantic: sealedSemanticForManifest(manifest),
    safety: input.safety,
  } satisfies ExternalCapabilityRiskInputV1);
  if (!projection.ok) return { ok: false, reason: projection.reason };

  return {
    ok: true,
    attestation: {
      version: EXTERNAL_CAPABILITY_RISK_LOADER_VERSION,
      manifest: {
        version: manifest.version,
        manifestId: manifest.manifestId,
        manifestDigest,
        definitionFingerprint: manifest.definitionFingerprint,
        providerKind: definition.providerKind,
        providerIdentity: manifest.providerIdentity,
        providerVersion: manifest.providerVersion,
        operationId: manifest.operationId,
        operationVersion: manifest.operationVersion,
        accountId: manifest.accountId,
        effect,
      },
      currentDefinition: {
        definitionDigest,
        manifestDefinitionFingerprint: definition.manifestDefinitionFingerprint,
        schemaDigest,
        providerKind: definition.providerKind,
        providerIdentity: definition.providerIdentity,
        providerVersion: definition.providerVersion,
        operationId: definition.operationId,
        operationVersion: definition.operationVersion,
        accountId: definition.accountId,
        semanticName: definition.semanticName,
        behaviorHints: { ...definition.behaviorHints },
      },
      projection: projection.projection,
    },
  };
}

function operationOnlySemanticName(operationId: string): string {
  // MCP namespace syntax is structural, not a server allowlist. Strip only an
  // exact transport prefix and one exact `server__tool` boundary. Composio and
  // other action identifiers retain their full provider-declared operation id;
  // the projector searches action tokens without treating the namespace as a
  // permission or risk fact.
  const withoutTransport = operationId.trim().replace(/^mcp__/i, '');
  const boundary = withoutTransport.indexOf('__');
  return boundary > 0 && boundary < withoutTransport.length - 2
    ? withoutTransport.slice(boundary + 2)
    : withoutTransport;
}

function sealedSemanticForManifest(
  manifest: CapabilityManifestV1,
): ExternalCapabilityRiskInputV1['documentedSemantic'] {
  const semantic = manifest.operationSemantics
    ? parseCapabilityManifestOperationSemantics(manifest.operationSemantics)
    : null;
  if (!semantic?.reversibility) return null;

  const destructive = manifest.externalDefinition?.behaviorHints.destructive === true;
  const consequence = manifest.effect === 'admin'
    ? 'admin' as const
    : manifest.destination?.posture === 'create_new'
      ? 'create' as const
      : manifest.destination?.posture === 'named_existing'
        ? 'update' as const
        : 'unknown' as const;
  const positivelyBoundedReversibleCreate = semantic.reversibility === 'reversible'
    && manifest.effect === 'external_write'
    && manifest.destination?.posture === 'create_new'
    && manifest.externalDefinition?.behaviorHints.readOnly === false
    && manifest.externalDefinition.behaviorHints.destructive === false
    && manifest.idempotency.required === true
    && manifest.reconciliation.supported === true;
  const reversibility = semantic.reversibility === 'irreversible'
    ? 'irreversible' as const
    : positivelyBoundedReversibleCreate
      ? 'reversible' as const
      : 'unknown' as const;
  return {
    sourceDigest: sha256(closedCanonicalJson({
      domain: 'sealed-external-operation-semantic',
      version: EXTERNAL_CAPABILITY_RISK_LOADER_VERSION,
      manifestDigest: capabilityManifestDigest(manifest),
      effect: manifest.effect,
      destination: manifest.destination ?? null,
      behaviorHints: manifest.externalDefinition?.behaviorHints ?? null,
      semantic,
    })),
    effect: manifest.effect === 'admin' ? 'admin' : 'external_write',
    reversibility,
    consequence,
    destructive,
  };
}

function productionAuthority(): CatalogManifestExternalRiskAuthorityV1 | null {
  const manifestStore = peekCapabilityManifestStore() ?? resolveCapabilityManifestStore();
  const catalogFactory = peekHostCapabilityCatalogFactory();
  if (!catalogFactory) return null;
  const adapter = peekProductionCapabilityAdapter()
    ?? createProductionCapabilityAdapter({ store: manifestStore, factory: catalogFactory });
  return {
    manifestStore,
    catalogFactory,
    observe: (manifest) => {
      // Proof provisioning and live carrier materialization both register the
      // shipped independent observer as crossing-time authority. Reopen that
      // owner before asking an optional direct transport: a work_call carrier
      // may deliberately have no parallel direct provider dispatch port.
      const independent = independentlyObserveCapability(
        manifest.operationId,
        manifest.accountId,
      );
      if (
        independent
        && independent.origin === 'independent'
        && observationIsFresh(independent)
      ) {
        if (
          independent.operationId !== manifest.operationId
          || independent.accountId !== manifest.accountId
        ) return 'mismatched';
        return {
          definitionFingerprint: independent.definitionFingerprint,
          providerVersion: independent.providerVersion,
          operationVersion: independent.operationVersion,
          accountId: independent.accountId,
          observedAt: independent.observedAt,
        };
      }
      return adapter.observe[manifest.providerKind](manifest);
    },
  };
}

/**
 * Production-ready catalog seam for prepared `catalog_manifest` work.
 *
 * The function reopens the current manifest, registered catalog identity,
 * immutable schema digest, account, operation/provider versions, and current
 * observer before delegating to the pure loader above. It does not evaluate
 * interactive consent and does not issue an admission token.
 */
export function loadCatalogManifestExternalRiskAttestationV1(
  input: LoadCatalogManifestExternalRiskAttestationInputV1,
  authority?: CatalogManifestExternalRiskAuthorityV1,
): LoadCatalogManifestExternalRiskAttestationResultV1 {
  if (input.version !== EXTERNAL_CAPABILITY_RISK_LOADER_VERSION) {
    return { ok: false, reason: 'malformed_input' };
  }
  const resolved = authority ?? productionAuthority();
  if (!resolved) return { ok: false, reason: 'current_definition_unavailable' };
  const binding = input.binding;
  if (binding.bindingKind !== 'catalog_manifest') {
    return { ok: false, reason: 'catalog_binding_mismatch' };
  }

  const installed = resolved.manifestStore.get(binding.manifestId);
  if (!installed || installed.digest !== binding.manifestDigest) {
    return { ok: false, reason: 'manifest_unavailable' };
  }
  const manifest = installed.manifest;
  if (capabilityManifestDigest(manifest) !== binding.manifestDigest) {
    return { ok: false, reason: 'manifest_unavailable' };
  }
  const catalog = resolved.catalogFactory.get(binding.capabilityId);
  const canonical = catalog ? canonicalCatalogIdentityOf(catalog) : null;
  // Parallel connected accounts are separate current authorities for the same
  // provider operation. Uniqueness belongs to the exact bound tuple, not to a
  // global operation-name bucket; two rows for the SAME tuple remain an
  // ambiguity and fail closed.
  const currentBindingRows = resolved.catalogFactory.snapshot().filter((entry) => (
    isCurrentCallableCatalogEntry(entry)
    && entry.manifest.operationId === manifest.operationId
    && entry.manifest.providerKind === manifest.providerKind
    && entry.manifest.providerIdentity === manifest.providerIdentity
    && entry.manifest.accountId === manifest.accountId
  ));
  if (
    !catalog
    || !isCurrentCallableCatalogEntry(catalog)
    || currentBindingRows.length !== 1
    || currentBindingRows[0] !== catalog
    || !canonical
    || canonical.capabilityId !== binding.capabilityId
    || canonical.manifestId !== binding.manifestId
    || canonical.manifestDigest !== binding.manifestDigest
    || canonical.operationId !== binding.operationId
    || canonical.schemaDigest !== binding.schemaFingerprint
    || canonical.account !== binding.accountId
    || canonical.effect !== binding.effect
    || canonical.invokePortId !== binding.invokePortId
    || manifest.operationId !== binding.operationId
    || manifest.definitionFingerprint !== binding.schemaFingerprint
    || manifest.accountId !== binding.accountId
    || manifest.effect !== binding.effect
    || manifest.invokePortId !== binding.invokePortId
  ) return { ok: false, reason: 'catalog_binding_mismatch' };

  const schemaDigest = canonicalExternalInputSchemaDigestV1(input.inputSchema);
  const persistedDefinition = manifest.externalDefinition;
  const expectedSchemaDigest = binding.providerInputSchemaDigest
    ?? canonical.providerInputSchemaDigest
    ?? persistedDefinition?.providerInputSchemaDigest;
  if (!expectedSchemaDigest || !SHA256.test(expectedSchemaDigest)) {
    return { ok: false, reason: 'schema_authority_missing' };
  }
  if (
    schemaDigest !== expectedSchemaDigest.toLowerCase()
    || (persistedDefinition
      && persistedDefinition.providerInputSchemaDigest !== expectedSchemaDigest)
    || (binding.providerInputSchemaDigest
      && canonical.providerInputSchemaDigest
      && binding.providerInputSchemaDigest !== canonical.providerInputSchemaDigest)
  ) return { ok: false, reason: 'schema_drift' };
  // A native MCP operation has no separate curated semantics registry. Its
  // exact normalized tools/list annotations must therefore be carried by the
  // manifest that materialized the catalog entry. Falling back to absent hints
  // would silently turn destructiveHint/openWorldHint drift into ordinary
  // work after restart.
  if (manifest.providerKind === 'native_mcp' && !persistedDefinition) {
    return { ok: false, reason: 'current_definition_unavailable' };
  }
  if (
    persistedDefinition
    && persistedDefinition.semanticName !== operationOnlySemanticName(manifest.operationId)
  ) return { ok: false, reason: 'identity_mismatch' };

  const observed = observationMatchesManifest(manifest, resolved.observe(manifest));
  if (!observed.ok) return { ok: false, reason: 'current_definition_unavailable' };

  return loadExternalCapabilityRiskAttestationV1({
    version: EXTERNAL_CAPABILITY_RISK_LOADER_VERSION,
    manifest,
    currentDefinition: {
      version: EXTERNAL_CAPABILITY_RISK_LOADER_VERSION,
      providerKind: manifest.providerKind as ExternalCapabilityProviderKind,
      providerIdentity: manifest.providerIdentity,
      providerVersion: observed.observation.providerVersion,
      operationId: manifest.operationId,
      operationVersion: observed.observation.operationVersion,
      accountId: observed.observation.accountId,
      manifestDefinitionFingerprint: observed.observation.definitionFingerprint,
      schemaDigest,
      inputSchema: input.inputSchema as Readonly<Record<string, unknown>>,
      semanticName: persistedDefinition?.semanticName
        ?? operationOnlySemanticName(manifest.operationId),
      behaviorHints: persistedDefinition
        ? { ...persistedDefinition.behaviorHints }
        : {
            readOnly: null,
            destructive: null,
            idempotent: null,
            openWorld: null,
          },
    },
    destination: input.destination,
    callSignals: input.callSignals,
    safety: input.safety,
  });
}
