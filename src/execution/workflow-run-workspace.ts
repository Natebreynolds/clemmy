/**
 * Goal-anchored shared RUN WORKSPACE — the substrate for long-horizon,
 * multi-agent workflow runs.
 *
 * This is the "filesystem as memory" layer the long-horizon harness needs. It
 * solves the endurance gap (context thrashing on tool-heavy runs) AND doubles
 * as the shared surface multiple agents coordinate through:
 *
 *   runs/<runId>/workspace/
 *     GOAL.md            <- the anchor every agent/step references
 *     artifacts/…        <- offloaded tool outputs + agent deliverables
 *     manifest.jsonl     <- one line per artifact (who made it, what, how big)
 *
 * The two load-bearing ideas:
 *   1. OFFLOAD — a large tool result is written to artifacts/ and the model gets
 *      a path + a short summary instead of the raw blob, so the loop reads
 *      detail on demand (progressive disclosure) instead of drowning in it.
 *   2. MANIFEST — a shared, append-only index anchored to GOAL.md, so a checker
 *      agent can verify what's been produced against the goal, and the dashboard
 *      can render a live window into the run without re-reading the artifacts.
 *
 * Pure filesystem I/O — no LLM — so the whole thing is deterministically
 * testable. This is app-side (runner) code, so Date is available here.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { WORKFLOWS_DIR } from '../memory/vault.js';

/** Tool outputs at or above this size are offloaded to the workspace instead of
 *  returned inline. Deliberately well below the 32KB event-log cap — a single
 *  DataForSEO/scrape payload is routinely 50–200KB, and a handful of those
 *  inline is what thrashes the context. Override with CLEMMY_RUN_OFFLOAD_BYTES. */
const DEFAULT_OFFLOAD_BYTES = 8 * 1024;
const SUMMARY_MAX = 700;

export interface RunGoalAnchor {
  objective: string;
  successCriteria?: string[];
}

export interface WorkspaceArtifact {
  path: string;
  tool: string;
  agent: string;
  bytes: number;
  summary: string;
  producedAt: string;
}

export interface ToolOffloadResult {
  offloaded: boolean;
  /** Workspace-relative path when offloaded; undefined when kept inline. */
  path?: string;
  bytes: number;
  summary: string;
}

