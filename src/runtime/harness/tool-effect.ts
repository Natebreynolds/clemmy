import {
  TOOL_REGISTRY,
  actionTopologyRoleFor,
  isRegisteredDelegationPrimitive,
  type ActionTopologyRole,
  type ToolSideEffect,
} from '../../tools/tool-registry.js';
import { classifyShellCommand, classifyShellNetworkMutation, expandLiteralShellCommands } from './destination-gate.js';
import {
  isCurrentCallableCatalogEntry,
  peekHostCapabilityCatalogFactory,
  type RegisteredHostCapability,
} from './host-capability-catalog-factory.js';
import { classifyCanonicalExternalEffect, isMutatingExternalWrite } from './execution-gate.js';
import {
  currentManifestRecoverySemantics,
  type CurrentManifestRecoverySemanticsV1,
} from './current-manifest-operation-semantics.js';
import { resolveCallToolAlias } from '../../tools/call-tool-alias.js';
import {
  catalogOperationIdentityKey,
  isClementineLocalToolNamespace as isClementineLocalNamespace,
  isPlainOrClementineLocalTool,
  isTrustedComposioGateway,
  isTrustedDynamicComposioTool,
  runtimeToolTail as localToolTail,
  stripMcpTransportPrefix as normalizedToolName,
} from './runtime-tool-identity.js';

/**
 * Runtime effect classification used by the guardrail and SDK call ceiling.
 *
 * Registry metadata is sufficient for Clementine-owned tools, but gateways and
 * shell calls need their arguments inspected. Keeping that inspection here
 * prevents the exact drift that caused native sends to look harmless while
 * ordinary build/test/render shell calls looked like dangerous writes.
 */
export type RuntimeToolEffect = 'read' | 'compute' | 'host_only' | 'local_write' | 'external_write' | 'admin' | 'unknown';

export interface RuntimeToolEffectDecision {
  effect: RuntimeToolEffect;
  /** Any state mutation, including reversible local writes. */
  mutating: boolean;
  /** A mutation outside Clementine's local workspace/state boundary. */
  dangerousWrite: boolean;
  source: 'shell' | 'composio' | 'native_mcp' | 'reviewed_cli' | 'registry' | 'unknown';
}

/** Provider-neutral authority class consumed by shared execution owners. */
export type RuntimeToolAuthorityBinding = 'local_envelope' | 'catalog_manifest' | 'unknown';

/**
 * Translate adapter provenance into the only authority fact the host kernel
 * needs. The positive local allowlist is deliberate: an unrecognized future
 * source can never inherit local-envelope authority by omission.
 */
export function runtimeToolAuthorityBinding(
  decision: RuntimeToolEffectDecision,
): RuntimeToolAuthorityBinding {
  if (decision.effect === 'unknown' || decision.source === 'unknown') return 'unknown';
  switch (decision.source) {
    case 'registry':
    case 'shell':
      return decision.effect === 'external_write' || decision.effect === 'admin'
        ? 'catalog_manifest'
        : 'local_envelope';
    case 'composio':
    case 'native_mcp':
    case 'reviewed_cli':
      return 'catalog_manifest';
    default:
      return 'unknown';
  }
}

/**
 * Opaque host provenance for a physical dispatch whose durable identity has
 * already been peeled to an inner provider tool. A bare provider slug is not
 * enough to recover whether it arrived through the trusted Composio gateway;
 * this carrier preserves that fact without letting a model-authored boolean or
 * prose field grant effect authority.
 *
 * Runtime authority comes from membership in the module-private WeakSet, not
 * from this object's visible fields. The symbol keeps the type opaque to other
 * TypeScript callers; the WeakSet makes structural lookalikes fail closed even
 * after an unsafe cast or a JSON round trip.
 */
const TRUSTED_RUNTIME_EFFECT_CARRIER = Symbol('clem.trustedRuntimeEffectCarrier');
const trustedRuntimeEffectCarriers = new WeakSet<object>();

export interface TrustedRuntimeEffectCarrier {
  readonly toolName: string;
  readonly args: unknown;
  readonly [TRUSTED_RUNTIME_EFFECT_CARRIER]: true;
}

export interface TrustedRuntimeEffectCarrierInspection {
  readonly toolName: string;
  readonly args: unknown;
  readonly decision: RuntimeToolEffectDecision;
}

/** Minted only by a host adapter at the point it still owns wrapper identity. */
export function trustedRuntimeEffectCarrier(
  toolName: string,
  args: unknown,
): TrustedRuntimeEffectCarrier {
  const carrier = Object.freeze({
    toolName,
    args,
    [TRUSTED_RUNTIME_EFFECT_CARRIER]: true as const,
  });
  trustedRuntimeEffectCarriers.add(carrier);
  return carrier;
}

