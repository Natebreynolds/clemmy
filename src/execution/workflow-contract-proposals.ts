import type {
  WorkflowAllowedTool,
  WorkflowDefinition,
  WorkflowGoal,
  WorkflowInputDef,
  WorkflowStepInput,
  WorkflowStepOutputContract,
} from '../memory/workflow-store.js';
import { COMMON_WORKFLOW_INPUT_KEYS } from './workflow-inputs.js';
import { deriveLegacyWorkflowRunGoal } from './workflow-objective-judge.js';

export interface WorkflowContractInputProposal {
  key: string;
  input: WorkflowInputDef;
  reasons: string[];
}

export interface WorkflowContractStepOutputProposal {
  stepId: string;
  output: WorkflowStepOutputContract;
  reasons: string[];
  promptSnippet: string;
}

export interface WorkflowContractProposal {
  workflowName: string;
  needsUpgrade: boolean;
  alreadyPinnedGoal: boolean;
  proposedInputs: WorkflowContractInputProposal[];
  proposedGoal?: WorkflowGoal;
  proposedStepOutputs: WorkflowContractStepOutputProposal[];
  notes: string[];
}

export interface AppliedWorkflowContractUpgrades {
  def: WorkflowDefinition;
  changes: string[];
}

const INPUT_TOKEN_RE = /\{\{\s*input\.([A-Za-z0-9_-]+)\s*\}\}/g;
const LEGACY_COMMON_INPUT_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_-]*)\s*\}\}/g;

const PRODUCE_RE =
  /\b(?:produce|generate|create|build|write|draft|deploy|publish|save|export|render|compile|assemble|deliver|output|return|provide)\b/i;
const READ_DATA_RE =
  /\b(?:fetch|find|search|query|pull|list|retrieve|collect|extract|scrape|crawl|get|read|load|monitor)\b/i;
const DELIVERABLE_RE =
  /\b(?:report|brief|audit|summary|summaries|file|document|url|link|html|sheet|spreadsheet|pdf|csv|deck|slides?|deploy(?:ed|ment)?|publish(?:ed)?|draft(?:ed)?|records?|rows?|list|items?|leads|prospects|meetings|accounts|contacts|results?|page|website|saved to|written to|upload(?:ed)?)\b/i;
const URL_DELIVERABLE_RE =
  /\b(?:url|link|deploy(?:ed|ment)?|publish(?:ed)?|website|page|live\s+site|netlify|vercel|google\s+sheets?|spreadsheet|sheet)\b/i;
const FILE_DELIVERABLE_RE =
  /\b(?:file|html|pdf|csv|deck|slides?|screenshot|preview|saved to|written to|export|render)\b/i;
const LIST_DELIVERABLE_RE =
  /\b(?:list|rows?|records?|items?|leads|prospects|meetings|accounts|contacts|results?)\b/i;
const SUMMARY_DELIVERABLE_RE =
  /\b(?:summary|summaries)\b/i;

const LIVE_RESEARCH_RE =
  /\b(?:research|audit|analy[sz]e|seo|keyword|backlink|serp|lighthouse|competitor|competitive|rank(?:ing)?|crawl|scrape|extract|dataforseo|firecrawl)\b/i;
const EVIDENCE_DENSE_RE =
  /\b(?:audit|seo|keyword|backlink|serp|lighthouse|competitor|competitive|dataforseo)\b/i;
const ARTIFACT_WRITE_RE =
  /\b(?:build|create|generate|render|write|save|export|compile|assemble)\b[\s\S]{0,80}\b(?:html|pdf|file|report|brief|audit|document|deck|slides?|page|website|site)\b/i;
const EXTERNAL_TOOL_RE =
  /^(?:\*|composio|mcp|dataforseo|firecrawl|apify|fetch|web_|browser|run_shell_command|recall_tool_result|tool_output_query)/i;
const PINNED_COMPOSIO_MUTATION_SLUG_RE =
  /\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+){0,4}_(?:ADD|APPEND|COPY|CREATE|DELETE|EXECUTE|INSERT|MODIFY|MOVE|PATCH|POST|PUBLISH|REPLACE|SEND|TRIGGER|UPDATE|UPLOAD|UPSERT)(?:_[A-Z0-9]+)*\b/;
