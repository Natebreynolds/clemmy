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
import { withDaemonRuntimePhase } from '../daemon/phase.js';
import {
  compileLiveCatalogWorkflowCallPlan,
  ensureLiveReadCapabilityForOperation,
  isCapabilityNotRegisteredMessage,
  type WorkflowCapabilityAccountSelectionV1,
} from '../execution/workflow-live-call-compiler.js';
import { executeWorkflowNodeRead } from '../execution/workflow-node-invocation-executor.js';
import type { WorkflowNodeCallExecutionIdentityV1 } from '../execution/workflow-node-invocation-executor.js';
import { nextWorkflowNodeAttempt } from '../runtime/harness/accepted-turn-call-authority.js';
import { peekCapabilityManifestStore } from '../runtime/harness/capability-manifest-store.js';
import { refreshIndependentCapabilityObservation } from '../runtime/harness/independent-capability-observation.js';
import { peekProductionCapabilityAdapter } from '../runtime/harness/production-capability-adapter.js';
import { listComposioToolkitTools, listConnectedToolkits, peekConnectedToolkits } from '../integrations/composio/client.js';
import { peekTurnSemanticModelPort } from '../runtime/semantic-boundary/turn-semantic-port-registry.js';
import { CALENDAR_READ_RECIPE_PURPOSE } from '../runtime/semantic-boundary/turn-semantic-model-port.js';
import {
  CalendarReadRecipeV1Schema,
  learnedCalendarRead,
  listLearnedCalendarReads,
  recipeArgs,
  recipeParse,
  recipeReadsPayload,
  rememberCalendarRead,
  type LearnedCalendarRead,
} from './calendar-read-recipe.js';
import { peekAttestedTransport } from '../runtime/harness/implementation-artifacts/attested-transport.js';
import { ensureLiveComposioSchemaFingerprint, liveComposioSchemaFingerprint } from '../tools/composio-schema-cache.js';
import { HarnessSession } from '../runtime/harness/session.js';
import { appendEvent } from '../runtime/harness/eventlog.js';
import { prepareWorkflowStepExternalCatalog } from '../execution/workflow-step-external-catalog.js';
import { isolatedTestContractActive } from '../runtime/harness/isolated-test-contract.js';
import { tryJevWatchChangeVerdict } from '../runtime/jev/control-plane.js';
import { addNotification, getNotification, markNotificationRead } from '../runtime/notifications.js';
import { loadUserProfile } from '../runtime/user-profile.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import {
  DEFAULT_CALENDAR_WATCH_CONFIG,
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

function readOperationFromRecipe(learned: LearnedCalendarRead): CalendarReadOperation {
  const { recipe } = learned;
  return {
    operationId: recipe.operationId,
    args: (window) => recipeArgs(recipe, window),
    parse: (payload, context) => recipeParse(recipe, payload, context),
  };
}

/** The calendar reads the watch knows how to make: one learned read per
 * connected provider, with every CURRENT durable manifest the catalog holds
 * for it (one per account). A learned read whose provider is no longer
 * connected is left alone; it is not read. */
export function connectedCalendarOperations(): ConnectedCalendarOperation[] {
  const connectedToolkits = new Set(peekConnectedToolkits()
    .filter((row) => String(row.status ?? '').toLowerCase() !== 'disconnected')
    .map((row) => String(row.slug ?? '').trim().toLowerCase())
    .filter(Boolean));
  const learned = listLearnedCalendarReads()
    .filter((row) => connectedToolkits.size === 0 || connectedToolkits.has(row.toolkit));
  if (learned.length === 0) return [];
  const byOperation = new Map<string, ConnectedCalendarOperation>();
  for (const row of learned) {
    byOperation.set(row.recipe.operationId.toLowerCase(), {
      operationId: row.recipe.operationId,
      providerKind: 'composio',
      manifests: [],
      provider: readOperationFromRecipe(row),
    });
  }
  const store = peekCapabilityManifestStore();
  for (const entry of store?.list() ?? []) {
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
    const target = byOperation.get(manifest.operationId.toLowerCase());
    if (!target) continue;
    const str = (value: unknown): string => (typeof value === 'string' ? value : '');
    // The catalog's own spelling wins once a manifest exists.
    target.operationId = manifest.operationId;
    target.providerKind = str(manifest.providerKind) || target.providerKind;
    if (str(manifest.manifestId)) {
      target.manifests.push({
        manifestId: str(manifest.manifestId),
        accountId: str(manifest.accountId),
        definitionFingerprint: str(manifest.definitionFingerprint),
        providerVersion: str(manifest.providerVersion),
        operationVersion: str(manifest.operationVersion),
      });
    }
  }
  return [...byOperation.values()];
}