/** Validate opaque provenance and classify its original trusted wrapper. */
export function inspectTrustedRuntimeEffectCarrier(
  value: unknown,
): TrustedRuntimeEffectCarrierInspection | null {
  if (!value || typeof value !== 'object' || !trustedRuntimeEffectCarriers.has(value)) return null;
  const carrier = value as TrustedRuntimeEffectCarrier;
  return {
    toolName: carrier.toolName,
    args: carrier.args,
    decision: classifyRuntimeToolEffect(carrier.toolName, carrier.args),
  };
}

/** Minimal event shape shared by runtime/eval consumers. Kept independent of
 * EventRow so accounting helpers cannot introduce an eventlog import cycle. */
export interface RuntimeToolEventLike {
  type: string;
  data?: unknown;
}

function eventToolData(event: RuntimeToolEventLike): Record<string, unknown> {
  return event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : {};
}

export type RuntimeToolEventType = 'tool_called' | 'tool_returned';

function runtimeToolEventAccounting(event: RuntimeToolEventLike): unknown {
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return undefined;
  return (event.data as Record<string, unknown>).accounting;
}

/** True for one logical tool boundary. Native/ordinary events and legacy rows
 * without accounting metadata remain countable; only the explicitly-labelled
 * inner MCP gateway copy is excluded. */
export function isCanonicalTopLevelToolEvent(
  event: RuntimeToolEventLike,
  type?: RuntimeToolEventType,
): boolean {
  const isToolEvent = event.type === 'tool_called' || event.type === 'tool_returned';
  if (!isToolEvent || (type !== undefined && event.type !== type)) return false;
  return runtimeToolEventAccounting(event) !== 'transport_mirror';
}

/** Order-preserving canonical projection for metrics, priors, and decisions. */
export function projectCanonicalTopLevelToolEvents<T extends RuntimeToolEventLike>(
  events: readonly T[],
  type?: RuntimeToolEventType,
): T[] {
  return events.filter((event) => isCanonicalTopLevelToolEvent(event, type));
}

export interface TransportMirrorToolCallPairs {
  canonicalToMirrorCallId: Map<string, string>;
  mirrorToCanonicalCallId: Map<string, string>;
}

function normalizedToolInput(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try { return normalizedToolInput(JSON.parse(trimmed)); } catch { /* keep literal */ }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizedToolInput);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    // Strict MCP wrappers fill omitted optional fields with null. Removing only
    // nullish values makes their input fingerprint match the provider call.
    if (child == null) continue;
    out[key] = normalizedToolInput(child);
  }
  return out;
}

function toolCallPairKey(data: Record<string, unknown>): string {
  const tool = typeof data.tool === 'string' ? data.tool : '';
  const input = normalizedToolInput(data.arguments ?? data.args ?? data.input ?? {});
  let fingerprint = '';
  try { fingerprint = JSON.stringify(input); } catch { fingerprint = String(input); }
  return `${tool}\0${fingerprint}`;
}

function eventCorrelationFingerprint(data: Record<string, unknown>): string {
  return typeof data.correlationFingerprint === 'string'
    ? data.correlationFingerprint.trim()
    : '';
}

function popUnmatchedCallId(
  queues: Map<string, string[]>,
  key: string,
  unmatchedCallIds: Set<string>,
): string | undefined {
  if (!key) return undefined;
  const queue = queues.get(key) ?? [];
  let callId: string | undefined;
  while (queue.length > 0 && !callId) {
    const candidate = queue.pop();
    if (candidate && unmatchedCallIds.has(candidate)) callId = candidate;
  }
  queues.set(key, queue);
  return callId;
}

/** Pair the provider-level call with its later inner MCP audit row without
 * collapsing either durable event. Only explicit `top_level` rows participate,
 * so legacy calls can never be accidentally consumed by a later mirror. When
 * `resolvedCanonicalCallIds` is supplied, already-returned calls are skipped so
 * a later live same-tool invocation pairs with its own mirror. */
export function pairTransportMirrorToolCalls(
  events: readonly RuntimeToolEventLike[],
  resolvedCanonicalCallIds: ReadonlySet<string> = new Set(),
): TransportMirrorToolCallPairs {
  const canonicalToMirrorCallId = new Map<string, string>();
  const mirrorToCanonicalCallId = new Map<string, string>();
  const unmatchedByCorrelation = new Map<string, string[]>();
  const unmatchedByLegacyInput = new Map<string, string[]>();
  const unmatchedCallIds = new Set<string>();
  for (const event of events) {
    if (event.type !== 'tool_called') continue;
    const data = eventToolData(event);
    const callId = typeof data.callId === 'string' ? data.callId : '';
    if (!callId) continue;
    const correlationFingerprint = eventCorrelationFingerprint(data);
    const correlationKey = correlationFingerprint ? `correlation:${correlationFingerprint}` : '';
    const legacyInputKey = toolCallPairKey(data);
    if (data.accounting === 'top_level') {
      if (resolvedCanonicalCallIds.has(callId)) continue;
      unmatchedCallIds.add(callId);
      if (correlationKey) {
        const queue = unmatchedByCorrelation.get(correlationKey) ?? [];
        queue.push(callId);
        unmatchedByCorrelation.set(correlationKey, queue);
      }
      const legacyQueue = unmatchedByLegacyInput.get(legacyInputKey) ?? [];
      legacyQueue.push(callId);
      unmatchedByLegacyInput.set(legacyInputKey, legacyQueue);
      continue;
    }
    if (data.accounting !== 'transport_mirror') continue;
    // Prefer the full-input digest. Exact visible-argument matching remains as
    // a backward-compatible fallback for rows written before the digest existed.
    const canonicalCallId = popUnmatchedCallId(
      unmatchedByCorrelation,
      correlationKey,
      unmatchedCallIds,
    ) ?? popUnmatchedCallId(unmatchedByLegacyInput, legacyInputKey, unmatchedCallIds);
    if (!canonicalCallId) continue;
    unmatchedCallIds.delete(canonicalCallId);
    canonicalToMirrorCallId.set(canonicalCallId, callId);
    mirrorToCanonicalCallId.set(callId, canonicalCallId);
  }
  return { canonicalToMirrorCallId, mirrorToCanonicalCallId };
}