const IDENTITY_CONTRACT_KEYS = new Set([
  'id',
  'name',
  'client',
  'client_name',
  'company',
  'domain',
  'url',
  'canonical_url',
  'website',
  'site',
  'status',
  'timestamp',
  'date',
]);
const EVIDENCE_CONTRACT_KEYS = new Set([
  'sources',
  'source_urls',
  'source_errors',
  'evidence',
  'key_findings',
  'findings',
  'results',
  'items',
  'rows',
  'records',
  'metrics',
  'data',
  'ranked_keywords',
  'keywords',
  'backlinks',
  'referring_domains',
  'competitors',
  'technical_score',
  'summary',
]);

const LIST_KEY_HINTS: Array<[string, RegExp]> = [
  ['meetings', /\bmeetings?\b/i],
  ['leads', /\bleads\b/i],
  ['prospects', /\bprospects\b/i],
  ['accounts', /\baccounts?\b/i],
  ['contacts', /\bcontacts?\b/i],
  ['records', /\brecords?\b/i],
  ['rows', /\brows?\b/i],
  ['results', /\bresults?\b/i],
  ['items', /\bitems?\b/i],
];

function snippet(text: string, max = 180): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}

function hasOutputContract(step: WorkflowStepInput): boolean {
  return Boolean(step.output && Object.keys(step.output).length > 0);
}

function toolName(tool: WorkflowAllowedTool | string): string {
  return typeof tool === 'string' ? tool : tool.name;
}

function effectiveToolNames(workflow: WorkflowDefinition, step: WorkflowStepInput): string[] {
  const local = step.allowedTools?.filter((tool) => tool.trim().length > 0);
  const raw = local && local.length > 0 ? local : (workflow.allowedTools ?? []);
  return raw.map(toolName).filter((name) => name.trim().length > 0);
}

function stepReachesExternalToolSurface(workflow: WorkflowDefinition, step: WorkflowStepInput): boolean {
  if (step.usesSkill) return true;
  if (step.forEach) return true;
  return effectiveToolNames(workflow, step).some((tool) => EXTERNAL_TOOL_RE.test(tool));
}

function isUnattendedWorkflow(workflow: WorkflowDefinition): boolean {
  return Boolean(
    workflow.trigger?.schedule
    || workflow.trigger?.webhookPath
    || (workflow.trigger?.events?.length ?? 0) > 0,
  );
}

/**
 * A generic Composio executor is intentionally schema-light. That keeps the
 * normal tool surface lean, but an unattended write must either carry a proven
 * action binding in its own prompt or retain bounded catalog discovery. Without
 * either, the model can reach the mutation node knowing *what* to do but with
 * no executable slug/argument contract — the legacy morning-outreach failure.
 */
function unattendedComposioWriteNeedsBinding(
  workflow: WorkflowDefinition,
  step: WorkflowStepInput,
): boolean {
  if (!isUnattendedWorkflow(workflow)) return false;
  if (step.sideEffect !== 'write' || step.call || step.deterministic) return false;
  const tools = new Set(effectiveToolNames(workflow, step).map((tool) => tool.toLowerCase()));
  if (!tools.has('composio_execute_tool')) return false;
  if (tools.has('composio_search_tools')) return false;
  return !PINNED_COMPOSIO_MUTATION_SLUG_RE.test(step.prompt ?? '');
}

function contractEvidenceKeys(contract: WorkflowStepOutputContract | undefined): Set<string> {
  const keys = new Set<string>();
  for (const key of contract?.required_keys ?? []) keys.add(key);
  for (const key of contract?.non_empty ?? []) keys.add(key);
  for (const key of Object.keys(contract?.min_items ?? {})) keys.add(key);
  for (const key of contract?.verify?.path_exists ?? []) keys.add(key);
  for (const key of contract?.verify?.url_present ?? []) keys.add(key);
  return keys;
}

