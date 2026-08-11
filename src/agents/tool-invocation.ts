/**
 * Canonical tool-invocation identity.
 *
 * External MCP servers sometimes expose a generic call_tool-style broker. The
 * outer provider/tool and full carrier payload remain the durable approval
 * authority, but policy must classify the concrete nested action. Keeping that
 * projection here prevents taxonomy, plan scope, resend consent, and UI code
 * from disagreeing about what a broker call means.
 */

export const LOCAL_MCP_SERVER_SLUG = 'clementine-local';

export type ToolInvocationFailure =
  | 'malformed-native-authority'
  | 'local-authority-spoof'
  | 'malformed-local-tool'
  | 'invalid-broker-args'
  | 'missing-broker-target'
  | 'malformed-broker-target'
  | 'ambiguous-broker-args'
  | 'unexpected-broker-field'
  | 'recursive-broker-target';

export interface ParsedToolAuthority {
  raw: string;
  authority: string;
  server?: string;
  tool: string;
  nativeMcp: boolean;
  local: boolean;
  external: boolean;
  valid: boolean;
  failure?: ToolInvocationFailure;
}

export interface ResolvedToolInvocation {
  /** Exact outer authority, with only the transport-only `mcp__` removed. */
  outerAuthority: string;
  outerArgs: unknown;
  /** Concrete action used by taxonomy and scope. */
  toolName: string;
  args: unknown;
  nested: boolean;
  externalBroker: boolean;
  valid: boolean;
  failure?: ToolInvocationFailure;
  /** A foreign shell/Composio gateway is arbitrary capability, not a local tool. */
  unsafeExternalMultiplexer: boolean;
}

/**
 * The only semantic argument carriers accepted by a call_tool-style broker.
 * Multiple carriers are tolerated only when they decode to the same object.
 */
export const BROKER_ARGUMENT_CARRIER_KEYS = [
  'args_json',
  'arguments',
  'args',
  'input',
  'payload',
] as const;

/** MCP reserves `_meta` for transport metadata; it cannot carry tool args. */
export const BROKER_METADATA_KEYS = ['_meta'] as const;

export type DecodedBrokerCarrier =
  | { ok: true; target: string; args: Record<string, unknown> }
  | { ok: false; failure: ToolInvocationFailure };

function splitCamelCase(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2');
}