const REGISTRY_EFFECTS = new Map<string, ToolSideEffect>(
  TOOL_REGISTRY.map((decl) => [decl.name, decl.sideEffect]),
);
const REGISTRY_RUNTIME_EFFECTS = new Map<string, RuntimeToolEffect>(
  TOOL_REGISTRY.flatMap((decl) => decl.runtimeEffect ? [[decl.name, decl.runtimeEffect]] : []),
);

function shellCommand(args: unknown): string {
  if (typeof args === 'string') return args;
  if (!args || typeof args !== 'object') return '';
  const value = (args as Record<string, unknown>).command;
  return typeof value === 'string' ? value : '';
}

function composioSlug(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const slug = (args as Record<string, unknown>).tool_slug;
  return typeof slug === 'string' && slug.trim() ? slug.trim() : undefined;
}

function decodedToolArgs(args: unknown): unknown {
  if (typeof args !== 'string') return args;
  const trimmed = args.trim();
  if (!trimmed.startsWith('{')) return args;
  try { return JSON.parse(trimmed) as unknown; } catch { return args; }
}

export interface RuntimeEffectiveToolIdentity {
  toolName: string | null;
  args: unknown;
  /** True when the peel crossed the trusted Composio gateway. `toolName` and
   *  `args` are already the exact inner operation + argument object; the flag
   *  retains carrier provenance without making downstream callers interpret
   *  the envelope a second time. */
  composioCarrier?: boolean;
}

/**
 * Recover a local, graph-neutral control that was placed inside a trusted
 * provider carrier. This is deliberately a closed structural projection:
 * the inner name must be an exact registry declaration, that declaration must
 * be both read-only and control-plane, and the trusted carrier must already
 * have produced one contractible object payload. Unknown names, local writes,
 * and business reads stay on the ordinary provider path.
 */
export function resolveProviderCarrierLocalReadControl(
  toolName: string,
  rawArgs: unknown,
): { toolName: string; args: Record<string, unknown> } | null {
  const effective = unwrapRuntimeEffectiveToolIdentity(toolName, rawArgs);
  if (
    effective.composioCarrier !== true
    || !effective.toolName
    || !effective.args
    || typeof effective.args !== 'object'
    || Array.isArray(effective.args)
  ) return null;
  const declaration = TOOL_REGISTRY.find((candidate) => candidate.name === effective.toolName);
  if (
    !declaration
    || declaration.sideEffect !== 'read'
    || declaration.actionTopologyRole !== 'control'
  ) return null;
  return {
    toolName: declaration.name,
    args: effective.args as Record<string, unknown>,
  };
}

/**
 * Recover a HOST-ONLY control the model named inside a trusted LOCAL carrier
 * (`call_tool` / `work_call`). Closed structural projection: the inner name
 * must be an exact registry declaration whose entire execution is host-local
 * (`runtimeEffect: 'host_only'`) and whose role is the control plane, so no
 * provider, business, or external-effect name can ever enter here.
 *
 * Registry membership is NOT authority: callers must additionally prove the
 * control is on THIS turn's configured surface before routing to it.
 */
export function resolveCarriedHostControl(
  toolName: string,
  rawArgs: unknown,
): { toolName: string; args: Record<string, unknown> } | null {
  if (
    !isPlainOrClementineLocalTool(toolName, 'call_tool')
    && !isPlainOrClementineLocalTool(toolName, 'work_call')
  ) return null;
  const effective = unwrapRuntimeEffectiveToolIdentity(toolName, rawArgs);
  if (
    effective.composioCarrier === true
    || !effective.toolName
    || !effective.args
    || typeof effective.args !== 'object'
    || Array.isArray(effective.args)
  ) return null;
  const declaration = TOOL_REGISTRY.find((candidate) => candidate.name === effective.toolName);
  if (
    !declaration
    || declaration.runtimeEffect !== 'host_only'
    || declaration.actionTopologyRole !== 'control'
  ) return null;
  return {
    toolName: declaration.name,
    args: effective.args as Record<string, unknown>,
  };
}