function hasEvidenceKey(contract: WorkflowStepOutputContract | undefined): boolean {
  // A domain collection ({accounts}, {invoices}, {patients}) is an evidence-
  // bearing payload just like generic rows/records — but ONLY when the author
  // declared it a non-empty COLLECTION (min_items ≥ 1). non_empty alone is not
  // enough: a required non-empty scalar ("assessment") is prose, not evidence.
  // Structural, so it works for every user's domain instead of an enumerated
  // noun list; identity/metadata keys stay excluded.
  const declaredCollections = new Set<string>(
    Object.entries(contract?.min_items ?? {})
      .filter(([, minimum]) => minimum >= 1)
      .map(([key]) => key),
  );
  for (const key of contractEvidenceKeys(contract)) {
    if (EVIDENCE_CONTRACT_KEYS.has(key)) return true;
    if (key && key !== '.' && declaredCollections.has(key) && !IDENTITY_CONTRACT_KEYS.has(key)) return true;
  }
  return false;
}

function onlyIdentityKeys(contract: WorkflowStepOutputContract | undefined): boolean {
  const keys = [...contractEvidenceKeys(contract)].filter((key) => key && key !== '.');
  return keys.length > 0 && keys.every((key) => IDENTITY_CONTRACT_KEYS.has(key));
}

function arrayContractHasRootEvidence(contract: WorkflowStepOutputContract | undefined): boolean {
  if (contract?.type !== 'array') return false;
  if ((contract.non_empty ?? []).some((path) => path === '' || path === '.')) return true;
  return Object.entries(contract.min_items ?? {})
    .some(([path, minimum]) => (path === '' || path === '.') && minimum >= 1);
}

export function stepHasWeakLiveResearchContract(
  workflow: WorkflowDefinition,
  step: WorkflowStepInput,
): boolean {
  if (!hasOutputContract(step)) return false;
  if (step.deterministic) return false;
  // A write/upsert step may mention the research data it is preserving (SEO,
  // keywords, audit fields) without being a research step itself. Its proof is
  // the destination receipt/read-back contract, not invented research-summary
  // keys. Explicit side effects are authoritative here.
  if (step.sideEffect && step.sideEffect !== 'read') return false;
  if ((step.output?.verify?.path_exists?.length ?? 0) > 0) return false;
  const prompt = step.prompt ?? '';
  if (!LIVE_RESEARCH_RE.test(prompt)) return false;
  if (!stepReachesExternalToolSurface(workflow, step)) return false;
  // A root array is the evidence payload itself. Object-only keys such as
  // sources/key_findings cannot be grafted onto it without creating an
  // impossible contract (`type:array` + `required_keys`). For forEach this is
  // also the runner's aggregate shape: [{itemKey, output}].
  if (arrayContractHasRootEvidence(step.output)) return false;
  return onlyIdentityKeys(step.output) || !hasEvidenceKey(step.output);
}

export function hardenWeakLiveResearchOutputContract(
  workflow: WorkflowDefinition,
  step: WorkflowStepInput,
): WorkflowStepOutputContract | null {
  if (!stepHasWeakLiveResearchContract(workflow, step)) return null;
  const current = step.output ?? {};
  if (current.type === 'array') {
    const nonEmpty = new Set(current.non_empty ?? []);
    const minItems = { ...(current.min_items ?? {}) };
    const rootKey = Object.hasOwn(minItems, '.') ? '.' : '';
    const minimum = step.forEach ? 1 : (EVIDENCE_DENSE_RE.test(step.prompt ?? '') ? 3 : 1);
    nonEmpty.add(rootKey);
    minItems[rootKey] = Math.max(minItems[rootKey] ?? 0, minimum);
    return compactContract({
      ...current,
      // required_keys only applies to an object root. Dropping it repairs
      // legacy impossible array contracts without guessing an item schema.
      required_keys: undefined,
      non_empty: [...nonEmpty],
      min_items: minItems,
      description: current.description ?? `Evidence-bearing research result array for step "${step.id}".`,
    });
  }
  const required = new Set(current.required_keys ?? []);
  const nonEmpty = new Set(current.non_empty ?? []);
  const minItems = { ...(current.min_items ?? {}) };
  // A fan-out item represents one researched entity. Requiring three sources
  // and three findings from every item is an invented burden; the aggregate
  // supplies breadth. Non-fan-out evidence-dense research still gets 3.
  const minEvidenceItems = step.forEach ? 1 : (EVIDENCE_DENSE_RE.test(step.prompt ?? '') ? 3 : 1);

  required.add('sources');
  required.add('key_findings');
  required.add('source_errors');
  nonEmpty.add('sources');
  nonEmpty.add('key_findings');
  minItems.sources = Math.max(minItems.sources ?? 0, minEvidenceItems);
  minItems.key_findings = Math.max(minItems.key_findings ?? 0, minEvidenceItems);

  return compactContract({
    ...current,
    type: current.type ?? 'object',
    required_keys: [...required],
    non_empty: [...nonEmpty],
    min_items: minItems,
    description: current.description ?? `Evidence-grade live research output for step "${step.id}".`,
  });
}