/** Normalize only for matching a known carrier spelling; never for authority. */
export function canonicalToolToken(value: string): string {
  return splitCamelCase(value.trim())
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

/** The action segment after MCP/provider namespace delimiters. */
export function toolActionSegment(value: string): string {
  const withoutCarrier = value.trim().replace(/^mcp__/, '');
  return withoutCarrier.split('__').at(-1) ?? withoutCarrier;
}

export function isCallToolMultiplexerName(value: string): boolean {
  return canonicalToolToken(toolActionSegment(value)) === 'call_tool';
}

export function isComposioMultiplexerName(value: string): boolean {
  return canonicalToolToken(toolActionSegment(value)) === 'composio_execute_tool';
}

export function isShellMultiplexerName(value: string): boolean {
  return canonicalToolToken(toolActionSegment(value)) === 'run_shell_command';
}

export function parseToolAuthority(value: string): ParsedToolAuthority {
  const raw = value.trim();
  if (!raw.startsWith('mcp__')) {
    const separator = raw.indexOf('__');
    if (separator <= 0 || separator >= raw.length - 2) {
      return {
        raw,
        authority: raw,
        tool: raw,
        nativeMcp: false,
        local: false,
        external: false,
        valid: Boolean(raw),
        failure: raw ? undefined : 'malformed-native-authority',
      };
    }
    const server = raw.slice(0, separator);
    const tool = raw.slice(separator + 2);
    if (server.toLowerCase() === LOCAL_MCP_SERVER_SLUG && server !== LOCAL_MCP_SERVER_SLUG) {
      return {
        raw,
        authority: raw,
        server,
        tool,
        nativeMcp: false,
        local: false,
        external: true,
        valid: false,
        failure: 'local-authority-spoof',
      };
    }
    if (server === LOCAL_MCP_SERVER_SLUG && tool.includes('__')) {
      return {
        raw,
        authority: raw,
        server,
        tool,
        nativeMcp: false,
        local: true,
        external: false,
        valid: false,
        failure: 'malformed-local-tool',
      };
    }
    return {
      raw,
      authority: server === LOCAL_MCP_SERVER_SLUG ? tool : raw,
      server,
      tool,
      nativeMcp: false,
      local: server === LOCAL_MCP_SERVER_SLUG,
      external: server !== LOCAL_MCP_SERVER_SLUG,
      valid: true,
    };
  }

  const namespaced = raw.slice('mcp__'.length);
  const separator = namespaced.indexOf('__');
  if (separator <= 0 || separator >= namespaced.length - 2) {
    return {
      raw,
      authority: raw,
      tool: toolActionSegment(raw),
      nativeMcp: true,
      local: false,
      external: true,
      valid: false,
      failure: 'malformed-native-authority',
    };
  }
  const server = namespaced.slice(0, separator);
  const tool = namespaced.slice(separator + 2);
  if (server.toLowerCase() === LOCAL_MCP_SERVER_SLUG && server !== LOCAL_MCP_SERVER_SLUG) {
    return {
      raw,
      authority: namespaced,
      server,
      tool,
      nativeMcp: true,
      local: false,
      external: true,
      valid: false,
      failure: 'local-authority-spoof',
    };
  }
  if (server === LOCAL_MCP_SERVER_SLUG && tool.includes('__')) {
    return {
      raw,
      authority: raw,
      server,
      tool,
      nativeMcp: true,
      local: true,
      external: false,
      valid: false,
      failure: 'malformed-local-tool',
    };
  }
  const local = server === LOCAL_MCP_SERVER_SLUG;
  return {
    raw,
    authority: local ? tool : namespaced,
    server,
    tool,
    nativeMcp: true,
    local,
    external: !local,
    valid: true,
  };
}

export function decodedToolArgs(value: unknown): Record<string, unknown> | undefined {
  let decoded = value;
  if (typeof decoded === 'string') {
    try {
      decoded = JSON.parse(decoded) as unknown;
    } catch {
      return undefined;
    }
  }
  return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
    ? decoded as Record<string, unknown>
    : undefined;
}

function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return JSON.stringify(value.toString());
    if (typeof value === 'number' && !Number.isFinite(value)) return JSON.stringify(String(value));
    return JSON.stringify(value);
  }
  if (seen.has(value)) return JSON.stringify('[circular]');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry, seen)).join(',')}]`;
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(obj[key], seen)}`
    )).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function decodedBrokerArgs(
  carrier: Record<string, unknown>,
): { ok: true; args: Record<string, unknown> } | { ok: false; failure: ToolInvocationFailure } {
  const candidates = BROKER_ARGUMENT_CARRIER_KEYS
    .filter((key) => Object.prototype.hasOwnProperty.call(carrier, key))
    .map((key) => carrier[key]);
  if (candidates.length === 0) return { ok: true, args: {} };
  const decoded = candidates.map((candidate) => {
    if (candidate === null || candidate === undefined || candidate === '') return {};
    return decodedToolArgs(candidate);
  });
  if (decoded.some((candidate) => !candidate)) {
    return { ok: false, failure: 'invalid-broker-args' };
  }
  const fingerprints = new Set(decoded.map((candidate) => canonicalJson(candidate)));
  if (fingerprints.size > 1) {
    return { ok: false, failure: 'ambiguous-broker-args' };
  }
  return { ok: true, args: decoded[0]! };
}

const BROKER_ENVELOPE_KEYS = new Set<string>([
  'name',
  ...BROKER_ARGUMENT_CARRIER_KEYS,
  ...BROKER_METADATA_KEYS,
]);

/**
 * Decode the one canonical broker envelope used by policy and presentation.
 * Semantic arguments must live in a recognized carrier. Silently treating
 * other top-level fields as metadata would let two different destructive
 * targets collapse onto the same plan-action key.
 */
export function decodeBrokerCarrier(value: unknown): DecodedBrokerCarrier {
  const carrier = decodedToolArgs(value);
  if (!carrier) return { ok: false, failure: 'invalid-broker-args' };
  if (Object.keys(carrier).some((key) => !BROKER_ENVELOPE_KEYS.has(key))) {
    return { ok: false, failure: 'unexpected-broker-field' };
  }

  const target = Object.prototype.hasOwnProperty.call(carrier, 'name')
    && typeof carrier.name === 'string'
    ? carrier.name.trim()
    : '';
  if (!target) return { ok: false, failure: 'missing-broker-target' };
  if (target.length > 256 || /\s/.test(target)) {
    return { ok: false, failure: 'malformed-broker-target' };
  }

  const nestedArgs = decodedBrokerArgs(carrier);
  if (!nestedArgs.ok) return nestedArgs;
  return { ok: true, target, args: nestedArgs.args };
}

