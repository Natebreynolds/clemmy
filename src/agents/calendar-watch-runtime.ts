/**
 * Calendar watch — production ports and the daemon heartbeat.
 *
 * The read goes through the SAME prepared workflow read path a scheduled
 * `call:` step uses (live-catalog compile → identity → durable activation →
 * kernel), never the raw provider client, so the watch carries accepted read
 * authority like any other background read. Every connected calendar account
 * is read: when the catalog holds more than one account for the operation the
 * choice set is walked and each account compiles as its own exact selection.
 *
 * Jev answers "does this change matter?" for low-signal changes (see
 * calendar-watch.ts); the deterministic rule stands in whenever Jev is
 * unavailable, slow, or unsure.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import {
  compileLiveCatalogWorkflowCallPlan,
  ensureLiveReadCapabilityForOperation,
  type WorkflowCapabilityAccountSelectionV1,
} from '../execution/workflow-live-call-compiler.js';
import { executeWorkflowNodeRead } from '../execution/workflow-node-invocation-executor.js';
import type { WorkflowNodeCallExecutionIdentityV1 } from '../execution/workflow-node-invocation-executor.js';
import { nextWorkflowNodeAttempt } from '../runtime/harness/accepted-turn-call-authority.js';
import { peekCapabilityManifestStore } from '../runtime/harness/capability-manifest-store.js';
import { refreshIndependentCapabilityObservation } from '../runtime/harness/independent-capability-observation.js';
import { peekProductionCapabilityAdapter } from '../runtime/harness/production-capability-adapter.js';
import { listConnectedToolkits, peekConnectedToolkits } from '../integrations/composio/client.js';
import { peekAttestedTransport } from '../runtime/harness/implementation-artifacts/attested-transport.js';
import { ensureLiveComposioSchemaFingerprint, liveComposioSchemaFingerprint } from '../tools/composio-schema-cache.js';
import { HarnessSession } from '../runtime/harness/session.js';
import { tryJevWatchChangeVerdict } from '../runtime/jev/control-plane.js';
import { addNotification, getNotification, markNotificationRead } from '../runtime/notifications.js';
import { loadUserProfile } from '../runtime/user-profile.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import {
  DEFAULT_CALENDAR_WATCH_CONFIG,
  calendarReadOperation,
  emptyCalendarWatchState,
  formatWhen,
  processCalendarWatchTick,
  type CalendarReadOperation,
  type CalendarWatchAccountRead,
  type CalendarWatchChange,
  type CalendarWatchConfig,
  type CalendarWatchItem,
  type CalendarWatchJudgeVerdict,
  type CalendarWatchReadFailure,
  type CalendarWatchState,
  type CalendarWatchTickResult,
} from './calendar-watch.js';
import { isQuietHoursActive, loadProactivityPolicy, saveProactivityPolicy } from './proactivity-policy.js';

const logger = pino({ name: 'clementine-next.calendar-watch' });

export const CALENDAR_WATCH_ID = 'calendar';
export const CALENDAR_WATCH_SESSION_ID = 'watch:calendar';
const WATCH_OWNER_ID = 'watch:calendar';
const STATE_FILE = path.join(BASE_DIR, 'state', 'calendar-watch.json');
/** How often the heartbeat checks whether a tick is due. The tick cadence
 * itself is the policy's calendarWatchMinutes. */
export const CALENDAR_WATCH_HEARTBEAT_MS = 60_000;
const FIRST_HEARTBEAT_DELAY_MS = 30_000;
const READ_DEADLINE_MS = 45_000;
/** A tick whose reads all failed retries sooner than the cadence. */
const FAILED_READ_RETRY_MS = 5 * 60_000;

// ── state file ────────────────────────────────────────────────────────────────
export function loadCalendarWatchState(): CalendarWatchState {
  if (!existsSync(STATE_FILE)) return emptyCalendarWatchState();
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as Partial<CalendarWatchState>;
    const base = emptyCalendarWatchState();
    return {
      ...base,
      ...raw,
      version: 1,
      snapshot: raw.snapshot && typeof raw.snapshot === 'object' ? raw.snapshot : {},
      items: raw.items && typeof raw.items === 'object' ? raw.items : {},
      metrics: { ...base.metrics, ...(raw.metrics ?? {}) },
    };
  } catch {
    return emptyCalendarWatchState();
  }
}