/**
 * Peel schema/discovery carriers using the full invocation payload. Callers
 * must run this before event previews are clipped: the returned identity is a
 * small durable fact, while `args` may be arbitrarily large and remains only
 * in the tool lifecycle/output stores.
 */
export function unwrapRuntimeEffectiveToolIdentity(
  toolName: string | null,
  rawArgs: unknown,
  depth = 0,
): RuntimeEffectiveToolIdentity {
  if (!toolName) return { toolName: null, args: rawArgs };
  if (depth > 8) return { toolName: null, args: rawArgs };
  const args = decodedToolArgs(rawArgs);
  const tail = localToolTail(toolName);

  if (
    (tail === 'call_tool' && isPlainOrClementineLocalTool(toolName, 'call_tool'))
    || (tail === 'work_call' && isPlainOrClementineLocalTool(toolName, 'work_call'))
  ) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { toolName: tail, args };
    }
    const record = args as Record<string, unknown>;
    const target = typeof record.name === 'string' ? record.name.trim() : '';
    if (!target) return { toolName: tail, args };
    const targetArgs = decodedToolArgs(record.args_json ?? record.args ?? {});
    const alias = resolveCallToolAlias(target, targetArgs);
    if (alias?.ok) {
      return unwrapRuntimeEffectiveToolIdentity(
        alias.targetName,
        alias.targetArgs,
        depth + 1,
      );
    }
    return unwrapRuntimeEffectiveToolIdentity(
      target,
      targetArgs,
      depth + 1,
    );
  }

  if (isTrustedComposioGateway(toolName)) {
    const carrier = args && typeof args === 'object' && !Array.isArray(args)
      ? args as Record<string, unknown>
      : null;
    const slug = carrier?.tool_slug;
    const rawInnerArgs = carrier?.arguments;
    // The authoritative Composio wire uses explicit null for a valid action
    // with zero arguments. Normalize only that sanctioned representation to
    // the canonical empty object. A missing field, malformed JSON, array, or
    // primitive remains unreadable and therefore fails closed below.
    const innerArgs = rawInnerArgs === null ? {} : decodedToolArgs(rawInnerArgs);
    // The trusted gateway is a transport envelope, not the business call.
    // Host admission, settlement and the provider port must all bind the exact
    // inner operation + arguments. Malformed/non-object inner bytes do not
    // degrade to `{}` or retain the wrapper identity: they are deliberately
    // uncontractible so the execution boundary fails closed before I/O.
    if (
      typeof slug !== 'string'
      || !slug.trim()
      || !innerArgs
      || typeof innerArgs !== 'object'
      || Array.isArray(innerArgs)
    ) {
      return { toolName: null, args: innerArgs, composioCarrier: true };
    }
    return {
      toolName: slug.trim(),
      args: innerArgs,
      composioCarrier: true,
    };
  }

  if (isTrustedDynamicComposioTool(toolName)) {
    const slug = tail.slice(3).trim();
    return { toolName: slug ? slug.toUpperCase() : tail, args };
  }

  return { toolName, args };
}

/**
 * Compact cross-SDK identity persisted on lifecycle rows. Strip only the MCP
 * transport prefix and Clementine's own local namespace; a foreign namespace
 * remains part of the identity so `server__workflow_run` cannot impersonate
 * the local controller. Model-supplied carrier names are bounded and limited
 * to provider-safe tool-name characters before entering durable telemetry.
 */
export function canonicalRuntimeEffectiveToolName(toolName: string | null): string | undefined {
  if (!toolName) return undefined;
  const trimmed = toolName.trim();
  if (!trimmed || trimmed.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(trimmed)) {
    return undefined;
  }
  const normalized = normalizedToolName(trimmed);
  return isClementineLocalNamespace(normalized)
    ? localToolTail(normalized)
    : normalized;
}

/**
 * The per-step structural result channel the workflow runner attaches to a
 * step's own session (workflow-graph.ts re-exports it as
 * WORKFLOW_GRAPH_RESULT_ONLY_TOOL). It records the step's exact structured
 * result for the host and performs no external effect. It is deliberately
 * NOT a catalog/registry tool — the positive project manifest stays closed —
 * so the classifier names it here the way it names call_tool and work_call.
 * Live 2026-09-01 (platform-49 run 5b1e0b): every business write crossed,
 * then this channel was refused `effect_unknown` twice and the no-progress
 * governor blocked a finished step as a "bounded internal host error".
 */
export const WORKFLOW_STEP_RESULT_CHANNEL = 'workflow_step_result' as const;

function readDecision(source: RuntimeToolEffectDecision['source']): RuntimeToolEffectDecision {
  return { effect: 'read', mutating: false, dangerousWrite: false, source };
}

