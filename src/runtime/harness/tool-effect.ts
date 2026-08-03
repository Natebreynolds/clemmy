import { TOOL_REGISTRY, type ToolSideEffect } from '../../tools/tool-registry.js';
import { classifyShellCommand, classifyShellNetworkMutation, expandLiteralShellCommands } from './destination-gate.js';
import { isMutatingExternalWrite } from './execution-gate.js';
import { resolveCallToolAlias } from '../../tools/call-tool-alias.js';
import {
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
export type RuntimeToolEffect = 'read' | 'compute' | 'local_write' | 'external_write' | 'admin' | 'unknown';

export interface RuntimeToolEffectDecision {
  effect: RuntimeToolEffect;
  /** Any state mutation, including reversible local writes. */
  mutating: boolean;
  /** A mutation outside Clementine's local workspace/state boundary. */
  dangerousWrite: boolean;
  source: 'shell' | 'composio' | 'native_mcp' | 'registry' | 'unknown';
}

/** Minimal event shape shared by runtime/eval consumers. Kept independent of
 * EventRow so accounting helpers cannot introduce an eventlog import cycle. */
export interface RuntimeToolEventLike {
  type: string;
  data?: unknown;
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

function eventToolData(event: RuntimeToolEventLike): Record<string, unknown> {
  return event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : {};
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

  if (tail === 'call_tool' && isPlainOrClementineLocalTool(toolName, 'call_tool')) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { toolName: tail, args };
    }
    const record = args as Record<string, unknown>;
    const target = typeof record.name === 'string' ? record.name.trim() : '';
    if (!target) return { toolName: tail, args };
    return unwrapRuntimeEffectiveToolIdentity(
      target,
      record.args_json ?? record.args ?? {},
      depth + 1,
    );
  }

  if (isTrustedComposioGateway(toolName)) {
    const slug = args && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>).tool_slug
      : undefined;
    return {
      toolName: typeof slug === 'string' && slug.trim() ? slug.trim() : tail,
      args,
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
function canonicalRuntimeEffectiveToolName(toolName: string | null): string | undefined {
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

function readDecision(source: RuntimeToolEffectDecision['source']): RuntimeToolEffectDecision {
  return { effect: 'read', mutating: false, dangerousWrite: false, source };
}

function externalWriteDecision(source: RuntimeToolEffectDecision['source']): RuntimeToolEffectDecision {
  return { effect: 'external_write', mutating: true, dangerousWrite: true, source };
}

function classifyComposio(args: unknown): RuntimeToolEffectDecision {
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
  return /(^|[^>])>>?\s*[^&|]/.test(unquoted) || /(?:^|[;&|\n])\s*tee\b/i.test(unquoted);
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
  const sideEffect = REGISTRY_EFFECTS.get(tail) ?? REGISTRY_EFFECTS.get(registryTail);
  if (!sideEffect) return null;
  switch (sideEffect) {
    case 'read': return readDecision('registry');
    case 'write': return { effect: 'local_write', mutating: true, dangerousWrite: false, source: 'registry' };
    case 'send': return externalWriteDecision('registry');
    case 'admin': return { effect: 'admin', mutating: true, dangerousWrite: true, source: 'registry' };
  }
}

export function classifyRuntimeToolEffect(toolName: string, args: unknown): RuntimeToolEffectDecision {
  const normalized = normalizedToolName(toolName);
  const tail = localToolTail(normalized);

  if (tail === 'call_tool' && isPlainOrClementineLocalTool(toolName, 'call_tool')) {
    const outer = decodedToolArgs(args);
    if (!outer || typeof outer !== 'object' || Array.isArray(outer)) {
      return { effect: 'unknown', mutating: false, dangerousWrite: false, source: 'unknown' };
    }
    const input = outer as Record<string, unknown>;
    const target = typeof input.name === 'string' ? input.name.trim() : '';
    if (!target || target === 'call_tool') {
      return { effect: 'unknown', mutating: false, dangerousWrite: false, source: 'unknown' };
    }
    const innerArgs = decodedToolArgs(input.args_json ?? {});
    const alias = resolveCallToolAlias(target, innerArgs);
    if (alias?.ok) return classifyRuntimeToolEffect(alias.targetName, alias.targetArgs);
    if (alias && !alias.ok) {
      return { effect: 'unknown', mutating: false, dangerousWrite: false, source: 'unknown' };
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

  if (isTrustedComposioGateway(toolName)) return classifyComposio(args);
  if (isTrustedDynamicComposioTool(toolName)) {
    return classifyComposio({ tool_slug: tail.slice(3), arguments: args });
  }

  const isNamespaced = normalized.includes('__');
  const isClementineLocal = isClementineLocalNamespace(normalized);
  if (isNamespaced && !isClementineLocal) return classifyNativeMcp(toolName, args);

  return classifyRegistered(normalized)
    ?? { effect: 'unknown', mutating: false, dangerousWrite: false, source: 'unknown' };
}

/** Canonical fields attached to top-level tool accounting events. Tool hooks
 * carry serialized arguments while the Claude stream carries objects; decode
 * once here so both lanes report the same effect and inner Composio action. */
export function runtimeToolAccountingMetadata(
  toolName: string,
  rawArgs: unknown,
): { effect: RuntimeToolEffect; effectiveTool?: string; toolSlug?: string } {
  const args = decodedToolArgs(rawArgs);
  const effect = classifyRuntimeToolEffect(toolName, args).effect;
  const tail = localToolTail(toolName);
  const effectiveIdentity = unwrapRuntimeEffectiveToolIdentity(toolName, rawArgs);
  const effectiveTool = canonicalRuntimeEffectiveToolName(effectiveIdentity.toolName);
  const slug = isTrustedComposioGateway(toolName)
    ? composioSlug(args)
    : isTrustedDynamicComposioTool(toolName)
      ? tail.slice(3).toUpperCase()
      : undefined;
  return {
    effect,
    ...(effectiveTool ? { effectiveTool } : {}),
    ...(slug ? { toolSlug: slug } : {}),
  };
}
