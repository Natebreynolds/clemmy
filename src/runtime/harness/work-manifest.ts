import { appendEvent, getSession, listEvents, type EventRow } from './eventlog.js';

export type WorkItemStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'needs_validation'
  | 'invalidated';

export type WorkEvidenceKind =
  | 'artifact'
  | 'source'
  | 'external_write'
  | 'tool_result'
  | 'worker_result'
  | 'readback'
  | 'other';

export interface WorkEvidenceRef {
  kind: WorkEvidenceKind;
  ref: string;
  summary?: string;
}

export interface WorkManifestPhase {
  id: string;
  label?: string;
  dependsOn?: string[];
}

export interface WorkManifestItem {
  id: string;
  label?: string;
  aliases?: string[];
}

export interface DeclareWorkManifestInput {
  sessionId: string;
  manifestId: string;
  contractVersion: string | number;
  objective?: string;
  phases: WorkManifestPhase[];
  items: WorkManifestItem[];
  /** `declare` is idempotent. `extend` explicitly adds items/phases; checkpoints
   * never expand a manifest implicitly, which prevents row labels and record ids
   * from becoming two logical jobs. */
  mode?: 'declare' | 'extend';
}

export interface CheckpointWorkItemInput {
  sessionId: string;
  manifestId: string;
  contractVersion: string | number;
  phase: string;
  /** Canonical id is preferred; a previously declared alias is accepted. */
  itemId: string;
  status: Exclude<WorkItemStatus, 'pending' | 'needs_validation'>;
  attemptId?: string;
  evidence?: WorkEvidenceRef[];
  reason?: string;
}

export interface ReviseWorkContractInput {
  sessionId: string;
  manifestId: string;
  fromVersion?: string | number;
  toVersion: string | number;
  instruction: string;
  evidencePolicy: 'preserve' | 'revalidate' | 'invalidate';
  /** Omit to apply the revision to every phase. */
  phases?: string[];
}

export interface WorkerManifestDescriptor {
  id: string;
  contractVersion: string | number;
  phase: string;
  /** First use declares; later uses reconcile. Expansion is never implicit. */
  mode?: 'declare' | 'reconcile' | 'extend' | null;
  phases?: WorkManifestPhase[] | null;
  /** Exact worker item label -> canonical manifest item id. */
  aliases?: Array<{ alias: string; itemId: string }> | Record<string, string> | null;
}

export interface PreparedWorkerManifest {
  manifestId: string;
  contractVersion: string;
  phase: string;
  itemIds: Map<string, string>;
}

export interface PreparedWorkerCompletion {
  itemId: string;
  state: WorkItemPhaseState;
  /**
   * Packet identities recovered from the worker_result evidence that proved the
   * success. A resumed brain may construct a different packet for the same
   * logical item; these keys let it recover the original persisted work-product
   * without weakening packet-key isolation for unrelated work.
   */
  packetKeys: string[];
}

export interface PreparedWorkerReuseSummary {
  completedItems: string[];
  phaseComplete: boolean;
}

export type PrepareWorkerManifestResult =
  | { ok: true; binding: PreparedWorkerManifest }
  | { ok: false; error: string };

export interface WorkItemPhaseState {
  status: WorkItemStatus;
  contractVersion: string;
  attempts: number;
  evidence: WorkEvidenceRef[];
  reason?: string;
  updatedAt?: string;
}

export interface WorkManifestItemSummary {
  id: string;
  label: string;
  aliases: string[];
  phases: Record<string, WorkItemPhaseState>;
  complete: boolean;
}

export interface WorkManifestPhaseSummary {
  id: string;
  label: string;
  dependsOn: string[];
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  needsValidation: number;
  invalidated: number;
}

export interface WorkManifestSummary {
  manifestId: string;
  objective?: string;
  contractVersion: string;
  phases: WorkManifestPhaseSummary[];
  items: WorkManifestItemSummary[];
  total: number;
  completed: number;
  remaining: number;
  currentPhase?: string;
  evidenceCount: number;
  artifactCount: number;
  staleCheckpoints: number;
  untrackedCheckpoints: number;
  anomalies: string[];
  updatedAt?: string;
}

interface MutablePhase {
  id: string;
  label: string;
  dependsOn: string[];
}

interface MutableItem {
  id: string;
  label: string;
  aliases: Set<string>;
  phases: Map<string, WorkItemPhaseState>;
}