function externalWriteDecision(source: RuntimeToolEffectDecision['source']): RuntimeToolEffectDecision {
  return { effect: 'external_write', mutating: true, dangerousWrite: true, source };
}

function unknownDecision(): RuntimeToolEffectDecision {
  return { effect: 'unknown', mutating: false, dangerousWrite: false, source: 'unknown' };
}

/**
 * Reopen effect authority from one exact callable catalog row. No operation
 * spelling participates: the manifest effect and adapter provenance were
 * sealed before registration, while `isCurrentCallableCatalogEntry` proves
 * the row still matches those registration-time bytes and invoke identity.
 */
function currentCatalogEffectDecision(
  entry: RegisteredHostCapability,
): RuntimeToolEffectDecision {
  if (!isCurrentCallableCatalogEntry(entry)) return unknownDecision();
  const source: RuntimeToolEffectDecision['source'] = entry.manifest.providerKind === 'local_registry'
    ? 'registry'
    : entry.manifest.providerKind;
  switch (entry.manifest.effect) {
    case 'read': return readDecision(source);
    case 'compute': return { effect: 'compute', mutating: false, dangerousWrite: false, source };
    case 'host_only': return { effect: 'host_only', mutating: true, dangerousWrite: false, source };
    case 'local_write': return { effect: 'local_write', mutating: true, dangerousWrite: false, source };
    case 'external_write': return externalWriteDecision(source);
    case 'admin': return { effect: 'admin', mutating: true, dangerousWrite: true, source };
    case 'none':
    case 'unknown':
      return unknownDecision();
  }
}

/**
 * Identity-before-spelling lookup for bare tools. Presence is reported
 * separately from the decision so a stale, unattested, or ambiguous catalog
 * residue fails closed instead of falling through to a provider-name heuristic.
 */
function catalogEntriesNamedFor(toolName: string): RegisteredHostCapability[] {
  const identity = toolName.trim().toLowerCase();
  if (!identity) return [];
  const snapshot = peekHostCapabilityCatalogFactory()?.snapshot() ?? [];
  const exact = snapshot.filter((entry) => (
    entry.toolName.trim().toLowerCase() === identity
    || (entry.manifest?.operationId.trim().toLowerCase() === identity)
  ));
  if (exact.length > 0) return exact;
  const key = catalogOperationIdentityKey(toolName);
  if (!key) return [];
  return snapshot.filter((entry) => (
    catalogOperationIdentityKey(entry.toolName) === key
    || catalogOperationIdentityKey(entry.manifest?.operationId ?? '') === key
  ));
}

function uniqueCurrentCallableCatalogEntry(toolName: string): RegisteredHostCapability | null {
  const current = catalogEntriesNamedFor(toolName).filter(isCurrentCallableCatalogEntry);
  return current.length === 1 ? current[0]! : null;
}

function classifyBareCurrentCatalogCapability(toolName: string): {
  matched: boolean;
  decision: RuntimeToolEffectDecision;
} {
  const named = catalogEntriesNamedFor(toolName);
  if (named.length === 0) return { matched: false, decision: unknownDecision() };
  const current = named.filter(isCurrentCallableCatalogEntry);
  if (current.length === 0) return { matched: true, decision: unknownDecision() };
  const effects = new Set(current.map((entry) => entry.manifest.effect));
  // Same operation on two transports is still that effect. Live 2026-08-29
  // workflow:1788024507349: GOOGLESHEETS_BATCH_GET / SLACK_FETCH occupancy
  // failed closed as write, then the worker missed at proven=none.
  if (effects.size === 1) {
    return { matched: true, decision: currentCatalogEffectDecision(current[0]!) };
  }
  return { matched: true, decision: unknownDecision() };
}

function classifyComposio(args: unknown): RuntimeToolEffectDecision {
  const decoded = decodedToolArgs(args);
  const slug = decoded && typeof decoded === 'object' && !Array.isArray(decoded)
    ? String(
      (decoded as Record<string, unknown>).tool_slug
      ?? (decoded as Record<string, unknown>).slug
      ?? '',
    ).trim()
    : '';
  if (slug) {
    const registered = classifyBareCurrentCatalogCapability(slug);
    if (registered.matched) return registered.decision;
  }
  // Use the same canonical carrier-aware classifier as dispatch admission.
  // Missing and unfamiliar external actions therefore fail closed here too.
  return isMutatingExternalWrite('composio_execute_tool', args)
    ? externalWriteDecision('composio')
    : readDecision('composio');
}

function classifyNativeMcp(toolName: string, args: unknown): RuntimeToolEffectDecision {
  const normalized = normalizedToolName(toolName);
  // Claude may report either `mcp__server__tool` or `server__tool`. Preserve
  // the former and restore the carrier on the latter before classification;
  // stripping `mcp__` made the canonical boundary mistake an external action
  // for a local unknown. A namespaced action is a read only when the canonical
  // classifier can affirmatively prove that it is one.
  const authorityName = toolName.startsWith('mcp__')
    ? toolName
    : `mcp__${normalized}`;
  return isMutatingExternalWrite(authorityName, args)
    ? externalWriteDecision('native_mcp')
    : readDecision('native_mcp');
}

