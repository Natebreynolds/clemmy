/**
 * What a workflow run's completed steps actually changed, read from the durable
 * settlement ledger.
 *
 * These are structural facts, never a verdict on the goal: a write the ledger
 * settled as landed stays landed whatever a reviewer later says about the
 * run's content, and whether the goal is met stays the goal reviewer's call.
 * The runner uses the facts only to decide what may run again:
 *
 *  - a step whose every landed write declares that repeating it adds no write
 *    (a content-addressed local write, or an author's `loopSafe`) may re-run;
 *  - a model-driven step whose writes landed may be asked to re-check and do
 *    only what is missing, with those writes listed as done;
 *  - a send, an approval-gated step, and a write the ledger cannot see are
 *    never run again automatically;
 *  - an unresolved write (open call, dispatch without a verdict, uncertain
 *    settlement) is not a landed fact and keeps the existing reconciliation
 *    path.
 */
import { openEventLog } from '../runtime/harness/eventlog.js';
import { TOOL_REGISTRY } from '../tools/tool-registry.js';
import type { WorkflowStepInput } from '../memory/workflow-store.js';

export type WorkflowStepWriteDisposition =
  /** Nothing this step did needs protecting from a repeat. */
  | 'none'
  /** Its writes landed, and each declares that a repeat adds no write. */
  | 'repeat_safe'
  /** Its writes landed and a repeat could add another. */
  | 'landed'
  /** A send or approval-gated step: never repeated without a person. */
  | 'sent'
  /** A write whose outcome is not settled. Not a landed fact. */
  | 'uncertain';

export interface WorkflowLandedWrite {
  stepId: string;
  sessionId: string;
  logicalCallId: string;
  tool: string;
  /** The tool's declared contract says an exact repeat adds no write. */
  repeatSafe: boolean;
  /** Destination identities the write's own reservation recorded. */
  targets: string[];
}

/** One completed step's ledger, as rows the classifier can read. */
export interface WorkflowStepLedgerFacts {
  landed: WorkflowLandedWrite[];
  /** Calls still open, dispatches without a verdict, or mutating settlements
   *  that ended uncertain. */
  unresolved: number;
}

export interface WorkflowStepWriteFacts extends WorkflowStepLedgerFacts {
  stepId: string;
  disposition: WorkflowStepWriteDisposition;
  /** A completed step whose writes happen outside the ledger's view. Its
   *  declared writes are taken as landed, never as absent. */
  landedUnobserved: boolean;
  /** A model carries this step out, so it can be asked to re-check and do
   *  only what is missing. */
  modelDriven: boolean;
  /** Inherited as completed from this earlier run, where its writes landed. */
  carriedFromRunId?: string;
}

export interface WorkflowRunWriteFacts {
  /** False when the ledger could not be read; callers keep today's rules. */
  available: boolean;
  steps: WorkflowStepWriteFacts[];
}

/** A step no model carries out: an exact call, a transform, a script. */
export function workflowStepIsModelDriven(step: WorkflowStepInput): boolean {
  return step.call === undefined
    && step.transform === undefined
    && step.deterministic === undefined
    && step.invocationPlan === undefined
    && step.subgraph === undefined;
}

/** The ledger sees every tool call a model-driven or exact-call step makes. A
 *  script's own I/O is outside it. */
function workflowStepWritesAreObservable(step: WorkflowStepInput): boolean {
  return step.deterministic === undefined;
}

/** The tool registry's declared contract: an exact replay of the same content
 *  reuses the committed revision and adds no write. */
export function toolDeclaresRepeatAddsNoWrite(toolName: string): boolean {
  const entry = TOOL_REGISTRY.find((tool) => tool.name === toolName);
  return entry?.localExecution?.idempotency === 'content_addressed';
}

/**
 * Classify one COMPLETED step from its declared class and its own ledger.
 * Pure: the caller supplies the ledger rows and the step's declared side-effect
 * class (the runner's canonical classifier).
 */
export function classifyWorkflowStepWrites(
  step: WorkflowStepInput,
  sideEffect: 'read' | 'write' | 'send',
  ledger: WorkflowStepLedgerFacts,
): Omit<WorkflowStepWriteFacts, 'landed' | 'unresolved' | 'stepId'> {
  const modelDriven = workflowStepIsModelDriven(step);
  const observable = workflowStepWritesAreObservable(step);
  if (ledger.unresolved > 0) {
    return { disposition: 'uncertain', landedUnobserved: false, modelDriven };
  }
  if (sideEffect === 'send' || step.requiresApproval === true) {
    return {
      disposition: 'sent',
      landedUnobserved: !observable,
      modelDriven,
    };
  }
  if (sideEffect === 'read') {
    // A read step keeps its existing repeat law; what it touched on the way is
    // not a delivered write this decision protects.
    return { disposition: 'none', landedUnobserved: false, modelDriven };
  }
  if (!observable) {
    return {
      disposition: step.loopSafe === true ? 'repeat_safe' : 'landed',
      landedUnobserved: true,
      modelDriven,
    };
  }
  if (ledger.landed.length === 0) {
    return { disposition: 'none', landedUnobserved: false, modelDriven };
  }
  const repeatSafe = step.loopSafe === true || ledger.landed.every((write) => write.repeatSafe);
  return { disposition: repeatSafe ? 'repeat_safe' : 'landed', landedUnobserved: false, modelDriven };
}

