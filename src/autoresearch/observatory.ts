/**
 * Autoresearch — Foundation layer.
 *
 * Inspired by NousResearch/hermes-agent-self-evolution. This module is
 * pure OBSERVATION. No mutations of any kind. Its job is to walk
 * yesterday's traces, compute per-artifact health signals, and write a
 * single human-readable daily report to:
 *
 *   ~/.clementine-next/vault/00-System/autoresearch/<date>.md
 *
 * The report is also reachable via /api/console/autoresearch/report
 * and rendered in the dashboard's EVOLUTION panel.
 *
 * Why ship this BEFORE any mutation logic: one week of these reports
 * tells us whether mutations are worth building. If wrong-tool calls
 * aren't actually frequent in real traces, we'd be building Phase C
 * blind. Foundation is the eval data for the eval data.
 *
 * Design constraints honored:
 *   - Reads only. Never writes anywhere outside the report file.
 *   - Bounded compute: caps lines parsed per source, total time <2s.
 *   - Skips silently when no data (no error spam).
 *   - Idempotent: same input → same report → no churn.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import { VAULT_DIR } from '../memory/vault.js';
import { openMemoryDb } from '../memory/db.js';

const logger = pino({ name: 'clementine-next.autoresearch.observatory' });

const REPORTS_DIR = path.join(VAULT_DIR, '00-System', 'autoresearch');
const TOOL_EVENTS_DIR = path.join(BASE_DIR, 'state', 'tool-events');
const WORKFLOW_RUNS_DIR = path.join(BASE_DIR, 'workflows', 'runs');

/** Trace event normalized across sources. */
interface ToolEvent {
  at: string;
  sessionId?: string;
  toolName: string;
  phase?: 'start' | 'end' | 'error';
  outcome?: string;
  durationMs?: number;
  errorMessage?: string;
  argsSummary?: string;
  mcp?: boolean;
}

interface WorkflowRunSummary {
  id: string;
  workflow: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  stepCount: number;
  stepErrors: number;
}

/**
 * Per-tool health snapshot computed from a window of trace events.
 * `wrongPickHints` = sessions where this tool was called, returned
 * 0/empty/error, and a different tool was called for the same intent
 * within 60 seconds. That's our "wrong-tool" heuristic — the signal
 * Phase C will use to propose better tool descriptions.
 */
interface ToolHealth {
  toolName: string;
  calls: number;
  successes: number;
  errors: number;
  emptyResults: number;
  wrongPickHints: number;
  avgDurationMs?: number;
  sampleError?: string;
}

interface ReportInput {
  /** Report date — defaults to today's local date. */
  date?: Date;
  /** Look-back window in hours. Default 24 = "yesterday". */
  hoursBack?: number;
}

/**
 * Brain Phase 2 health snapshot. Surfaces the reflection layer's
 * behavior so the user can see whether the new importance-threshold
 * gating + recursive reflection are doing useful work or wasting tokens.
 * All numbers are computed from existing telemetry + the consolidated_facts
 * table — no extra writes.
 */
interface BrainHealth {
  reflectionCounts: {
    success: number;
    cancelledTooShort: number;
    cancelledLowImportance: number;
    cancelledAlreadyReflected: number;
    cancelledDisabled: number;
    extractorFailed: number;
    error: number;
  };
  recursiveReflection: {
    runs: number;
    lastOutcome?: string;
    patternsWrittenTotal: number;
  };
  factImportance: {
    sample: number;
    avg?: number;
    p50?: number;
    p90?: number;
  };
  factDepth: {
    atomic: number;
    depthOne: number;
    depthTwo: number;
  };
}

/**
 * P2 measured-learning-loop snapshot. Computed from the synthetic
 * `tool_choice` events emitted by tool-choice-store. The headline is the
 * recall HIT-RATE: the share of recalls that found a remembered tool
 * (exact or fuzzy) instead of missing and forcing rediscovery. A rising
 * hit-rate week-over-week is the concrete proof of the north-star claim
 * that Clem "gets measurably better at your work."
 */