// ── learning the read ─────────────────────────────────────────────────────────
const MAX_CANDIDATE_OPERATIONS = 40;
const MAX_SCHEMA_CHARS = 4_000;
const MAX_SAMPLE_CHARS = 6_000;
const LEARN_RETRY_MS = 30 * 60_000;
/** Per toolkit: when learning last failed, so a quiet tick does not spend a
 * model call every few minutes on a provider that keeps refusing. */
const learnAttempts = new Map<string, number>();
export function _resetCalendarReadLearningForTests(): void { learnAttempts.clear(); resampled.clear(); }

function bounded(value: unknown, max: number): string {
  let text: string;
  try { text = typeof value === 'string' ? value : JSON.stringify(value ?? null) ?? 'null'; } catch { text = String(value); }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Make sure every connected provider that can list a calendar has a learned
 * read. A provider with no recipe, or whose definition changed since the
 * recipe was written, gets one derived from its own current definitions by
 * the judge role; the recipe is remembered against that definition. Returns
 * what could not be learned, named, for the tick's failure list.
 */
export interface CalendarReadLearningDeps {
  now: () => number;
  listToolkits: () => Promise<Array<{ slug: string; status: string }>>;
  listTools: (toolkit: string, limit: number) => Promise<Array<{ slug: string; name?: string; description?: string; inputParameters?: unknown; outputParameters?: unknown }>>;
  fingerprint: (operationId: string) => Promise<string | undefined>;
  port: () => Pick<NonNullable<ReturnType<typeof peekTurnSemanticModelPort>>, 'deriveCalendarRead'> | null;
}
const productionLearningDeps: CalendarReadLearningDeps = {
  now: Date.now,
  listToolkits: async () => (await listConnectedToolkits()).map((row) => ({ slug: String(row.slug ?? ''), status: String(row.status ?? '') })),
  listTools: (toolkit, limit) => listComposioToolkitTools(toolkit, limit),
  fingerprint: (operationId) => ensureLiveComposioSchemaFingerprint(operationId),
  port: () => peekTurnSemanticModelPort(),
};
export async function ensureLearnedCalendarReads(overrides: Partial<CalendarReadLearningDeps> = {}): Promise<string[]> {
  const deps = { ...productionLearningDeps, ...overrides };
  const now = deps.now;
  const notes: string[] = [];
  let toolkits: Array<{ slug: string; status: string }> = [];
  try {
    toolkits = (await deps.listToolkits()).map((row) => ({ slug: row.slug.trim().toLowerCase(), status: row.status }));
  } catch (error) {
    return [`connected providers unavailable: ${error instanceof Error ? error.message : String(error)}`];
  }
  const active = [...new Set(toolkits.filter((row) => row.slug && row.status.toLowerCase() !== 'disconnected').map((row) => row.slug))];
  const learned = new Map(listLearnedCalendarReads().map((row) => [row.toolkit, row]));
  for (const toolkit of active) {
    const existing = learned.get(toolkit);
    if (existing) {
      // Still the definition it was read from? A changed definition means
      // the recipe is no longer evidence.
      let current: string | undefined;
      try { current = await deps.fingerprint(existing.recipe.operationId); } catch { current = undefined; }
      if (!current || current === existing.definitionFingerprint) continue;
    }
    const last = learnAttempts.get(toolkit) ?? 0;
    if (now() - last < LEARN_RETRY_MS) continue;
    learnAttempts.set(toolkit, now());
    const note = await learnCalendarReadForToolkit(toolkit, deps);
    if (note) notes.push(`${toolkit}: ${note}`);
    else learnAttempts.delete(toolkit);
  }
  return notes;
}

async function learnCalendarReadForToolkit(toolkit: string, deps: CalendarReadLearningDeps, sample?: { operationId: string; response: string }): Promise<string | null> {
  const port = deps.port();
  if (!port?.deriveCalendarRead) return 'no model is available to learn this provider\'s calendar read; it will be tried again';
  let tools: Awaited<ReturnType<CalendarReadLearningDeps['listTools']>>;
  try {
    tools = await deps.listTools(toolkit, MAX_CANDIDATE_OPERATIONS);
  } catch (error) {
    return `its operations could not be listed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (tools.length === 0) return 'it lists no operations';
  const operations = tools.map((tool) => ({
    operationId: tool.slug,
    description: bounded(tool.description ?? tool.name ?? '', 600),
    // A provider schema is text for the model, not a closed-domain value:
    // live 2026-10-01 a description holding a non-JSON value refused the
    // canonical form and the whole tick with it.
    inputSchema: bounded(tool.inputParameters ?? {}, MAX_SCHEMA_CHARS),
    ...(tool.outputParameters ? { outputSchema: bounded(tool.outputParameters, MAX_SCHEMA_CHARS) } : {}),
  }));
  const evidenceDigest = createHash('sha256').update(JSON.stringify({ toolkit, operations, sample: sample ?? null }), 'utf8').digest('hex');
  let answer: Awaited<ReturnType<NonNullable<typeof port.deriveCalendarRead>>>;
  try {
    answer = await port.deriveCalendarRead({ purpose: CALENDAR_READ_RECIPE_PURPOSE, operations, ...(sample ? { sample } : {}), evidenceDigest });
  } catch (error) {
    return `the model could not read its definitions: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (answer.evidenceDigest !== evidenceDigest) return 'the model answered for different evidence';
  if (answer.recipe === null) return 'none of its operations lists calendar events in a time window';
  const parsed = CalendarReadRecipeV1Schema.safeParse(answer.recipe);
  if (!parsed.success) return `the model\'s recipe was not well-formed: ${parsed.error.issues[0]?.message ?? 'invalid'}`;
  const chosen = tools.find((tool) => tool.slug.toLowerCase() === parsed.data.operationId.toLowerCase());
  if (!chosen) return `the model named an operation this provider does not list (${parsed.data.operationId})`;
  const recipe = { ...parsed.data, operationId: chosen.slug };
  let fingerprint: string | undefined;
  try { fingerprint = await deps.fingerprint(chosen.slug); } catch { fingerprint = undefined; }
  if (!fingerprint) return `the live definition of ${chosen.slug} could not be fingerprinted`;
  rememberCalendarRead({
    recipe, toolkit, definitionFingerprint: fingerprint,
    basis: { learnedAt: new Date().toISOString(), modelIdentity: answer.modelIdentity, ...(sample ? { fromSample: true } : {}) },
  });
  logger.info({ toolkit, operationId: chosen.slug, model: answer.modelIdentity, fromSample: Boolean(sample) }, 'calendar watch: learned the provider\'s calendar read');
  return null;
}

/** A recipe that reads no event out of a non-empty response is wrong about
 * the fields. Derive it again once with that response as the sample. */
const resampled = new Set<string>();
async function relearnFromSample(toolkit: string, operationId: string, payload: unknown): Promise<LearnedCalendarRead | null> {
  const deps = productionLearningDeps;
  const key = `${toolkit}:${operationId.toLowerCase()}`;
  if (resampled.has(key)) return null;
  resampled.add(key);
  const note = await learnCalendarReadForToolkit(toolkit, deps, { operationId, response: bounded(payload, MAX_SAMPLE_CHARS) });
  if (note) {
    logger.warn({ toolkit, operationId, note }, 'calendar watch: could not relearn the read from a sample');
    return null;
  }
  return listLearnedCalendarReads().find((row) => row.toolkit === toolkit) ?? null;
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
    // Best effort only: the transport may already hold an observation for
    // these accounts (a chat turn, or the boot reconstruction, registered
    // it), and the compiler's own refresh adopts it. The note travels with a
    // compile failure so the cause is named there.
    return `no account could be refreshed live (${outcomes.join('; ') || 'no account on the manifests'}; ${describeObservationInputs(operation)})`;
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
      const seen = operation.manifests.flatMap((m) => {
        if (!m.accountId) return [];
        const live = transport.observe({ operationId: operation.operationId, accountId: m.accountId });
        if (!live) return [];
        const same = live.definitionFingerprint === m.definitionFingerprint
          && live.providerVersion === m.providerVersion
          && live.operationVersion === m.operationVersion;
        return [`${m.accountId}${same ? ' matches manifest' : ` differs (live ${live.definitionFingerprint.slice(0, 8)}/${live.operationVersion} vs manifest ${m.definitionFingerprint.slice(0, 8)}/${m.operationVersion})`}`];
      });
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

type CalendarReadPreparer = typeof prepareWorkflowStepExternalCatalog;
let calendarReadPreparer: CalendarReadPreparer = prepareWorkflowStepExternalCatalog;
export function _setCalendarReadPreparerForTests(preparer: CalendarReadPreparer | null): void {
  if (!isolatedTestContractActive()) throw new Error('calendar read preparer overrides are isolated-test only');
  calendarReadPreparer = preparer ?? prepareWorkflowStepExternalCatalog;
}

/**
 * Prepare one learned read against the provider's CURRENT definition before
 * compiling it, the way a workflow step and a Space refresh do. A provider
 * that changes an operation's definition leaves the watch's durable manifest
 * behind; the compiler then refuses it as mismatched on every tick (live
 * 2026-09-25 → 10-01: 443 of 768 reads failed that way, nothing was ever
 * rebound). The preparer revalidates, and provisions the live definition as
 * the stored manifest's successor when it drifted. It needs an accepted
 * source for that rebind; the watch mints one per tick in its own session,
 * a system event, never a person's turn. Returns a note when preparation
 * refused; the compiler still decides on its own.
 */
async function prepareLearnedRead(operation: ConnectedCalendarOperation, tickId: string, sessionId: string): Promise<string | undefined> {
  const accounts = [...new Set(operation.manifests.map((m) => m.accountId).filter(Boolean))];
  const notes: string[] = [];
  for (const accountId of accounts.length ? accounts : ['']) {
    const acceptedInput = `Calendar watch ${tickId}: read ${operation.operationId}${accountId ? ` on ${accountId}` : ''}`;
    let source: { sessionId: string; sourceUserSeq: number; acceptedInput: string };
    try {
      const event = appendEvent({ sessionId, turn: 0, role: 'system', type: 'user_input_received',
        data: { text: acceptedInput, synthetic: true, source: 'calendar_watch', tickId, operationId: operation.operationId, ...(accountId ? { accountId } : {}) } });
      source = { sessionId, sourceUserSeq: event.seq, acceptedInput };
    } catch (error) {
      notes.push(`${accountId || 'any account'}: could not record the preparation (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    try {
      const prepared = await calendarReadPreparer({ immutablePrompt: accountId, allowedTools: [operation.operationId], acceptedSource: source });
      if (prepared.status === 'ready') continue;
      notes.push(`${accountId || 'any account'}: ${prepared.status === 'refused' ? [prepared.reason, prepared.detail].filter(Boolean).join(':') : 'no durable manifest'}`);
    } catch (error) {
      notes.push(`${accountId || 'any account'}: preparation failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return notes.length ? `preparation: ${notes.join('; ')}` : undefined;
}

/** Read every connected calendar account through the prepared read path. */
export async function readCalendarAccountsAttested(
  window: { startIso: string; endIso: string; top: number; timezone: string },
  tickId: string,
): Promise<{ reads: CalendarWatchAccountRead[]; failures: CalendarWatchReadFailure[] }> {
  const reads: CalendarWatchAccountRead[] = [];
  const failures: CalendarWatchReadFailure[] = [];
  for (const note of await ensureLearnedCalendarReads()) failures.push({ operationId: 'calendar', reason: `calendar read not learned for ${note}` });
  const operations = connectedCalendarOperations();
  if (operations.length === 0) {
    if (failures.length === 0) failures.push({ operationId: 'calendar', reason: 'no connected provider lists a calendar (connect one in Settings)' });
    return { reads, failures };
  }
  const sessionId = ensureWatchSession().id;
  const accountLabels = accountLabelsByConnectionId();
  for (const connected of operations) {
    const { operationId, provider: operation } = connected;
    const args = operation.args(window);
    const prepareNote = await prepareLearnedRead(connected, tickId, sessionId);
    const warmNote = [await warmProviderObservation(connected), prepareNote].filter(Boolean).join('; ') || undefined;
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
        const reason = isCapabilityNotRegisteredMessage(read.reason)
          ? `${read.reason} (catalog: ${explainMissingCandidates(connected)}${warmNote ? `; ${warmNote}` : ''})`
          : prepareNote ? `${read.reason} (${prepareNote})` : read.reason;
        failures.push({ operationId, ...(read.accountId ? { accountId: read.accountId } : {}), reason });
        continue;
      }
      let events = operation.parse(read.payload, { timezone: window.timezone });
      if (events.length === 0) {
        // The provider answered with events the recipe cannot read: the
        // recipe is wrong about the fields, not the calendar empty.
        const learned = listLearnedCalendarReads().find((row) => row.recipe.operationId.toLowerCase() === operationId.toLowerCase());
        if (learned && recipeReadsPayload(learned.recipe, read.payload, window.timezone) === 'misses') {
          const relearned = await relearnFromSample(learned.toolkit, operationId, read.payload);
          if (relearned) events = recipeParse(relearned.recipe, read.payload, { timezone: window.timezone });
          if (events.length === 0) {
            failures.push({ operationId, accountId: read.accountId, reason: 'the provider returned events the learned read could not interpret' });
            continue;
          }
        }
      }
      reads.push({
        operationId: operation.operationId,
        accountId: read.accountId,
        accountLabel: accountLabels.get(read.accountId) ?? read.accountId,
        events,
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
  const run = (async (): Promise<CalendarWatchTickResult> => {
    // A home with no calendar is quiet, not failing: no read to retry every
    // five minutes, no error on the card. Live (blank home): the first tick
    // reported "Read failed" and armed the failed-read retry. A connected
    // provider whose read is not learned yet is given its chance here first.
    const learningNotes = connectedCalendarOperations().length === 0 ? await ensureLearnedCalendarReads() : [];
    if (connectedCalendarOperations().length === 0 && learningNotes.length === 0) {
      const state = loadCalendarWatchState();
      const finding: CalendarWatchState['lastFinding'] = {
        tickId, at: new Date(nowMs).toISOString(), source: options.source, durationMs: 0,
        accounts: 0, events: 0, changes: 0, produced: 0, vetoed: 0, retired: 0, quiet: true, readFailures: 0,
        summary: 'No calendar connected yet (connect one in Settings to start watching).',
      };
      state.lastTickAt = finding.at;
      state.lastFinding = finding;
      state.metrics.ticks += 1;
      state.metrics.quietTicks += 1;
      saveCalendarWatchState(state);
      return {
        ...finding,
        items: [], changesByKind: {}, judged: 0, duplicatesSuppressed: 0, acknowledged: 0, failures: [], seenEvents: [],
      } as CalendarWatchTickResult;
    }
    return processCalendarWatchTick({
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
    });
  })().then((result) => {
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
  // Its own phase, so time this timer holds the main thread is named.
  const beat = (): void => {
    void withDaemonRuntimePhase('daemon.timer.calendar_watch', {}, async () => {
      let due: ReturnType<typeof isCalendarWatchDue>;
      try {
        due = isCalendarWatchDue();
      } catch (error) {
        logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'calendar watch: due check failed');
        return;
      }
      if (!due.due) return;
      await runCalendarWatchTick({ source: 'heartbeat' }).catch((error) => {
        logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'calendar watch: tick failed');
      });
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
