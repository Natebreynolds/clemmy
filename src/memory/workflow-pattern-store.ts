import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { BASE_DIR } from '../config.js';
import { recordToolEvent } from '../agents/tool-observability.js';
import { slugifyIntent } from './tool-choice-store.js';
import type { WorkflowAllowedTool, WorkflowDefinition, WorkflowStepInput } from './workflow-store.js';

const PATTERN_ROOT = path.join(BASE_DIR, 'memory', 'workflow-patterns');

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into',
  'is', 'it', 'of', 'on', 'or', 'the', 'this', 'to', 'with', 'workflow', 'run',
]);

export interface WorkflowPatternStep {
  id: string;
  mode: 'deterministic' | 'foreach' | 'llm';
  intent?: string;
  sideEffect?: WorkflowStepInput['sideEffect'];
  usesSkill?: string;
}

export interface WorkflowPatternRecord {
  objective: string;
  workflowName: string;
  workflowSlug: string;
  successCount: number;
  lastRunId: string;
  lastSuccessAt: string;
  tools: string[];
  steps: WorkflowPatternStep[];
  evidence?: string;
  /** Quality signal: how many times this workflow later NEEDED ATTENTION. A
   *  pattern is only recalled while it stays healthy (net-positive + latest
   *  outcome clean), so a once-good workflow that starts failing stops being
   *  handed out as a confident hint. */
  failureCount?: number;
  lastFailureAt?: string;
  body: string;
  filePath: string;
}

export interface WorkflowPatternMatch {
  record: WorkflowPatternRecord;
  score: number;
}

function ensurePatternRoot(): void {
  if (!existsSync(PATTERN_ROOT)) mkdirSync(PATTERN_ROOT, { recursive: true });
}

function patternPathFor(objective: string): string {
  const slug = slugifyIntent(objective) || 'workflow-pattern';
  return path.join(PATTERN_ROOT, `${slug}.md`);
}

function compactText(value: string, maxChars: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function tokens(value: string): Set<string> {
  return new Set(
    slugifyIntent(value)
      .split(/[._\-/]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
  );
}

function overlap(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  return shared / Math.max(left.size, right.size);
}

function parseTools(tools: WorkflowAllowedTool[] | undefined): string[] {
  return (tools ?? [])
    .flatMap((tool) => {
      if (typeof tool === 'string') return [tool];
      if (tool && typeof tool.name === 'string') return [tool.name];
      return [];
    })
    .filter((tool) => tool.trim().length > 0);
}

function summarizeStep(step: WorkflowStepInput): WorkflowPatternStep {
  return {
    id: step.id,
    mode: step.deterministic?.runner ? 'deterministic' : step.forEach ? 'foreach' : 'llm',
    ...(step.intent ? { intent: step.intent } : {}),
    ...(step.sideEffect ? { sideEffect: step.sideEffect } : {}),
    ...(step.usesSkill ? { usesSkill: step.usesSkill } : {}),
  };
}

function extractWorkflowTools(workflow: WorkflowDefinition): string[] {
  const tools = new Set<string>();
  for (const tool of parseTools(workflow.allowedTools)) tools.add(tool);
  for (const step of workflow.steps ?? []) {
    for (const tool of step.allowedTools ?? []) tools.add(tool);
    if (step.deterministic?.runner) tools.add(`script:${step.deterministic.runner}`);
    if (step.usesSkill) tools.add(`skill:${step.usesSkill}`);
  }
  return Array.from(tools).sort();
}

function parsePattern(filePath: string): WorkflowPatternRecord | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = matter(readFileSync(filePath, 'utf-8'));
    const fm = parsed.data as Record<string, unknown>;
    const objective = typeof fm.objective === 'string' ? fm.objective : path.basename(filePath, '.md');
    const workflowName = typeof fm.workflowName === 'string' ? fm.workflowName : objective;
    const workflowSlug = typeof fm.workflowSlug === 'string' ? fm.workflowSlug : slugifyIntent(workflowName);
    const steps = Array.isArray(fm.steps)
      ? fm.steps
          .filter((step): step is Record<string, unknown> => !!step && typeof step === 'object')
          .map((step) => {
            const mode: WorkflowPatternStep['mode'] =
              step.mode === 'deterministic' || step.mode === 'foreach' ? step.mode : 'llm';
            const sideEffect: WorkflowPatternStep['sideEffect'] =
              step.sideEffect === 'read' || step.sideEffect === 'write' || step.sideEffect === 'send'
                ? step.sideEffect
                : undefined;
            return {
              id: typeof step.id === 'string' ? step.id : '?',
              mode,
              ...(typeof step.intent === 'string' ? { intent: step.intent } : {}),
              ...(sideEffect ? { sideEffect } : {}),
              ...(typeof step.usesSkill === 'string' ? { usesSkill: step.usesSkill } : {}),
            };
          })
      : [];
    return {
      objective,
      workflowName,
      workflowSlug,
      successCount: typeof fm.successCount === 'number' && Number.isFinite(fm.successCount) ? fm.successCount : 0,
      lastRunId: typeof fm.lastRunId === 'string' ? fm.lastRunId : '',
      lastSuccessAt: typeof fm.lastSuccessAt === 'string' ? fm.lastSuccessAt : '',
      tools: Array.isArray(fm.tools) ? fm.tools.filter((tool): tool is string => typeof tool === 'string') : [],
      steps,
      evidence: typeof fm.evidence === 'string' ? fm.evidence : undefined,
      failureCount: typeof fm.failureCount === 'number' && Number.isFinite(fm.failureCount) ? fm.failureCount : undefined,
      lastFailureAt: typeof fm.lastFailureAt === 'string' ? fm.lastFailureAt : undefined,
      body: parsed.content ?? '',
      filePath,
    };
  } catch {
    return null;
  }
}