interface ToolChoiceHealth {
  recalls: number;
  hits: number;        // exact
  fuzzyHits: number;
  misses: number;
  hitRatePct: number;  // (hits + fuzzyHits) / recalls
  remembers: number;
  invalidations: number;
}

export interface ObservatoryReport {
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  toolHealth: ToolHealth[];
  workflowRuns: WorkflowRunSummary[];
  sessionCount: number;
  totalToolCalls: number;
  suggestions: string[];
  brainHealth?: BrainHealth;
  toolChoiceHealth?: ToolChoiceHealth;
}

function loadJsonl(filePath: string, maxLines = 20_000): unknown[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');
  const start = Math.max(0, lines.length - maxLines);
  const out: unknown[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('{')) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* skip */ }
  }
  return out;
}

/** Walk tool-events ndjson files in the window. Files are per-day so we
 *  only need to read today's + yesterday's at most. */
function loadToolEventsInWindow(windowStartMs: number): ToolEvent[] {
  if (!existsSync(TOOL_EVENTS_DIR)) return [];
  // Days to scan: today + yesterday + (defensively) day-before. Three
  // files max; each capped at 20k lines = fast.
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 3600_000);
  const dayBefore = new Date(today.getTime() - 48 * 3600_000);
  const fileDates = [today, yesterday, dayBefore].map((d) => d.toISOString().slice(0, 10));
  const events: ToolEvent[] = [];
  for (const ds of fileDates) {
    const filePath = path.join(TOOL_EVENTS_DIR, `${ds}.ndjson`);
    for (const raw of loadJsonl(filePath)) {
      const e = raw as ToolEvent;
      const t = Date.parse(e.at ?? '');
      if (!Number.isFinite(t) || t < windowStartMs) continue;
      events.push(e);
    }
  }
  return events;
}

/**
 * Wrong-tool heuristic: a session calls tool A → A returns an error /
 * empty result → A DIFFERENT tool is called within 60 seconds for
 * something the agent now correctly handles. We count one "hint" per
 * occurrence on the original tool. False positives are OK — Phase C
 * proposes a variant, the eval set says yea/nay; this metric just
 * drives "where to look first."
 */
function countWrongPickHints(events: ToolEvent[], targetTool: string): number {
  // Build per-session timelines of starts only, sorted by time.
  const bySession = new Map<string, ToolEvent[]>();
  for (const e of events) {
    if (e.phase && e.phase !== 'start') continue;
    const sid = e.sessionId ?? 'unscoped';
    const bucket = bySession.get(sid) ?? [];
    bucket.push(e);
    bySession.set(sid, bucket);
  }
  let hints = 0;
  for (const bucket of bySession.values()) {
    bucket.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
    for (let i = 0; i < bucket.length; i += 1) {
      if (bucket[i].toolName !== targetTool) continue;
      // We need the corresponding 'end' (success/error) for THIS call.
      // The native runtime emits start+end pairs; just look at the next
      // event's outcome OR scan for the matching end.
      const nextDifferentTool = bucket.slice(i + 1).find((e) => e.toolName !== targetTool);
      if (!nextDifferentTool) continue;
      const dtMs = Date.parse(nextDifferentTool.at ?? '') - Date.parse(bucket[i].at ?? '');
      if (!Number.isFinite(dtMs) || dtMs > 60_000) continue;
      // Heuristic: if a DIFFERENT tool runs within 60s, it's at least
      // suspicious. We refine in Phase C by also checking outcome=error.
      hints += 1;
    }
  }
  return hints;
}

// Synthetic telemetry channels emitted as fake tool events (they have a
// dedicated report section, not a real tool). Excluded from the tool-health
// table + totalToolCalls so they don't appear as phantom "tools" or inflate
// counts. tool_choice → computeToolChoiceHealth; reflection/recursive_reflection
// → computeBrainHealth.
const SYNTHETIC_TOOL_EVENTS = new Set(['tool_choice', 'reflection', 'recursive_reflection']);

