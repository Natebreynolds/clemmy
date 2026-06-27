export type GoalDraftConfidence = 'low' | 'medium' | 'high';

export interface GoalDraftInput {
  notes: string;
  desiredOutcome?: string;
}

export interface GoalDraft {
  objective: string;
  successCriteria: string[];
  nextActions: string[];
  risks: string[];
  missingInputs: string[];
  rationale: string;
  confidence: GoalDraftConfidence;
  sourceLines: string[];
}

const OBJECTIVE_RE = /\b(goal|objective|outcome|target|north star|aim|increase|decrease|reduce|improve|grow|launch|deliver|create|finish|complete|ship|expand|retain|automate|cut|raise|lower|move|achieve)\b/i;
const STRONG_OBJECTIVE_RE = /\b(goal|objective|outcome|target|north star|aim)\b/i;
const CRITERIA_RE = /\b(success|successful|done when|metric|kpi|baseline|target|measure|measured|verify|verified|prove|validated|validation|increase|decrease|reduce|improve|grow|lift|percent|%|rate|count|threshold|quality|by\s+\w+|\d+(?:\.\d+)?)\b/i;
const ACTION_RE = /\b(next action|next step|action|todo|to do|follow up|need to|needs to|must|should|ask|review|audit|draft|create|build|connect|collect|find|prepare|send|schedule|publish|research|write|update|document|confirm|clarify)\b/i;
const RISK_RE = /\b(risk|blocker|blocked|missing|depends|dependency|constraint|concern|access|approval|legal|compliance|budget|deadline|unknown|unclear|waiting|permission|credential|login|source)\b/i;
const METRIC_RE = /\b(metric|kpi|baseline|target|measure|conversion|growth|revenue|pipeline|cost|quality|accuracy|count|rate|percent|%)\b/i;
const TIMEBOX_RE = /\b(deadline|due|cadence|review cadence|weekly|daily|monthly|quarterly|tomorrow|today|within|by\s+\w+|over the next|next\s+\d+|\d+\s+(day|week|month|quarter|hour)s?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})\b/i;
const APPROVAL_RE = /\b(approve|approval|review|sign[- ]?off|human|decision|before sending|before publishing|permission)\b/i;
const ACCESS_RE = /\b(access|account|login|credential|data source|source data|analytics|crm|sheet|file|repo|document|inbox|calendar|system)\b/i;