/** True when this step changed something that stays changed. */
export function workflowStepLandedWrites(facts: WorkflowStepWriteFacts): boolean {
  if (facts.disposition === 'uncertain' || facts.disposition === 'none') return false;
  return facts.landed.length > 0 || facts.landedUnobserved;
}

interface SettlementRow {
  sessionId: string;
  callId: string;
  tool: string;
}

/**
 * Read the ledger facts for every completed step of one run. Read-only; an
 * unreadable ledger reports `available: false` so the caller keeps the
 * conservative declared-class rules.
 */
export function readWorkflowRunWriteFacts(input: {
  runId: string;
  steps: WorkflowStepInput[];
  completedStepIds: ReadonlySet<string>;
  sideEffectOf: (step: WorkflowStepInput) => 'read' | 'write' | 'send';
}): WorkflowRunWriteFacts {
  try {
    const db = openEventLog();
    const landedQuery = db.prepare(`
      SELECT s.session_id AS sessionId, s.logical_tool_call_id AS callId, l.tool_name AS tool
        FROM logical_call_settlements s
        JOIN logical_tool_calls l ON l.session_id = s.session_id
         AND l.source_user_seq = s.source_user_seq AND l.logical_tool_call_id = s.logical_tool_call_id
       WHERE (s.session_id = ? OR substr(s.session_id, 1, ?) = ?)
         AND s.mutating = 1
         AND s.execution_kind IN ('local_execution', 'provider_execution')
         AND s.outcome_kind IN ('succeeded', 'empty_result')
       ORDER BY s.rowid
    `);
    const unresolvedQuery = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM logical_call_settlements
          WHERE (session_id = ? OR substr(session_id, 1, ?) = ?)
            AND mutating = 1
            AND (outcome_kind = 'uncertain_write' OR requires_reconciliation = 1)) AS uncertain,
        (SELECT COUNT(*) FROM logical_tool_calls
          WHERE (session_id = ? OR substr(session_id, 1, ?) = ?) AND state = 'open') AS open,
        (SELECT COUNT(*) FROM physical_dispatches
          WHERE (session_id = ? OR substr(session_id, 1, ?) = ?) AND state IN ('started', 'unknown')) AS unsettled
    `);
    const targetsQuery = db.prepare(`
      SELECT json_extract(data_json, '$.targets') AS targets
        FROM events
       WHERE session_id = ? AND type = 'external_write'
         AND COALESCE(json_extract(data_json, '$.canonicalCallId'), json_extract(data_json, '$.callId')) = ?
       ORDER BY seq DESC LIMIT 1
    `);
    const steps: WorkflowStepWriteFacts[] = [];
    for (const step of input.steps) {
      if (!input.completedStepIds.has(step.id)) continue;
      const exact = `workflow:${input.runId}:${step.id}`;
      const childPrefix = `${exact}:`;
      const scope = [exact, childPrefix.length, childPrefix] as const;
      const rows = landedQuery.all(...scope) as SettlementRow[];
      const counts = unresolvedQuery.get(...scope, ...scope, ...scope) as
        { uncertain?: number; open?: number; unsettled?: number } | undefined;
      const landed: WorkflowLandedWrite[] = rows.map((row) => {
        let targets: string[] = [];
        try {
          const raw = (targetsQuery.get(row.sessionId, row.callId) as { targets?: string | null } | undefined)?.targets;
          const parsed = raw ? JSON.parse(raw) as unknown : [];
          targets = Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string').slice(0, 5) : [];
        } catch { targets = []; }
        return {
          stepId: step.id,
          sessionId: row.sessionId,
          logicalCallId: row.callId,
          tool: row.tool,
          repeatSafe: toolDeclaresRepeatAddsNoWrite(row.tool),
          targets,
        };
      });
      const unresolved = Number(counts?.uncertain ?? 0) + Number(counts?.open ?? 0) + Number(counts?.unsettled ?? 0);
      const ledger = { landed, unresolved };
      steps.push({
        stepId: step.id,
        ...ledger,
        ...classifyWorkflowStepWrites(step, input.sideEffectOf(step), ledger),
      });
    }
    return { available: true, steps };
  } catch {
    return { available: false, steps: [] };
  }
}

/**
 * The lineage a pinned-goal follow-up run carries from the run whose writes
 * landed. Carried steps are inherited as completed with the disposition their
 * landed writes had; continued steps are model-driven steps whose writes
 * landed and which re-run to re-check and do only what is missing.
 */
export interface WorkflowGoalFollowUpLineage {
  fromRunId: string;
  carriedSteps: Array<{ stepId: string; disposition: 'landed' | 'sent' }>;
  continuedStepIds: string[];
}

const STEP_ID_RE = /^[\w.-]{1,200}$/;
const RUN_ID_RE = /^[a-zA-Z0-9_.:-]{1,200}$/;

export function normalizeWorkflowGoalFollowUpLineage(value: unknown): WorkflowGoalFollowUpLineage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const fromRunId = typeof row.fromRunId === 'string' ? row.fromRunId.trim() : '';
  if (!RUN_ID_RE.test(fromRunId)) return undefined;
  const carriedSteps: WorkflowGoalFollowUpLineage['carriedSteps'] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(row.carriedSteps) ? row.carriedSteps : []) {
    const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null;
    const stepId = typeof item?.stepId === 'string' ? item.stepId.trim() : '';
    const disposition = item?.disposition === 'landed' || item?.disposition === 'sent' ? item.disposition : null;
    if (!STEP_ID_RE.test(stepId) || !disposition || seen.has(stepId)) return undefined;
    seen.add(stepId);
    carriedSteps.push({ stepId, disposition });
  }
  const continuedStepIds: string[] = [];
  for (const entry of Array.isArray(row.continuedStepIds) ? row.continuedStepIds : []) {
    const stepId = typeof entry === 'string' ? entry.trim() : '';
    if (!STEP_ID_RE.test(stepId) || seen.has(stepId)) return undefined;
    seen.add(stepId);
    continuedStepIds.push(stepId);
  }
  return { fromRunId, carriedSteps, continuedStepIds };
}

/**
 * Read a follow-up run's own facts together with its lineage: a carried step
 * landed its writes in the run it was carried from, and a continued step's
 * earlier writes landed there too, so neither ever reads as "nothing landed"
 * because this attempt did not repeat them.
 */
export function applyGoalFollowUpLineage(
  facts: WorkflowRunWriteFacts,
  lineage: WorkflowGoalFollowUpLineage | undefined,
): WorkflowRunWriteFacts {
  if (!lineage || !facts.available) return facts;
  const carried = new Map(lineage.carriedSteps.map((step) => [step.stepId, step.disposition]));
  const continued = new Set(lineage.continuedStepIds);
  return {
    available: true,
    steps: facts.steps.map((step) => {
      const carriedDisposition = carried.get(step.stepId);
      if (carriedDisposition) {
        return {
          ...step,
          landed: [],
          unresolved: 0,
          disposition: carriedDisposition,
          landedUnobserved: true,
          carriedFromRunId: lineage.fromRunId,
        };
      }
      if (continued.has(step.stepId) && (step.disposition === 'none' || step.disposition === 'repeat_safe')) {
        return { ...step, disposition: 'landed', landedUnobserved: true };
      }
      return step;
    }),
  };
}

/** Plain facts for the next attempt's prompt: what earlier runs of this goal
 *  already changed, oldest first. Tool results stay out; only the call
 *  identity and recorded destinations. */
export function renderLandedWritesForFollowUp(
  runs: ReadonlyArray<{ runId: string; facts: WorkflowRunWriteFacts }>,
): string {
  const lines: string[] = [];
  for (const { runId, facts } of runs) {
    for (const step of facts.steps) {
      if (!workflowStepLandedWrites(step)) continue;
      if (step.carriedFromRunId) continue;
      if (step.landed.length === 0) {
        lines.push(`- run ${runId}, step "${step.stepId}": completed its ${step.disposition === 'sent' ? 'send' : 'write'}`);
        continue;
      }
      for (const write of step.landed.slice(0, 12)) {
        const to = write.targets.length > 0 ? ` to ${write.targets.join(', ')}` : '';
        lines.push(`- run ${runId}, step "${step.stepId}": ${write.tool}${to} (call ${write.logicalCallId})`);
      }
      if (step.landed.length > 12) lines.push(`- run ${runId}, step "${step.stepId}": ${step.landed.length - 12} more writes`);
    }
  }
  if (lines.length === 0) return '';
  return [
    'Already done by earlier attempts of this goal (these writes landed and stay as they are; do not repeat them):',
    ...lines,
    'Re-check what the goal review found missing and do only that.',
  ].join('\n');
}