function computeToolHealth(events: ToolEvent[]): ToolHealth[] {
  // Group by toolName, only consider start-phase events for total count,
  // pair with end-phase events for outcome.
  const byTool = new Map<string, { calls: ToolEvent[]; endsByCallTime: Map<string, ToolEvent> }>();
  for (const e of events) {
    if (SYNTHETIC_TOOL_EVENTS.has(e.toolName)) continue;
    const bucket = byTool.get(e.toolName) ?? { calls: [], endsByCallTime: new Map<string, ToolEvent>() };
    if (e.phase === 'start' || e.phase === undefined) bucket.calls.push(e);
    if (e.phase === 'end' || e.phase === 'error') bucket.endsByCallTime.set(e.at ?? '', e);
    byTool.set(e.toolName, bucket);
  }
  const out: ToolHealth[] = [];
  for (const [toolName, { calls, endsByCallTime }] of byTool.entries()) {
    if (calls.length === 0) continue;
    let successes = 0;
    let errors = 0;
    let emptyResults = 0;
    let totalDur = 0;
    let durSamples = 0;
    let sampleError: string | undefined;
    for (const end of endsByCallTime.values()) {
      if (end.outcome === 'success') successes += 1;
      else if (end.outcome === 'error') {
        errors += 1;
        if (!sampleError && end.errorMessage) sampleError = end.errorMessage.slice(0, 160);
      }
      // The argsSummary on the END row sometimes has "0 results" or
      // similar hints. Cheap pattern check.
      const summary = (end.argsSummary ?? '').toLowerCase();
      if (/\b0\s*(rows|results|items|matches)\b|\bempty\b/.test(summary)) emptyResults += 1;
      if (end.durationMs && end.durationMs > 0) {
        totalDur += end.durationMs;
        durSamples += 1;
      }
    }
    out.push({
      toolName,
      calls: calls.length,
      successes,
      errors,
      emptyResults,
      wrongPickHints: countWrongPickHints(events, toolName),
      avgDurationMs: durSamples > 0 ? Math.round(totalDur / durSamples) : undefined,
      sampleError,
    });
  }
  return out.sort((a, b) => b.calls - a.calls);
}

function loadWorkflowRuns(windowStartMs: number): WorkflowRunSummary[] {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return [];
  const out: WorkflowRunSummary[] = [];
  for (const entry of readdirSync(WORKFLOW_RUNS_DIR)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, entry), 'utf-8')) as Record<string, unknown>;
      const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt : undefined;
      if (!startedAt) continue;
      const startedMs = Date.parse(startedAt);
      if (!Number.isFinite(startedMs) || startedMs < windowStartMs) continue;
      const steps = (raw.stepOutputs ?? {}) as Record<string, unknown>;
      const stepCount = Object.keys(steps).length;
      const stepErrors = Object.values(steps).filter((v) => typeof v === 'string' && /\berror\b|fail/i.test(v)).length;
      out.push({
        id: String(raw.id ?? entry.replace(/\.json$/, '')),
        workflow: String(raw.workflow ?? '?'),
        status: String(raw.status ?? '?'),
        startedAt,
        finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : undefined,
        stepCount,
        stepErrors,
      });
    } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
}

/** Lightweight rule-based suggestions. These are NOT mutations — they're
 *  observations a human can act on. Phase C will replace this with LLM
 *  proposals; today this is a starter list to make the report useful
 *  from day one. */