/** High-signal local mutations. These consume exact-repeat/tool ceilings, but
 * never the distinct-argument external-write halt. Arbitrary scripts remain
 * compute because their behavior cannot be inferred safely. */
function oneShellCommandMutatesLocalState(command: string): boolean {
  const unquoted = command.replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ');
  if (/(?:^|[;&|\n])\s*(?:sudo\s+)?(?:rm|rmdir|unlink|trash|mv|cp|touch|mkdir|chmod|chown|chgrp|ln|kill|killall|pkill)\b/i.test(unquoted)) return true;
  if (/(?:^|[;&|\n])\s*(?:sudo\s+)?git\s+(?:add|commit|merge|rebase|reset|clean|checkout|restore|branch|tag|stash)\b/i.test(unquoted)) return true;
  if (/(?:^|[;&|\n])\s*(?:npm|pnpm|yarn|pip|pip3|gem|cargo|brew)\s+(?:install|add|remove|uninstall|update|upgrade|link|unlink)\b/i.test(unquoted)) return true;
  if (/(?:^|[;&|\n])\s*sed\s+[^;&|\n]*\s-i(?:\s|$)/i.test(unquoted)) return true;
  // Stderr/stdout suppression is not a write. Live 2026-08-14: `sf data query
  // … 2>/dev/null | python3 -c '…'` is a Salesforce read; the `2>` made the
  // host label it local_write, so the retrieve contract never observed it.
  const withoutNullRedirects = unquoted
    .replace(/(?:\d+)?>>?\s*\/dev\/null\b/g, ' ')
    .replace(/(?:\d+)?>>&\d+\b/g, ' ')
    .replace(/(?:\d+)?>>&-/g, ' ');
  return /(^|[^>])>>?\s*[^&|]/.test(withoutNullRedirects)
    || /(?:^|[;&|\n])\s*tee\b/i.test(withoutNullRedirects);
}

function shellMutatesLocalState(command: string): boolean {
  return expandLiteralShellCommands(command).commands.some(oneShellCommandMutatesLocalState);
}

function classifyRegistered(toolName: string): RuntimeToolEffectDecision | null {
  const tail = localToolTail(toolName);
  // The Claude SDK may surface its deferred-discovery built-in in PascalCase
  // (`ToolSearch`) while Clementine's registry uses `tool_search`. Normalize
  // only the local registry lookup; native MCP actions keep their provider-
  // shaped classification above.
  const registryTail = tail
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
  const runtimeEffect = REGISTRY_RUNTIME_EFFECTS.get(tail) ?? REGISTRY_RUNTIME_EFFECTS.get(registryTail);
  if (runtimeEffect === 'host_only') {
    return { effect: 'host_only', mutating: true, dangerousWrite: false, source: 'registry' };
  }
  const sideEffect = REGISTRY_EFFECTS.get(tail) ?? REGISTRY_EFFECTS.get(registryTail);
  if (!sideEffect) return null;
  switch (sideEffect) {
    case 'read': return readDecision('registry');
    case 'write': return { effect: 'local_write', mutating: true, dangerousWrite: false, source: 'registry' };
    case 'send': return externalWriteDecision('registry');
    case 'admin': return { effect: 'admin', mutating: true, dangerousWrite: true, source: 'registry' };
  }
}

/** Resolve control/business role from Clementine's own registry after peeling
 * trusted local carriers. Foreign/provider tools with lookalike names remain
 * business because their effect provenance is not the local registry. */
export function actionTopologyRoleForRuntimeCall(
  toolName: string,
  args: unknown,
): ActionTopologyRole {
  const effective = unwrapRuntimeEffectiveToolIdentity(toolName, args);
  if (!effective.toolName) return 'business';
  if (classifyRuntimeToolEffect(toolName, args).source !== 'registry') return 'business';
  const registryName = localToolTail(effective.toolName)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
  if (registryName === WORKFLOW_STEP_RESULT_CHANNEL) return 'control';
  return actionTopologyRoleFor(registryName);
}

/**
 * One structural projection for the boundary between registry control
 * operations and accepted business work. A read-only control retains its role;
 * an explicitly declared native planning read or a registry mutation may bind
 * an exact expected-work requirement. Eligibility alone grants no authority;
 * once bound, that durable row is the settlement authority.
 */