interface MutableManifest {
  manifestId: string;
  objective?: string;
  contractVersion: string;
  phases: Map<string, MutablePhase>;
  phaseOrder: string[];
  items: Map<string, MutableItem>;
  aliases: Map<string, string>;
  staleCheckpoints: number;
  untrackedCheckpoints: number;
  anomalies: string[];
  updatedAt?: string;
}

const MANIFEST_EVENT_TYPES = [
  'work_manifest_declared',
  'work_item_checkpoint',
  'work_contract_revised',
] as const;

function clean(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function version(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return clean(value, 120);
}

function aliasKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function phaseGraphError(phases: WorkManifestPhase[]): string | null {
  if (phases.length === 0) return 'work manifest needs at least one phase';
  const ids: string[] = [];
  const positions = new Map<string, number>();
  for (const phase of phases) {
    const id = clean(phase.id, 160);
    if (!id) return 'work manifest phase needs an id';
    if (positions.has(id)) return `work manifest has duplicate phase "${id}"`;
    positions.set(id, ids.length);
    ids.push(id);
  }
  for (let index = 0; index < phases.length; index += 1) {
    for (const dependency of phases[index]?.dependsOn ?? []) {
      const dependencyId = clean(dependency, 160);
      const dependencyPosition = positions.get(dependencyId);
      if (dependencyPosition === undefined) {
        return `work manifest phase "${ids[index]}" depends on undeclared phase "${dependencyId || '(empty)'}"`;
      }
      if (dependencyPosition >= index) {
        return `work manifest phase "${ids[index]}" must come after dependency "${dependencyId}"`;
      }
    }
  }
  return null;
}

function boundedUnique(values: unknown, max = 500): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = clean(value, 500);
    const key = aliasKey(normalized);
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeEvidence(value: unknown): WorkEvidenceRef[] {
  if (!Array.isArray(value)) return [];
  const out: WorkEvidenceRef[] = [];
  const seen = new Set<string>();
  const allowed = new Set<WorkEvidenceKind>([
    'artifact',
    'source',
    'external_write',
    'tool_result',
    'worker_result',
    'readback',
    'other',
  ]);
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const kind = clean(record.kind, 40) as WorkEvidenceKind;
    const ref = clean(record.ref, 1_000);
    if (!allowed.has(kind) || !ref) continue;
    const key = `${kind}:${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const summary = clean(record.summary, 500);
    out.push({ kind, ref, ...(summary ? { summary } : {}) });
    if (out.length >= 100) break;
  }
  return out;
}

function mergeEvidence(existing: WorkEvidenceRef[], incoming: WorkEvidenceRef[]): WorkEvidenceRef[] {
  const byKey = new Map(existing.map((entry) => [`${entry.kind}:${entry.ref}`, entry]));
  for (const entry of incoming) byKey.set(`${entry.kind}:${entry.ref}`, entry);
  return [...byKey.values()];
}

function pushAnomaly(manifest: MutableManifest, message: string): void {
  if (!manifest.anomalies.includes(message) && manifest.anomalies.length < 50) {
    manifest.anomalies.push(message);
  }
}

function emptyPhaseState(contractVersion: string): WorkItemPhaseState {
  return {
    status: 'pending',
    contractVersion,
    attempts: 0,
    evidence: [],
  };
}

function ensureItemPhaseStates(manifest: MutableManifest): void {
  for (const item of manifest.items.values()) {
    for (const phaseId of manifest.phaseOrder) {
      if (!item.phases.has(phaseId)) {
        item.phases.set(phaseId, emptyPhaseState(manifest.contractVersion));
      }
    }
  }
}

function registerAlias(manifest: MutableManifest, item: MutableItem, alias: string): void {
  const key = aliasKey(alias);
  if (!key) return;
  const owner = manifest.aliases.get(key);
  if (owner && owner !== item.id) {
    pushAnomaly(manifest, `Alias "${alias}" belongs to both "${owner}" and "${item.id}"; kept "${owner}".`);
    return;
  }
  manifest.aliases.set(key, item.id);
  item.aliases.add(alias);
}

function applyDeclaration(
  manifests: Map<string, MutableManifest>,
  event: EventRow,
): void {
  const data = event.data as Record<string, unknown>;
  const manifestId = clean(data.manifestId, 160);
  const contractVersion = version(data.contractVersion);
  const mode = clean(data.mode, 40);
  if (!manifestId || !contractVersion) return;
  let manifest = manifests.get(manifestId);
  const isInitialDeclaration = !manifest;
  if (!manifest) {
    manifest = {
      manifestId,
      contractVersion,
      phases: new Map(),
      phaseOrder: [],
      items: new Map(),
      aliases: new Map(),
      staleCheckpoints: 0,
      untrackedCheckpoints: 0,
      anomalies: [],
    };
    manifests.set(manifestId, manifest);
  } else if (manifest.contractVersion !== contractVersion) {
    pushAnomaly(
      manifest,
      `Declaration for contract ${contractVersion} did not replace active contract ${manifest.contractVersion}; use a contract revision.`,
    );
    return;
  }
  const objective = clean(data.objective, 4_000);
  if (objective) manifest.objective = objective;

  if (Array.isArray(data.phases)) {
    for (const raw of data.phases.slice(0, 100)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      const id = clean(record.id, 160);
      if (!id) continue;
      const label = clean(record.label, 240) || id;
      const dependsOn = boundedUnique(record.dependsOn, 50);
      const existing = manifest.phases.get(id);
      if (existing) {
        if (
          existing.label !== label
          || existing.dependsOn.join('\u0000') !== dependsOn.join('\u0000')
        ) {
          pushAnomaly(manifest, `Declaration tried to change existing phase "${id}"; kept the original phase contract.`);
        }
      } else {
        if (!isInitialDeclaration && mode !== 'extend') {
          pushAnomaly(manifest, `Declaration referenced new phase "${id}" without mode="extend"; ignored it.`);
          continue;
        }
        manifest.phases.set(id, { id, label, dependsOn });
        manifest.phaseOrder.push(id);
      }
    }
  }

  if (Array.isArray(data.items)) {
    for (const raw of data.items.slice(0, 10_000)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      const id = clean(record.id, 500);
      if (!id) continue;
      let item = manifest.items.get(id);
      if (!item) {
        if (!isInitialDeclaration && mode !== 'extend') {
          pushAnomaly(manifest, `Declaration referenced new item "${id}" without mode="extend"; ignored it.`);
          continue;
        }
        item = {
          id,
          label: clean(record.label, 500) || id,
          aliases: new Set(),
          phases: new Map(),
        };
        manifest.items.set(id, item);
      } else if (clean(record.label, 500)) {
        item.label = clean(record.label, 500);
      }
      registerAlias(manifest, item, id);
      registerAlias(manifest, item, item.label);
      for (const alias of boundedUnique(record.aliases, 100)) registerAlias(manifest, item, alias);
    }
  }
  ensureItemPhaseStates(manifest);
  manifest.updatedAt = event.createdAt;
}

function resolveItem(manifest: MutableManifest, itemId: string): MutableItem | undefined {
  return manifest.items.get(itemId)
    ?? manifest.items.get(manifest.aliases.get(aliasKey(itemId)) ?? '');
}

function applyCheckpoint(manifests: Map<string, MutableManifest>, event: EventRow): void {
  const data = event.data as Record<string, unknown>;
  const manifestId = clean(data.manifestId, 160);
  const manifest = manifests.get(manifestId);
  if (!manifest) return;
  const checkpointVersion = version(data.contractVersion);
  if (!checkpointVersion || checkpointVersion !== manifest.contractVersion) {
    manifest.staleCheckpoints += 1;
    manifest.updatedAt = event.createdAt;
    return;
  }
  const phaseId = clean(data.phase, 160);
  const itemId = clean(data.itemId, 500);
  const phase = manifest.phases.get(phaseId);
  const item = resolveItem(manifest, itemId);
  if (!phase || !item) {
    manifest.untrackedCheckpoints += 1;
    pushAnomaly(
      manifest,
      !phase
        ? `Checkpoint referenced undeclared phase "${phaseId || '(empty)'}".`
        : `Checkpoint referenced undeclared item or alias "${itemId || '(empty)'}".`,
    );
    manifest.updatedAt = event.createdAt;
    return;
  }
  const rawStatus = clean(data.status, 40) as WorkItemStatus;
  if (!['running', 'succeeded', 'failed', 'invalidated'].includes(rawStatus)) return;
  const prior = item.phases.get(phaseId) ?? emptyPhaseState(manifest.contractVersion);
  const incomingEvidence = normalizeEvidence(data.evidence);
  let status = rawStatus;
  let reason = clean(data.reason, 1_000) || undefined;
  if (status === 'succeeded' && incomingEvidence.length === 0 && prior.evidence.length === 0) {
    status = 'needs_validation';
    reason = reason ?? 'Success checkpoint had no durable evidence reference.';
    pushAnomaly(manifest, `Unproven success for "${item.id}" in phase "${phaseId}" requires validation.`);
  }
  // A proven success is monotonic inside one contract revision. A duplicate or
  // late failed attempt cannot erase already-recorded evidence; only an explicit
  // invalidation or contract revision can do that.
  if (prior.status === 'succeeded' && status !== 'invalidated') status = 'succeeded';
  item.phases.set(phaseId, {
    status,
    contractVersion: manifest.contractVersion,
    attempts: prior.attempts + 1,
    evidence: mergeEvidence(prior.evidence, incomingEvidence),
    ...(reason ? { reason } : prior.reason ? { reason: prior.reason } : {}),
    updatedAt: event.createdAt,
  });
  manifest.updatedAt = event.createdAt;
}

function applyRevision(manifests: Map<string, MutableManifest>, event: EventRow): void {
  const data = event.data as Record<string, unknown>;
  const manifestId = clean(data.manifestId, 160);
  const manifest = manifests.get(manifestId);
  if (!manifest) return;
  const fromVersion = version(data.fromVersion);
  const toVersion = version(data.toVersion);
  if (!toVersion) return;
  if (fromVersion && fromVersion !== manifest.contractVersion) {
    pushAnomaly(
      manifest,
      `Ignored out-of-order contract revision from ${fromVersion}; active contract is ${manifest.contractVersion}.`,
    );
    return;
  }
  const policy = clean(data.evidencePolicy, 40);
  if (!['preserve', 'revalidate', 'invalidate'].includes(policy)) return;
  const requestedPhases = boundedUnique(data.phases, 100);
  const scope = new Set(requestedPhases.length > 0 ? requestedPhases : manifest.phaseOrder);
  const instruction = clean(data.instruction, 1_000);
  manifest.contractVersion = toVersion;
  for (const item of manifest.items.values()) {
    for (const phaseId of manifest.phaseOrder) {
      const prior = item.phases.get(phaseId) ?? emptyPhaseState(toVersion);
      if (!scope.has(phaseId)) {
        item.phases.set(phaseId, { ...prior, contractVersion: toVersion });
        continue;
      }
      let status: WorkItemStatus = 'pending';
      if (policy === 'preserve' && prior.status === 'succeeded') status = 'succeeded';
      else if (policy === 'revalidate' && prior.status === 'succeeded') status = 'needs_validation';
      else if (policy === 'invalidate') status = 'invalidated';
      item.phases.set(phaseId, {
        ...prior,
        status,
        contractVersion: toVersion,
        ...(instruction ? { reason: instruction } : {}),
        updatedAt: event.createdAt,
      });
    }
  }
  manifest.updatedAt = event.createdAt;
}

function applyWorkManifestEvents(
  manifests: Map<string, MutableManifest>,
  events: EventRow[],
): Map<string, MutableManifest> {
  for (const event of events) {
    if (event.type === 'work_manifest_declared') applyDeclaration(manifests, event);
    else if (event.type === 'work_item_checkpoint') applyCheckpoint(manifests, event);
    else if (event.type === 'work_contract_revised') applyRevision(manifests, event);
  }
  return manifests;
}

interface WorkManifestReducerCacheEntry {
  lastSeq: number;
  sessionCreatedAt?: string;
  manifests: Map<string, MutableManifest>;
}

// Materialize the append-only reducer in process. Worker waves and the cockpit
// ask for progress repeatedly; rebuilding 10k item checkpoints from seq 1 on
// every batch/poll would turn durable visibility into O(n²) overhead. A daemon
// restart simply rebuilds once from the event log, which remains authoritative.
const reducerCache = new Map<string, WorkManifestReducerCacheEntry>();
const MAX_REDUCER_CACHE_SESSIONS = 200;

function reducedManifestsForSession(sessionId: string): Map<string, MutableManifest> {
  const sessionCreatedAt = getSession(sessionId)?.createdAt;
  const existingCache = reducerCache.get(sessionId);
  const cached = existingCache?.sessionCreatedAt === sessionCreatedAt ? existingCache : undefined;
  const events = listEvents(sessionId, {
    types: [...MANIFEST_EVENT_TYPES],
    ...(cached?.lastSeq ? { sinceSeq: cached.lastSeq } : {}),
  });
  const manifests = cached?.manifests ?? new Map<string, MutableManifest>();
  applyWorkManifestEvents(manifests, events);
  const lastSeq = events.at(-1)?.seq ?? cached?.lastSeq ?? 0;
  reducerCache.delete(sessionId);
  reducerCache.set(sessionId, { lastSeq, sessionCreatedAt, manifests });
  while (reducerCache.size > MAX_REDUCER_CACHE_SESSIONS) {
    const oldest = reducerCache.keys().next().value as string | undefined;
    if (!oldest) break;
    reducerCache.delete(oldest);
  }
  return manifests;
}

function summarizeMutable(manifest: MutableManifest): WorkManifestSummary {
  ensureItemPhaseStates(manifest);
  const items: WorkManifestItemSummary[] = [];
  const evidenceKeys = new Set<string>();
  const artifactKeys = new Set<string>();
  for (const item of manifest.items.values()) {
    const phases: Record<string, WorkItemPhaseState> = {};
    for (const phaseId of manifest.phaseOrder) {
      const state = item.phases.get(phaseId) ?? emptyPhaseState(manifest.contractVersion);
      phases[phaseId] = {
        ...state,
        evidence: [...state.evidence],
      };
      for (const evidence of state.evidence) {
        const key = `${evidence.kind}:${evidence.ref}`;
        evidenceKeys.add(key);
        if (evidence.kind === 'artifact' || evidence.kind === 'external_write' || evidence.kind === 'readback') {
          artifactKeys.add(key);
        }
      }
    }
    items.push({
      id: item.id,
      label: item.label,
      aliases: [...item.aliases],
      phases,
      complete: manifest.phaseOrder.length > 0
        && manifest.phaseOrder.every((phaseId) => phases[phaseId]?.status === 'succeeded'),
    });
  }
  const phases: WorkManifestPhaseSummary[] = manifest.phaseOrder.map((phaseId) => {
    const phase = manifest.phases.get(phaseId)!;
    const states = items.map((item) => item.phases[phaseId]?.status ?? 'pending');
    const count = (status: WorkItemStatus): number => states.filter((value) => value === status).length;
    return {
      id: phase.id,
      label: phase.label,
      dependsOn: [...phase.dependsOn],
      total: items.length,
      pending: count('pending'),
      running: count('running'),
      succeeded: count('succeeded'),
      failed: count('failed'),
      needsValidation: count('needs_validation'),
      invalidated: count('invalidated'),
    };
  });
  const completed = items.filter((item) => item.complete).length;
  return {
    manifestId: manifest.manifestId,
    ...(manifest.objective ? { objective: manifest.objective } : {}),
    contractVersion: manifest.contractVersion,
    phases,
    items,
    total: items.length,
    completed,
    remaining: Math.max(0, items.length - completed),
    currentPhase: phases.find((phase) => phase.succeeded < phase.total)?.id,
    evidenceCount: evidenceKeys.size,
    artifactCount: artifactKeys.size,
    staleCheckpoints: manifest.staleCheckpoints,
    untrackedCheckpoints: manifest.untrackedCheckpoints,
    anomalies: [...manifest.anomalies],
    ...(manifest.updatedAt ? { updatedAt: manifest.updatedAt } : {}),
  };
}

export function declareWorkManifest(input: DeclareWorkManifestInput): EventRow {
  const manifestId = clean(input.manifestId, 160);
  const contractVersion = version(input.contractVersion);
  if (!manifestId) throw new Error('work manifest needs manifestId');
  if (!contractVersion) throw new Error('work manifest needs contractVersion');
  const existing = summarizeWorkManifest(input.sessionId, manifestId);
  const validationPhases = existing && input.mode === 'extend'
    ? (() => {
        const phases = new Map<string, WorkManifestPhase>(
          existing.phases.map((phase) => [phase.id, {
            id: phase.id,
            label: phase.label,
            dependsOn: phase.dependsOn,
          }]),
        );
        for (const phase of input.phases) phases.set(phase.id, phase);
        return [...phases.values()];
      })()
    : existing
      ? null
      : input.phases;
  const graphError = validationPhases ? phaseGraphError(validationPhases) : null;
  if (graphError) throw new Error(graphError);
  if (input.items.length === 0) throw new Error('work manifest needs at least one item');
  return appendEvent({
    sessionId: input.sessionId,
    turn: 0,
    role: 'system',
    type: 'work_manifest_declared',
    data: {
      manifestId,
      contractVersion,
      ...(input.objective?.trim() ? { objective: input.objective.trim() } : {}),
      mode: input.mode ?? 'declare',
      phases: input.phases,
      items: input.items,
    },
  });
}

export function checkpointWorkItem(input: CheckpointWorkItemInput): EventRow {
  const evidence = normalizeEvidence(input.evidence);
  if (input.status === 'succeeded' && evidence.length === 0) {
    throw new Error('succeeded work checkpoint needs at least one evidence reference');
  }
  return appendEvent({
    sessionId: input.sessionId,
    turn: 0,
    role: 'system',
    type: 'work_item_checkpoint',
    data: {
      manifestId: clean(input.manifestId, 160),
      contractVersion: version(input.contractVersion),
      phase: clean(input.phase, 160),
      itemId: clean(input.itemId, 500),
      status: input.status,
      ...(input.attemptId?.trim() ? { attemptId: input.attemptId.trim() } : {}),
      ...(evidence.length > 0 ? { evidence } : {}),
      ...(input.reason?.trim() ? { reason: input.reason.trim().slice(0, 1_000) } : {}),
    },
  });
}

export function reviseWorkContract(input: ReviseWorkContractInput): EventRow {
  const toVersion = version(input.toVersion);
  if (!toVersion) throw new Error('work contract revision needs toVersion');
  if (!input.instruction.trim()) throw new Error('work contract revision needs an instruction');
  return appendEvent({
    sessionId: input.sessionId,
    turn: 0,
    role: 'system',
    type: 'work_contract_revised',
    data: {
      manifestId: clean(input.manifestId, 160),
      ...(input.fromVersion !== undefined ? { fromVersion: version(input.fromVersion) } : {}),
      toVersion,
      instruction: input.instruction.trim().slice(0, 4_000),
      evidencePolicy: input.evidencePolicy,
      ...(input.phases?.length ? { phases: input.phases } : {}),
    },
  });
}

export function summarizeWorkManifests(sessionId: string): WorkManifestSummary[] {
  if (!sessionId) return [];
  try {
    return [...reducedManifestsForSession(sessionId).values()].map(summarizeMutable);
  } catch {
    return [];
  }
}

export function summarizeWorkManifest(
  sessionId: string,
  manifestId?: string,
): WorkManifestSummary | null {
  const summaries = summarizeWorkManifests(sessionId);
  if (manifestId) return summaries.find((entry) => entry.manifestId === manifestId) ?? null;
  return summaries.at(-1) ?? null;
}

export function resolveWorkItemId(
  sessionId: string,
  manifestId: string,
  itemOrAlias: string,
): string | null {
  const summary = summarizeWorkManifest(sessionId, manifestId);
  if (!summary) return null;
  const key = aliasKey(itemOrAlias);
  for (const item of summary.items) {
    if (aliasKey(item.id) === key || item.aliases.some((alias) => aliasKey(alias) === key)) return item.id;
  }
  return null;
}

/**
 * Bind one run_worker call to durable logical work. This is intentionally
 * separate from worker execution: callers run it once before spawning a pool,
 * then attach the returned canonical ids to every start/result checkpoint.
 *
 * The critical invariant is "checkpoints never grow the universe." A second
 * wave whose labels changed from Salesforce ids to spreadsheet rows must map
 * those aliases back to the declared ids, or it is refused before spending
 * another worker wave. Genuine scope expansion is explicit with mode=extend.
 */
export function prepareWorkerManifest(input: {
  sessionId: string;
  items: string[];
  descriptor: WorkerManifestDescriptor;
  objective?: string;
}): PrepareWorkerManifestResult {
  try {
    const manifestId = clean(input.descriptor.id, 160);
    const contractVersion = version(input.descriptor.contractVersion);
    const phase = clean(input.descriptor.phase, 160);
    if (!manifestId || !contractVersion || !phase) {
      return { ok: false, error: 'workManifest needs id, contractVersion, and phase.' };
    }
    // The live tool surface uses an array of fixed-shape pairs because OpenAI
    // strict function schemas reject dynamic-key objects (`additionalProperties`
    // must be false). Keep record support here for older/internal callers.
    const aliases = Array.isArray(input.descriptor.aliases)
      ? Object.fromEntries(input.descriptor.aliases.map((entry) => [entry.alias, entry.itemId]))
      : input.descriptor.aliases ?? {};
    const lookupAlias = (item: string): string => {
      const exact = clean(aliases[item], 500);
      if (exact) return exact;
      const wanted = aliasKey(item);
      for (const [label, itemId] of Object.entries(aliases)) {
        if (aliasKey(label) === wanted) return clean(itemId, 500);
      }
      return item;
    };
    const itemIds = new Map<string, string>();
    const canonicalIds = new Set<string>();
    for (const item of input.items) {
      const itemId = lookupAlias(item);
      if (!itemId) return { ok: false, error: `workManifest has no canonical id for "${item}".` };
      if (canonicalIds.has(itemId)) {
        return { ok: false, error: `workManifest maps multiple workers to canonical item "${itemId}".` };
      }
      canonicalIds.add(itemId);
      itemIds.set(item, itemId);
    }

    const existing = summarizeWorkManifest(input.sessionId, manifestId);
    const requestedMode = input.descriptor.mode ?? (existing ? 'reconcile' : 'declare');
    if (!existing) {
      if (requestedMode === 'reconcile') {
        return { ok: false, error: `workManifest "${manifestId}" is not declared yet.` };
      }
      const phases = input.descriptor.phases?.length
        ? input.descriptor.phases
        : [{ id: phase }];
      if (!phases.some((entry) => clean(entry.id, 160) === phase)) {
        return { ok: false, error: `workManifest phase "${phase}" is absent from its phase graph.` };
      }
      declareWorkManifest({
        sessionId: input.sessionId,
        manifestId,
        contractVersion,
        ...(input.objective?.trim() ? { objective: input.objective.trim() } : {}),
        phases,
        items: input.items.map((item) => {
          const id = itemIds.get(item)!;
          return { id, label: id === item ? item : id, ...(id === item ? {} : { aliases: [item] }) };
        }),
        mode: 'declare',
      });
      return { ok: true, binding: { manifestId, contractVersion, phase, itemIds } };
    }

    if (existing.contractVersion !== contractVersion) {
      return {
        ok: false,
        error: `workManifest "${manifestId}" is on contract ${existing.contractVersion}; this call used ${contractVersion}. Revise the contract explicitly before continuing.`,
      };
    }
    const phaseIds = new Set(existing.phases.map((entry) => entry.id));
    const itemUniverse = new Set(existing.items.map((entry) => entry.id));
    const missingPhase = !phaseIds.has(phase);
    const missingItems = [...canonicalIds].filter((itemId) => !itemUniverse.has(itemId));
    if ((missingPhase || missingItems.length > 0) && requestedMode !== 'extend') {
      const details = [
        missingPhase ? `undeclared phase "${phase}"` : '',
        missingItems.length > 0
          ? `${missingItems.length} undeclared canonical item${missingItems.length === 1 ? '' : 's'} (${missingItems.slice(0, 5).join(', ')})`
          : '',
      ].filter(Boolean).join(' and ');
      return {
        ok: false,
        error: `workManifest "${manifestId}" refused ${details}. Map aliases to existing ids, or use mode="extend" for a real scope increase.`,
      };
    }

    // Reconciliation is read-only for graph shape. Some providers populate the
    // optional `phases` field again on a later wave—and may produce a lossy or
    // malformed copy. Once declared, the durable graph is authoritative; only
    // an explicit `extend` may submit phase additions. This keeps model-specific
    // schema filling from manufacturing ledger anomalies after valid work.
    const canonicalPhases = existing.phases.map((entry) => ({
      id: entry.id,
      label: entry.label,
      dependsOn: entry.dependsOn,
    }));
    const phasesToDeclare = requestedMode === 'extend'
      ? input.descriptor.phases?.length
        ? input.descriptor.phases
        : missingPhase
          ? [{ id: phase }]
          : canonicalPhases
      : canonicalPhases;
    declareWorkManifest({
      sessionId: input.sessionId,
      manifestId,
      contractVersion,
      ...(existing.objective ? { objective: existing.objective } : {}),
      phases: phasesToDeclare,
      items: input.items.map((item) => {
        const id = itemIds.get(item)!;
        return { id, label: existing.items.find((entry) => entry.id === id)?.label ?? id, aliases: [item] };
      }),
      mode: requestedMode === 'extend' ? 'extend' : 'declare',
    });
    return { ok: true, binding: { manifestId, contractVersion, phase, itemIds } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function checkpointPreparedWorker(
  sessionId: string,
  binding: PreparedWorkerManifest,
  item: string,
  status: 'running' | 'succeeded' | 'failed' | 'invalidated',
  options: {
    attemptId?: string;
    evidence?: WorkEvidenceRef[];
    reason?: string;
  } = {},
): EventRow {
  const itemId = binding.itemIds.get(item);
  if (!itemId) throw new Error(`worker item "${item}" has no prepared canonical id`);
  return checkpointWorkItem({
    sessionId,
    manifestId: binding.manifestId,
    contractVersion: binding.contractVersion,
    phase: binding.phase,
    itemId,
    status,
    ...options,
  });
}

/**
 * Return an evidence-backed success for this exact prepared logical work item.
 *
 * This is the durable idempotency identity for long-horizon fan-out. Packet
 * keys identify one model call; manifest id + contract + phase + canonical item
 * identify the work across model turns and daemon restarts. Only a success on
 * the active contract is reusable. Contract revisions that revalidate or
 * invalidate evidence therefore naturally reopen the item.
 */
export function completedPreparedWorker(
  sessionId: string,
  binding: PreparedWorkerManifest,
  item: string,
): PreparedWorkerCompletion | null {
  try {
    const itemId = binding.itemIds.get(item);
    if (!itemId) return null;
    const summary = summarizeWorkManifest(sessionId, binding.manifestId);
    if (!summary || summary.contractVersion !== binding.contractVersion) return null;
    const state = summary.items.find((entry) => entry.id === itemId)?.phases[binding.phase];
    if (
      !state
      || state.status !== 'succeeded'
      || state.contractVersion !== binding.contractVersion
      || state.evidence.length === 0
    ) {
      return null;
    }

    const packetKeys: string[] = [];
    const seen = new Set<string>();
    for (const evidence of state.evidence) {
      if (evidence.kind !== 'worker_result') continue;
      const match = /^event:(\d+)$/.exec(evidence.ref);
      if (!match) continue;
      const seq = Number(match[1]);
      if (!Number.isSafeInteger(seq) || seq <= 0) continue;
      const event = listEvents(sessionId, {
        sinceSeq: seq - 1,
        types: ['worker_result'],
        limit: 1,
      })[0];
      if (!event || event.seq !== seq) continue;
      const packetKey = clean((event.data as Record<string, unknown>).packetKey, 500);
      if (!packetKey || seen.has(packetKey)) continue;
      seen.add(packetKey);
      packetKeys.push(packetKey);
    }
    return {
      itemId,
      state: { ...state, evidence: [...state.evidence] },
      packetKeys,
    };
  } catch {
    return null;
  }
}

/**
 * Inspect a prepared batch once before dispatch.
 *
 * This is the O(manifest + requested-items) batch twin of
 * completedPreparedWorker(), whose packet-key recovery is intentionally
 * item-specific. Both run_worker transports use it to distinguish fresh work
 * from durable receipt reuse without rebuilding the whole event graph N times.
 */
export function summarizePreparedWorkerReuse(
  sessionId: string,
  binding: PreparedWorkerManifest,
  items: readonly string[],
): PreparedWorkerReuseSummary {
  try {
    const manifest = summarizeWorkManifest(sessionId, binding.manifestId);
    if (!manifest || manifest.contractVersion !== binding.contractVersion) {
      return { completedItems: [], phaseComplete: false };
    }
    const itemById = new Map(manifest.items.map((entry) => [entry.id, entry]));
    const completedItems = items.filter((item) => {
      const itemId = binding.itemIds.get(item);
      if (!itemId) return false;
      const state = itemById.get(itemId)?.phases[binding.phase];
      return Boolean(
        state
        && state.status === 'succeeded'
        && state.contractVersion === binding.contractVersion
        && state.evidence.length > 0
      );
    });
    const phase = manifest.phases.find((entry) => entry.id === binding.phase);
    const phaseComplete = Boolean(
      phase
      && phase.total > 0
      && phase.succeeded === phase.total
      && phase.failed === 0
      && phase.running === 0
      && phase.needsValidation === 0
      && phase.invalidated === 0
    );
    return { completedItems, phaseComplete };
  } catch {
    return { completedItems: [], phaseComplete: false };
  }
}
