import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { withFileLockSyncStrict } from '../../runtime/atomic-json.js';
import type { RecallMeetingRecord } from './meeting-capture.js';
import { MeetingModelPinSchema, type MeetingModelPin } from './meeting-assistant-policy.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const name = (max: number) => z.string().min(1).max(max).refine(value => Boolean(value.trim()) && !/[\u0000-\u001f\u007f]/.test(value));
const documentRef = z.object({ id: name(200), revision: z.number().int().positive(), digest: hex }).strict();
export type MeetingResearchDocumentRef = z.infer<typeof documentRef>;
const grantSchema = z.object({ revision: z.number().int().positive(), digest: hex, enabled: z.boolean(), captureDigest: hex,
  useMemory: z.boolean(), documentRefs: z.array(documentRef).max(16), maxLookups: z.number().int().min(1).max(8),
  expiresAt: z.number().finite().positive(), createdAt: z.number().finite() }).strict();
export type MeetingResearchGrant = Readonly<z.infer<typeof grantSchema>>;
const questionSchema = z.object({ offerId: name(80), offerDigest: hex, sourceDigest: hex, question: name(500),
  quote: z.string().min(1).max(1_000), segmentIds: z.array(name(512)).min(1).max(24) }).strict();
export type MeetingResearchQuestion = z.infer<typeof questionSchema>;
const referenceSchema = z.object({ meetingId: name(512), jobId: hex, grantRevision: z.number().int().positive(), grantDigest: hex }).strict();
export type MeetingResearchReference = Readonly<z.infer<typeof referenceSchema>>;
const taskSchema = z.object({ sessionId: name(120), sourceUserSeq: z.number().int().positive(), attemptId: name(200),
  runId: name(200), clientRequestId: name(120) }).strict();
export type MeetingResearchTask = z.infer<typeof taskSchema>;
const jobSchema = z.object({ id: hex, key: hex, grantRevision: z.number().int().positive(), grantDigest: hex,
  captureDigest: hex.optional(), modelPin: MeetingModelPinSchema.optional(),
  question: questionSchema, evidenceDigest: hex, clientRequestId: name(120), privateOriginSessionId: name(120),
  state: z.enum(['queued', 'running', 'completed', 'blocked', 'cancelled']), createdAt: z.number().finite(),
  startedAt: z.number().finite().optional(), settledAt: z.number().finite().optional(),
  dispatchOwnerPid: z.number().int().positive().optional(),
  task: taskSchema.optional(), reason: name(100).optional(), outcomeUnknown: z.boolean().optional() }).strict();
export type MeetingResearchJob = Readonly<z.infer<typeof jobSchema>>;
const stateSchema = z.object({ format: z.literal(1), meetingId: name(512), version: z.number().int().nonnegative(),
  grant: grantSchema.nullable(), jobs: z.array(jobSchema).max(128) }).strict();
type State = z.infer<typeof stateSchema>;
export interface MeetingResearchSnapshot {
  meetingId: string; version: number; enabled: boolean; useMemory: boolean; maxLookups: number; usedLookups: number;
  status: 'disabled' | 'ready' | 'running' | 'exhausted' | 'unavailable'; reason?: string;
  documentRefs: readonly MeetingResearchDocumentRef[]; expiresAt?: number;
  jobs: readonly { id: string; question: string; status: MeetingResearchJob['state']; task?: MeetingResearchTask;
    reason?: string; outcomeUnknown?: boolean }[];
}
export interface MeetingResearchBoundary {
  reference: MeetingResearchReference; grant: MeetingResearchGrant; job: MeetingResearchJob;
  /** This grants owner-wide FACTS only. Vault, project, agent, entity and resource stores are not implicitly authorized. */
  memoryScope: { projectId: null; agentKey: null; exact: true } | null;
  documentRefs: readonly MeetingResearchDocumentRef[];
}
export type MeetingResearchDispatchResult = { status: 'accepted' | 'completed'; task: MeetingResearchTask }
  | { status: 'blocked' | 'cancelled'; reason?: string; task?: MeetingResearchTask };