export function runtimeExpectedWorkProjection(
  toolName: string,
  args: unknown,
): {
  role: ActionTopologyRole;
  decision: RuntimeToolEffectDecision;
  mayBindBusinessWork: boolean;
} {
  const role = actionTopologyRoleForRuntimeCall(toolName, args);
  const decision = classifyRuntimeToolEffect(toolName, args);
  const effective = unwrapRuntimeEffectiveToolIdentity(toolName, args);
  const declaredNativePlanningRead = decision.source === 'registry'
    && decision.effect === 'read'
    && !decision.mutating
    && effective.composioCarrier !== true
    && effective.toolName !== null
    && TOOL_REGISTRY.some((declaration) => declaration.name === localToolTail(effective.toolName!)
      && declaration.sideEffect === 'read' && declaration.localPlanningRead === true);
  return {
    role,
    decision,
    mayBindBusinessWork: role === 'business'
      || declaredNativePlanningRead
      || (
        decision.source === 'registry'
        && decision.mutating
        && runtimeEffectIsMutation(decision.effect)
      ),
  };
}

/** Shared effect projection for durable admission and settlement rows. */
export function runtimeEffectIsMutation(effect: RuntimeToolEffect): boolean {
  return effect === 'local_write' || effect === 'external_write' || effect === 'admin';
}

/** True only for a trusted local registry call whose exact declaration can
 * execute, release, auto-test, activate, or mint future unpropagated work.
 * Foreign lookalikes and provider calls fail closed to false; no provider/tool
 * prose is parsed. */
export function isDelegationPrimitiveRuntimeCall(
  toolName: string,
  args: unknown,
): boolean {
  const effective = unwrapRuntimeEffectiveToolIdentity(toolName, args);
  if (!effective.toolName) return false;
  if (classifyRuntimeToolEffect(toolName, args).source !== 'registry') return false;
  const registryName = localToolTail(effective.toolName)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
  return isRegisteredDelegationPrimitive(registryName);
}

/** Trusted local shell carriers can perform arbitrary network reads without a
 * catalog/source identity. During a material-source turn they must be refused
 * rather than deriving authority from command text. */
export function isUnscopedShellRuntimeCall(toolName: string, args: unknown): boolean {
  return classifyRuntimeToolEffect(toolName, args).source === 'shell';
}

export function classifyRuntimeToolEffect(toolName: string, args: unknown): RuntimeToolEffectDecision {
  const normalized = normalizedToolName(toolName);
  const tail = localToolTail(normalized);

  if (
    (tail === 'call_tool' && isPlainOrClementineLocalTool(toolName, 'call_tool'))
    || (tail === 'work_call' && isPlainOrClementineLocalTool(toolName, 'work_call'))
  ) {
    const outer = decodedToolArgs(args);
    if (!outer || typeof outer !== 'object' || Array.isArray(outer)) {
      return unknownDecision();
    }
    const input = outer as Record<string, unknown>;
    const target = typeof input.name === 'string' ? input.name.trim() : '';
    if (!target || target === 'call_tool' || target === 'work_call') {
      return unknownDecision();
    }
    const innerArgs = decodedToolArgs(input.args_json ?? {});
    const alias = resolveCallToolAlias(target, innerArgs);
    if (alias?.ok) return classifyRuntimeToolEffect(alias.targetName, alias.targetArgs);
    if (alias && !alias.ok) {
      return unknownDecision();
    }
    return classifyRuntimeToolEffect(target, innerArgs);
  }

  if (tail === 'run_batch' && isPlainOrClementineLocalTool(toolName, 'run_batch')) {
    const input = decodedToolArgs(args);
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const batch = input as Record<string, unknown>;
      const action = typeof batch.action === 'string' ? batch.action.trim().toLowerCase() : '';
      const plan = batch.plan && typeof batch.plan === 'object' && !Array.isArray(batch.plan)
        ? batch.plan as Record<string, unknown>
        : null;
      if (action === 'status' || (action === 'propose' && plan?.sideEffect === 'read')) {
        return readDecision('registry');
      }
    }
  }

  if (tail === 'run_shell_command' && isPlainOrClementineLocalTool(toolName, 'run_shell_command')) {
    const command = shellCommand(args);
    const expanded = expandLiteralShellCommands(command);
    const network = classifyShellNetworkMutation(command);
    const publish = classifyShellCommand(command);
    if (network.isNetworkMutation || publish.isPublish) return externalWriteDecision('shell');
    if (shellMutatesLocalState(command)) {
      return { effect: 'local_write', mutating: true, dangerousWrite: false, source: 'shell' };
    }
    // Dynamic or over-depth shell -c code cannot be proven read-only. Classify
    // it as a local mutation so consequential approval scope cannot mistake it
    // for compute; the shell's own approval boundary also fails closed.
    if (expanded.hasOpaqueShellWrapper) {
      return { effect: 'local_write', mutating: true, dangerousWrite: false, source: 'shell' };
    }
    // A shell can mutate local files, but ordinary reads/builds/tests/renders are
    // not dangerous external writes. The total-call and exact-signature budgets
    // still bound them; they simply no longer consume the mass-send halt ladder.
    return { effect: 'compute', mutating: false, dangerousWrite: false, source: 'shell' };
  }

  // A model may put a LOCAL schema/discovery control inside a provider carrier
  // after reading two adjacent carrier instructions. Exact registry identity
  // wins only for a read-only control; execution still has to re-route through
  // the configured local surface at the host boundary. This keeps the mistake
  // out of business-write accounting without turning arbitrary inner strings
  // into local authority.
  const carriedLocalControl = resolveProviderCarrierLocalReadControl(toolName, args);
  if (carriedLocalControl) {
    return classifyRegistered(carriedLocalControl.toolName) ?? unknownDecision();
  }
  if (isTrustedComposioGateway(toolName)) return classifyComposio(args);
  if (isTrustedDynamicComposioTool(toolName)) {
    return classifyComposio({ tool_slug: tail.slice(3), arguments: args });
  }

  const isNamespaced = normalized.includes('__');
  const isClementineLocal = isClementineLocalNamespace(normalized);

  // IDENTITY BEFORE SPELLING. If this exact name is a capability the host has
  // already registered, its effect is a KNOWN, provisioned fact — the registry
  // recorded it from the manifest at connect time. Ask the registry rather than
  // inferring an effect from how the name happens to be spelled.
  //
  // Live 2026-08-26: the model called a registered write capability by its
  // registered lowercase name. The SCREAMING_SNAKE test below is case-sensitive,
  // so it did not match, nothing else recognized the name, and the effect came
  // back 'unknown' — which the production call boundary refuses outright. The
  // write was refused five times while the registry two modules away held
  // `effect: external_write` for that exact toolName. Casing is not a safety
  // property, and a capability the host itself provisioned should never be
  // unclassifiable.
  //
  // Live 2026-08-29 (OPEN-THE-GATES, sess-mob-416706): namespaced MCP spelling
  // `google_sheets__batch_get` skipped this lookup, classified fail-closed as
  // write, and the live-read seam then refused a same-turn proven Sheets read.
  const registered = classifyBareCurrentCatalogCapability(normalized);
  if (registered.matched) return registered.decision;
  if (isNamespaced && !isClementineLocal) {
    const tailRegistered = classifyBareCurrentCatalogCapability(localToolTail(normalized));
    if (tailRegistered.matched) return tailRegistered.decision;
    return classifyNativeMcp(toolName, args);
  }

  // A bare SCREAMING_SNAKE name is a Composio slug: tool_search hands the
  // model slugs as exact reachable inner-tool names, and dispatch resolves
  // them to the gateway. Effect authority must resolve them the same way —
  // classifying the slug as 'unknown' made the finish-phase governor refuse
  // the exact Sheets create its own advisory demanded (live 2026-08-18).
  if (!isNamespaced && /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(normalized)) {
    return classifyComposio({ tool_slug: normalized, arguments: args });
  }

  if (
    tail === WORKFLOW_STEP_RESULT_CHANNEL
    && isPlainOrClementineLocalTool(toolName, WORKFLOW_STEP_RESULT_CHANNEL)
  ) {
    return readDecision('registry');
  }

  return classifyRegistered(normalized)
    ?? unknownDecision();
}

