/** Canonical read-only workflow record display projection. */
const HEAVY_FIELDS = new Set(['stepOutputs', 'workflowDefinitionSnapshot', 'output', 'reportBack', 'mutationContractSnapshot']);
const SNAPSHOT_IDENTITY_FIELDS = ['version', 'scope', 'compilerId', 'definitionHash', 'workflowSlug', 'codeRevision'];

export function slimWorkflowRunRecord(raw: Record<string, unknown>): Record<string, unknown> {
  // Spread defines own data keys, including a decoded `__proto__` key. An
  // assignment loop could turn that key into inherited workflow/status fields.
  const out = { ...raw };
  for (const key of HEAVY_FIELDS) delete out[key];
  const outputs = raw.stepOutputs;
  out.stepOutputKeys = outputs && typeof outputs === 'object' && !Array.isArray(outputs) ? Object.keys(outputs) : [];
  const snapshot = raw.workflowDefinitionSnapshot;
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    const identity: Record<string, unknown> = {};
    for (const key of SNAPSHOT_IDENTITY_FIELDS) {
      if (key in snapshot) identity[key] = (snapshot as Record<string, unknown>)[key];
    }
    out.workflowDefinitionSnapshot = identity;
  }
  const report = raw.reportBack;
  if (report && typeof report === 'object' && !Array.isArray(report)) {
    out.reportBack = { outcome: (report as Record<string, unknown>).outcome };
  }
  return out;
}
