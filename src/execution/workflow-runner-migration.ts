/**
 * Deterministic migration of a legacy deterministic-runner step into exact
 * workflow steps.
 *
 * Owner, 2026-09-01: "Clem needs to have the right tools to migrate workflows,
 * or legacy ones still need to be able to run." Both are now true. Legacy
 * runners run (workflow-runner.ts executeStep). This module is the tool: it
 * reads the runner's SOURCE — never executes it — and extracts what a model
 * kept failing to rewrite from 1,109 lines (18 attempts in one day):
 *
 *   - every Salesforce SOQL query the script issues → one exact
 *     `salesforce_sf_soql_query` call step each, with `${IDENT}` placeholders
 *     resolved from the script's own literal string arrays (a `const REPS =
 *     [...]` and a `REP_FILTER = REPS.map(...).join(...)` both resolve to the
 *     quoted list) or, when they cannot be resolved, lifted into declared
 *     workflow inputs the model or the user fills;
 *   - one closed `transform` step that packages every read's parsed JSON;
 *   - one rendering step whose prompt carries the script's own output
 *     format (the string literals it pushed into its summary), so the model
 *     reproduces the shape instead of inventing one;
 *   - the workflow's other steps unchanged, with `steps.<runner>.output.<key>`
 *     references pointed at the new render step;
 *   - a GAPS list naming what exact steps cannot express (local state files,
 *     per-record attribution loops, computed dates) so the model's remaining
 *     job is review and gap-filling, not translation.
 *
 * Pure and testable: input is the definition plus the runner source bytes.
 */
import type {
  WorkflowDefinition,
  WorkflowInputDef,
  WorkflowStepInput,
  WorkflowTransformExpressionV1,
} from '../memory/workflow-store.js';

export const SALESFORCE_SOQL_READ_TOOL = 'salesforce_sf_soql_query';

export interface RunnerMigrationRead {
  /** The step id the query became. */
  stepId: string;
  /** The SOQL with every resolvable placeholder substituted. */
  query: string;
  /** Placeholders that could not be resolved from the source; each is also a
   * declared workflow input the query now references as `{{input.<name>}}`. */
  unresolved: string[];
}

export interface RunnerMigrationDraft {
  ok: boolean;
  /** The candidate definition with the runner step replaced. */
  definition: WorkflowDefinition;
  reads: RunnerMigrationRead[];
  /** What the script did that exact steps cannot express; the model or the
   * user decides what to keep. Never silent. */
  gaps: string[];
  /** The render step id, when the runner produced a rendered field. */
  renderStepId?: string;
}

const SOQL_LITERAL = /(`|'|")\s*(SELECT\s+[\s\S]*?\bFROM\b[\s\S]*?)\1/g;
const PLACEHOLDER = /\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g;

/** `export const NAME = Object.freeze([ 'a', 'b' ])` / `const NAME = ['a']`. */
function literalStringArrays(source: string): Map<string, string[]> {
  const arrays = new Map<string, string[]>();
  const declaration = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:Object\.freeze\()?\s*\[([\s\S]*?)\]\s*\)?\s*;/g;
  for (const match of source.matchAll(declaration)) {
    const name = match[1]!;
    const body = match[2]!;
    const items = [...body.matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)].map((item) => item[2]!);
    if (items.length === 0) continue;
    // A body with anything but string literals and separators is not a literal list.
    const residue = body.replace(/(['"])((?:\\.|(?!\1).)*)\1/g, '').replace(/[\s,]/g, '');
    if (residue) continue;
    arrays.set(name, items);
  }
  return arrays;
}

/** `const FILTER = REPS.map(...).join(...)` → the quoted list of REPS. */
function derivedQuotedLists(source: string, arrays: Map<string, string[]>): Map<string, string> {
  const derived = new Map<string, string>();
  const declaration = /const\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\.map\([\s\S]*?\)\.join\(/g;
  for (const match of source.matchAll(declaration)) {
    const items = arrays.get(match[2]!);
    if (!items) continue;
    derived.set(match[1]!, items.map((item) => `'${item.replaceAll("'", "\\'")}'`).join(','));
  }
  for (const [name, items] of arrays) {
    derived.set(name, items.map((item) => `'${item.replaceAll("'", "\\'")}'`).join(','));
  }
  return derived;
}

function stepIdFor(query: string, index: number, taken: Set<string>): string {
  const from = /\bFROM\s+([A-Za-z_][\w]*)/i.exec(query)?.[1]?.toLowerCase() ?? 'read';
  const where = /\bWHERE\b([\s\S]{0,60})/i.exec(query)?.[1] ?? '';
  const hint = /(TODAY|THIS_WEEK|THIS_MONTH|N_DAYS_AGO|LAST_N_DAYS|IsWon|IsClosed|CreatedDate|ActivityDate)/i.exec(where)?.[1]?.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  let candidate = `${from}${hint ? `_${hint}` : ''}`;
  if (taken.has(candidate)) candidate = `${candidate}_${index + 1}`;
  taken.add(candidate);
  return candidate;
}

/** The literal lines the script pushes into its rendered output, in order. */
function renderedFormatLines(source: string): string[] {
  const lines: string[] = [];
  for (const match of source.matchAll(/(?:lines|out|parts|rows)\.push\(\s*([\s\S]*?)\);/g)) {
    for (const literal of match[1]!.matchAll(/(`|'|")((?:\\.|(?!\1).)*)\1/g)) {
      const text = literal[2]!.replace(/\$\{[^}]*\}/g, '<value>').trim();
      if (text.length > 0 && text.length <= 200) lines.push(text);
    }
  }
  return [...new Set(lines)].slice(0, 60);
}