function writePattern(record: WorkflowPatternRecord): WorkflowPatternRecord {
  ensurePatternRoot();
  const frontmatter = {
    objective: record.objective,
    workflowName: record.workflowName,
    workflowSlug: record.workflowSlug,
    successCount: record.successCount,
    lastRunId: record.lastRunId,
    lastSuccessAt: record.lastSuccessAt,
    tools: record.tools,
    steps: record.steps,
    ...(record.evidence ? { evidence: record.evidence } : {}),
    ...(record.failureCount ? { failureCount: record.failureCount } : {}),
    ...(record.lastFailureAt ? { lastFailureAt: record.lastFailureAt } : {}),
  };
  writeFileSync(record.filePath, matter.stringify(record.body, frontmatter), 'utf-8');
  return record;
}

function emitPatternEvent(action: string, objective: string, outcome: 'success' | 'cancelled' = 'success'): void {
  recordToolEvent({
    at: new Date().toISOString(),
    toolName: 'workflow_pattern',
    kind: 'read',
    phase: outcome === 'success' ? 'end' : 'error',
    outcome,
    argsSummary: `action=${action} objective=${compactText(objective, 120)}`,
  });
}

export function recordSuccessfulWorkflowPattern(input: {
  workflow: WorkflowDefinition;
  workflowSlug: string;
  runId: string;
  finalOutput: string;
}): WorkflowPatternRecord | null {
  const objective = compactText(input.workflow.description || input.workflow.name, 160);
  if (!objective) return null;
  const filePath = patternPathFor(objective);
  const existing = parsePattern(filePath);
  const now = new Date().toISOString();
  const evidence = compactText(input.finalOutput, 800);
  const record: WorkflowPatternRecord = {
    objective,
    workflowName: input.workflow.name,
    workflowSlug: input.workflowSlug,
    successCount: (existing?.successCount ?? 0) + 1,
    lastRunId: input.runId,
    lastSuccessAt: now,
    tools: extractWorkflowTools(input.workflow),
    steps: (input.workflow.steps ?? []).map(summarizeStep),
    evidence,
    // preserve the quality signal across updates (a clean run does NOT erase the
    // failure history — health is net over the pattern's whole life).
    failureCount: existing?.failureCount,
    lastFailureAt: existing?.lastFailureAt,
    body: [
      `# Workflow pattern - ${input.workflow.name}`,
      '',
      'This file is maintained by Clementine after clean workflow runs. It is used as lightweight procedural recall for similar future workflows.',
      '',
      evidence ? `Latest evidence: ${evidence}` : '',
      '',
    ].filter(Boolean).join('\n'),
    filePath,
  };
  const saved = writePattern(record);
  emitPatternEvent('remember', objective);
  return saved;
}