export interface MeetingResearchCoordinatorOptions {
  directory: string;
  readMeeting(id: string): RecallMeetingRecord | null;
  /** Host-owned current selection, not model-authored references. Throw if unavailable. */
  readDocumentRefs(id: string): readonly MeetingResearchDocumentRef[];
  /** Production freezes this host-owned choice before reserving a lookup. */
  resolveModelPin?(id: string): MeetingModelPin;
  dispatch(input: { reference: MeetingResearchReference; job: MeetingResearchJob; signal: AbortSignal;
    verify(): MeetingResearchBoundary;
    /** Persist the exact canonical source immediately after acceptance, before
     * awaiting execution. Recording that fact does not renew permission. */
    bindTask(task: MeetingResearchTask): void }): Promise<MeetingResearchDispatchResult>;
  /** Observation only: it must never restart or redispatch a task. */
  observe?(task: MeetingResearchTask): Promise<{ status: 'in_progress' | 'completed' | 'blocked' | 'cancelled' | 'unknown' }>;
  now?: () => number;
}
export class MeetingResearchBoundaryError extends Error {
  constructor(readonly reason: string) { super(`Meeting research is unavailable: ${reason}.`); this.name = 'MeetingResearchBoundaryError'; }
}
function fail(reason: string): never { throw new MeetingResearchBoundaryError(reason); }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }
/** Must stay identical to assistance/documents: an id/window alone is not capture identity. */
export function meetingResearchCaptureDigest(record: RecallMeetingRecord): string {
  return hash([record.id, record.windowId, record.startedAt, record.provider ?? 'recall', record.source ?? null, record.sdkUploadId ?? null]);
}
function grantDigest(grant: Omit<MeetingResearchGrant, 'digest'> | MeetingResearchGrant): string {
  const { digest: _digest, ...value } = grant as MeetingResearchGrant;
  return hash(value);
}
function refsOf(value: readonly MeetingResearchDocumentRef[]): MeetingResearchDocumentRef[] {
  const refs = z.array(documentRef).max(16).parse(value.map(ref => ({ id: ref.id, revision: ref.revision, digest: ref.digest })));
  if (new Set(refs.map(ref => ref.id)).size !== refs.length) fail('document_selection_ambiguous');
  return refs.sort((a, b) => a.id.localeCompare(b.id));
}
const processDrains = new Map<string, Promise<MeetingResearchSnapshot>>();
const processActive = new Map<string, { jobId: string; controller: AbortController }>();
const jobIntentKey = (job: Pick<MeetingResearchJob, 'grantRevision' | 'grantDigest' | 'question' | 'evidenceDigest'>) =>
  hash([job.grantRevision, job.grantDigest, job.question.offerId, job.question.offerDigest, job.question.sourceDigest, job.question.question, job.evidenceDigest]);
const jobKey = (job: Pick<MeetingResearchJob, 'grantRevision' | 'grantDigest' | 'question' | 'evidenceDigest' | 'captureDigest' | 'modelPin'>) =>
  job.captureDigest ? hash([jobIntentKey(job), job.captureDigest, job.modelPin ?? null]) : jobIntentKey(job);
