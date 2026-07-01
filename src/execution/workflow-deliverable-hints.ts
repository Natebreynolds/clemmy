import type { WorkflowStepOutputContract } from '../memory/workflow-store.js';

// Conservative deliverable-shape inference shared by authoring advisories and
// legacy run-target validation. This is never used to execute a tool or mutate a
// workflow; it only turns already-authored prompts into concrete evidence checks.

const DELIVERABLE_RE = /\b(report|brief|audit|summary|summaries|file|document|url|link|html|sheet|spreadsheet|pdf|csv|deck|slides?|deploy(?:ed|ment)?|publish(?:ed)?|draft(?:ed)?|records?|rows?|list|items?|leads|prospects|meetings|accounts|contacts|results?|page|website|saved to|written to|upload(?:ed)?)\b/i;
const PRODUCE_RE = /\b(produce|generate|create|build|write|draft|deploy|publish|save|export|render|compile|assemble|deliver|output)\b/i;
const URL_DELIVERABLE_RE = /\b(url|link|deploy(?:ed|ment)?|publish(?:ed)?|website|page|live\s+site|netlify|vercel)\b/i;
const FILE_DELIVERABLE_RE = /\b(file|html|pdf|csv|deck|slides?|document|screenshot|preview|saved to|written to|export|render)\b/i;
const LIST_DELIVERABLE_RE = /\b(list|rows?|records?|items?|leads|prospects|meetings|accounts|contacts|results?)\b/i;
const SUMMARY_DELIVERABLE_RE = /\b(summary|summaries)\b/i;

export function promptLooksDeliverable(prompt: string): boolean {
  return DELIVERABLE_RE.test(prompt) && PRODUCE_RE.test(prompt);
}

export function textMentionsDeliverable(text: string): boolean {
  return DELIVERABLE_RE.test(text);
}

export function inferOutputContractFromPrompt(prompt: string): WorkflowStepOutputContract | null {
  if (!promptLooksDeliverable(prompt)) return null;

  const required = new Set<string>();
  const verify: NonNullable<WorkflowStepOutputContract['verify']> = {};
  const nonEmpty: string[] = [];
  const minItems: Record<string, number> = {};

  if (URL_DELIVERABLE_RE.test(prompt)) {
    required.add('url');
    verify.url_present = ['url'];
  }
  if (FILE_DELIVERABLE_RE.test(prompt)) {
    required.add('path');
    verify.path_exists = ['path'];
  }
  if (SUMMARY_DELIVERABLE_RE.test(prompt)) {
    required.add('summary');
    nonEmpty.push('summary');
  }
  if (LIST_DELIVERABLE_RE.test(prompt)) {
    required.add('items');
    nonEmpty.push('items');
    minItems.items = 1;
  }
  if (required.size === 0) {
    required.add('result');
    nonEmpty.push('result');
  }

  return {
    type: 'object',
    required_keys: [...required],
    ...(Object.keys(verify).length > 0 ? { verify } : {}),
    ...(nonEmpty.length > 0 ? { non_empty: nonEmpty } : {}),
    ...(Object.keys(minItems).length > 0 ? { min_items: minItems } : {}),
  };
}

function renderStringArray(values: string[]): string {
  return `[${values.map((value) => `"${value}"`).join(', ')}]`;
}

export function outputContractSuggestionFromPrompt(prompt: string): string {
  const contract = inferOutputContractFromPrompt(prompt) ?? {
    type: 'object',
    required_keys: ['result'],
    non_empty: ['result'],
  };
  const parts = [
    'type: "object"',
    `required_keys: ${renderStringArray(contract.required_keys ?? ['result'])}`,
  ];
  const verifyParts: string[] = [];
  if (contract.verify?.url_present?.length) {
    verifyParts.push(`url_present: ${renderStringArray(contract.verify.url_present)}`);
  }
  if (contract.verify?.path_exists?.length) {
    verifyParts.push(`path_exists: ${renderStringArray(contract.verify.path_exists)}`);
  }
  if (verifyParts.length > 0) parts.push(`verify: { ${verifyParts.join(', ')} }`);
  if (contract.non_empty?.length) parts.push(`non_empty: ${renderStringArray(contract.non_empty)}`);
  if (contract.min_items && Object.keys(contract.min_items).length > 0) {
    const entries = Object.entries(contract.min_items).map(([key, value]) => `${key}: ${value}`);
    parts.push(`min_items: { ${entries.join(', ')} }`);
  }
  return `Suggested shape: output: { ${parts.join(', ')} }.`;
}