/**
 * Record that a workflow run NEEDED ATTENTION (failed / blocked). Bumps the
 * pattern's failure signal so an unreliable workflow stops being recalled as a
 * confident hint. Creates no pattern if none exists yet (we only track health
 * for workflows that have at least one learned success). Best-effort.
 */
export function recordFailedWorkflowPattern(input: { workflow: WorkflowDefinition; workflowSlug: string }): WorkflowPatternRecord | null {
  const objective = compactText(input.workflow.description || input.workflow.name, 160);
  if (!objective) return null;
  const existing = parsePattern(patternPathFor(objective));
  if (!existing) return null; // nothing learned yet → nothing to penalize
  const updated: WorkflowPatternRecord = {
    ...existing,
    failureCount: (existing.failureCount ?? 0) + 1,
    lastFailureAt: new Date().toISOString(),
  };
  return writePattern(updated);
}

/**
 * A pattern is worth recalling only while it stays reliable: it has at least one
 * clean run, its successes outnumber its failures, and its MOST RECENT outcome
 * was clean (not a more-recent failure). A once-good workflow that starts
 * failing therefore drops out of recall until it succeeds again — the fix for
 * "a since-degraded pattern keeps getting handed out as a confident hint".
 * Pure + exported for tests.
 */
export function isPatternHealthy(record: WorkflowPatternRecord): boolean {
  const successes = record.successCount ?? 0;
  const failures = record.failureCount ?? 0;
  if (successes <= 0) return false;
  if (failures >= successes) return false;
  if (record.lastFailureAt && record.lastFailureAt > (record.lastSuccessAt ?? '')) return false;
  return true;
}

export function listWorkflowPatterns(): WorkflowPatternRecord[] {
  if (!existsSync(PATTERN_ROOT)) return [];
  return readdirSync(PATTERN_ROOT)
    .filter((file) => file.endsWith('.md'))
    .map((file) => parsePattern(path.join(PATTERN_ROOT, file)))
    .filter((record): record is WorkflowPatternRecord => record !== null)
    .sort((left, right) => right.lastSuccessAt.localeCompare(left.lastSuccessAt));
}

export function recallWorkflowPatterns(query: string, limit = 3): WorkflowPatternMatch[] {
  const queryTokens = tokens(query);
  const matches = listWorkflowPatterns()
    .filter(isPatternHealthy) // quality gate: never recall a since-degraded pattern
    .map((record) => ({
      record,
      score: Math.max(
        overlap(queryTokens, tokens(record.objective)),
        overlap(queryTokens, tokens(record.workflowName)),
      ),
    }))
    .filter((match) => match.score >= 0.25)
    // tiebreak by RECENCY (last clean run), not raw count — a stale pattern
    // decays behind a more-recently-proven one of equal match.
    .sort((left, right) => right.score - left.score || right.record.lastSuccessAt.localeCompare(left.record.lastSuccessAt))
    .slice(0, Math.max(0, limit));
  emitPatternEvent(matches.length > 0 ? 'recall_hit' : 'recall_miss', query, matches.length > 0 ? 'success' : 'cancelled');
  return matches;
}

export function renderWorkflowPatternHint(matches: WorkflowPatternMatch[]): string {
  if (matches.length === 0) return '';
  const lines = [
    '=== LEARNED WORKFLOW PATTERNS ===',
    'Similar prior successful workflows. Use these as procedural hints only; explicit workflow instructions and current inputs win.',
  ];
  for (const { record, score } of matches.slice(0, 3)) {
    const tools = record.tools.slice(0, 8).join(', ') || 'no specific tools recorded';
    const steps = record.steps
      .slice(0, 8)
      .map((step) => `${step.id}:${step.mode}${step.intent ? `:${step.intent}` : ''}`)
      .join(', ');
    lines.push(
      `- ${record.workflowName} (${record.successCount} clean run${record.successCount === 1 ? '' : 's'}, match ${Math.round(score * 100)}%): tools [${tools}]; steps [${steps || 'none recorded'}].`,
    );
    if (record.evidence) lines.push(`  Evidence: ${record.evidence.slice(0, 220)}`);
  }
  lines.push('=== END LEARNED WORKFLOW PATTERNS ===');
  return lines.join('\n');
}