function generateSuggestions(toolHealth: ToolHealth[]): string[] {
  const suggestions: string[] = [];
  for (const h of toolHealth.slice(0, 30)) {
    if (h.calls < 5) continue;
    const errorRate = h.calls > 0 ? h.errors / h.calls : 0;
    const emptyRate = h.calls > 0 ? h.emptyResults / h.calls : 0;
    const wrongPickRate = h.calls > 0 ? h.wrongPickHints / h.calls : 0;
    if (errorRate >= 0.3) {
      suggestions.push(`\`${h.toolName}\`: ${(errorRate * 100).toFixed(0)}% error rate over ${h.calls} calls${h.sampleError ? ` · sample: "${h.sampleError}"` : ''}. Consider tightening the tool description so the agent only calls it when preconditions are met.`);
    }
    if (emptyRate >= 0.3 && wrongPickRate >= 0.2) {
      suggestions.push(`\`${h.toolName}\`: ${(emptyRate * 100).toFixed(0)}% of calls returned empty + ${(wrongPickRate * 100).toFixed(0)}% wrong-pick hints. Likely the agent is picking this tool when a different one would have data.`);
    }
    if (h.avgDurationMs && h.avgDurationMs > 8000 && h.calls >= 10) {
      suggestions.push(`\`${h.toolName}\`: avg ${(h.avgDurationMs / 1000).toFixed(1)}s over ${h.calls} calls. Slow tools become a UX problem when the agent uses them speculatively.`);
    }
  }
  if (suggestions.length === 0) {
    suggestions.push('No standout patterns in this window — tools are healthy.');
  }
  return suggestions;
}

/**
 * Brain Phase 2 health metrics. Pulls reflection-event counts from the
 * 24h window's ndjson + queries the consolidated_facts table for
 * importance + depth distribution. Pure read; null-safe in environments
 * where the DB hasn't initialized.
 */
function computeBrainHealth(events: ToolEvent[]): BrainHealth | undefined {
  const counts: BrainHealth['reflectionCounts'] = {
    success: 0,
    cancelledTooShort: 0,
    cancelledLowImportance: 0,
    cancelledAlreadyReflected: 0,
    cancelledDisabled: 0,
    extractorFailed: 0,
    error: 0,
  };
  let recursiveRuns = 0;
  let lastRecursiveOutcome: string | undefined;
  let recursivePatternsTotal = 0;

  for (const e of events) {
    if (e.toolName === 'reflection' && e.phase === 'end') {
      const summary = (e.argsSummary ?? '').toLowerCase();
      if (e.outcome === 'success') {
        counts.success += 1;
      } else if (e.outcome === 'error') {
        counts.error += 1;
      } else if (e.outcome === 'cancelled') {
        if (summary.includes('skipped=too_short')) counts.cancelledTooShort += 1;
        else if (summary.includes('skipped=low_importance')) counts.cancelledLowImportance += 1;
        else if (summary.includes('skipped=already_reflected')) counts.cancelledAlreadyReflected += 1;
        else if (summary.includes('skipped=disabled')) counts.cancelledDisabled += 1;
        else if (summary.includes('skipped=extractor_failed')) counts.extractorFailed += 1;
      }
    } else if (e.toolName === 'recursive_reflection' && e.phase === 'end') {
      recursiveRuns += 1;
      lastRecursiveOutcome = e.outcome;
      const match = /written=(\d+)/.exec(e.argsSummary ?? '');
      if (match) recursivePatternsTotal += Number.parseInt(match[1], 10) || 0;
    }
  }

  let factImportance: BrainHealth['factImportance'] = { sample: 0 };
  let factDepth: BrainHealth['factDepth'] = { atomic: 0, depthOne: 0, depthTwo: 0 };
  try {
    const db = openMemoryDb();
    const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const importanceRows = db.prepare(`
      SELECT importance FROM consolidated_facts
      WHERE active = 1 AND importance IS NOT NULL
        AND updated_at >= ?
      ORDER BY importance ASC
    `).all(sinceIso) as { importance: number }[];
    if (importanceRows.length > 0) {
      const vals = importanceRows.map((r) => r.importance);
      const sum = vals.reduce((a, b) => a + b, 0);
      const pick = (q: number) => vals[Math.min(vals.length - 1, Math.floor(q * vals.length))];
      factImportance = {
        sample: vals.length,
        avg: Number((sum / vals.length).toFixed(2)),
        p50: Number(pick(0.5).toFixed(2)),
        p90: Number(pick(0.9).toFixed(2)),
      };
    }
    const depthRows = db.prepare(`
      SELECT derivation_depth AS d, COUNT(*) AS c FROM consolidated_facts
      WHERE active = 1
      GROUP BY derivation_depth
    `).all() as { d: number; c: number }[];
    for (const row of depthRows) {
      if (row.d === 0) factDepth.atomic = row.c;
      else if (row.d === 1) factDepth.depthOne = row.c;
      else if (row.d === 2) factDepth.depthTwo = row.c;
    }
  } catch {
    // Brain DB unavailable — return what we have from telemetry alone.
  }

  const anySignal =
    counts.success > 0 || counts.cancelledTooShort > 0 || counts.cancelledLowImportance > 0 ||
    counts.cancelledAlreadyReflected > 0 || counts.error > 0 || counts.extractorFailed > 0 ||
    recursiveRuns > 0 || factImportance.sample > 0 || factDepth.atomic > 0;
  if (!anySignal) return undefined;

  return {
    reflectionCounts: counts,
    recursiveReflection: {
      runs: recursiveRuns,
      lastOutcome: lastRecursiveOutcome,
      patternsWrittenTotal: recursivePatternsTotal,
    },
    factImportance,
    factDepth,
  };
}

