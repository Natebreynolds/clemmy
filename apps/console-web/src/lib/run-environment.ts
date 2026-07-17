import type { RunRow } from './inbox';

export interface RunEnvironmentEvent {
  type?: string;
  createdAt?: string;
  stepId?: string;
  data?: Record<string, unknown>;
}

export interface RunEnvironmentArtifact {
  id?: string;
  runScopeId?: string;
  slotKey?: string;
  kind?: string;
  provider?: string;
  title?: string | null;
  status?: 'pending' | 'bound' | 'uncertain' | string;
  resourceId?: string | null;
  uri?: string | null;
  /** Exact-id provider read-back proof. `bound` without this timestamp means
   * Clementine found a resource pointer but has not independently read it. */
  bindingVerifiedAt?: string | null;
  verificationCallId?: string | null;
  verificationShape?: string | null;
  verificationFingerprint?: string | null;
  updatedAt?: string;
}

export interface RunEnvironmentArtifactPresentation {
  meta: string;
  state: 'running' | 'done' | 'warning';
}

/** Keep the desktop honest about the distinction between parsing a create
 * response and independently reading the exact provider resource back. */
export function artifactBindingPresentation(
  artifact: RunEnvironmentArtifact,
): RunEnvironmentArtifactPresentation {
  if (artifact.status === 'bound' && artifact.bindingVerifiedAt) {
    return { meta: 'provider verified', state: 'done' };
  }
  if (artifact.status === 'bound') {
    return { meta: 'resource found · verification pending', state: 'warning' };
  }
  if (artifact.status === 'uncertain') {
    return { meta: 'outcome uncertain', state: 'warning' };
  }
  return { meta: artifact.status === 'pending' ? 'creating' : (artifact.status || 'recorded'), state: 'running' };
}

export interface RunEnvironmentDetail extends RunRow {
  live?: boolean;
  liveLine?: string;
  kindLabel?: string;
  objective?: string;
  category?: string;
  queuedTaskId?: string;
  model?: string;
  workspace?: string;
  cwd?: string;
  workDir?: string;
  branch?: string;
  metadata?: Record<string, unknown>;
  summary?: { ask?: string; result?: string; error?: string };
  events?: RunEnvironmentEvent[];
  artifacts?: RunEnvironmentArtifact[];
  /** Server-authoritative control projection. ID prefixes are not a reliable
   * discriminator (`space-*` and `discord:*` are valid harness sessions). */
  canCancel?: boolean;
  cancelEndpoint?: string;
  canBackground?: boolean;
  backgroundEndpoint?: string;
  /** Compact, server-computed usage aggregate for the selected run scope.
   * Environment views intentionally receive only structural events, so tool
   * totals must come from this summary rather than re-counting the projection. */
  toolSummary?: {
    names?: string[];
    countsByName?: Record<string, number>;
    logicalCount?: number | null;
    recordedCalls?: number;
    mirrorEvents?: number;
  };
  runEnvironmentMeta?: {
    scopeKind?: 'current_attempt' | 'latest_turn' | 'session_history' | string;
    runScopeId?: string | null;
    attemptScopeId?: string | null;
    artifactRootScopeId?: string | null;
    attemptId?: string | null;
    sourceUserSeq?: number | null;
    scopeStartedAt?: string | null;
    latestSeq?: number;
    auditEventsTotal?: number;
    projectionEventsTotal?: number;
    projectionEventsReturned?: number;
    projectionEventsOmitted?: number;
    artifactsTotal?: number;
    artifactsReturned?: number;
    artifactsOmitted?: number;
    artifactCoverageStatus?: 'available' | 'unavailable' | string;
  };
}

export interface RunEnvironmentPlan {
  objective: string;
  declaredCount: number | null;
  recorded: boolean;
  steps: Array<{ label: string; state: 'pending' | 'running' | 'done' | 'failed' }>;
}