export function saveCalendarWatchState(state: CalendarWatchState): void {
  const dir = path.dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmp, STATE_FILE);
}

// ── the attested read ─────────────────────────────────────────────────────────
function digest(domain: string, value: unknown): string {
  return createHash('sha256').update(closedCanonicalJson({ domain, version: 1, value }), 'utf8').digest('hex');
}

function ensureWatchSession(): HarnessSession {
  const existing = HarnessSession.load(CALENDAR_WATCH_SESSION_ID);
  if (existing) return existing;
  return HarnessSession.create({
    id: CALENDAR_WATCH_SESSION_ID,
    kind: 'workflow',
    channel: 'watch',
    title: 'Calendar watch',
    metadata: { source: 'watch', watch: CALENDAR_WATCH_ID, exactCallAuthority: 'workflow_v3_call' },
  });
}

export interface ConnectedCalendarOperation {
  /** The operation id exactly as the durable manifest spells it. The catalog
   * identity, the acquisition registry and the compiler all match on that
   * exact string; the watch never re-spells it. */
  operationId: string;
  providerKind: string;
  /** Every CURRENT durable manifest for the operation, one per account. */
  manifests: Array<{
    manifestId: string;
    accountId: string;
    definitionFingerprint: string;
    providerVersion: string;
    operationVersion: string;
  }>;
  provider: CalendarReadOperation;
}

/** Operations that have a CURRENT durable manifest. Nothing is acquired or
 * searched for a provider the owner never connected; that keeps a quiet tick
 * free of discovery work. */
export function connectedCalendarOperations(): ConnectedCalendarOperation[] {
  const store = peekCapabilityManifestStore();
  if (!store) return [];
  const present = new Map<string, ConnectedCalendarOperation>();
  for (const entry of store.list()) {
    const manifest = entry.manifest as {
      manifestId?: unknown;
      operationId?: unknown;
      providerKind?: unknown;
      accountId?: unknown;
      definitionFingerprint?: unknown;
      providerVersion?: unknown;
      operationVersion?: unknown;
      lifecycle?: { state?: unknown };
    };
    const state = manifest.lifecycle?.state;
    if (state !== undefined && state !== 'current') continue;
    if (typeof manifest.operationId !== 'string') continue;
    const provider = calendarReadOperation(manifest.operationId);
    if (!provider) continue;
    const str = (value: unknown): string => (typeof value === 'string' ? value : '');
    const row = {
      manifestId: str(manifest.manifestId),
      accountId: str(manifest.accountId),
      definitionFingerprint: str(manifest.definitionFingerprint),
      providerVersion: str(manifest.providerVersion),
      operationVersion: str(manifest.operationVersion),
    };
    const existing = present.get(manifest.operationId);
    if (existing) {
      if (row.manifestId) existing.manifests.push(row);
      continue;
    }
    present.set(manifest.operationId, {
      operationId: manifest.operationId,
      providerKind: str(manifest.providerKind) || 'unknown',
      manifests: row.manifestId ? [row] : [],
      provider,
    });
  }
  return [...present.values()];
}

/**
 * A Composio manifest is only observable once this process holds the live
 * schema fingerprint for its operation; a cold daemon holds none, so the
 * catalog refresh reports the durable manifest "missing" and the compiler
 * says not-connected. The workflow runner warms the same fingerprint before a
 * Composio call step; the watch does the identical thing.
 */
