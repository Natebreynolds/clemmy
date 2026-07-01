export const TOOL_POLICY_VERSION = '2026-07-01.enabled-then-deny';

export interface ToolLike {
  name?: string;
}

export interface ToolPolicyDiagnostics {
  version: string;
  surface: string;
  lane: string;
  inputCount: number;
  outputCount: number;
  allowedCount?: number;
  deniedCount: number;
  denyAppliedAfterAllow: true;
  requestedExcludes: string[];
  excludedApplied: string[];
  excludedMissing: string[];
  duplicateNames: string[];
  reason?: string;
}

export interface ToolPolicyResult<T> {
  tools: T[];
  diagnostics: ToolPolicyDiagnostics;
}

export interface ToolNamePolicyResult {
  names: string[];
  diagnostics: ToolPolicyDiagnostics;
}

function cleanNames(names: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names ?? []) {
    const name = String(raw ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function duplicateNames(names: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) dupes.add(name);
    seen.add(name);
  }
  return [...dupes].sort();
}

export function resolveEffectiveToolNames(input: {
  surface: string;
  lane: string;
  toolNames: readonly string[];
  allowedToolNames?: readonly string[];
  excludeToolNames?: readonly string[];
  reason?: string;
}): ToolNamePolicyResult {
  const originalNames = cleanNames(input.toolNames);
  const allowSet = input.allowedToolNames ? new Set(cleanNames(input.allowedToolNames)) : null;
  const requestedExcludes = cleanNames(input.excludeToolNames);
  const excludeSet = new Set(requestedExcludes);
  const afterAllow = allowSet ? originalNames.filter((name) => allowSet.has(name)) : originalNames;
  const names = afterAllow.filter((name) => !excludeSet.has(name));
  const nameSet = new Set(afterAllow);
  const excludedApplied = requestedExcludes.filter((name) => nameSet.has(name));
  const excludedMissing = requestedExcludes.filter((name) => !nameSet.has(name));

  return {
    names,
    diagnostics: {
      version: TOOL_POLICY_VERSION,
      surface: input.surface,
      lane: input.lane,
      inputCount: originalNames.length,
      outputCount: names.length,
      ...(allowSet ? { allowedCount: afterAllow.length } : {}),
      deniedCount: excludedApplied.length,
      denyAppliedAfterAllow: true,
      requestedExcludes,
      excludedApplied,
      excludedMissing,
      duplicateNames: duplicateNames(input.toolNames.map((name) => String(name ?? '').trim()).filter(Boolean)),
      ...(input.reason ? { reason: input.reason } : {}),
    },
  };
}

export function resolveEffectiveToolPolicy<T extends ToolLike>(input: {
  surface: string;
  lane: string;
  tools: readonly T[];
  allowedToolNames?: readonly string[];
  excludeToolNames?: readonly string[];
  reason?: string;
}): ToolPolicyResult<T> {
  const names = input.tools
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
  const byNamePolicy = resolveEffectiveToolNames({
    surface: input.surface,
    lane: input.lane,
    toolNames: names,
    allowedToolNames: input.allowedToolNames,
    excludeToolNames: input.excludeToolNames,
    reason: input.reason,
  });
  const allowedSet = input.allowedToolNames ? new Set(cleanNames(input.allowedToolNames)) : null;
  const excludeSet = new Set(cleanNames(input.excludeToolNames));
  const tools = input.tools.filter((tool) => {
    const name = typeof tool.name === 'string' ? tool.name.trim() : '';
    if (!name) return true;
    if (allowedSet && !allowedSet.has(name)) return false;
    return !excludeSet.has(name);
  });
  return {
    tools,
    diagnostics: {
      ...byNamePolicy.diagnostics,
      inputCount: input.tools.length,
      outputCount: tools.length,
    },
  };
}

export function nonFilterableToolExcludes(
  excludeToolNames: readonly string[] | undefined,
  filterableToolNames: ReadonlySet<string>,
): string[] {
  return cleanNames(excludeToolNames).filter((name) => !filterableToolNames.has(name));
}
