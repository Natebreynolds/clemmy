import { createHash } from 'node:crypto';

/**
 * Provider-neutral executable contract for a standing policy.
 *
 * Natural-language compilation belongs to an integration adapter. The memory
 * and harness kernels accept only this sealed data contract; they never infer
 * an operand, provider, route, or account from remembered prose.
 */
export const STANDING_POLICY_SCHEMA_VERSION = 2 as const;
export const STANDING_POLICY_COMPILER_PROTOCOL = 'standing-policy-compiler/v1' as const;

export interface StandingPolicySelector {
  /** Adapter-owned namespace. It is opaque to the shared kernel. */
  adapterId: string;
  /** Every tag must be present in the adapter-normalized dispatch context. */
  allTags: string[];
}

export interface StandingPolicyDirectiveBase {
  selector: StandingPolicySelector;
  reason: string;
  violatingField: string;
  overrideAllowed: boolean;
  recovery: string;
}

export interface StandingPolicyDenyDirective extends StandingPolicyDirectiveBase {
  kind: 'deny';
}

export interface StandingPolicyFieldDirective extends StandingPolicyDirectiveBase {
  kind: 'field_constraint';
  field: string;
  operator: 'forbid_exact' | 'forbid_contains' | 'require_contains';
  values: string[];
  /** When true, an absent normalized field is itself a violation. */
  requirePresent: boolean;
}

export interface StandingPolicyIdentityDirective extends StandingPolicyDirectiveBase {
  kind: 'verified_identity';
  identityKind: string;
  requiredValue: string;
  verifierCapability: string;
  /** Optional reversible-authoring selector. It is preference, not authority. */
  preferenceSelector?: StandingPolicySelector;
}

export interface StandingPolicyRouteDirective extends StandingPolicyDirectiveBase {
  kind: 'route';
  bindingKind: string;
  bindingValue: string;
  intentLabels: string[];
}

export type StandingPolicyDirective =
  | StandingPolicyDenyDirective
  | StandingPolicyFieldDirective
  | StandingPolicyIdentityDirective
  | StandingPolicyRouteDirective;

/** A generic advertisement hint. It can widen visibility, never grant call authority. */
export interface StandingPolicyCapabilityHint {
  adapterId: string;
  intentLabels: string[];
  requiresTemporalCue: boolean;
  allowedServerSlugs: string[];
  toolPatterns: string[];
  priorityKeywords: string[];
  maxTools: number;
}

export interface StandingPolicyBinding {
  adapterId: string;
  kind: string;
  value: string;
}

export interface StandingPolicyDescriptorBody {
  schemaVersion: typeof STANDING_POLICY_SCHEMA_VERSION;
  contract: 'standing_policy';
  compiler: {
    protocol: typeof STANDING_POLICY_COMPILER_PROTOCOL;
    adapterId: string;
    version: number;
  };
  sourceSha256: string;
  deterministic: boolean;
  policyClass: string;
  gateways: string[];
  bindings: StandingPolicyBinding[];
  directives: StandingPolicyDirective[];
  capabilityHints: StandingPolicyCapabilityHint[];
  reason: string;
}