async function warmProviderObservation(operation: ConnectedCalendarOperation): Promise<string | undefined> {
  if (operation.providerKind !== 'composio') return undefined;
  try {
    const fingerprint = await ensureLiveComposioSchemaFingerprint(operation.operationId);
    if (!fingerprint) return 'live provider schema unavailable for this operation';
  } catch (error) {
    return `live provider schema refresh failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  // The attested transport resolves an account against the connected
  // toolkits it can see; a cold process has seen none yet.
  try { await listConnectedToolkits(); } catch { /* the observation below reports it */ }
  // A durable manifest becomes a live candidate only after the attested
  // transport has observed the operation for its account in THIS process
  // (independent observation, 60 s freshness). Chat does this through the
  // materializer during discovery; the watch asks for the same observation
  // for each account the manifests name.
  const outcomes: string[] = [];
  let observed = 0;
  for (const manifest of operation.manifests) {
    if (!manifest.accountId) continue;
    try {
      const result = await refreshIndependentCapabilityObservation({
        operationId: operation.operationId,
        accountId: manifest.accountId,
        definitionFingerprint: manifest.definitionFingerprint,
        providerVersion: manifest.providerVersion,
        operationVersion: manifest.operationVersion,
      });
      if (result) observed += 1;
      else outcomes.push(`${manifest.accountId}: not observed`);
    } catch (error) {
      outcomes.push(`${manifest.accountId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (observed === 0 && operation.manifests.length > 0) {
    return `no account could be observed live (${outcomes.join('; ') || 'no account on the manifests'}; ${describeObservationInputs(operation)})`;
  }
  return undefined;
}

/** Name the inputs the attested observer needs, so a refusal is diagnosable
 * from the status card instead of from a debugger. */
function describeObservationInputs(operation: ConnectedCalendarOperation): string {
  const parts: string[] = [];
  try {
    const toolkit = operation.operationId.split('_')[0]?.toLowerCase() ?? '';
    const rows = peekConnectedToolkits();
    const matching = rows.filter((row) => String(row.slug ?? '').toLowerCase().includes(toolkit));
    parts.push(`connected toolkits ${rows.length}, ${toolkit}: ${matching.map((row) => `${row.connectionId}/${row.status}`).join(',') || 'none'}`);
  } catch (error) {
    parts.push(`connected toolkits unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  parts.push(`live schema ${liveComposioSchemaFingerprint(operation.operationId) ? 'present' : 'absent'}`);
  try {
    const transport = peekAttestedTransport();
    if (!transport) parts.push('transport unbound');
    else {
      const seen = operation.manifests
        .filter((m) => m.accountId && transport.observe({ operationId: operation.operationId, accountId: m.accountId }))
        .map((m) => m.accountId);
      parts.push(`transport observed: ${seen.join(',') || 'none'}`);
    }
  } catch (error) {
    parts.push(`transport unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parts.join('; ');
}

/** When the compiler still finds no candidate, ask the adapter why the
 * durable manifests did not register, so the failure names its cause. */
function explainMissingCandidates(operation: ConnectedCalendarOperation): string {
  try {
    const adapter = peekProductionCapabilityAdapter();
    if (!adapter || operation.manifests.length === 0) return 'no durable manifest';
    const result = adapter.refresh(new Set(operation.manifests.map((m) => m.manifestId)));
    if (result.refused.length === 0) return `${result.registered} registered, none refused`;
    return result.refused.map((entry) => `${entry.manifestId.split(':definition:')[1] ?? entry.manifestId}: ${entry.reason}`).join('; ');
  } catch (error) {
    return `adapter refresh failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

type AccountRead =
  | { ok: true; accountId: string; payload: unknown }
  | { ok: false; accountId?: string; reason: string; choiceSet?: { candidates: readonly { capabilityId: string; accountId: string }[]; digest: string } };

async function readOneAccount(input: {
  operationId: string;
  args: Record<string, unknown>;
  tickId: string;
  sessionId: string;
  selectedAccount?: WorkflowCapabilityAccountSelectionV1;
}): Promise<AccountRead> {
  const nodeId = input.selectedAccount ? `events:${input.selectedAccount.accountId}` : 'events';
  const acquisition = await ensureLiveReadCapabilityForOperation({
    ownerId: WATCH_OWNER_ID,
    nodeId,
    operationId: input.operationId,
    expectedEffect: 'read',
    deadlineAt: Date.now() + READ_DEADLINE_MS,
  });
  if (acquisition.status !== 'present') {
    // Supply only, exactly as the workflow runner treats it: the compiler
    // below re-materializes the durable manifests and decides for itself.
    logger.debug({ operationId: input.operationId, acquisition }, 'calendar watch: live read acquisition');
  }
  const compiled = compileLiveCatalogWorkflowCallPlan({
    ownerId: WATCH_OWNER_ID,
    nodeId,
    operationId: input.operationId,
    args: input.args,
    expectedEffect: 'read',
    requirementNamespace: 'watch-call',
    logicalCapabilityNamespace: 'watch.call',
    ...(input.selectedAccount ? { selectedAccount: input.selectedAccount } : {}),
  });
  if (!compiled.ok) {
    if (compiled.recoverable && compiled.reason === 'ambiguous-account' && compiled.accountChoiceSet && !input.selectedAccount) {
      return { ok: false, reason: compiled.message, choiceSet: compiled.accountChoiceSet };
    }
    return { ok: false, ...(input.selectedAccount ? { accountId: input.selectedAccount.accountId } : {}), reason: compiled.message };
  }
  const plan = compiled.plan;
  const workflowDigest = digest('calendar-watch-contract', { watch: CALENDAR_WATCH_ID, operationId: input.operationId, argKeys: Object.keys(input.args).sort() });
  const bindingSnapshotDigest = digest('calendar-watch-binding', plan.binding);
  const controlDigest = digest('calendar-watch-control', { operationId: input.operationId, nodeId, effect: 'read' });
  const runId = `watch:calendar:${input.tickId}`;
  const identityBase = {
    workflowId: WATCH_OWNER_ID,
    workflowRevision: 1,
    workflowDigest,
    runId,
    runOccurrenceId: runId,
    nodeId,
    invocationPlanDigest: plan.bindingDigest,
    bindingSnapshotDigest,
    controlDigest,
  };
  const identity: WorkflowNodeCallExecutionIdentityV1 = {
    ...identityBase,
    nodeAttempt: nextWorkflowNodeAttempt(identityBase),
  };
  const result = await executeWorkflowNodeRead({
    sessionId: input.sessionId,
    plan,
    identity,
    arguments: { workflowInputs: input.args, stepOutputs: {} },
    cancelled: false,
  });
  const accountId = compiled.identity.account;
  if (!result.ok) {
    return { ok: false, accountId, reason: `${result.block.code}: ${result.block.message}` };
  }
  return { ok: true, accountId, payload: result.result };
}

/** Read every connected calendar account through the prepared read path. */
export async function readCalendarAccountsAttested(
  window: { startIso: string; endIso: string; top: number; timezone: string },
  tickId: string,
): Promise<{ reads: CalendarWatchAccountRead[]; failures: CalendarWatchReadFailure[] }> {
  const reads: CalendarWatchAccountRead[] = [];
  const failures: CalendarWatchReadFailure[] = [];
  const operations = connectedCalendarOperations();
  if (operations.length === 0) {
    failures.push({ operationId: 'calendar', reason: 'no connected calendar read is registered (connect Outlook or Google Calendar)' });
    return { reads, failures };
  }
  const sessionId = ensureWatchSession().id;
  const accountLabels = accountLabelsByConnectionId();
  for (const connected of operations) {
    const { operationId, provider: operation } = connected;
    const args = operation.args(window);
    const warm = await warmProviderObservation(connected);
    if (warm) {
      failures.push({ operationId, reason: warm });
      continue;
    }
    const first = await readOneAccount({ operationId, args, tickId, sessionId });
    const perAccount: AccountRead[] = [];
    if (!first.ok && first.choiceSet) {
      for (const candidate of first.choiceSet.candidates) {
        perAccount.push(await readOneAccount({
          operationId,
          args,
          tickId,
          sessionId,
          selectedAccount: {
            capabilityId: candidate.capabilityId,
            accountId: candidate.accountId,
            choiceSetDigest: first.choiceSet.digest,
          },
        }));
      }
    } else {
      perAccount.push(first);
    }
    for (const read of perAccount) {
      if (!read.ok) {
        const reason = /No current capability is registered/.test(read.reason)
          ? `${read.reason} (catalog: ${explainMissingCandidates(connected)})`
          : read.reason;
        failures.push({ operationId, ...(read.accountId ? { accountId: read.accountId } : {}), reason });
        continue;
      }
      reads.push({
        operationId: operation.operationId,
        accountId: read.accountId,
        accountLabel: accountLabels.get(read.accountId) ?? read.accountId,
        events: operation.parse(read.payload),
      });
    }
  }
  return { reads, failures };
}

function accountLabelsByConnectionId(): Map<string, string> {
  const labels = new Map<string, string>();
  try {
    const file = path.join(BASE_DIR, 'state', 'capability-live-identity.json');
    if (!existsSync(file)) return labels;
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const record = value as Record<string, unknown>;
      const id = typeof record.connectionId === 'string' ? record.connectionId : typeof record.accountId === 'string' ? record.accountId : undefined;
      const label = typeof record.accountEmail === 'string' ? record.accountEmail : typeof record.accountLabel === 'string' ? record.accountLabel : typeof record.label === 'string' ? record.label : undefined;
      if (id && label && !labels.has(id)) labels.set(id, label);
      Object.values(record).forEach(visit);
    };
    visit(raw);
  } catch { /* labels are cosmetic */ }
  return labels;
}

// ── Jev port ──────────────────────────────────────────────────────────────────
export async function judgeCalendarChangeWithJev(
  change: CalendarWatchChange,
  context: { timezone: string; nowMs: number },
): Promise<CalendarWatchJudgeVerdict | null> {
  const ev = change.event;
  const verdict = await tryJevWatchChangeVerdict({
    watch: 'calendar',
    sessionId: CALENDAR_WATCH_SESSION_ID,
    change: {
      kind: change.kind,
      reasons: change.reasons,
      subject: ev.subject.slice(0, 160),
      startsAt: formatWhen(ev.startMs, context.nowMs, context.timezone),
      minutesUntilStart: Math.round((ev.startMs - context.nowMs) / 60_000),
      durationMinutes: Math.round((ev.endMs - ev.startMs) / 60_000),
      ...(change.previous
        ? {
            previousStart: formatWhen(change.previous.startMs, context.nowMs, context.timezone),
            shiftMinutes: Math.round((ev.startMs - change.previous.startMs) / 60_000),
          }
        : {}),
      attendees: ev.attendeeCount,
      myResponse: ev.myResponse || 'none',
      showAs: ev.showAs || 'busy',
      ...(ev.organizer ? { organizer: ev.organizer } : {}),
      ...(change.other ? { overlapsWith: change.other.subject.slice(0, 120) } : {}),
    },
  });
  return verdict;
}

// ── policy ────────────────────────────────────────────────────────────────────
export interface CalendarWatchPolicyView {
  enabled: boolean;
  cadenceMinutes: number;
  quietHoursActive: boolean;
}

/** The calendar watch has its own switch. It does not require the global
 * "proactive work" switch: it only reads and produces items, never acts. */
export function calendarWatchPolicy(): CalendarWatchPolicyView {
  const policy = loadProactivityPolicy();
  return {
    enabled: policy.calendarWatchEnabled,
    cadenceMinutes: policy.calendarWatchMinutes,
    quietHoursActive: isQuietHoursActive(policy),
  };
}

export function setCalendarWatchPolicy(patch: { enabled?: boolean; cadenceMinutes?: number }): CalendarWatchPolicyView {
  saveProactivityPolicy({
    ...(patch.enabled !== undefined ? { calendarWatchEnabled: patch.enabled } : {}),
    ...(patch.cadenceMinutes !== undefined ? { calendarWatchMinutes: patch.cadenceMinutes } : {}),
  });
  return calendarWatchPolicy();
}

// ── ticks ─────────────────────────────────────────────────────────────────────
let inFlight: Promise<CalendarWatchTickResult> | null = null;

function newTickId(nowMs: number): string {
  return `tick-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function watchTimezone(): string {
  try {
    return loadUserProfile().timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }
}

export function calendarWatchConfig(): CalendarWatchConfig {
  return { ...DEFAULT_CALENDAR_WATCH_CONFIG };
}

/** One tick, single-flight. `force` runs even when the watch is disabled or
 * not yet due (the console's "Check now"); the heartbeat never forces. */
export function runCalendarWatchTick(options: { source: string; force?: boolean } = { source: 'heartbeat' }): Promise<CalendarWatchTickResult> {
  if (inFlight) return inFlight;
  const nowMs = Date.now();
  const tickId = newTickId(nowMs);
  const run = processCalendarWatchTick({
    now: () => Date.now(),
    tickId,
    source: options.source,
    timezone: watchTimezone(),
    config: calendarWatchConfig(),
    readAccounts: (window) => readCalendarAccountsAttested(window, tickId),
    judgeChange: judgeCalendarChangeWithJev,
    notify: addNotification,
    isNotificationRead: (id) => getNotification(id)?.read === true,
    markNotificationRead: (id) => { markNotificationRead(id); },
    loadState: loadCalendarWatchState,
    saveState: saveCalendarWatchState,
  }).then((result) => {
    logger.info(
      {
        tickId,
        source: options.source,
        durationMs: result.durationMs,
        accounts: result.accounts,
        events: result.events,
        changes: result.changes,
        produced: result.produced,
        vetoed: result.vetoed,
        retired: result.retired,
        judged: result.judged,
        quiet: result.quiet,
        readFailures: result.readFailures,
      },
      result.quiet ? 'calendar watch: quiet tick' : 'calendar watch: tick',
    );
    return result;
  }).finally(() => { inFlight = null; });
  inFlight = run;
  return run;
}

export function isCalendarWatchDue(nowMs = Date.now()): { due: boolean; reason: string; nextAt?: string } {
  const policy = calendarWatchPolicy();
  if (!policy.enabled) return { due: false, reason: 'disabled' };
  if (policy.quietHoursActive) return { due: false, reason: 'quiet_hours' };
  const state = loadCalendarWatchState();
  const lastReadFailed = Boolean(state.lastFinding && state.lastFinding.accounts === 0 && state.lastFinding.readFailures > 0);
  const intervalMs = lastReadFailed
    ? Math.min(policy.cadenceMinutes * 60_000, FAILED_READ_RETRY_MS)
    : policy.cadenceMinutes * 60_000;
  const last = state.lastTickAt ? Date.parse(state.lastTickAt) : NaN;
  if (!Number.isFinite(last)) return { due: true, reason: 'never_ran' };
  const nextAt = last + intervalMs;
  if (nowMs >= nextAt) return { due: true, reason: 'interval_elapsed', nextAt: new Date(nextAt).toISOString() };
  return { due: false, reason: 'not_yet', nextAt: new Date(nextAt).toISOString() };
}

/** Daemon heartbeat: checks every minute, ticks on the policy cadence. */
export function startCalendarWatchHeartbeat(): { stop: () => void } {
  const beat = (): void => {
    let due: ReturnType<typeof isCalendarWatchDue>;
    try {
      due = isCalendarWatchDue();
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'calendar watch: due check failed');
      return;
    }
    if (!due.due) return;
    runCalendarWatchTick({ source: 'heartbeat' }).catch((error) => {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'calendar watch: tick failed');
    });
  };
  const first = setTimeout(beat, FIRST_HEARTBEAT_DELAY_MS);
  first.unref?.();
  const timer = setInterval(beat, CALENDAR_WATCH_HEARTBEAT_MS);
  timer.unref?.();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}

// ── status for the console ────────────────────────────────────────────────────
export interface CalendarWatchStatus {
  id: 'calendar';
  title: string;
  purpose: string;
  enabled: boolean;
  cadenceMinutes: number;
  quietHoursActive: boolean;
  connectedOperations: string[];
  running: boolean;
  lastTickAt?: string;
  nextTickAt?: string;
  snapshotAt?: string;
  lastFinding?: CalendarWatchState['lastFinding'];
  lastError?: CalendarWatchState['lastError'];
  metrics: CalendarWatchState['metrics'];
  openItems: CalendarWatchItem[];
  recentlyRetired: CalendarWatchItem[];
}

export function calendarWatchStatus(nowMs = Date.now()): CalendarWatchStatus {
  const policy = calendarWatchPolicy();
  const state = loadCalendarWatchState();
  const due = isCalendarWatchDue(nowMs);
  const items = Object.values(state.items);
  const open = items.filter((item) => !item.retiredAt).sort((a, b) => a.eventStartMs - b.eventStartMs);
  const retired = items
    .filter((item) => item.retiredAt)
    .sort((a, b) => (b.retiredAt ?? '').localeCompare(a.retiredAt ?? ''))
    .slice(0, 8);
  let connectedOperations: string[] = [];
  try { connectedOperations = connectedCalendarOperations().map((op) => op.operationId); } catch { /* status stays honest with an empty list */ }
  return {
    id: 'calendar',
    title: 'Calendar watch',
    purpose: 'Reads the next 24 hours of every connected calendar on a heartbeat and raises one item per meaningful change: cancellations, new double-bookings, invites awaiting your reply, and moves that matter. It never creates, edits or replies to events.',
    enabled: policy.enabled,
    cadenceMinutes: policy.cadenceMinutes,
    quietHoursActive: policy.quietHoursActive,
    connectedOperations,
    running: inFlight !== null,
    ...(state.lastTickAt ? { lastTickAt: state.lastTickAt } : {}),
    ...(due.nextAt ? { nextTickAt: due.nextAt } : policy.enabled && !state.lastTickAt ? { nextTickAt: new Date(nowMs).toISOString() } : {}),
    ...(state.snapshotAt ? { snapshotAt: state.snapshotAt } : {}),
    ...(state.lastFinding ? { lastFinding: state.lastFinding } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
    metrics: state.metrics,
    openItems: open,
    recentlyRetired: retired,
  };
}