export function workflowAuthoringAdvisories(workflow: WorkflowDefinition): string[] {
  const warnings: string[] = [];
  for (const step of workflow.steps ?? []) {
    if (unattendedComposioWriteNeedsBinding(workflow, step)) {
      warnings.push(
        `Step "${step.id}" is an unattended external write through composio_execute_tool, but its prompt names no concrete mutation slug and the step cannot call composio_search_tools. Pin a proven TOOLKIT_ACTION slug plus its argument shape, or allow bounded discovery, so the run reaches the write with an executable action.`,
      );
    }

    if (stepHasWeakLiveResearchContract(workflow, step)) {
      const keys = [...contractEvidenceKeys(step.output)].filter(Boolean);
      warnings.push(
        `Step "${step.id}" reaches live research tools but its output contract can pass without evidence`
        + `${keys.length > 0 ? ` (${keys.join(', ')})` : ''}. Require source-backed keys such as sources, key_findings, and source_errors so provider data cannot be discarded.`,
      );
    }

    if (
      !step.deterministic
      && (step.output?.verify?.path_exists?.length ?? 0) > 0
      && ARTIFACT_WRITE_RE.test(step.prompt ?? '')
    ) {
      warnings.push(
        `Step "${step.id}" verifies a local artifact path but is still model-written. Prefer a deterministic runner under scripts/ for rendering/writing, and keep the model responsible for structured data only.`,
      );
    }
  }
  return warnings;
}

function hasPinnedGoal(workflow: WorkflowDefinition): boolean {
  return Boolean(workflow.goal?.objective && workflow.goal.objective.trim().length >= 4);
}

function sampleInputsFromDefaults(workflow: WorkflowDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, meta] of Object.entries(workflow.inputs ?? {})) {
    if (typeof meta.default === 'string' && meta.default.trim().length > 0) out[key] = meta.default.trim();
  }
  return out;
}

function addReason(map: Map<string, Set<string>>, key: string, reason: string): void {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key)!.add(reason);
}

function collectReferencedInputs(workflow: WorkflowDefinition): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  const texts: Array<{ source: string; text?: string }> = [
    { source: 'description body', text: workflow.description_body },
    ...workflow.steps.map((step) => ({ source: `step "${step.id}"`, text: step.prompt })),
    { source: 'synthesis prompt', text: workflow.synthesis?.prompt },
  ];

  for (const { source, text } of texts) {
    if (!text) continue;
    INPUT_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INPUT_TOKEN_RE.exec(text)) !== null) {
      addReason(refs, m[1], `${source} references {{input.${m[1]}}}`);
    }

    LEGACY_COMMON_INPUT_RE.lastIndex = 0;
    while ((m = LEGACY_COMMON_INPUT_RE.exec(text)) !== null) {
      const key = m[1];
      if (!COMMON_WORKFLOW_INPUT_KEYS.has(key)) continue;
      addReason(refs, key, `${source} uses legacy {{${key}}}; declare "${key}" and rewrite as {{input.${key}}}`);
    }
  }

  return refs;
}

function proposeInputs(workflow: WorkflowDefinition): WorkflowContractInputProposal[] {
  const declared = workflow.inputs ?? {};
  const refs = collectReferencedInputs(workflow);
  return [...refs.entries()]
    .filter(([key]) => !(key in declared))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, reasons]) => ({
      key,
      input: { type: 'string' },
      reasons: [...reasons].sort(),
    }));
}

function listOutputKey(prompt: string): string {
  return LIST_KEY_HINTS.find(([, re]) => re.test(prompt))?.[0] ?? 'items';
}