/** Canonical fields attached to top-level tool accounting events. Tool hooks
 * carry serialized arguments while the Claude stream carries objects; decode
 * once here so both lanes report the same effect and inner Composio action. */
export function runtimeToolAccountingMetadata(
  toolName: string,
  rawArgs: unknown,
): {
  effect: RuntimeToolEffect;
  effectiveTool?: string;
  toolSlug?: string;
  /** Durable positive semantics captured while the exact capability manifest
   * is current. Omitted for read-only, unknown, or unproven operations. */
  reversibility?: 'reversible' | 'irreversible';
  /** Exact current-manifest authority for same-shape/target repair. This is
   * durable because terminal publication may run without the live catalog. */
  recoverySemantics?: CurrentManifestRecoverySemanticsV1;
} {
  const args = decodedToolArgs(rawArgs);
  const effect = classifyRuntimeToolEffect(toolName, args).effect;
  const externalEffect = classifyCanonicalExternalEffect(toolName, args);
  const tail = localToolTail(toolName);
  const effectiveIdentity = unwrapRuntimeEffectiveToolIdentity(toolName, rawArgs);
  const effectiveTool = canonicalRuntimeEffectiveToolName(effectiveIdentity.toolName);
  const recoverySemantics = effect === 'external_write'
    ? currentManifestRecoverySemantics(effectiveTool)
    : null;
  const slug = isTrustedComposioGateway(toolName)
    ? composioSlug(args)
    : isTrustedDynamicComposioTool(toolName)
      ? tail.slice(3).toUpperCase()
      : undefined;
  return {
    effect,
    ...(effectiveTool ? { effectiveTool } : {}),
    ...(slug ? { toolSlug: slug } : {}),
    ...(externalEffect.external
      && externalEffect.mutating
      && externalEffect.reversibility === 'irreversible'
      ? { reversibility: 'irreversible' as const }
      : recoverySemantics?.basis === 'reversible_operation'
        ? { reversibility: 'reversible' as const }
        : {}),
    ...(recoverySemantics ? { recoverySemantics } : {}),
  };
}