/**
 * Parse the synthetic `tool_choice` events into a recall hit-rate
 * snapshot. Mirrors computeBrainHealth's "synthetic toolName + parse
 * argsSummary" pattern. Returns undefined when no tool-choice activity
 * happened in the window (keeps the report clean).
 */
function computeToolChoiceHealth(events: ToolEvent[]): ToolChoiceHealth | undefined {
  let hits = 0, fuzzyHits = 0, misses = 0, remembers = 0, invalidations = 0;
  for (const e of events) {
    if (e.toolName !== 'tool_choice' || e.phase !== 'end') continue;
    const summary = e.argsSummary ?? '';
    if (summary.includes('action=recall_hit_fuzzy')) fuzzyHits += 1;
    else if (summary.includes('action=recall_hit')) hits += 1;
    else if (summary.includes('action=recall_miss')) misses += 1;
    else if (summary.includes('action=remember')) remembers += 1;
    else if (summary.includes('action=invalidate')) invalidations += 1;
  }
  const recalls = hits + fuzzyHits + misses;
  if (recalls === 0 && remembers === 0 && invalidations === 0) return undefined;
  return {
    recalls,
    hits,
    fuzzyHits,
    misses,
    hitRatePct: recalls > 0 ? Math.round(((hits + fuzzyHits) / recalls) * 100) : 0,
    remembers,
    invalidations,
  };
}

export function buildReport(opts: ReportInput = {}): ObservatoryReport {
  const hoursBack = opts.hoursBack ?? 24;
  const now = opts.date ?? new Date();
  const windowStartMs = now.getTime() - hoursBack * 3600_000;

  const events = loadToolEventsInWindow(windowStartMs);
  const toolHealth = computeToolHealth(events);
  const workflowRuns = loadWorkflowRuns(windowStartMs);

  const sessionSet = new Set<string>();
  for (const e of events) if (e.sessionId) sessionSet.add(e.sessionId);

  return {
    generatedAt: now.toISOString(),
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: now.toISOString(),
    toolHealth,
    workflowRuns,
    sessionCount: sessionSet.size,
    totalToolCalls: toolHealth.reduce((sum, h) => sum + h.calls, 0),
    suggestions: generateSuggestions(toolHealth),
    brainHealth: computeBrainHealth(events),
    toolChoiceHealth: computeToolChoiceHealth(events),
  };
}

function fmtPct(n: number, denom: number): string {
  if (denom === 0) return '0%';
  return `${Math.round((n / denom) * 100)}%`;
}