function offloadThresholdBytes(): number {
  const raw = Number.parseInt(process.env.CLEMMY_RUN_OFFLOAD_BYTES ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_OFFLOAD_BYTES;
}

function safeSegment(value: string, fallback: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_.:-]/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

export function runWorkspaceDir(workflowName: string, runId: string): string {
  return path.join(WORKFLOWS_DIR, safeSegment(workflowName, 'workflow'), 'runs', safeSegment(runId, 'run'), 'workspace');
}

function artifactsDir(workflowName: string, runId: string): string {
  return path.join(runWorkspaceDir(workflowName, runId), 'artifacts');
}

function manifestPath(workflowName: string, runId: string): string {
  return path.join(runWorkspaceDir(workflowName, runId), 'manifest.jsonl');
}

export function ensureRunWorkspace(workflowName: string, runId: string): string {
  const dir = runWorkspaceDir(workflowName, runId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const art = artifactsDir(workflowName, runId);
  if (!existsSync(art)) mkdirSync(art, { recursive: true });
  return dir;
}

/** Write the goal anchor every agent/step references. Idempotent. */
export function anchorRunGoal(workflowName: string, runId: string, goal: RunGoalAnchor): void {
  ensureRunWorkspace(workflowName, runId);
  const lines = [
    `# Run goal`,
    '',
    goal.objective.trim() || `Deliver "${workflowName}"`,
  ];
  const criteria = (goal.successCriteria ?? []).map((c) => c.trim()).filter(Boolean);
  if (criteria.length > 0) {
    lines.push('', '## Success criteria (every deliverable is judged against these)', ...criteria.map((c) => `- ${c}`));
  }
  lines.push('', '_All agents on this run share this workspace. Write artifacts to artifacts/, index them in manifest.jsonl, and check your work against the criteria above._', '');
  writeFileSync(path.join(runWorkspaceDir(workflowName, runId), 'GOAL.md'), lines.join('\n'), 'utf-8');
}

export function readRunGoal(workflowName: string, runId: string): string | null {
  try {
    return readFileSync(path.join(runWorkspaceDir(workflowName, runId), 'GOAL.md'), 'utf-8');
  } catch {
    return null;
  }
}

/** A compact, model-readable summary of a value's shape + head — enough to keep
 *  working without the full payload. */
export function summarizeToolOutput(output: unknown): string {
  if (output === null || output === undefined) return String(output);
  if (typeof output === 'string') {
    const head = output.slice(0, SUMMARY_MAX).replace(/\s+/g, ' ').trim();
    return output.length > SUMMARY_MAX ? `${head}… (${output.length} chars total)` : head;
  }
  if (Array.isArray(output)) {
    const first = output[0];
    const shape = first && typeof first === 'object' ? `; item keys: ${Object.keys(first as object).slice(0, 12).join(', ')}` : '';
    return `array of ${output.length} item${output.length === 1 ? '' : 's'}${shape}`;
  }
  if (typeof output === 'object') {
    const keys = Object.keys(output as object);
    const domArray = keys.find((k) => Array.isArray((output as Record<string, unknown>)[k]));
    const domNote = domArray ? `; "${domArray}" has ${((output as Record<string, unknown>)[domArray] as unknown[]).length} items` : '';
    return `object with keys: ${keys.slice(0, 16).join(', ')}${domNote}`;
  }
  return String(output).slice(0, SUMMARY_MAX);
}

function recordArtifact(workflowName: string, runId: string, entry: WorkspaceArtifact): void {
  appendFileSync(manifestPath(workflowName, runId), JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Offload a tool result to the shared workspace when it's large enough to hurt
 * the context. Returns a handback describing where it went + a summary; when the
 * output is small, returns { offloaded: false } and the caller keeps it inline.
 */
export function offloadToolOutput(args: {
  workflowName: string;
  runId: string;
  agent: string;
  tool: string;
  output: unknown;
  index?: number;
  nowIso: string;
  thresholdBytes?: number;
}): ToolOffloadResult {
  const serialized = typeof args.output === 'string' ? args.output : safeStringify(args.output);
  const bytes = Buffer.byteLength(serialized, 'utf-8');
  const summary = summarizeToolOutput(args.output);
  const threshold = args.thresholdBytes ?? offloadThresholdBytes();
  if (bytes < threshold) {
    return { offloaded: false, bytes, summary };
  }
  ensureRunWorkspace(args.workflowName, args.runId);
  const ext = typeof args.output === 'string' ? 'txt' : 'json';
  const base = `${safeSegment(args.tool, 'tool')}-${args.index ?? nextArtifactIndex(args.workflowName, args.runId)}.${ext}`;
  const rel = path.join('artifacts', base);
  writeFileSync(path.join(runWorkspaceDir(args.workflowName, args.runId), rel), serialized, 'utf-8');
  recordArtifact(args.workflowName, args.runId, {
    path: rel,
    tool: args.tool,
    agent: args.agent,
    bytes,
    summary,
    producedAt: args.nowIso,
  });
  return { offloaded: true, path: rel, bytes, summary };
}

/** The string handed back to the model in place of a large tool result. */
export function renderOffloadHandback(tool: string, result: ToolOffloadResult): string {
  if (!result.offloaded) return '';
  const kb = (result.bytes / 1024).toFixed(1);
  return [
    `⤓ ${tool} returned ${kb}KB — saved to the run workspace at ${result.path} (not inlined, to keep the loop fast).`,
    `Summary: ${result.summary}`,
    `Read ${result.path} with read_file when you need the full detail.`,
  ].join('\n');
}

export function readWorkspaceManifest(workflowName: string, runId: string): WorkspaceArtifact[] {
  try {
    return readFileSync(manifestPath(workflowName, runId), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WorkspaceArtifact);
  } catch {
    return [];
  }
}

function nextArtifactIndex(workflowName: string, runId: string): number {
  return readWorkspaceManifest(workflowName, runId).length + 1;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Persist a completed step's output as a durable workspace artifact — the
 * "work product" of that step. ALWAYS writes the file + a manifest entry (even
 * small outputs), so the manifest is a complete, inspectable record of the run
 * that the live window and a checker agent read. Overwrites the file on
 * re-pursuit (latest work wins); the manifest keeps the history.
 */
export function recordStepOutput(args: {
  workflowName: string;
  runId: string;
  stepId: string;
  output: unknown;
  nowIso: string;
}): WorkspaceArtifact {
  ensureRunWorkspace(args.workflowName, args.runId);
  const rel = path.join('artifacts', `step-${safeSegment(args.stepId, 'step')}.json`);
  const serialized = safeStringify(args.output);
  const entry: WorkspaceArtifact = {
    path: rel,
    tool: 'step-output',
    agent: args.stepId,
    bytes: Buffer.byteLength(serialized, 'utf-8'),
    summary: summarizeToolOutput(args.output),
    producedAt: args.nowIso,
  };
  writeFileSync(path.join(runWorkspaceDir(args.workflowName, args.runId), rel), serialized, 'utf-8');
  recordArtifact(args.workflowName, args.runId, entry);
  return entry;
}

export function runWorkspaceOffloadEnabled(): boolean {
  return (process.env.CLEMMY_RUN_WORKSPACE_OFFLOAD ?? 'on').trim().toLowerCase() !== 'off';
}

/**
 * Offload a large cross-step CONTEXT value to the shared workspace under a
 * DETERMINISTIC per-key path, so every downstream step that depends on the same
 * upstream output points at ONE artifact (no duplicate blobs) and can read the
 * exact full value with read_file instead of a lossy inline preview. Idempotent:
 * writes the file + manifest entry once per (run, key).
 */
export function offloadContextValue(args: {
  workflowName: string;
  runId: string;
  key: string;
  value: unknown;
  nowIso: string;
}): { path: string; summary: string; bytes: number } {
  const rel = path.join('artifacts', `context-${safeSegment(args.key, 'value')}.json`);
  const abs = path.join(runWorkspaceDir(args.workflowName, args.runId), rel);
  const serialized = safeStringify(args.value);
  const bytes = Buffer.byteLength(serialized, 'utf-8');
  const summary = summarizeToolOutput(args.value);
  if (!existsSync(abs)) {
    ensureRunWorkspace(args.workflowName, args.runId);
    writeFileSync(abs, serialized, 'utf-8');
    recordArtifact(args.workflowName, args.runId, {
      path: rel, tool: 'step-context', agent: args.key, bytes, summary, producedAt: args.nowIso,
    });
  }
  return { path: rel, summary, bytes };
}

/** Persist / read the checker agent's latest report for a run (shown in the
 *  window). Typed as unknown to avoid a cycle with the checker module. */
export function writeWorkspaceCheckerReport(workflowName: string, runId: string, report: unknown): void {
  ensureRunWorkspace(workflowName, runId);
  writeFileSync(path.join(runWorkspaceDir(workflowName, runId), 'checker.json'), JSON.stringify(report, null, 2), 'utf-8');
}

export function readWorkspaceCheckerReport(workflowName: string, runId: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path.join(runWorkspaceDir(workflowName, runId), 'checker.json'), 'utf-8'));
  } catch {
    return null;
  }
}

/** Total bytes currently offloaded to the workspace (for the visual window). */
export function workspaceArtifactBytes(workflowName: string, runId: string): number {
  const dir = artifactsDir(workflowName, runId);
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const file of readdirSync(dir)) {
    try { total += statSync(path.join(dir, file)).size; } catch { /* ignore */ }
  }
  return total;
}