function stepLooksContractWorthy(prompt: string): boolean {
  return (DELIVERABLE_RE.test(prompt) && PRODUCE_RE.test(prompt))
    || (LIST_DELIVERABLE_RE.test(prompt) && READ_DATA_RE.test(prompt));
}

function uniqueKeys(keys: string[]): string[] {
  return [...new Set(keys.filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)))];
}

/**
 * Prefer the payload shape the workflow author actually named over noun-based
 * guessing. The old inference saw words such as "accounts", "summary", and
 * "sheet URL" anywhere in a tracker prompt and invented `{url, summary,
 * accounts}` even when the prompt explicitly returned
 * `{spreadsheetId, sheetName, sheetUrl, columns, existingRows}`. That turns a
 * helpful contract into a model-choking false gate.
 *
 * Intentionally conservative: recognize only an object literal immediately
 * after "return" or a comma-separated "including/exactly these fields" clause.
 * If neither exists, the legacy coarse proposal remains the fallback.
 */
function explicitReturnKeys(prompt: string): string[] {
  const objectShape = prompt.match(
    /\breturn(?:\s+only|\s+exactly)?\s+(?:structured\s+JSON\s+)?\{([\s\S]{1,600}?)\}/i,
  );
  if (objectShape) {
    const keys = objectShape[1]
      .split(',')
      .map((part) => part.trim().match(/^`?([A-Za-z_][A-Za-z0-9_]*)`?\s*(?::|$)/)?.[1] ?? '');
    const unique = uniqueKeys(keys);
    if (unique.length > 0) return unique;
  }

  const fieldClause = prompt.match(
    /\breturn[\s\S]{0,300}?\b(?:including|exactly\s+these\s+fields)\s*:\s*([^.\n]{1,600})/i,
  );
  if (!fieldClause) return [];
  const clause = fieldClause[1];
  const quoted = [...clause.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((match) => match[1]);
  if (quoted.length > 0) return uniqueKeys(quoted);
  return uniqueKeys(
    clause
      .replace(/\band\b/gi, ',')
      .split(',')
      .map((part) => part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)$/)?.[1] ?? ''),
  );
}

function compactContract(contract: WorkflowStepOutputContract): WorkflowStepOutputContract {
  const out: WorkflowStepOutputContract = { ...contract };
  if (out.required_keys && out.required_keys.length === 0) delete out.required_keys;
  if (out.non_empty && out.non_empty.length === 0) delete out.non_empty;
  if (out.min_items && Object.keys(out.min_items).length === 0) delete out.min_items;
  if (out.verify) {
    const verify = { ...out.verify };
    if (!verify.path_exists || verify.path_exists.length === 0) delete verify.path_exists;
    if (!verify.url_present || verify.url_present.length === 0) delete verify.url_present;
    out.verify = verify;
    if (Object.keys(verify).length === 0) delete out.verify;
  }
  return out;
}