export function renderReportMarkdown(report: ObservatoryReport): string {
  const lines: string[] = [
    `# Autoresearch — ${report.generatedAt.slice(0, 10)}`,
    '',
    `_Window: ${report.windowStart} → ${report.windowEnd}_`,
    '',
    `**${report.totalToolCalls}** tool calls across **${report.sessionCount}** session${report.sessionCount === 1 ? '' : 's'} · **${report.workflowRuns.length}** workflow run${report.workflowRuns.length === 1 ? '' : 's'}`,
    '',
    '## Tool health',
    '',
    '| Tool | Calls | Success | Errors | Empty | Wrong-pick hints | Avg ms |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const h of report.toolHealth.slice(0, 20)) {
    lines.push(`| \`${h.toolName}\` | ${h.calls} | ${fmtPct(h.successes, h.calls)} | ${h.errors} | ${h.emptyResults} | ${h.wrongPickHints} | ${h.avgDurationMs ?? '—'} |`);
  }
  if (report.toolHealth.length > 20) {
    lines.push(`| _… +${report.toolHealth.length - 20} more tools omitted_ | | | | | | |`);
  }
  lines.push('');

  if (report.workflowRuns.length > 0) {
    lines.push('## Workflow runs');
    lines.push('');
    for (const r of report.workflowRuns.slice(0, 10)) {
      const ok = r.stepErrors === 0 ? '✓' : '⚠';
      lines.push(`- ${ok} \`${r.workflow}\` · ${r.status} · ${r.stepCount} steps · ${r.stepErrors} step error(s) · started ${r.startedAt ?? '—'}`);
    }
    lines.push('');
  }

  if (report.brainHealth) {
    const bh = report.brainHealth;
    const rc = bh.reflectionCounts;
    const totalReflections = rc.success + rc.cancelledTooShort + rc.cancelledLowImportance +
      rc.cancelledAlreadyReflected + rc.cancelledDisabled + rc.extractorFailed + rc.error;
    lines.push('## Brain health');
    lines.push('');
    lines.push(`**Reflection — last 24h** · ${totalReflections} attempts`);
    lines.push('');
    lines.push('| Outcome | Count |');
    lines.push('|---|---:|');
    lines.push(`| success | ${rc.success} |`);
    lines.push(`| cancelled · too short | ${rc.cancelledTooShort} |`);
    lines.push(`| cancelled · low importance | ${rc.cancelledLowImportance} |`);
    lines.push(`| cancelled · already reflected | ${rc.cancelledAlreadyReflected} |`);
    lines.push(`| cancelled · disabled | ${rc.cancelledDisabled} |`);
    lines.push(`| extractor failed | ${rc.extractorFailed} |`);
    lines.push(`| error | ${rc.error} |`);
    lines.push('');
    lines.push(`**Recursive reflection (Stanford §4.2) — last 24h** · ${bh.recursiveReflection.runs} run${bh.recursiveReflection.runs === 1 ? '' : 's'}${bh.recursiveReflection.lastOutcome ? `, last outcome: ${bh.recursiveReflection.lastOutcome}` : ''}, ${bh.recursiveReflection.patternsWrittenTotal} pattern${bh.recursiveReflection.patternsWrittenTotal === 1 ? '' : 's'} written`);
    lines.push('');
    if (bh.factImportance.sample > 0) {
      lines.push(`**Importance distribution — last 7 days** (n=${bh.factImportance.sample}) · avg ${bh.factImportance.avg} · p50 ${bh.factImportance.p50} · p90 ${bh.factImportance.p90}`);
      lines.push('');
    }
    lines.push(`**Fact depth** · ${bh.factDepth.atomic} atomic · ${bh.factDepth.depthOne} pattern (depth 1) · ${bh.factDepth.depthTwo} meta-pattern (depth 2)`);
    lines.push('');
  }

  if (report.toolChoiceHealth) {
    const tc = report.toolChoiceHealth;
    lines.push('## Tool-choice learning (last 24h)');
    lines.push('');
    lines.push(`**Recall hit-rate: ${tc.hitRatePct}%** (${tc.hits + tc.fuzzyHits}/${tc.recalls} recalls found a remembered tool${tc.fuzzyHits > 0 ? `, ${tc.fuzzyHits} via fuzzy match` : ''})`);
    lines.push('');
    lines.push(`${tc.remembers} new choice${tc.remembers === 1 ? '' : 's'} saved · ${tc.invalidations} invalidated · ${tc.misses} miss${tc.misses === 1 ? '' : 'es'} (forced rediscovery)`);
    lines.push('');
    lines.push('_A rising hit-rate week-over-week means Clem is reusing proven tools instead of re-searching — the measured "gets better at your work" signal._');
    lines.push('');
  }

  lines.push('## Suggested manual edits to consider');
  lines.push('');
  for (const s of report.suggestions) lines.push(`- ${s}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('_This report is generated nightly. No mutations have been applied. To act on these_');
  lines.push('_observations, edit the relevant tool descriptions / skills / workflows by hand, or wait_');
  lines.push('_until Phase C of the autoresearch roadmap is shipped (mutation + approval flow)._');
  return lines.join('\n');
}

export interface WriteReportResult {
  path: string;
  written: boolean;
  bytes: number;
}

export function writeReport(report: ObservatoryReport): WriteReportResult {
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const filePath = path.join(REPORTS_DIR, `${report.generatedAt.slice(0, 10)}.md`);
  const content = renderReportMarkdown(report);
  // No-op if the content matches what's already on disk (e.g. two
  // ticks landed in the same window). Foundation doesn't churn the
  // vault reindexer for nothing.
  if (existsSync(filePath)) {
    try {
      const existing = readFileSync(filePath, 'utf-8');
      // Strip the generatedAt line from both before comparing — it
      // changes every run but the data may be identical.
      const stripMutable = (s: string) => s.replace(/_Window: [^_]+_/, '_Window: <range>_');
      if (stripMutable(existing) === stripMutable(content)) {
        return { path: filePath, written: false, bytes: existing.length };
      }
    } catch { /* fall through to write */ }
  }
  writeFileSync(filePath, content, 'utf-8');
  return { path: filePath, written: true, bytes: content.length };
}

/** Foundation tick — called by the maintenance loop once per day.
 *  Builds the report, writes the file, logs to supervisor when content
 *  actually changed (suppresses noise on repeat ticks). */
export function tickAutoresearchObservatory(): void {
  try {
    const report = buildReport();
    const result = writeReport(report);
    if (result.written) {
      logger.info(
        { path: result.path, bytes: result.bytes, tools: report.toolHealth.length, workflows: report.workflowRuns.length },
        'autoresearch report refreshed',
      );
    }
    // Phase C: turn the just-built observations into human-gated improvement
    // proposals. No-op (no model/skill reads) unless CLEMMY_IMPROVEMENT_PROPOSER
    // is on; applying a proposal is always a separate explicit human click.
    // Lazy import keeps observatory free of a runtime dependency on the proposer.
    void import('./improvement-proposer.js')
      .then(({ proposeFromReport }) => {
        const r = proposeFromReport(report);
        if (r.ran && r.added > 0) {
          logger.info({ added: r.added, total: r.total }, 'autoresearch improvement proposals drafted (pending human review)');
        }
      })
      .catch((err) => logger.warn({ err }, 'improvement-proposer pass failed'));
  } catch (err) {
    logger.warn({ err }, 'autoresearch observatory tick failed');
  }
}

/** Find the most recent report on disk. Used by the dashboard endpoint
 *  so the EVOLUTION panel can show "latest" without recomputing. */
export function findLatestReport(): { path: string; date: string; content: string } | null {
  if (!existsSync(REPORTS_DIR)) return null;
  const files = readdirSync(REPORTS_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  const file = files[0];
  const filePath = path.join(REPORTS_DIR, file);
  return {
    path: filePath,
    date: file.replace(/\.md$/, ''),
    content: readFileSync(filePath, 'utf-8'),
  };
}

/** List all available report dates (newest first). The dashboard uses
 *  this to show "history" — past reports clickable in the EVOLUTION
 *  panel. */
export function listReports(): Array<{ date: string; path: string }> {
  if (!existsSync(REPORTS_DIR)) return [];
  return readdirSync(REPORTS_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .reverse()
    .map((f) => ({ date: f.replace(/\.md$/, ''), path: path.join(REPORTS_DIR, f) }));
}