function gapsIn(source: string): string[] {
  const gaps: string[] = [];
  if (/writeFile|appendFile|mkdir|rename\(|unlink\(/.test(source)) {
    gaps.push('The script wrote local files (a baseline or cache under the workflow directory). Exact steps keep no local state between runs; a morning-to-afternoon delta needs either a read of the previous run\'s output or must be dropped.');
  }
  if (/for\s*\(.*\bof\b[\s\S]{0,400}?(sf\s|soql|SELECT)/i.test(source) || /Promise\.all\([\s\S]{0,300}?(sf\s|soql|SELECT)/i.test(source)) {
    gaps.push('The script ran a query per record of an earlier result (an attribution or detail loop). Express it as one `forEach` read step over the earlier step\'s records, or drop it.');
  }
  if (/new Date\(|Date\.now\(|toISOString\(/.test(source)) {
    gaps.push('The script computed dates at run time. SOQL date literals (TODAY, THIS_WEEK, N_DAYS_AGO:n) cover most cases; anything else is a declared input.');
  }
  if (/fetch\(|https?:\/\//.test(source)) {
    gaps.push('The script called an HTTP endpoint directly. Find the exact provider operation with tool_search or keep that part on the legacy runner.');
  }
  return gaps;
}

function outputKeysOf(step: WorkflowStepInput): string[] {
  const keys = step.output?.required_keys ?? [];
  return keys.length > 0 ? keys : ['summary'];
}

function referencesRunner(value: unknown, runnerStepId: string): boolean {
  return typeof value === 'string' && value.includes(`steps.${runnerStepId}.output`);
}

function repoint(value: unknown, runnerStepId: string, renderStepId: string): unknown {
  if (typeof value === 'string') return value.split(`steps.${runnerStepId}.output`).join(`steps.${renderStepId}.output`);
  if (Array.isArray(value)) return value.map((item) => repoint(item, runnerStepId, renderStepId));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, inner]) => [key, repoint(inner, runnerStepId, renderStepId)]));
  }
  return value;
}

/**
 * Draft exact steps for one legacy runner step from the runner's source.
 * Returns ok:false with an empty reads list when the source has no SOQL the
 * extractor recognises — then the legacy runner stays the right lane.
 */
export function draftRunnerMigration(input: {
  definition: WorkflowDefinition;
  runnerStepId: string;
  runnerSource: string;
  /** The Salesforce target org, normally `resources.salesforce_org.account`. */
  targetOrg?: string;
}): RunnerMigrationDraft {
  const { definition, runnerStepId, runnerSource } = input;
  const steps = definition.steps ?? [];
  const runnerStep = steps.find((step) => step.id === runnerStepId);
  const gaps = gapsIn(runnerSource);
  if (!runnerStep) {
    return { ok: false, definition, reads: [], gaps: [`step "${runnerStepId}" is not in the definition`, ...gaps] };
  }
  const targetOrg = input.targetOrg
    ?? Object.values(definition.resources ?? {}).find((resource) => resource.cli === 'sf' && resource.account)?.account;

  const arrays = literalStringArrays(runnerSource);
  const quotedLists = derivedQuotedLists(runnerSource, arrays);
  const taken = new Set(steps.map((step) => step.id));
  const inputs: Record<string, WorkflowInputDef> = { ...(definition.inputs ?? {}) };
  const reads: RunnerMigrationRead[] = [];
  const readSteps: WorkflowStepInput[] = [];
  const seenQueries = new Set<string>();
  let index = 0;
  for (const match of runnerSource.matchAll(SOQL_LITERAL)) {
    const raw = match[2]!.replace(/\s+/g, ' ').trim();
    if (!/\bFROM\s+[A-Za-z_]/.test(raw) || seenQueries.has(raw)) continue;
    seenQueries.add(raw);
    const unresolved: string[] = [];
    const query = raw.replace(PLACEHOLDER, (_whole, name: string) => {
      const list = quotedLists.get(name);
      if (list) return list;
      unresolved.push(name);
      inputs[name] = inputs[name] ?? {
        type: 'string',
        required: true,
        description: `Was computed inside the legacy runner as \`${name}\`; supply the literal the query needs.`,
      };
      return `{{input.${name}}}`;
    });
    const stepId = stepIdFor(query, index, taken);
    index += 1;
    reads.push({ stepId, query, unresolved });
    readSteps.push({
      id: stepId,
      prompt: '',
      sideEffect: 'read',
      call: {
        tool: SALESFORCE_SOQL_READ_TOOL,
        args: { ...(targetOrg ? { target_org: targetOrg } : {}), query },
      },
      output: { type: 'object', required_keys: ['stdout'], non_empty: ['stdout'] },
    });
  }
  if (reads.length === 0) {
    return { ok: false, definition, reads, gaps: ['No SOQL read was recognised in the runner source.', ...gaps] };
  }

  const packageId = taken.has('package_records') ? `package_${runnerStepId}` : 'package_records';
  taken.add(packageId);
  const packageExpression: WorkflowTransformExpressionV1 = {
    op: 'jsonStringify',
    value: {
      op: 'object',
      fields: [
        { key: 'version', value: { op: 'literal', value: 1 } },
        ...readSteps.map((step) => ({
          key: step.id,
          value: { op: 'jsonParse', value: { op: 'get', from: `steps.${step.id}.output.stdout` } },
        })),
      ],
    },
  } as WorkflowTransformExpressionV1;
  const packageStep: WorkflowStepInput = {
    id: packageId,
    prompt: '',
    dependsOn: readSteps.map((step) => step.id),
    sideEffect: 'read',
    transform: { version: 1, expression: packageExpression },
    output: { type: 'string', non_empty: [''] },
  };

  const renderId = taken.has('render_summary') ? `render_${runnerStepId}` : 'render_summary';
  taken.add(renderId);
  const outputKeys = outputKeysOf(runnerStep);
  const format = renderedFormatLines(runnerSource);
  const renderStep: WorkflowStepInput = {
    id: renderId,
    prompt: [
      `Render the fields ${outputKeys.map((key) => `"${key}"`).join(', ')} from the packaged records below. Use ONLY these records; never invent, estimate, or carry over values. Zero rows is a real, valid result.`,
      '',
      'Packaged records (JSON):',
      '',
      `{{steps.${packageId}.output}}`,
      '',
      `Each key of the package is one read's \`result.records\` array as the Salesforce CLI returned it (${readSteps.map((step) => step.id).join(', ')}).`,
      ...(format.length > 0
        ? ['', 'The legacy runner rendered its output with these lines, in this order; reproduce the same shape and section order:', ...format.map((line) => `- ${line}`)]
        : []),
      '',
      `Return exactly one JSON object with the keys ${outputKeys.map((key) => `"${key}"`).join(', ')}.`,
    ].join('\n'),
    dependsOn: [packageId],
    maxTurns: 2,
    allowedTools: [],
    sideEffect: 'read',
    output: { type: 'object', required_keys: outputKeys, non_empty: outputKeys },
  };

  const migratedSteps: WorkflowStepInput[] = [];
  for (const step of steps) {
    if (step.id === runnerStepId) {
      migratedSteps.push(...readSteps, packageStep, renderStep);
      continue;
    }
    const dependsOn = (step.dependsOn ?? []).map((dep) => (dep === runnerStepId ? renderId : dep));
    const repointed = repoint({ ...step, ...(dependsOn.length > 0 ? { dependsOn } : {}) }, runnerStepId, renderId) as WorkflowStepInput;
    migratedSteps.push(repointed);
  }
  const stillReferenced = migratedSteps.some((step) => referencesRunner(JSON.stringify(step), runnerStepId));
  if (stillReferenced) gaps.push(`A step still references steps.${runnerStepId}.output after repointing; check it by hand.`);

  return {
    ok: true,
    definition: {
      ...definition,
      ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
      steps: migratedSteps,
    },
    reads,
    gaps,
    renderStepId: renderId,
  };
}