function compact(value: string, max = 220): string {
  const line = value
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+\n/g, '\n')
    .trim();
  if (line.length <= max) return line;
  return `${line.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function stripLabel(value: string): string {
  return value
    .replace(/^\s*(?:[-*]|\d+[.)])\s*/, '')
    .replace(/^\s*(?:notes?|meeting|context|background|owner|vision|goal|objective|outcome|target|success|criteria|metric|kpi|todo|to do|next action|next|action|risk|blocker|constraint|deadline|cadence|approval|review)\s*[:=-]\s*/i, '')
    .trim();
}

function normalizeLine(value: string): string {
  return compact(stripLabel(value.replace(/\s+/g, ' ')));
}

function splitNotes(notes: string): string[] {
  const rawLines = notes
    .replace(/\r\n/g, '\n')
    .split(/\n+/)
    .map(normalizeLine)
    .filter((line) => line.length >= 3);

  const expanded = rawLines.length <= 2
    ? rawLines.flatMap((line) => line.split(/(?<=[.!?])\s+|;\s+/).map(normalizeLine))
    : rawLines;

  return unique(expanded.filter((line) => line.length >= 3), 18);
}

function unique(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = compact(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function scoreObjective(line: string): number {
  let score = 0;
  if (STRONG_OBJECTIVE_RE.test(line)) score += 4;
  if (OBJECTIVE_RE.test(line)) score += 3;
  if (/\b\d+(?:\.\d+)?\s*%|\b\d+(?:\.\d+)?\b/.test(line)) score += 1;
  if (TIMEBOX_RE.test(line)) score += 1;
  if (ACTION_RE.test(line)) score -= 1;
  if (RISK_RE.test(line)) score -= 1;
  if (line.endsWith('?')) score -= 2;
  return score;
}

function chooseObjective(lines: string[], desiredOutcome?: string): { objective: string; explicit: boolean } {
  const desired = typeof desiredOutcome === 'string' ? normalizeLine(desiredOutcome) : '';
  if (desired) return { objective: desired, explicit: true };

  const ranked = lines
    .map((line) => ({ line, score: scoreObjective(line) }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0];
  if (top && top.score > 0) return { objective: top.line, explicit: STRONG_OBJECTIVE_RE.test(top.line) || top.score >= 5 };
  if (lines[0]) return { objective: lines[0], explicit: false };
  return { objective: 'Turn these notes into a measurable outcome.', explicit: false };
}

function collect(lines: string[], pattern: RegExp, limit: number, exclude?: RegExp): string[] {
  return unique(
    lines
      .filter((line) => pattern.test(line) && (!exclude || !exclude.test(line)))
      .map((line) => normalizeLine(line)),
    limit,
  );
}

function ensureMinimum(values: string[], fallback: string[], limit: number, min: number): string[] {
  const out = unique(values, limit);
  for (const item of fallback) {
    if (out.length >= min) break;
    if (!out.some((existing) => existing.toLowerCase() === item.toLowerCase())) out.push(item);
  }
  return out.slice(0, limit);
}

function buildMissingInputs(notes: string): string[] {
  const haystack = notes;
  const missing: string[] = [];
  if (!METRIC_RE.test(haystack)) missing.push('Target metric, baseline, or success threshold');
  if (!TIMEBOX_RE.test(haystack)) missing.push('Deadline or review cadence');
  if (!ACCESS_RE.test(haystack)) missing.push('Required accounts, data sources, or workspace access');
  if (!APPROVAL_RE.test(haystack)) missing.push('Human review or approval rules');
  return missing.slice(0, 4);
}

function confidenceFor(input: {
  lineCount: number;
  explicitObjective: boolean;
  criteria: string[];
  actions: string[];
  risks: string[];
  missing: string[];
}): GoalDraftConfidence {
  let score = 0;
  if (input.explicitObjective) score += 2;
  if (input.lineCount >= 3) score += 1;
  if (input.criteria.length >= 2) score += 1;
  if (input.actions.length >= 2) score += 1;
  if (input.risks.length > 0) score += 1;
  if (input.missing.length <= 1) score += 1;
  if (input.lineCount <= 1 && input.missing.length >= 3) return 'low';
  if (score >= 5) return 'high';
  if (score >= 3) return 'medium';
  return 'low';
}

export function draftGoalFromNotes(input: GoalDraftInput): GoalDraft {
  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  const lines = splitNotes(notes);
  const chosen = chooseObjective(lines, input.desiredOutcome);
  const criteria = ensureMinimum(
    collect(lines, CRITERIA_RE, 6),
    [
      'Baseline and current constraints are captured.',
      'A measurable target and review cadence are approved.',
      'Progress is reviewed with evidence before the goal is marked done.',
    ],
    6,
    3,
  );
  const nextActions = ensureMinimum(
    collect(lines, ACTION_RE, 6, RISK_RE),
    [
      'Clarify owner, target audience, constraints, and decision rules.',
      'Capture the current baseline and available evidence.',
      'Draft the first execution plan for review.',
    ],
    6,
    3,
  );
  const risks = ensureMinimum(
    collect(lines, RISK_RE, 5),
    ['Success depends on access to the current baseline and source evidence.'],
    5,
    1,
  );
  const missingInputs = buildMissingInputs(notes);
  const confidence = confidenceFor({
    lineCount: lines.length,
    explicitObjective: chosen.explicit,
    criteria,
    actions: nextActions,
    risks,
    missing: missingInputs,
  });
  const sourceLines = unique(
    [
      chosen.objective,
      ...criteria.filter((item) => lines.includes(item)),
      ...nextActions.filter((item) => lines.includes(item)),
      ...risks.filter((item) => lines.includes(item)),
    ],
    6,
  );

  return {
    objective: compact(chosen.objective, 260),
    successCriteria: criteria,
    nextActions,
    risks,
    missingInputs,
    rationale: compact(`Drafted from ${lines.length || 1} note line${lines.length === 1 ? '' : 's'} with ${missingInputs.length} missing input${missingInputs.length === 1 ? '' : 's'} flagged for review.`, 220),
    confidence,
    sourceLines,
  };
}