const ROOT_ARRAY_OUTPUT_RE =
  /\b(?:return|emit|output|produce|respond\s+with)\b[\s\S]{0,180}\b(?:only\s+)?(?:a\s+)?(?:json\s+)?array\b|\bconverge\b[\s\S]{0,180}\binto\s+(?:only\s+)?(?:a\s+)?json\s+array\b/i;

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function explicitRootArrayMinimum(prompt: string): number {
  const match = prompt.match(/\b(?:exactly|at\s+least)\s+(\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)\b/i);
  if (!match) return 1;
  const raw = match[1].toLowerCase();
  const parsed = NUMBER_WORDS[raw] ?? Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function proposeStepOutput(step: WorkflowStepInput): WorkflowContractStepOutputProposal | null {
  if (hasOutputContract(step)) return null;
  if (step.forEach) return null;
  if (step.deterministic) return null;
  if (step.call) return null;
  const prompt = step.prompt ?? '';
  if (!stepLooksContractWorthy(prompt)) return null;

  const reasons: string[] = [];
  const required = new Set<string>();
  const verify: NonNullable<WorkflowStepOutputContract['verify']> = {};
  const minItems: Record<string, number> = {};
  const nonEmpty = new Set<string>();

  // Preserve an explicitly requested ROOT array. The generic list heuristic
  // used to rewrite prompts such as "return only a JSON array of three drafts"
  // into an object contract `{rows:[...]}`. The model then obeyed the invented
  // harness shape instead of the authored task, and downstream writes received
  // a different payload than requested.
  if (ROOT_ARRAY_OUTPUT_RE.test(prompt)) {
    const minimum = explicitRootArrayMinimum(prompt);
    return {
      stepId: step.id,
      output: {
        type: 'array',
        non_empty: [''],
        min_items: { '': minimum },
        description: `Prompt-declared root array for step "${step.id}".`,
      },
      reasons: [`prompt explicitly requests a root JSON array; require at least ${minimum} item(s) without wrapping it in an invented object key`],
      promptSnippet: snippet(prompt),
    };
  }

  const declaredKeys = explicitReturnKeys(prompt);
  if (declaredKeys.length > 0) {
    const urlKeys = declaredKeys.filter((key) => /(?:url|link)$/i.test(key));
    const pathKeys = declaredKeys.filter((key) => /(?:^|_)(?:path|file_path)$/i.test(key) || /Path$/.test(key));
    return {
      stepId: step.id,
      output: compactContract({
        type: 'object',
        required_keys: declaredKeys,
        verify: {
          ...(urlKeys.length > 0 ? { url_present: urlKeys } : {}),
          ...(pathKeys.length > 0 ? { path_exists: pathKeys } : {}),
        },
        description: `Prompt-declared output shape for step "${step.id}".`,
      }),
      reasons: ['prompt explicitly declares its returned object fields; preserve that shape instead of guessing from nearby nouns'],
      promptSnippet: snippet(prompt),
    };
  }

  if (URL_DELIVERABLE_RE.test(prompt)) {
    required.add('url');
    verify.url_present = ['url'];
    reasons.push('prompt asks for a URL/link/live/sheet-style deliverable');
  }
  if (FILE_DELIVERABLE_RE.test(prompt)) {
    required.add('path');
    verify.path_exists = ['path'];
    reasons.push('prompt asks for a file/render/export-style deliverable');
  }
  if (SUMMARY_DELIVERABLE_RE.test(prompt)) {
    required.add('summary');
    nonEmpty.add('summary');
    reasons.push('prompt asks for a summary deliverable');
  }
  if (LIST_DELIVERABLE_RE.test(prompt)) {
    const key = listOutputKey(prompt);
    required.add(key);
    nonEmpty.add(key);
    minItems[key] = 1;
    reasons.push(`prompt asks for data rows/items; require non-empty "${key}"`);
  }

  if (required.size === 0) {
    reasons.push('prompt asks for a deliverable; require non-empty text output');
    return {
      stepId: step.id,
      output: { type: 'string', non_empty: [''], description: 'Non-empty deliverable text.' },
      reasons,
      promptSnippet: snippet(prompt),
    };
  }

  return {
    stepId: step.id,
    output: compactContract({
      type: 'object',
      required_keys: [...required],
      non_empty: [...nonEmpty],
      min_items: minItems,
      verify,
      description: `Verified output for step "${step.id}".`,
    }),
    reasons,
    promptSnippet: snippet(prompt),
  };
}

function criteriaFromStepProposal(proposal: WorkflowContractStepOutputProposal): string[] {
  const c = proposal.output;
  const out: string[] = [];
  if (c.required_keys?.length) {
    out.push(`Step "${proposal.stepId}" returns required key(s): ${c.required_keys.join(', ')}.`);
  }
  for (const p of c.non_empty ?? []) {
    out.push(`Step "${proposal.stepId}" returns a non-empty value at "${p || '(root)'}".`);
  }
  for (const [p, min] of Object.entries(c.min_items ?? {})) {
    out.push(`Step "${proposal.stepId}" returns at least ${min} item(s) at "${p}".`);
  }
  for (const p of c.verify?.url_present ?? []) {
    out.push(`Step "${proposal.stepId}" returns a real non-empty http(s) URL at "${p}".`);
  }
  for (const p of c.verify?.path_exists ?? []) {
    out.push(`Step "${proposal.stepId}" returns an existing local file path at "${p}".`);
  }
  return out;
}

function fallbackObjective(workflow: WorkflowDefinition, stepOutputs: WorkflowContractStepOutputProposal[]): string {
  const base = [
    workflow.description,
    workflow.description_body,
    workflow.synthesis?.prompt,
    stepOutputs[stepOutputs.length - 1]?.promptSnippet,
  ].find((part) => meaningfulObjective(part));
  if (base) return snippet(base, 1200);
  return `Complete workflow "${workflow.name}" and produce its expected deliverable.`;
}

function meaningfulObjective(text: string | undefined): string | undefined {
  const trimmed = text?.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  if (trimmed.length < 4) return undefined;
  if (/^(?:x|test|todo|tbd|n\/a|na)$/i.test(trimmed)) return undefined;
  return trimmed;
}

function proposeGoal(
  workflow: WorkflowDefinition,
  stepOutputs: WorkflowContractStepOutputProposal[],
): WorkflowGoal | undefined {
  if (hasPinnedGoal(workflow)) return undefined;
  const legacyGoal = deriveLegacyWorkflowRunGoal(workflow, sampleInputsFromDefaults(workflow));
  const legacyObjective = meaningfulObjective(legacyGoal?.objective);
  const legacyCriteria = legacyGoal?.successCriteria ?? [];
  const criteria = [
    ...(stepOutputs.length > 0
      ? legacyCriteria.filter((criterion) => !/^Step ".+" output (?:includes|has)\b/.test(criterion))
      : legacyCriteria),
    ...stepOutputs.flatMap(criteriaFromStepProposal),
  ];
  if (criteria.length === 0 && stepOutputs.length === 0 && !workflow.synthesis?.prompt) return undefined;
  return {
    objective: legacyObjective || fallbackObjective(workflow, stepOutputs),
    successCriteria: [...new Set(criteria)].slice(0, 10),
    maxAttempts: 2,
  };
}

export function proposeWorkflowContractUpgrades(workflow: WorkflowDefinition): WorkflowContractProposal {
  const proposedInputs = proposeInputs(workflow);
  const proposedStepOutputs = workflow.steps
    .map(proposeStepOutput)
    .filter((p): p is WorkflowContractStepOutputProposal => Boolean(p));
  const proposedGoal = proposeGoal(workflow, proposedStepOutputs);
  const alreadyPinnedGoal = hasPinnedGoal(workflow);
  const notes: string[] = [];
  if (alreadyPinnedGoal) notes.push('Pinned goal already exists; no run-goal proposal generated.');
  if (proposedInputs.length > 0) {
    notes.push('Input proposals are metadata-only; legacy raw placeholders such as {{url}} still need prompt rewrites to {{input.url}}.');
  }
  const needsUpgrade = proposedInputs.length > 0 || proposedStepOutputs.length > 0 || Boolean(proposedGoal);
  return {
    workflowName: workflow.name,
    needsUpgrade,
    alreadyPinnedGoal,
    proposedInputs,
    proposedGoal,
    proposedStepOutputs,
    notes,
  };
}

export function applyWorkflowContractUpgrades(
  workflow: WorkflowDefinition,
  proposal: WorkflowContractProposal = proposeWorkflowContractUpgrades(workflow),
): AppliedWorkflowContractUpgrades {
  const changes: string[] = [];
  const nextInputs: Record<string, WorkflowInputDef> = { ...(workflow.inputs ?? {}) };
  let inputsChanged = false;
  for (const input of proposal.proposedInputs) {
    if (input.key in nextInputs) continue;
    nextInputs[input.key] = input.input;
    inputsChanged = true;
    changes.push(`Declared workflow input "${input.key}".`);
  }

  const outputByStep = new Map(proposal.proposedStepOutputs.map((p) => [p.stepId, p]));
  let stepsChanged = false;
  const steps = workflow.steps.map((step) => {
    if (step.output && Object.keys(step.output).length > 0) return step;
    const output = outputByStep.get(step.id);
    if (!output) return step;
    stepsChanged = true;
    changes.push(`Added output contract to step "${step.id}".`);
    return { ...step, output: output.output };
  });

  let goalChanged = false;
  let goal = workflow.goal;
  if (!hasPinnedGoal(workflow) && proposal.proposedGoal) {
    goal = proposal.proposedGoal;
    goalChanged = true;
    changes.push('Pinned workflow goal.');
  }

  if (!inputsChanged && !stepsChanged && !goalChanged) return { def: workflow, changes };
  return {
    def: {
      ...workflow,
      ...(inputsChanged ? { inputs: nextInputs } : {}),
      ...(stepsChanged ? { steps } : {}),
      ...(goalChanged ? { goal } : {}),
    },
    changes,
  };
}

function q(value: string): string {
  return JSON.stringify(value);
}

function renderArray(values: string[]): string {
  return `[${values.map(q).join(', ')}]`;
}

function renderInputProposal(p: WorkflowContractInputProposal): string[] {
  const lines = [`  ${p.key}:`, `    type: ${p.input.type ?? 'string'}`];
  if (p.input.default !== undefined) lines.push(`    default: ${q(p.input.default)}`);
  if (p.input.description) lines.push(`    description: ${q(p.input.description)}`);
  lines.push(`    # ${p.reasons.join('; ')}`);
  return lines;
}

export function renderOutputContractYaml(contract: WorkflowStepOutputContract, indent = ''): string {
  const lines: string[] = [];
  if (contract.type) lines.push(`${indent}type: ${contract.type}`);
  if (contract.required_keys?.length) lines.push(`${indent}required_keys: ${renderArray(contract.required_keys)}`);
  if (contract.non_empty?.length) lines.push(`${indent}non_empty: ${renderArray(contract.non_empty)}`);
  if (contract.min_items && Object.keys(contract.min_items).length > 0) {
    lines.push(`${indent}min_items:`);
    for (const [key, min] of Object.entries(contract.min_items)) lines.push(`${indent}  ${key}: ${min}`);
  }
  if (contract.verify && Object.keys(contract.verify).length > 0) {
    lines.push(`${indent}verify:`);
    if (contract.verify.path_exists?.length) lines.push(`${indent}  path_exists: ${renderArray(contract.verify.path_exists)}`);
    if (contract.verify.url_present?.length) lines.push(`${indent}  url_present: ${renderArray(contract.verify.url_present)}`);
  }
  if (contract.description) lines.push(`${indent}description: ${q(contract.description)}`);
  return lines.join('\n');
}

function renderGoal(goal: WorkflowGoal): string[] {
  const lines = [
    'goal:',
    `  objective: ${q(goal.objective)}`,
  ];
  if (goal.successCriteria && goal.successCriteria.length > 0) {
    lines.push('  success_criteria:');
    for (const criterion of goal.successCriteria) lines.push(`    - ${q(criterion)}`);
  }
  if (goal.maxAttempts !== undefined) lines.push(`  max_attempts: ${goal.maxAttempts}`);
  return lines;
}

export function renderWorkflowContractProposalReport(proposals: WorkflowContractProposal[]): string {
  if (proposals.length === 0) return 'No workflow contract upgrades proposed.';
  const lines = [
    '## Workflow Contract Proposals',
    'Non-mutating scan: these are suggested blocks to review and apply with workflow_update or direct workflow editing.',
  ];
  for (const proposal of proposals) {
    lines.push('', `### ${proposal.workflowName}`);
    if (!proposal.needsUpgrade) {
      lines.push('No missing contract blocks detected.');
    }
    if (proposal.proposedInputs.length > 0) {
      lines.push('', 'Suggested inputs:', '```yaml', 'inputs:');
      for (const input of proposal.proposedInputs) lines.push(...renderInputProposal(input));
      lines.push('```');
    }
    if (proposal.proposedGoal) {
      lines.push('', 'Suggested pinned goal:', '```yaml', ...renderGoal(proposal.proposedGoal), '```');
    }
    if (proposal.proposedStepOutputs.length > 0) {
      lines.push('', 'Suggested step output contracts:');
      for (const step of proposal.proposedStepOutputs) {
        lines.push(
          '',
          `Step "${step.stepId}" (${step.reasons.join('; ')}):`,
          '```yaml',
          'output:',
          renderOutputContractYaml(step.output, '  '),
          '```',
          `Prompt: ${step.promptSnippet}`,
        );
      }
    }
    for (const note of proposal.notes) lines.push(`Note: ${note}`);
  }
  return lines.join('\n');
}