function invalidResolution(
  identity: ParsedToolAuthority,
  args: unknown,
  failure: ToolInvocationFailure,
  externalBroker = false,
): ResolvedToolInvocation {
  return {
    outerAuthority: identity.authority || identity.raw,
    outerArgs: args,
    toolName: identity.authority || identity.raw,
    args,
    nested: false,
    externalBroker,
    valid: false,
    failure,
    unsafeExternalMultiplexer: true,
  };
}

/**
 * Project a provider broker onto one concrete nested action. Only external
 * call_tool variants are unwrapped; Clementine-local's dispatcher retains its
 * own inner gate and must not be double-authorized here.
 */
export function resolveToolInvocation(toolName: string, args?: unknown): ResolvedToolInvocation {
  const identity = parseToolAuthority(toolName);
  if (!identity.valid) return invalidResolution(identity, args, identity.failure ?? 'malformed-native-authority');

  const externalCallBroker = identity.external && isCallToolMultiplexerName(identity.tool);
  if (!externalCallBroker) {
    return {
      outerAuthority: identity.authority,
      outerArgs: args,
      toolName: identity.authority,
      args,
      nested: false,
      externalBroker: false,
      valid: true,
      unsafeExternalMultiplexer: identity.external
        && (isShellMultiplexerName(identity.tool) || isComposioMultiplexerName(identity.tool)),
    };
  }

  const carrier = decodeBrokerCarrier(args);
  if (!carrier.ok) return invalidResolution(identity, args, carrier.failure, true);
  const { target } = carrier;
  if (isCallToolMultiplexerName(target)) {
    return invalidResolution(identity, args, 'recursive-broker-target', true);
  }

  const targetIdentity = parseToolAuthority(target);
  if (!targetIdentity.valid) {
    return invalidResolution(identity, args, targetIdentity.failure ?? 'malformed-broker-target', true);
  }
  let semanticTool: string;
  if (target.startsWith('mcp__')) {
    // A foreign broker does not inherit Clementine-local shortcuts merely by
    // spelling its target as our native carrier. Retain that namespace.
    semanticTool = targetIdentity.local
      ? target.slice('mcp__'.length)
      : targetIdentity.authority;
  } else if (target.includes('__')) {
    semanticTool = target;
  } else if (target === 'composio_execute_tool' || target.startsWith('cx_')) {
    semanticTool = target;
  } else if (identity.server) {
    semanticTool = `${identity.server}__${target}`;
  } else {
    return invalidResolution(identity, args, 'malformed-broker-target', true);
  }

  return {
    outerAuthority: identity.authority,
    outerArgs: args,
    toolName: semanticTool,
    args: carrier.args,
    nested: true,
    externalBroker: true,
    valid: true,
    unsafeExternalMultiplexer: isShellMultiplexerName(semanticTool)
      || isComposioMultiplexerName(semanticTool),
  };
}

export function extractComposioSlug(args: unknown): string | undefined {
  const decoded = decodedToolArgs(args);
  if (!decoded) return undefined;
  const slug = decoded.tool_slug ?? decoded.slug;
  return typeof slug === 'string' && slug.trim() ? slug.trim() : undefined;
}

const DESTRUCTIVE_ACTION_TOKENS = new Set([
  'DELETE',
  'TRASH',
  'PURGE',
  'DESTROY',
  'WIPE',
  'ERASE',
  'DROP',
]);

export function hasDestructiveActionToken(value: string): boolean {
  return splitCamelCase(value)
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .some((token) => DESTRUCTIVE_ACTION_TOKENS.has(token));
}

/** Pure destructive classifier over the resolved semantic action. */
export function isDestructiveToolInvocation(toolName: string, args?: unknown): boolean {
  const resolved = resolveToolInvocation(toolName, args);
  if (!resolved.valid) return resolved.externalBroker;
  const slug = extractComposioSlug(resolved.args)
    ?? (resolved.toolName.startsWith('cx_') ? resolved.toolName.slice(3) : undefined);
  if (slug && hasDestructiveActionToken(slug)) return true;

  const source = parseToolAuthority(toolName);
  const external = resolved.externalBroker
    || source.external
    || resolved.toolName.startsWith('cx_')
    || isComposioMultiplexerName(resolved.toolName);
  return external && hasDestructiveActionToken(toolActionSegment(resolved.toolName));
}
