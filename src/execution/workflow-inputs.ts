import type { WorkflowDefinition } from '../memory/workflow-store.js';

export const COMMON_WORKFLOW_INPUT_KEYS = new Set([
  'url',
  'website',
  'domain',
  'client',
  'clientName',
  'company',
  'firm',
  'query',
  'topic',
]);

export function collectRequiredWorkflowInputs(workflow: WorkflowDefinition): string[] {
  const required = new Set<string>();
  const declaredInputs = workflow.inputs ?? {};
  for (const [key, meta] of Object.entries(declaredInputs)) {
    if (!meta.default || meta.default.trim().length === 0) {
      required.add(key);
    }
  }

  const promptText = [
    workflow.description_body ?? '',
    ...workflow.steps.map((step) => step.prompt ?? ''),
    workflow.synthesis?.prompt ?? '',
  ].join('\n');

  for (const match of promptText.matchAll(/\{\{\s*input\.([A-Za-z0-9_-]+)\s*\}\}/g)) {
    required.add(match[1]);
  }

  // Older workflows used raw placeholders such as `{{url}}` in step
  // prose. Treat only common run-level input names as required so
  // unrelated template placeholders do not become false blockers.
  for (const match of promptText.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_-]*)\s*\}\}/g)) {
    const key = match[1];
    if (key in declaredInputs || COMMON_WORKFLOW_INPUT_KEYS.has(key)) {
      required.add(key);
    }
  }

  // A declared input with a non-empty default is ALWAYS satisfiable, so it
  // is never "required" — even if a step prompt references it via
  // {{input.X}}. Without this, a fully-defaulted workflow rejected an
  // empty-inputs workflow_run ("required inputs … missing"), which led the
  // chat agent to retry the same call ~137× — a runaway + 429 storm.
  for (const [key, meta] of Object.entries(declaredInputs)) {
    if (meta.default && meta.default.trim().length > 0) required.delete(key);
  }

  return [...required].sort();
}

export function normalizeWorkflowRunInputs(inputs: Record<string, string> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs ?? {})) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) normalized[key] = trimmed;
  }

  if (!normalized.url) {
    if (normalized.website) normalized.url = normalized.website;
    else if (normalized.domain) normalized.url = normalized.domain;
  }
  if (!normalized.website && normalized.url) normalized.website = normalized.url;
  return normalized;
}

export function missingWorkflowRunInputs(workflow: WorkflowDefinition, inputs: Record<string, string>): string[] {
  return collectRequiredWorkflowInputs(workflow).filter((key) => !inputs[key] || inputs[key].trim().length === 0);
}
