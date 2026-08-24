/**
 * Declared effect hints an MCP server publishes for its own tools.
 *
 * The MCP protocol lets a server annotate each tool with `readOnlyHint`,
 * `destructiveHint`, and `idempotentHint`. Until now Clementine read none of
 * them: every third-party tool was classified from its NAME alone, so a
 * perfectly ordinary read (`mcp__linear__issues`, `mcp__stripe__customers`)
 * had no proof it was a read and fell to the conservative unknown branch —
 * approval friction on every read of every server a user just connected. That
 * is the blank-install failure mode: connecting a capability must make it
 * usable, not merely visible.
 *
 * TRUST LEVEL: declared, not proven. The server is third-party code, so a
 * declaration can only ever ADMIT a read; it can never override contrary
 * evidence. Ranking in the classifier is deliberate:
 *
 *   documented semantics  >  curated provider rules  >  destructive/write
 *   evidence  >  declared readOnly  >  read verb in the operation  >  unknown
 *
 * A tool named `delete_all` that declares `readOnlyHint: true` is still a
 * write. A declaration is believed only when nothing contradicts it.
 *
 * This registry is process-scoped and populated as servers list their tools.
 * When the durable capability index lands, it becomes the persistence layer
 * for exactly these facts (plus their provenance and confidence) — the shape
 * here is deliberately the same.
 */

export interface DeclaredMcpToolEffect {
  /** The server declares this tool does not modify its environment. */
  readOnly?: boolean;
  /** The server declares this tool may perform destructive updates. */
  destructive?: boolean;
  /** The server declares repeated calls have no additional effect. */
  idempotent?: boolean;
}

const declared = new Map<string, DeclaredMcpToolEffect>();

function canonicalKey(toolName: string): string {
  const trimmed = toolName.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('mcp__') ? trimmed : `mcp__${trimmed}`;
}

function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Record what a server declared for one namespaced tool. Only real booleans
 * are kept: an absent or non-boolean hint stays absent so the classifier falls
 * through to its own evidence rather than reading a default as a claim.
 */
export function recordDeclaredMcpToolEffect(
  namespacedToolName: string,
  annotations: unknown,
): void {
  const key = canonicalKey(namespacedToolName);
  if (!key) return;
  if (!annotations || typeof annotations !== 'object' || Array.isArray(annotations)) {
    return;
  }
  const source = annotations as Record<string, unknown>;
  const effect: DeclaredMcpToolEffect = {
    ...(readBoolean(source, 'readOnlyHint') !== undefined
      ? { readOnly: readBoolean(source, 'readOnlyHint') }
      : {}),
    ...(readBoolean(source, 'destructiveHint') !== undefined
      ? { destructive: readBoolean(source, 'destructiveHint') }
      : {}),
    ...(readBoolean(source, 'idempotentHint') !== undefined
      ? { idempotent: readBoolean(source, 'idempotentHint') }
      : {}),
  };
  if (Object.keys(effect).length === 0) return;
  declared.set(key, effect);
}

/** What the owning server declared for this tool, or null when it declared nothing. */
export function declaredMcpToolEffect(toolName: string): DeclaredMcpToolEffect | null {
  const key = canonicalKey(toolName);
  if (!key) return null;
  return declared.get(key) ?? null;
}

/** Test seam: declarations are process state, not durable truth. */
export function _resetDeclaredMcpToolEffectsForTest(): void {
  declared.clear();
}
