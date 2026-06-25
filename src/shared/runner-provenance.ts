/**
 * Vendor-agnostic provenance for a deterministic RUNNER's source text — what
 * external system it actually reaches. The runner twin of
 * deriveStepDataSources (workflow-describe.ts): it reads a script's SOURCE and
 * surfaces the CLI it shells (e.g. `sf` → Salesforce), SOQL objects,
 * composio/MCP/connector refs, and HTTP hosts — so a reader sees "this runner
 * queries Salesforce" instead of guessing. No curated vendor list.
 *
 * Shared by Workspace runners (space_get_runner) and workflow deterministic
 * steps (workflow_get). Pure leaf — no runtime imports.
 */

/** Engine/SOQL/JS tokens that look like connector slugs but aren't — excluded
 *  from runner provenance so STEP_CONTEXT / MAX_BUFFER don't read as data
 *  sources. NOT a vendor list. */
const RUNNER_NON_CONNECTOR = new Set([
  'STEP_CONTEXT', 'JSON', 'HTTP', 'HTTPS', 'URL', 'API', 'UTF', 'NULL', 'TRUE', 'FALSE',
  'MAX_BUFFER', 'NODE_ENV', 'TODO', 'NOTE', 'AND', 'OR', 'NOT', 'CSV', 'PDF', 'HTML', 'ID',
]);

export function deriveRunnerProvenance(src: string): string[] {
  const s = src || '';
  const out: string[] = [];
  // CLI shell-outs — the binary reveals the system (sf=Salesforce CLI, gh, curl…).
  const clis = new Set<string>();
  for (const m of s.matchAll(/(?:execFileSync|execSync|spawnSync|spawn|exec)\s*\(\s*['"`]([a-zA-Z0-9_.\/-]+)['"`]/g)) {
    clis.add((m[1].split('/').pop() || m[1]));
  }
  if (clis.size > 0) {
    const note = clis.has('sf') ? ' (sf = Salesforce CLI)' : '';
    out.push(`shells: ${[...clis].join(', ')}${note}`);
  }
  // SOQL objects (Salesforce): FROM <Object>.
  const objs = new Set<string>();
  for (const m of s.matchAll(/\bFROM\s+([A-Z][A-Za-z0-9_]+)/g)) objs.add(m[1]);
  if (objs.size > 0) out.push(`SOQL FROM: ${[...objs].slice(0, 8).join(', ')} (Salesforce)`);
  // Connector references: composio, MCP tool names, ALL_CAPS connector slugs.
  const refs = new Set<string>();
  if (/\bcomposio_execute_tool\b/.test(s)) refs.add('composio_execute_tool');
  for (const m of s.matchAll(/\bmcp__[a-zA-Z0-9_]+__[a-zA-Z0-9_]+\b/g)) refs.add(m[0]);
  for (const m of s.matchAll(/\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+\b/g)) {
    if (!RUNNER_NON_CONNECTOR.has(m[0])) refs.add(m[0]);
  }
  if (refs.size > 0) out.push(`refs: ${[...refs].slice(0, 12).join(', ')}`);
  // HTTP endpoints.
  const hosts = new Set<string>();
  for (const m of s.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) hosts.add(m[1]);
  if (hosts.size > 0) out.push(`http: ${[...hosts].slice(0, 6).join(', ')}`);
  return out;
}
