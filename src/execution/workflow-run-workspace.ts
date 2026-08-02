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
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
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
  /** Present for correctness-critical artifacts referenced by the event log. */
  sha256?: string;
}

/** Exact immutable work-product reference carried by a step_completed event. */
export interface StepOutputArtifactReference {
  path: string;
  sha256: string;
  bytes: number;
  producedAt: string;
}

/** Exact immutable work-product reference carried by an item_completed event. */
export type ItemOutputArtifactReference = StepOutputArtifactReference;

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

function recordArtifactDurably(workflowName: string, runId: string, entry: WorkspaceArtifact): void {
  const fd = openSync(manifestPath(workflowName, runId), 'a');
  try {
    writeSync(fd, JSON.stringify(entry) + '\n', undefined, 'utf-8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectoryBestEffort(dir: string): void {
  // Directory fsync makes the preceding rename durable on macOS/Linux. Windows
  // does not permit opening a directory this way, so file fsync remains the
  // cross-platform durability floor.
  let fd: number | null = null;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Best effort across platforms.
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function writeFileAtomicallyAndDurably(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const temporary = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = openSync(temporary, 'wx');
    writeSync(fd, content, undefined, 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, filePath);
    fsyncDirectoryBestEffort(dir);
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
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

export function stepOutputArtifactRelPath(stepId: string, sha256?: string): string {
  const contentSuffix = sha256 ? `-${sha256}` : '';
  return path.join('artifacts', `step-${safeSegment(stepId, 'step')}${contentSuffix}.json`);
}

export function itemOutputArtifactRelPath(
  stepId: string,
  itemKey: string,
  sha256: string,
): string {
  const itemIdentity = createHash('sha256').update(itemKey).digest('hex').slice(0, 24);
  return path.join(
    'artifacts',
    `item-${safeSegment(stepId, 'step')}-${itemIdentity}-${sha256}.json`,
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function recordCompletedOutputArtifact(args: {
  workflowName: string;
  runId: string;
  artifactPath: (sha256: string) => string;
  tool: 'step-output' | 'item-output';
  agent: string;
  output: unknown;
  nowIso: string;
}): WorkspaceArtifact {
  ensureRunWorkspace(args.workflowName, args.runId);
  const serialized = safeStringify(args.output);
  const sha256 = createHash('sha256').update(serialized).digest('hex');
  const rel = args.artifactPath(sha256);
  const entry: WorkspaceArtifact = {
    path: rel,
    tool: args.tool,
    agent: args.agent,
    bytes: Buffer.byteLength(serialized, 'utf-8'),
    summary: summarizeToolOutput(args.output),
    producedAt: args.nowIso,
    sha256,
  };
  const absolutePath = path.join(runWorkspaceDir(args.workflowName, args.runId), rel);
  if (!existsSync(absolutePath)) {
    writeFileAtomicallyAndDurably(absolutePath, serialized);
  } else {
    // A same-content retry naturally addresses the same path. Verify it before
    // allowing an event to trust this inode.
    const existing = readFileSync(absolutePath, 'utf-8');
    const existingHash = createHash('sha256').update(existing).digest('hex');
    if (existingHash !== sha256) {
      throw new Error(`Output artifact hash collision/corruption at ${rel}.`);
    }
  }
  recordArtifactDurably(args.workflowName, args.runId, entry);
  return entry;
}

/**
 * Persist a completed step's output as a durable workspace artifact. The file
 * is content-addressed, fsynced, and atomically renamed before its manifest
 * entry is fsynced. A later step_completed event can therefore reference one
 * exact immutable payload without racing a different re-pursuit result.
 */
export function recordStepOutput(args: {
  workflowName: string;
  runId: string;
  stepId: string;
  output: unknown;
  nowIso: string;
}): WorkspaceArtifact {
  return recordCompletedOutputArtifact({
    workflowName: args.workflowName,
    runId: args.runId,
    artifactPath: (sha256) => stepOutputArtifactRelPath(args.stepId, sha256),
    tool: 'step-output',
    agent: args.stepId,
    output: args.output,
    nowIso: args.nowIso,
  });
}

/** Persist one completed forEach item's exact output before publishing it. */
export function recordItemOutput(args: {
  workflowName: string;
  runId: string;
  stepId: string;
  itemKey: string;
  output: unknown;
  nowIso: string;
}): WorkspaceArtifact {
  return recordCompletedOutputArtifact({
    workflowName: args.workflowName,
    runId: args.runId,
    artifactPath: (sha256) => itemOutputArtifactRelPath(args.stepId, args.itemKey, sha256),
    tool: 'item-output',
    agent: `${args.stepId}:${args.itemKey}`,
    output: args.output,
    nowIso: args.nowIso,
  });
}

type ArtifactReadResult = {
  found: boolean;
  verified: boolean;
  value?: unknown;
  producedAt?: string;
  path?: string;
  bytes?: number;
  sha256?: string;
  error?: string;
};

function readCompletedOutputArtifact(args: {
  workflowName: string;
  runId: string;
  tool: 'step-output' | 'item-output';
  agent: string;
  reference?: StepOutputArtifactReference;
}): ArtifactReadResult {
  const manifestEntry: WorkspaceArtifact | undefined = args.reference
    ? {
        path: args.reference.path,
        tool: args.tool,
        agent: args.agent,
        bytes: args.reference.bytes,
        summary: '',
        producedAt: args.reference.producedAt,
        sha256: args.reference.sha256,
      }
    : readWorkspaceManifest(args.workflowName, args.runId)
        .filter((entry) => entry.tool === args.tool && entry.agent === args.agent)
        .at(-1);
  if (!manifestEntry) return { found: false, verified: false };
  try {
    const root = realpathSync(runWorkspaceDir(args.workflowName, args.runId));
    if (path.isAbsolute(manifestEntry.path)) {
      return { found: false, verified: false, error: 'Artifact reference must be workspace-relative.' };
    }
    const candidate = path.resolve(root, manifestEntry.path);
    const relative = path.relative(root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return { found: false, verified: false, error: 'Artifact reference escapes the owning run workspace.' };
    }
    const resolved = realpathSync(candidate);
    const resolvedRelative = path.relative(root, resolved);
    if (resolvedRelative.startsWith('..') || path.isAbsolute(resolvedRelative)) {
      return { found: false, verified: false, error: 'Artifact symlink escapes the owning run workspace.' };
    }
    const raw = readFileSync(resolved, 'utf-8');
    const bytes = Buffer.byteLength(raw, 'utf-8');
    const sha256 = createHash('sha256').update(raw).digest('hex');
    if (args.reference) {
      if (bytes !== args.reference.bytes) {
        return {
          found: true,
          verified: false,
          path: manifestEntry.path,
          bytes,
          sha256,
          error: `Artifact byte length mismatch: expected ${args.reference.bytes}, got ${bytes}.`,
        };
      }
      if (sha256 !== args.reference.sha256) {
        return {
          found: true,
          verified: false,
          path: manifestEntry.path,
          bytes,
          sha256,
          error: 'Artifact SHA-256 mismatch.',
        };
      }
    } else if (manifestEntry.sha256 && sha256 !== manifestEntry.sha256) {
      return {
        found: true,
        verified: false,
        path: manifestEntry.path,
        bytes,
        sha256,
        error: 'Artifact SHA-256 does not match its manifest entry.',
      };
    }
    const common = {
      found: true,
      verified: true,
      producedAt: manifestEntry.producedAt,
      path: manifestEntry.path,
      bytes,
      sha256,
    };
    if (raw === 'undefined') {
      return { ...common, value: undefined };
    }
    try {
      return { ...common, value: JSON.parse(raw) as unknown };
    } catch {
      return { ...common, value: raw };
    }
  } catch (error) {
    return {
      found: false,
      verified: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Read the exact durable work product for a completed step. The event journal
 * remains the authority that a step completed; this artifact only restores the
 * payload when the journal intentionally compacted it.
 */
export function readStepOutputArtifact(args: {
  workflowName: string;
  runId: string;
  stepId: string;
  /** When supplied, only this exact event-owned artifact may be read. */
  reference?: StepOutputArtifactReference;
}): ArtifactReadResult {
  return readCompletedOutputArtifact({
    workflowName: args.workflowName,
    runId: args.runId,
    tool: 'step-output',
    agent: args.stepId,
    reference: args.reference,
  });
}

/** Read the event-owned exact work product for one completed forEach item. */
export function readItemOutputArtifact(args: {
  workflowName: string;
  runId: string;
  stepId: string;
  itemKey: string;
  reference?: ItemOutputArtifactReference;
}): ArtifactReadResult {
  return readCompletedOutputArtifact({
    workflowName: args.workflowName,
    runId: args.runId,
    tool: 'item-output',
    agent: `${args.stepId}:${args.itemKey}`,
    reference: args.reference,
  });
}

/**
 * Resolve the artifact matching this exact in-memory value. This never selects
 * a later orphan manifest entry from an interrupted re-pursuit.
 */
export function readStepOutputArtifactForValue(args: {
  workflowName: string;
  runId: string;
  stepId: string;
  value: unknown;
}): ArtifactReadResult {
  const serialized = safeStringify(args.value);
  const sha256 = createHash('sha256').update(serialized).digest('hex');
  return readStepOutputArtifact({
    workflowName: args.workflowName,
    runId: args.runId,
    stepId: args.stepId,
    reference: {
      path: stepOutputArtifactRelPath(args.stepId, sha256),
      sha256,
      bytes: Buffer.byteLength(serialized, 'utf-8'),
      producedAt: new Date(0).toISOString(),
    },
  });
}

export function runWorkspaceOffloadEnabled(): boolean {
  return (process.env.CLEMMY_RUN_WORKSPACE_OFFLOAD ?? 'on').trim().toLowerCase() !== 'off';
}

export function reduceDigestArtifactRelPath(stepId: string): string {
  return path.join('artifacts', `reduce-${safeSegment(stepId, 'step')}.json`);
}

export interface StepReduceDigest {
  stepId: string;
  /** Content fingerprint of the aggregate the digest was reduced from —
   *  a re-pursuit with unchanged items skips re-reducing. */
  fingerprint: string;
  shards: Array<{ shardIndex: number; degraded: boolean; items: Array<{ itemKey: string; gist: string }> }>;
  /** Assembled text the synthesis envelope inlines. Failure lines are appended
   *  by the runner from its own failure accumulator, never by the reducer. */
  digest: string;
  createdAt: string;
}

/** Stage 3 (reduce tier): persist a forEach step's shard-reduced digest as a
 *  durable workspace artifact next to the step output. Overwrite-idempotent. */
export function recordReduceDigest(args: {
  workflowName: string;
  runId: string;
  digest: StepReduceDigest;
}): void {
  ensureRunWorkspace(args.workflowName, args.runId);
  const rel = reduceDigestArtifactRelPath(args.digest.stepId);
  const serialized = safeStringify(args.digest);
  writeFileSync(path.join(runWorkspaceDir(args.workflowName, args.runId), rel), serialized, 'utf-8');
  recordArtifact(args.workflowName, args.runId, {
    path: rel,
    tool: 'reduce-digest',
    agent: args.digest.stepId,
    bytes: Buffer.byteLength(serialized, 'utf-8'),
    summary: `shard-reduced digest: ${args.digest.shards.length} shard${args.digest.shards.length === 1 ? '' : 's'}`,
    producedAt: args.digest.createdAt,
  });
}

export function readReduceDigest(workflowName: string, runId: string, stepId: string): StepReduceDigest | null {
  try {
    const abs = path.join(runWorkspaceDir(workflowName, runId), reduceDigestArtifactRelPath(stepId));
    return JSON.parse(readFileSync(abs, 'utf-8')) as StepReduceDigest;
  } catch {
    return null;
  }
}

/**
 * Offload a large cross-step CONTEXT value under an immutable content-addressed
 * path. The digest suffix is load-bearing for fan-out: two invocations may both
 * call their value `item`, but must never reuse stale bytes from a sibling.
 * Same key + same content naturally reuses one verified artifact.
 */
export function offloadContextValue(args: {
  workflowName: string;
  runId: string;
  key: string;
  value: unknown;
  nowIso: string;
}): { path: string; summary: string; bytes: number; sha256: string } {
  const serialized = safeStringify(args.value);
  const sha256 = createHash('sha256').update(serialized).digest('hex');
  const rel = path.join(
    'artifacts',
    `context-${safeSegment(args.key, 'value')}-${sha256}.json`,
  );
  const bytes = Buffer.byteLength(serialized, 'utf-8');
  const summary = summarizeToolOutput(args.value);
  ensureRunWorkspace(args.workflowName, args.runId);
  const abs = path.join(runWorkspaceDir(args.workflowName, args.runId), rel);
  if (!existsSync(abs)) {
    writeFileAtomicallyAndDurably(abs, serialized);
    recordArtifact(args.workflowName, args.runId, {
      path: rel,
      tool: 'step-context',
      agent: args.key,
      bytes,
      summary,
      producedAt: args.nowIso,
      sha256,
    });
  }
  // Existing content is never trusted merely because its name contains the
  // digest. Verify before handing the reference to an invocation.
  const existing = readFileSync(abs, 'utf-8');
  const existingBytes = Buffer.byteLength(existing, 'utf-8');
  const existingSha256 = createHash('sha256').update(existing).digest('hex');
  if (existingBytes !== bytes || existingSha256 !== sha256) {
    throw new Error(`Context artifact hash collision/corruption at ${rel}.`);
  }
  return { path: rel, summary, bytes, sha256 };
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
