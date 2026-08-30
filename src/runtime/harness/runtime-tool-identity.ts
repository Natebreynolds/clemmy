/**
 * Pure tool-name trust primitives shared by lifecycle accounting and external
 * effect classification. Keep transport recognition here so adding a new
 * carrier cannot silently acquire different authority in two runtime lanes.
 */

export function stripMcpTransportPrefix(toolName: string): string {
  if (!toolName.startsWith('mcp__')) return toolName;
  const remainder = toolName.slice(5);
  // A valid MCP identity has both a server and a tool. Preserve malformed
  // prefix-only shapes so they fall through to the foreign/fail-closed lane.
  return remainder.includes('__') ? remainder : toolName;
}

export function runtimeToolTail(toolName: string): string {
  const normalized = stripMcpTransportPrefix(toolName);
  return normalized.split('__').at(-1) ?? normalized;
}

export function isClementineLocalToolNamespace(toolName: string): boolean {
  const parts = stripMcpTransportPrefix(toolName).split('__');
  // Accept only the exact server__tool shape. Extra namespace segments must
  // not turn a foreign lookalike into a trusted local carrier.
  if (parts.length !== 2) return false;
  return /^(?:clementine(?:-local)?|clem(?:entine)?_local)$/i.test(parts[0] ?? '');
}

export function isPlainOrClementineLocalTool(
  toolName: string,
  expectedTail: string,
): boolean {
  // Plain means genuinely unnamespaced, not a malformed `mcp__tool` shape.
  return toolName === expectedTail
    || (
      isClementineLocalToolNamespace(toolName)
      && runtimeToolTail(toolName) === expectedTail
    );
}

export function isTrustedComposioGateway(toolName: string): boolean {
  const normalized = stripMcpTransportPrefix(toolName);
  const parts = normalized.split('__');
  const server = parts.slice(0, -1).join('__').toLowerCase();
  const tail = runtimeToolTail(toolName);
  return toolName === 'composio_execute_tool'
    || (
      isClementineLocalToolNamespace(toolName)
      && tail === 'composio_execute_tool'
    )
    || (parts.length === 2 && server === 'composio' && tail === 'execute_tool');
}

export function isTrustedDynamicComposioTool(toolName: string): boolean {
  const tail = runtimeToolTail(toolName);
  return tail.toLowerCase().startsWith('cx_')
    && isPlainOrClementineLocalTool(toolName, tail);
}

/**
 * Transport-neutral operation identity. Native MCP `google_sheets__batch_get`,
 * Composio `GOOGLESHEETS_BATCH_GET`, and catalog `googlesheets_batch_get` are
 * one operation. Casing, underscores, and MCP `__` separators are not safety
 * properties. Ambiguous collisions still fail closed at the caller.
 */
export function catalogOperationIdentityKey(operationId: string): string {
  return operationId.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function catalogOperationIdentitiesEqual(left: string, right: string): boolean {
  const a = catalogOperationIdentityKey(left);
  const b = catalogOperationIdentityKey(right);
  return Boolean(a) && a === b;
}