export interface RunEnvironmentHelper {
  key: string;
  label: string;
  state: 'running' | 'done' | 'failed';
  meta: string;
}

export interface RunEnvironmentToolSummary {
  names: string[];
  countsByName: Record<string, number>;
  logicalCount: number | null;
  recordedCalls: number;
  mirrorEvents: number;
}

export interface RunEnvironmentScopePresentation {
  label: string;
  audit: string;
  projection: string;
  artifacts: string;
}

export interface RunEnvironmentReferences {
  urls: string[];
  files: string[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return {};
  try { return record(JSON.parse(value)); } catch { return {}; }
}

function eventArgs(event: RunEnvironmentEvent): Record<string, unknown> {
  const data = record(event.data);
  return parseRecord(data.args ?? data.arguments ?? data.input);
}

export function isRunLive(run: Pick<RunEnvironmentDetail, 'live' | 'status' | 'runState'>): boolean {
  if (run.live === true) return true;
  return /^(running|active|in_progress|queued|awaiting_approval|waiting_for_input|paused)$/i
    .test(firstText(run.runState, run.status));
}

export function chooseRunEnvironmentRun(runs: RunRow[]): RunRow | null {
  const sorted = [...runs].sort((left, right) =>
    firstText(right.updatedAt, right.completedAt, right.createdAt)
      .localeCompare(firstText(left.updatedAt, left.completedAt, left.createdAt)),
  );
  return sorted.find((run) => isRunLive(run)) ?? sorted[0] ?? null;
}

/** Carry the exact canonical attempt into Tasks. A reusable harness session id
 * alone can identify several historical runs, so it is only the compatibility
 * fallback when the server has no attempt/scope metadata. */
export function runEnvironmentTasksHref(
  run: Pick<RunEnvironmentDetail, 'id' | 'runEnvironmentMeta'>,
): string {
  const params = new URLSearchParams({ select: run.id });
  const attemptId = run.runEnvironmentMeta?.attemptId?.trim();
  const runScopeId = run.runEnvironmentMeta?.runScopeId?.trim();
  if (attemptId) params.set('attemptId', attemptId);
  if (runScopeId) params.set('runScopeId', runScopeId);
  return `/tasks?${params.toString()}`;
}

/** A compact list poll can observe terminal state before the slower detail
 * poll. Force one reconciliation so the rail cannot leave stale Working/Stop
 * controls visible after the server has already settled the run. */
export function shouldReconcileRunEnvironmentDetail(
  compact: Pick<RunEnvironmentDetail, 'live' | 'status' | 'runState'> | null | undefined,
  detail: Pick<RunEnvironmentDetail, 'live' | 'status' | 'runState'> | null | undefined,
): boolean {
  return Boolean(compact && detail && !isRunLive(compact) && isRunLive(detail));
}

export function buildRunEnvironmentPlan(run: RunEnvironmentDetail): RunEnvironmentPlan {
  let draft: Record<string, unknown> | null = null;
  const steps = new Map<string, RunEnvironmentPlan['steps'][number]>();
  for (const event of run.events ?? []) {
    const type = firstText(event.type);
    const data = record(event.data);
    if (type === 'plan_drafted') draft = data;
    if (!['step_started', 'step_completed', 'step_verified', 'step_failed'].includes(type)) continue;
    const label = firstText(event.stepId, data.stepId, data.step, data.label, data.name);
    if (!label) continue;
    const previous = steps.get(label) ?? { label, state: 'pending' as const };
    previous.state = type === 'step_failed' ? 'failed'
      : type === 'step_completed' || type === 'step_verified' ? 'done'
        : 'running';
    steps.set(label, previous);
  }
  const count = Number(draft?.stepCount);
  return {
    objective: firstText(draft?.objective, run.objective, run.summary?.ask, run.input),
    declaredCount: Number.isFinite(count) ? count : null,
    recorded: Boolean(draft) || steps.size > 0,
    steps: [...steps.values()],
  };
}

export function buildRunEnvironmentHelpers(run: RunEnvironmentDetail): RunEnvironmentHelper[] {
  const helpers = new Map<string, RunEnvironmentHelper>();
  let handoff = 0;
  for (const event of run.events ?? []) {
    const type = firstText(event.type);
    const data = record(event.data);
    if (['worker_started', 'subagent_started', 'agent_started'].includes(type)) {
      const label = firstText(data.item, data.task, data.name, data.role) || `Helper ${helpers.size + 1}`;
      helpers.set(label, {
        key: label,
        label,
        state: 'running',
        meta: firstText(data.model, data.role, data.provider),
      });
      continue;
    }
    if (['worker_result', 'worker_completed', 'worker_failed', 'subagent_result', 'agent_result'].includes(type)) {
      const label = firstText(data.item, data.task, data.name, data.role) || `Helper ${helpers.size + 1}`;
      const previous = helpers.get(label);
      helpers.set(label, {
        key: label,
        label,
        state: type === 'worker_failed' || data.ok === false ? 'failed' : 'done',
        meta: previous?.meta || firstText(data.model, data.role, data.provider),
      });
      continue;
    }
    if (type === 'handoff') {
      const label = firstText(data.to, data.agent, data.role);
      if (!label) continue;
      handoff += 1;
      helpers.set(`handoff:${handoff}:${label}`, {
        key: `handoff:${handoff}:${label}`,
        label,
        state: 'done',
        meta: 'handoff',
      });
    }
  }
  return [...helpers.values()];
}

function toolName(event: RunEnvironmentEvent): string {
  const data = record(event.data);
  const args = eventArgs(event);
  const nested = parseRecord(args.arguments);
  const slug = firstText(data.slug, data.toolSlug, args.tool_slug, args.toolSlug, nested.slug);
  const name = firstText(data.tool, data.toolName, data.name);
  return slug || name || 'tool';
}

export function buildRunEnvironmentTools(run: RunEnvironmentDetail): RunEnvironmentToolSummary {
  if (run.toolSummary && typeof run.toolSummary === 'object') {
    const rawCounts = record(run.toolSummary.countsByName);
    const countsByName: Record<string, number> = {};
    for (const [name, count] of Object.entries(rawCounts)) {
      const parsed = Number(count);
      if (name.trim() && Number.isFinite(parsed) && parsed > 0) countsByName[name.trim()] = Math.floor(parsed);
    }
    const names: string[] = [];
    const seen = new Set<string>();
    for (const rawName of [...(run.toolSummary.names ?? []), ...Object.keys(countsByName)]) {
      if (typeof rawName !== 'string') continue;
      const name = rawName.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
      countsByName[name] ??= 1;
    }
    const logicalCount = run.toolSummary.logicalCount == null
      ? null
      : Number(run.toolSummary.logicalCount);
    const recordedCalls = Number(run.toolSummary.recordedCalls);
    const mirrorEvents = Number(run.toolSummary.mirrorEvents);
    return {
      names,
      countsByName,
      logicalCount: logicalCount != null && Number.isFinite(logicalCount) ? Math.max(0, Math.floor(logicalCount)) : null,
      recordedCalls: Number.isFinite(recordedCalls) ? Math.max(0, Math.floor(recordedCalls)) : 0,
      mirrorEvents: Number.isFinite(mirrorEvents) ? Math.max(0, Math.floor(mirrorEvents)) : 0,
    };
  }

  const calls = (run.events ?? []).filter((event) => event.type === 'tool_called');
  const mirrors = calls.filter((event) => record(event.data).accounting === 'transport_mirror');
  const topLevel = calls.filter((event) => record(event.data).accounting !== 'transport_mirror');
  const names: string[] = [];
  const countsByName: Record<string, number> = {};
  const seen = new Set<string>();
  for (const event of topLevel) {
    const name = toolName(event);
    countsByName[name] = (countsByName[name] ?? 0) + 1;
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  const ids = topLevel.map((event) => firstText(
    record(event.data).canonicalCallId,
    record(event.data).logicalCallId,
    record(event.data).invocationId,
  ));
  return {
    names,
    countsByName,
    logicalCount: topLevel.length > 0 && ids.every(Boolean) ? new Set(ids).size : null,
    recordedCalls: topLevel.length,
    mirrorEvents: mirrors.length,
  };
}

function boundedCount(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function coverageLabel(noun: string, returnedValue: unknown, totalValue: unknown, omittedValue: unknown): string {
  const returned = boundedCount(returnedValue);
  const total = boundedCount(totalValue);
  const omitted = boundedCount(omittedValue);
  if (returned == null && total == null && omitted == null) return '';
  const visible = returned ?? (total != null && omitted != null ? Math.max(0, total - omitted) : null);
  const whole = total ?? (visible != null && omitted != null ? visible + omitted : null);
  const coverage = visible != null && whole != null ? `${visible} of ${whole} ${noun}` : `${whole ?? visible ?? 0} ${noun}`;
  return omitted && omitted > 0 ? `${coverage} · ${omitted} omitted` : coverage;
}

/** Human-readable truth labels for the bounded environment projection. */
export function runEnvironmentScopePresentation(run: RunEnvironmentDetail): RunEnvironmentScopePresentation {
  const meta = run.runEnvironmentMeta;
  const auditEvents = boundedCount(meta?.auditEventsTotal);
  const label = meta?.scopeKind === 'current_attempt' ? 'current attempt'
    : meta?.scopeKind === 'latest_turn' ? 'latest turn'
      : meta?.scopeKind === 'session_history' ? 'session history'
        : 'run scope';
  return {
    label,
    audit: auditEvents != null ? `${auditEvents} audit events in scope` : '',
    projection: coverageLabel(
      'structural events',
      meta?.projectionEventsReturned,
      meta?.projectionEventsTotal,
      meta?.projectionEventsOmitted,
    ),
    artifacts: meta?.artifactCoverageStatus === 'unavailable'
      ? 'unavailable'
      : coverageLabel(
        'artifacts',
        meta?.artifactsReturned,
        meta?.artifactsTotal,
        meta?.artifactsOmitted,
      ),
  };
}

function safeHttpUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch { return ''; }
}

export function collectRunEnvironmentReferences(run: RunEnvironmentDetail): RunEnvironmentReferences {
  const urls = new Set<string>();
  const files = new Set<string>();
  const scan = (value: unknown, key = '', depth = 0): void => {
    if (depth > 3 || value == null) return;
    if (typeof value === 'string') {
      for (const token of value.split(/\s+/)) {
        const clean = token.replace(/[),.;:]+$/, '');
        const url = safeHttpUrl(clean);
        if (url) urls.add(url);
        if ((clean.startsWith('/') || clean.startsWith('~/')) && clean.length < 500) files.add(clean);
      }
      if (/sourceUri|url|href/i.test(key)) {
        const url = safeHttpUrl(value);
        if (url) urls.add(url);
      }
      if (/path|file|artifact|document/i.test(key)) {
        const clean = value.trim();
        if ((clean.startsWith('/') || clean.startsWith('~/')) && clean.length < 500) files.add(clean);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 20).forEach((entry) => scan(entry, key, depth + 1));
      return;
    }
    if (typeof value === 'object') {
      Object.entries(value as Record<string, unknown>).slice(0, 40)
        .forEach(([childKey, child]) => scan(child, childKey, depth + 1));
    }
  };
  scan(run.outputPreview, 'outputPreview');
  scan(run.metadata?.artifacts, 'artifacts');
  for (const event of run.events ?? []) {
    const data = record(event.data);
    if (['tool_returned', 'conversation_completed', 'run_completed', 'completed'].includes(firstText(event.type))) {
      scan(data, 'result');
    } else {
      for (const key of ['sourceUri', 'url', 'href', 'artifactUrl', 'artifactPath', 'resultPath']) {
        if (data[key] !== undefined) scan(data[key], key);
      }
    }
  }
  return { urls: [...urls].slice(0, 8), files: [...files].slice(0, 8) };
}

export interface RunEnvironmentMetadataValue {
  value: string;
  /** `recorded` comes from the run/session record. `observed` was only seen in
   * an event payload or tool argument and must never be presented as current
   * machine state (for example, a target PR branch is not the local branch). */
  provenance: 'recorded' | 'observed';
}

export interface RunEnvironmentMetadata {
  workspace: RunEnvironmentMetadataValue | null;
  branch: RunEnvironmentMetadataValue | null;
  model: RunEnvironmentMetadataValue | null;
}

export function runEnvironmentMetadata(run: RunEnvironmentDetail): RunEnvironmentMetadata {
  const metadata = record(run.metadata);
  const recordedWorkspace = firstText(
    run.workspace, run.cwd, run.workDir,
    metadata.workspacePath, metadata.workspace, metadata.workDir, metadata.cwd, metadata.projectPath,
  );
  const recordedBranch = firstText(run.branch, metadata.branch, metadata.gitBranch, metadata.branchName);
  const recordedModel = firstText(run.model, metadata.model, metadata.modelId);
  let observedWorkspace = '';
  let observedBranch = '';
  let observedModel = '';
  for (const event of [...(run.events ?? [])].reverse()) {
    if (observedWorkspace && observedBranch && observedModel) break;
    const data = record(event.data);
    const args = eventArgs(event);
    observedWorkspace ||= firstText(data.workspacePath, data.workspace, data.cwd, data.workDir, data.projectPath, args.cwd, args.workDir);
    observedBranch ||= firstText(data.branch, data.gitBranch, data.branchName, args.branch);
    observedModel ||= firstText(data.model, data.modelId);
  }
  const value = (recorded: string, observed: string): RunEnvironmentMetadataValue | null => (
    recorded ? { value: recorded, provenance: 'recorded' }
      : observed ? { value: observed, provenance: 'observed' }
        : null
  );
  return {
    workspace: value(recordedWorkspace, observedWorkspace),
    branch: value(recordedBranch, observedBranch),
    model: value(recordedModel, observedModel),
  };
}

export function elapsedLabel(run: RunEnvironmentDetail, now = Date.now()): string {
  const started = Date.parse(run.runEnvironmentMeta?.scopeStartedAt ?? run.createdAt ?? '');
  if (!Number.isFinite(started)) return '';
  const terminalAt = run.completedAt || (!isRunLive(run) ? run.updatedAt : '') || '';
  const parsedEnd = terminalAt ? Date.parse(terminalAt) : now;
  if (!Number.isFinite(parsedEnd)) return '';
  const seconds = Math.max(0, Math.floor((parsedEnd - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function runEnvironmentTone(run: RunEnvironmentDetail): 'success' | 'warning' | 'danger' | 'neutral' | 'live' {
  const state = firstText(run.runState, run.status).toLowerCase();
  if (state === 'failed') return 'danger';
  if (state === 'completed' || state === 'done') return 'success';
  if (/waiting|approval|attention|stalled|paused/.test(state)) return 'warning';
  if (isRunLive(run)) return 'live';
  return 'neutral';
}

export function isRunEnvironmentCancellable(run: RunEnvironmentDetail): boolean {
  return run.canCancel === true
    && typeof run.cancelEndpoint === 'string'
    && run.cancelEndpoint.startsWith('/api/');
}

export function isRunEnvironmentBackgroundable(run: RunEnvironmentDetail): boolean {
  return run.canBackground === true
    && typeof run.backgroundEndpoint === 'string'
    && run.backgroundEndpoint.startsWith('/api/');
}