export interface StandingPolicyDescriptor extends StandingPolicyDescriptorBody {
  seal: {
    algorithm: 'sha256';
    digest: string;
  };
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const TOKEN_RE = /^[a-z0-9][a-z0-9_.:/-]{0,127}$/i;
const MAX_TEXT = 1_000;
const MAX_LIST = 64;

export function standingPolicySourceSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function descriptorDigest(body: StandingPolicyDescriptorBody): string {
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}

export function sealStandingPolicyDescriptor(body: StandingPolicyDescriptorBody): StandingPolicyDescriptor {
  return {
    ...body,
    seal: { algorithm: 'sha256', digest: descriptorDigest(body) },
  };
}

export function compilePromptStandingPolicyDescriptor(
  content: string,
  policyClass: 'core_profile' | 'standing_preference' = 'standing_preference',
): StandingPolicyDescriptor {
  return sealStandingPolicyDescriptor({
    schemaVersion: STANDING_POLICY_SCHEMA_VERSION,
    contract: 'standing_policy',
    compiler: {
      protocol: STANDING_POLICY_COMPILER_PROTOCOL,
      adapterId: 'prompt-context',
      version: 1,
    },
    sourceSha256: standingPolicySourceSha256(content),
    deterministic: false,
    policyClass,
    gateways: [],
    bindings: [],
    directives: [],
    capabilityHints: [],
    reason: 'Prompt-context policy; not a tool-dispatch constraint.',
  });
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function token(value: unknown): value is string {
  return boundedText(value, 128) && TOKEN_RE.test(value);
}

function tokenList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= MAX_LIST
    && value.every(token)
    && new Set(value).size === value.length;
}

function parseSelector(value: unknown): StandingPolicySelector | null {
  if (!record(value) || !exactKeys(value, ['adapterId', 'allTags'])) return null;
  if (!token(value.adapterId) || !tokenList(value.allTags)) return null;
  return { adapterId: value.adapterId, allTags: [...value.allTags] };
}

function parseDirective(value: unknown): StandingPolicyDirective | null {
  if (!record(value) || !boundedText(value.kind, 64)) return null;
  const commonKeys = ['kind', 'selector', 'reason', 'violatingField', 'overrideAllowed', 'recovery'];
  const selector = parseSelector(value.selector);
  if (!selector || !boundedText(value.reason) || !boundedText(value.violatingField, 128)
    || typeof value.overrideAllowed !== 'boolean' || !boundedText(value.recovery)) return null;
  const base = {
    selector,
    reason: value.reason,
    violatingField: value.violatingField,
    overrideAllowed: value.overrideAllowed,
    recovery: value.recovery,
  };
  if (value.kind === 'deny') {
    if (!exactKeys(value, commonKeys)) return null;
    return { kind: 'deny', ...base };
  }
  if (value.kind === 'field_constraint') {
    if (!exactKeys(value, [...commonKeys, 'field', 'operator', 'values', 'requirePresent'])) return null;
    if (!token(value.field)
      || !['forbid_exact', 'forbid_contains', 'require_contains'].includes(String(value.operator))
      || !tokenList(value.values) || value.values.length === 0
      || typeof value.requirePresent !== 'boolean') return null;
    return {
      kind: 'field_constraint',
      ...base,
      field: value.field,
      operator: value.operator as StandingPolicyFieldDirective['operator'],
      values: [...value.values],
      requirePresent: value.requirePresent,
    };
  }
  if (value.kind === 'verified_identity') {
    const hasPreference = Object.hasOwn(value, 'preferenceSelector');
    if (!exactKeys(value, [...commonKeys, 'identityKind', 'requiredValue', 'verifierCapability', ...(hasPreference ? ['preferenceSelector'] : [])])) return null;
    const preferenceSelector = hasPreference ? parseSelector(value.preferenceSelector) : undefined;
    if (!token(value.identityKind) || !boundedText(value.requiredValue, 320)
      || !token(value.verifierCapability) || (hasPreference && !preferenceSelector)) return null;
    return {
      kind: 'verified_identity',
      ...base,
      identityKind: value.identityKind,
      requiredValue: value.requiredValue,
      verifierCapability: value.verifierCapability,
      ...(preferenceSelector ? { preferenceSelector } : {}),
    };
  }
  if (value.kind === 'route') {
    if (!exactKeys(value, [...commonKeys, 'bindingKind', 'bindingValue', 'intentLabels'])) return null;
    if (!token(value.bindingKind) || !boundedText(value.bindingValue, 320) || !tokenList(value.intentLabels)) return null;
    return {
      kind: 'route',
      ...base,
      bindingKind: value.bindingKind,
      bindingValue: value.bindingValue,
      intentLabels: [...value.intentLabels],
    };
  }
  return null;
}

function parseBinding(value: unknown): StandingPolicyBinding | null {
  if (!record(value) || !exactKeys(value, ['adapterId', 'kind', 'value'])) return null;
  if (!token(value.adapterId) || !token(value.kind) || !token(value.value)) return null;
  return { adapterId: value.adapterId, kind: value.kind, value: value.value };
}

function parseHint(value: unknown): StandingPolicyCapabilityHint | null {
  if (!record(value) || !exactKeys(value, [
    'adapterId', 'intentLabels', 'requiresTemporalCue', 'allowedServerSlugs',
    'toolPatterns', 'priorityKeywords', 'maxTools',
  ])) return null;
  if (!token(value.adapterId) || !tokenList(value.intentLabels)
    || typeof value.requiresTemporalCue !== 'boolean'
    || !tokenList(value.allowedServerSlugs) || !tokenList(value.toolPatterns)
    || !tokenList(value.priorityKeywords) || !Number.isSafeInteger(value.maxTools)
    || (value.maxTools as number) < 1 || (value.maxTools as number) > 64) return null;
  return {
    adapterId: value.adapterId,
    intentLabels: [...value.intentLabels],
    requiresTemporalCue: value.requiresTemporalCue,
    allowedServerSlugs: [...value.allowedServerSlugs],
    toolPatterns: [...value.toolPatterns],
    priorityKeywords: [...value.priorityKeywords],
    maxTools: value.maxTools as number,
  };
}

/**
 * Strict read-side parser. The compiled JSON is the executable authority:
 * source prose is consulted only for its digest, never reinterpreted.
 */
export function parseStandingPolicyDescriptor(
  value: string | null | undefined,
  sourceContent: string,
): StandingPolicyDescriptor | null {
  try {
    const parsed = JSON.parse(value ?? '') as unknown;
    if (!record(parsed) || !exactKeys(parsed, [
      'schemaVersion', 'contract', 'compiler', 'sourceSha256', 'deterministic',
      'policyClass', 'gateways', 'bindings', 'directives', 'capabilityHints', 'reason', 'seal',
    ])) return null;
    if (parsed.schemaVersion !== STANDING_POLICY_SCHEMA_VERSION || parsed.contract !== 'standing_policy') return null;
    if (!record(parsed.compiler) || !exactKeys(parsed.compiler, ['protocol', 'adapterId', 'version'])
      || parsed.compiler.protocol !== STANDING_POLICY_COMPILER_PROTOCOL
      || !token(parsed.compiler.adapterId) || parsed.compiler.version !== 1) return null;
    if (!SHA256_RE.test(String(parsed.sourceSha256))
      || parsed.sourceSha256 !== standingPolicySourceSha256(sourceContent)
      || typeof parsed.deterministic !== 'boolean' || !token(parsed.policyClass)
      || !tokenList(parsed.gateways) || !boundedText(parsed.reason)) return null;
    if (!Array.isArray(parsed.bindings) || parsed.bindings.length > MAX_LIST
      || !Array.isArray(parsed.directives) || parsed.directives.length > MAX_LIST
      || !Array.isArray(parsed.capabilityHints) || parsed.capabilityHints.length > MAX_LIST) return null;
    const bindings = parsed.bindings.map(parseBinding);
    const directives = parsed.directives.map(parseDirective);
    const capabilityHints = parsed.capabilityHints.map(parseHint);
    if (bindings.some((item) => !item) || directives.some((item) => !item)
      || capabilityHints.some((item) => !item)) return null;
    if (parsed.deterministic && directives.length === 0) return null;
    if (!record(parsed.seal) || !exactKeys(parsed.seal, ['algorithm', 'digest'])
      || parsed.seal.algorithm !== 'sha256' || !SHA256_RE.test(String(parsed.seal.digest))) return null;
    const body: StandingPolicyDescriptorBody = {
      schemaVersion: STANDING_POLICY_SCHEMA_VERSION,
      contract: 'standing_policy',
      compiler: {
        protocol: STANDING_POLICY_COMPILER_PROTOCOL,
        adapterId: parsed.compiler.adapterId,
        version: parsed.compiler.version as number,
      },
      sourceSha256: parsed.sourceSha256,
      deterministic: parsed.deterministic,
      policyClass: parsed.policyClass,
      gateways: [...parsed.gateways],
      bindings: bindings as StandingPolicyBinding[],
      directives: directives as StandingPolicyDirective[],
      capabilityHints: capabilityHints as StandingPolicyCapabilityHint[],
      reason: parsed.reason,
    };
    if (parsed.seal.digest !== descriptorDigest(body)) return null;
    return { ...body, seal: { algorithm: 'sha256', digest: parsed.seal.digest } };
  } catch {
    return null;
  }
}

export function requireStandingPolicyDescriptor(
  value: string | null | undefined,
  sourceContent: string,
): StandingPolicyDescriptor {
  const parsed = parseStandingPolicyDescriptor(value, sourceContent);
  if (!parsed) throw new Error('standing policy descriptor is stale, unknown, malformed, or has an invalid seal');
  return parsed;
}