function processIsPresent(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Durable single-flight reservations. It owns no model/tool executor; the injected
 * port must admit the exact ordinary task and enforce this boundary at every read. */
export function createMeetingResearchCoordinator(options: MeetingResearchCoordinatorOptions) {
  const now = options.now ?? Date.now;
  const file = (id: string) => path.join(options.directory, `${hash(name(512).parse(id))}.json`);
  const recordFor = (id: string) => { const record = options.readMeeting(id); if (!record || record.id !== id || !record.windowId || !record.startedAt || !Array.isArray(record.segments)) fail('capture_unavailable'); return record; };
  const read = (id: string): State => {
    let raw: string;
    let fd: number | undefined;
    try {
      fd = openSync(file(id), 'r'); const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) fail('state_corrupt');
      const bytes = Buffer.alloc(stat.size); let offset = 0;
      while (offset < bytes.length) { const read = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!read) break; offset += read; }
      if (offset !== stat.size || fstatSync(fd).size !== stat.size) fail('state_unavailable');
      raw = bytes.toString('utf8');
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { format: 1, meetingId: id, version: 0, grant: null, jobs: [] }; fail('state_unavailable'); }
    finally { if (fd !== undefined) closeSync(fd); }
    let state: State;
    try { state = stateSchema.parse(JSON.parse(raw)); } catch { fail('state_corrupt'); }
    if (state.meetingId !== id || (state.grant && grantDigest(state.grant) !== state.grant.digest)
      || new Set(state.jobs.map(job => job.id)).size !== state.jobs.length
      || state.jobs.filter(job => job.state === 'running').length > 1) fail('state_corrupt');
    for (const job of state.jobs) {
      if (job.key !== jobKey(job)
        || job.id !== hash([id, job.key]) || job.clientRequestId !== `meeting-research-${job.id}`
        || job.privateOriginSessionId !== `sess-desktop-${hash(job.clientRequestId).slice(0, 24)}`
        || (job.task && (job.task.clientRequestId !== job.clientRequestId || job.task.sessionId !== job.privateOriginSessionId))) fail('state_corrupt');
    }
    return state;
  };
  const mutate = <T>(id: string, change: (state: State) => T): T => {
    mkdirSync(options.directory, { recursive: true });
    return withFileLockSyncStrict(file(id), () => {
      const state = read(id); const before = JSON.stringify(state); const result = change(state);
      if (JSON.stringify(state) === before) return result;
      state.version += 1; stateSchema.parse(state);
      const temporary = `${file(id)}.${randomUUID()}.tmp`; let fd: number | undefined;
      try { fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temporary, file(id)); }
      finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
      return result;
    });
  };
  const invalidReason = (id: string, grant: MeetingResearchGrant | null): string | undefined => {
    if (!grant?.enabled) return 'disabled';
    if (grant.expiresAt <= now()) return 'permission_expired';
    let record: RecallMeetingRecord; try { record = recordFor(id); } catch { return 'capture_unavailable'; }
    if (meetingResearchCaptureDigest(record) !== grant.captureDigest) return 'capture_changed';
    if (record.status !== 'recording') return 'meeting_not_recording';
    try {
      if (!grant.documentRefs.length) return undefined;
      const current = refsOf(options.readDocumentRefs(id));
      if (grant.documentRefs.some(ref => !current.some(item => hash(item) === hash(ref)))) return 'documents_changed';
    }
    catch { return 'documents_unavailable'; }
    return undefined;
  };
  const get = (id: string): MeetingResearchSnapshot => {
    recordFor(id); const state = read(id); const reason = invalidReason(id, state.grant)
      ?? (state.jobs.some(job => job.outcomeUnknown) ? 'task_outcome_unknown' : undefined);
    // The owner's allowance is for this meeting, not one permission revision.
    // Pausing, changing notes or resaving cannot refund a reserved lookup.
    const count = state.jobs.length;
    return freeze({ meetingId: id, version: state.version, enabled: state.grant?.enabled ?? false, useMemory: state.grant?.useMemory ?? false,
      maxLookups: state.grant?.maxLookups ?? 3, usedLookups: count,
      status: !state.grant?.enabled ? 'disabled' : reason ? 'unavailable' : state.jobs.some(job => job.state === 'running') ? 'running'
        : count >= state.grant.maxLookups ? 'exhausted' : 'ready',
      ...(reason && reason !== 'disabled' ? { reason } : {}), documentRefs: state.grant?.documentRefs ?? [],
      ...(state.grant ? { expiresAt: state.grant.expiresAt } : {}),
      jobs: state.jobs.map(job => ({ id: job.id, question: job.question.question, status: job.state,
        ...(job.task ? { task: job.task } : {}), ...(job.reason ? { reason: job.reason } : {}), ...(job.outcomeUnknown ? { outcomeUnknown: true } : {}) })) });
  };
  const invalidate = (state: State, reason: string) => {
    for (const job of state.jobs) if (job.state === 'queued' || job.state === 'running') {
      job.state = 'cancelled'; job.reason = reason; job.settledAt = now();
      if (job.startedAt !== undefined && !job.task) job.outcomeUnknown = true;
    }
  };
  const set = (id: string, raw: { enabled: boolean; useMemory: boolean; maxLookups: number; documentRefs: MeetingResearchDocumentRef[]; expectedVersion: number; expiresAt?: number }): MeetingResearchSnapshot => {
    const input = z.object({ enabled: z.boolean(), useMemory: z.boolean(), maxLookups: z.number().int().min(1).max(8),
      documentRefs: z.array(documentRef).max(16), expectedVersion: z.number().int().nonnegative(), expiresAt: z.number().finite().positive().optional() }).strict().parse(raw);
    let changed = false;
    mutate(id, state => {
      if (state.version !== input.expectedVersion) fail('permission_changed');
      const record = recordFor(id); const captureDigest = meetingResearchCaptureDigest(record);
      if (input.enabled && record.status !== 'recording') fail('meeting_not_recording');
      const refs = refsOf(input.documentRefs);
      if (input.enabled && refs.length) {
        const current = refsOf(options.readDocumentRefs(id));
        if (refs.some(ref => !current.some(item => hash(item) === hash(ref)))) fail('documents_changed');
      }
      if (input.enabled && !input.useMemory && !refs.length) fail('select_a_research_source');
      const expiresAt = input.expiresAt ?? (state.grant?.enabled && state.grant.expiresAt > now()
        && state.grant.captureDigest === captureDigest ? state.grant.expiresAt : now() + 2 * 60 * 60_000);
      if (input.enabled && (expiresAt <= now() || expiresAt > now() + 2 * 60 * 60_000)) fail('invalid_expiry');
      const prior = state.grant;
      if (prior && prior.enabled === input.enabled && prior.captureDigest === captureDigest && prior.useMemory === input.useMemory
        && prior.maxLookups === input.maxLookups && prior.expiresAt === expiresAt && hash(prior.documentRefs) === hash(refs)) return;
      invalidate(state, input.enabled ? 'permission_changed' : 'owner_paused');
      changed = true;
      const value = { revision: (prior?.revision ?? 0) + 1, enabled: input.enabled, captureDigest,
        useMemory: input.useMemory, documentRefs: refs, maxLookups: input.maxLookups, expiresAt, createdAt: now() };
      state.grant = { ...value, digest: grantDigest(value) };
    });
    if (changed) processActive.get(file(id))?.controller.abort(); return get(id);
  };
  const evidenceDigest = (id: string, question: MeetingResearchQuestion): string => {
    const record = recordFor(id); const refs = new Set(question.segmentIds);
    if (refs.size !== question.segmentIds.length) fail('question_evidence_changed');
    const segments = question.segmentIds.map(ref => {
      const matches = record.segments.filter(segment => segment.id === ref && segment.isFinal === true);
      if (matches.length !== 1) fail('question_evidence_changed');
      const segment = matches[0]!; return { id: segment.id, text: segment.text, speaker: segment.speaker ?? null, timestamp: segment.timestamp };
    });
    if (!segments.some(segment => segment.text.includes(question.quote))) fail('question_evidence_changed');
    return hash(segments);
  };
  const referenceOf = (id: string, job: MeetingResearchJob): MeetingResearchReference => ({ meetingId: id, jobId: job.id, grantRevision: job.grantRevision, grantDigest: job.grantDigest });
  const enqueue = (id: string, raw: MeetingResearchQuestion): MeetingResearchJob => {
    const question = questionSchema.parse(raw);
    return freeze(mutate(id, state => {
      const reason = invalidReason(id, state.grant); if (reason) fail(reason); const grant = state.grant!;
      const evidence = evidenceDigest(id, question);
      const identity = { grantRevision: grant.revision, grantDigest: grant.digest, question, evidenceDigest: evidence };
      const existing = state.jobs.find(job => jobIntentKey(job) === jobIntentKey(identity)); if (existing) return structuredClone(existing);
      if (state.jobs.length >= grant.maxLookups) fail('lookup_budget_exhausted');
      if (state.jobs.length >= 128) fail('research_history_capacity');
      const modelPin = options.resolveModelPin ? MeetingModelPinSchema.parse(options.resolveModelPin(id)) : undefined;
      const key = jobKey({ ...identity, captureDigest: grant.captureDigest, modelPin });
      const jobId = hash([id, key]); const clientRequestId = `meeting-research-${jobId}`;
      const job: z.infer<typeof jobSchema> = { id: jobId, key, grantRevision: grant.revision, grantDigest: grant.digest,
        captureDigest: grant.captureDigest,
        ...(modelPin ? { modelPin } : {}),
        question, evidenceDigest: evidence, clientRequestId, privateOriginSessionId: `sess-desktop-${hash(clientRequestId).slice(0, 24)}`,
        state: 'queued', createdAt: now() };
      state.jobs.push(job); return structuredClone(job);
    }));
  };
  const verifyResearchBoundary = (raw: MeetingResearchReference): MeetingResearchBoundary => {
    const reference = referenceSchema.parse(raw); const state = read(reference.meetingId);
    const reason = invalidReason(reference.meetingId, state.grant); if (reason) fail(reason); const grant = state.grant!;
    const job = state.jobs.find(item => item.id === reference.jobId);
    if (!job || job.state !== 'running' || grant.revision !== reference.grantRevision || grant.digest !== reference.grantDigest
      || job.grantRevision !== grant.revision || job.grantDigest !== grant.digest) fail('research_authority_changed');
    if (evidenceDigest(reference.meetingId, job.question) !== job.evidenceDigest) fail('question_evidence_changed');
    return freeze({ reference, grant, job, memoryScope: grant.useMemory ? { projectId: null, agentKey: null, exact: true } : null, documentRefs: grant.documentRefs });
  };
  const stop = (id: string): MeetingResearchSnapshot => {
    mutate(id, state => { invalidate(state, 'owner_stopped'); if (state.grant?.enabled) {
      const { digest: _digest, ...prior } = state.grant; const value = { ...prior, enabled: false, revision: prior.revision + 1 };
      state.grant = { ...value, digest: grantDigest(value) };
    } });
    processActive.get(file(id))?.controller.abort(); return get(id);
  };
  const drainOnce = async (id: string): Promise<MeetingResearchSnapshot> => {
    let job: MeetingResearchJob | undefined;
    mutate(id, state => {
      const reason = invalidReason(id, state.grant); if (reason) { invalidate(state, reason); return; }
      const running = state.jobs.find(item => item.state === 'running' || item.outcomeUnknown);
      if (running) { job = structuredClone(running); return; }
      const queued = state.jobs.find(item => item.state === 'queued'); if (!queued) return;
      let currentEvidence: string | undefined; try { currentEvidence = evidenceDigest(id, queued.question); } catch { /* recorded cancellation below */ }
      if (currentEvidence !== queued.evidenceDigest) { queued.state = 'cancelled'; queued.reason = 'question_evidence_changed'; queued.settledAt = now(); return; }
      queued.state = 'running'; queued.startedAt = now(); queued.dispatchOwnerPid = process.pid; job = structuredClone(queued);
    });
    if (!job) { processActive.get(file(id))?.controller.abort(); return get(id); }
    const selected = job;
    // A prior reservation with no recorded accepted task may already have paid
    // or completed. Never invoke its dispatcher again, even after a restart.
    if (selected.startedAt !== undefined && selected.task) {
      if (!options.observe) return get(id);
      let observation: Awaited<ReturnType<NonNullable<typeof options.observe>>>;
      try { observation = await options.observe(selected.task); } catch { observation = { status: 'unknown' }; }
      mutate(id, state => { const current = state.jobs.find(item => item.id === selected.id); if (!current || current.state !== 'running' && !current.outcomeUnknown) return;
        if (observation.status === 'in_progress') return;
        current.state = observation.status === 'unknown' ? 'blocked' : observation.status;
        current.settledAt = now(); if (observation.status === 'unknown') { current.reason = 'task_outcome_unknown'; current.outcomeUnknown = true; }
        else { delete current.outcomeUnknown; delete current.reason; } });
      return get(id);
    }
    if (selected.state !== 'running') return get(id);
    const controller = new AbortController(); processActive.set(file(id), { jobId: selected.id, controller });
    const reference = referenceOf(id, selected);
    let enteredDispatch = false;
    try {
      verifyResearchBoundary(reference);
      const bindTask = (raw: MeetingResearchTask) => {
        const task = taskSchema.parse(raw);
        mutate(id, state => {
          const current = state.jobs.find(item => item.id === selected.id);
          if (!current || task.clientRequestId !== current.clientRequestId || task.sessionId !== current.privateOriginSessionId
            || (current.task && hash(current.task) !== hash(task))) fail('accepted_task_mismatch');
          // A pause may win just after canonical acceptance. Retain that exact
          // already-created task for Stop/readback, then refuse further work.
          current.task = task;
        });
        verifyResearchBoundary(reference);
      };
      enteredDispatch = true;
      const result = await options.dispatch({ reference: freeze(reference), job: freeze(selected), signal: controller.signal,
        verify: () => verifyResearchBoundary(reference), bindTask });
      mutate(id, state => {
        const current = state.jobs.find(item => item.id === selected.id); if (!current) fail('research_authority_changed');
        if (result.task) {
          const task = taskSchema.parse(result.task);
          if (task.clientRequestId !== current.clientRequestId || task.sessionId !== current.privateOriginSessionId
            || (current.task && hash(current.task) !== hash(task))) fail('accepted_task_mismatch');
          current.task = task;
        }
        if (result.status === 'accepted' || result.status === 'completed') {
          if (current.state === 'running') { current.state = result.status === 'completed' ? 'completed' : 'running'; if (result.status === 'completed') current.settledAt = now(); }
        } else if (current.state === 'running') {
          const reason = 'reason' in result ? result.reason : undefined;
          current.state = result.status; current.reason = reason && /^[a-z][a-z0-9_]{0,99}$/.test(reason)
            ? reason : result.status === 'cancelled' ? 'owner_stopped' : 'dispatch_refused';
          current.settledAt = now();
        }
      });
    } catch {
      mutate(id, state => { const current = state.jobs.find(item => item.id === selected.id); if (current?.state === 'running') {
        current.state = enteredDispatch ? 'blocked' : 'cancelled'; current.reason = enteredDispatch ? 'dispatch_outcome_unknown' : 'research_authority_changed';
        if (enteredDispatch) current.outcomeUnknown = true; current.settledAt = now();
      } });
    } finally { if (processActive.get(file(id))?.jobId === selected.id) processActive.delete(file(id)); }
    return get(id);
  };
  const drain = (id: string): Promise<MeetingResearchSnapshot> => {
    const processKey = file(id); const existing = processDrains.get(processKey); if (existing) return existing;
    // Distinguish this invocation's fresh reservation from an abandoned one.
    const priorRunning = read(id).jobs.find(job => job.state === 'running');
    if (priorRunning && !priorRunning.task) {
      // Another live owner may be between durable reservation and acknowledgement.
      // Observing it must not revoke its grant or launch a replacement execution.
      if (processIsPresent(priorRunning.dispatchOwnerPid)) return Promise.resolve(get(id));
      mutate(id, state => { const current = state.jobs.find(job => job.id === priorRunning.id); if (current?.state === 'running' && !current.task) {
        current.state = 'blocked'; current.reason = 'dispatch_outcome_unknown'; current.outcomeUnknown = true; current.settledAt = now();
      } });
      return Promise.resolve(get(id));
    }
    const promise = (async () => {
      let snapshot = await drainOnce(id);
      for (let index = 1; index < 8 && snapshot.jobs.some(job => job.status === 'queued')
        && !snapshot.jobs.some(job => job.status === 'running' || job.outcomeUnknown); index++) snapshot = await drainOnce(id);
      return snapshot;
    })().finally(() => { if (processDrains.get(processKey) === promise) processDrains.delete(processKey); }); processDrains.set(processKey, promise); return promise;
  };
  const readHandoff = (id: string) => {
    const record = recordFor(id); const state = read(id); const captureDigest = meetingResearchCaptureDigest(record);
    return freeze({ captureDigest, version: state.version, jobs: state.jobs.map(job => {
      // Legacy permission changes may have removed the original capture proof.
      const exactCapture = job.captureDigest ? job.captureDigest === captureDigest
        : state.grant?.digest === job.grantDigest && state.grant.captureDigest === captureDigest;
      return { id: job.id, question: job.question, state: job.state, exactCapture,
        ...(job.task ? { task: job.task } : {}), ...(job.reason ? { reason: job.reason } : {}),
        ...(job.outcomeUnknown ? { outcomeUnknown: true } : {}) };
    }) });
  };
  return { get, set, enqueue, drain, stop, verifyResearchBoundary, readHandoff };
}
