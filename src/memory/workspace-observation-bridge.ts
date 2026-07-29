import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { redactSensitiveText } from '../runtime/security.js';
import { openMemoryDb } from './db.js';
import {
  recordMemoryEpisode,
  type MemoryEpisodeInput,
} from './temporal-memory.js';

/**
 * Workspace memory is a compact trail of meaningful episodes, not a second
 * copy of Workspace state. Keep the complete write request below this cap so
 * raw observations cannot accidentally become prompt-sized memories.
 */
export const MAX_WORKSPACE_MEMORY_PAYLOAD_BYTES = 2_048;

const BRIDGE_VERSION = 1;
const MAX_REFERENCE_BYTES = 80;
const MAX_PROVENANCE_BYTES = 240;
const MAX_CONTENT_BYTES = 720;
const MIN_CONTENT_BYTES = 120;
const MIN_PROVENANCE_BYTES = 64;
const SECRETISH_REFERENCE_RE =
  /(?:^|[._:/?&=-])(?:api[_-]?key|authorization|bearer|password|private[_-]?key|secret|token)(?:$|[._:/?&=-])/i;
const WORKSPACE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;
const projectionSchemaReady = new WeakSet<object>();

type MaybePromise<T> = T | Promise<T>;

interface WorkspaceMemorySignalBase {
  workspaceId: string;
  sourceId: string;
  observationId: string;
  contentHash: string;
  occurredAt: string;
  provenanceSummary: string;
}

export type WorkspaceMemorySignal =
  | (WorkspaceMemorySignalBase & {
    kind: 'observation';
    previousContentHash: string | null;
    outcome: 'succeeded' | 'failed';
    /**
     * Counts are computed by trusted Workspace code. External field names,
     * paths, row identities, values, and prose are deliberately not accepted
     * on automatic observation signals.
     */
    changeCounts: {
      add: number;
      remove: number;
      replace: number;
    };
    truncated: boolean;
  })
  | (WorkspaceMemorySignalBase & {
    kind: 'user_correction';
    correction: string;
  })
  | (WorkspaceMemorySignalBase & {
    kind: 'effect_outcome';
    decision: 'approved' | 'rejected';
    summary: string;
  });

export interface WorkspaceObservationMemoryDependencies {
  findEpisode(input: {
    sessionId: string;
    callId: string;
  }): MaybePromise<{ id: string } | null>;
  recordEpisode(input: MemoryEpisodeInput): MaybePromise<{ id: string }>;
}

export interface WorkspaceObservationMemoryOptions {
  /**
   * A first snapshot normally establishes a baseline and is not an episode.
   * Callers may opt in when the initial observation is itself useful history.
   */
  includeFirstObservation?: boolean;
}

export type WorkspaceMemoryCaptureReason =
  | 'unchanged'
  | 'unsuccessful_observation'
  | 'first_observation_disabled'
  | 'no_meaningful_change'
  | 'empty_correction'
  | 'invalid_signal'
  | 'memory_unavailable';

export interface WorkspaceMemoryCaptureResult {
  status: 'recorded' | 'deduped' | 'suppressed' | 'failed';
  reason: WorkspaceMemoryCaptureReason | null;
  episodeId: string | null;
  /**
   * This is advice to the future Workspace integration, not an action taken
   * here. Scheduled observations never wake the agent. Explicit human
   * corrections and effect decisions may.
   */
  wake: boolean;
}

export interface WorkspaceMemoryPurgeResult {
  workspaceId: string;
  episodesDeleted: number;
  derivedFactsDeleted: number;
  pendingRowsDeleted: number;
  evidenceRowsDeleted: number;
  evidenceReferencesCleared: number;
  projectionReceiptsDeleted: number;
}

export type WorkspaceObservationProjectionDisposition = 'captured' | 'suppressed';

export interface WorkspaceObservationProjectionReceipt {
  workspaceId: string;
  observationId: string;
  disposition: WorkspaceObservationProjectionDisposition;
  reason: string;
  projectedAt: string;
}

interface PreparedEpisode {
  input: MemoryEpisodeInput;
  wake: boolean;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function clipUtf8(value: string, maxBytes: number): string {
  const normalized = value.trim();
  if (byteLength(normalized) <= maxBytes) return normalized;
  let end = Math.min(normalized.length, maxBytes);
  while (end > 0 && byteLength(normalized.slice(0, end)) > maxBytes) end -= 1;
  return normalized.slice(0, end).trimEnd();
}

function sanitizedText(value: unknown, maxBytes: number): string {
  return clipUtf8(
    redactSensitiveText(value).replace(/\s+/g, ' ').trim(),
    maxBytes,
  );
}

/**
 * References are identifiers only. Suspicious or structurally unsafe values
 * become one-way handles so credentials can never leak through metadata,
 * source URIs, session IDs, or titles.
 */
function safeReference(value: unknown, label: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  const structurallySafe = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(raw);
  if (
    raw
    && structurallySafe
    && !SECRETISH_REFERENCE_RE.test(raw)
    && byteLength(raw) <= MAX_REFERENCE_BYTES
  ) {
    return raw;
  }
  return `${label}-${digest(raw).slice(0, 20)}`;
}

function validSignalReferences(signal: WorkspaceMemorySignal): boolean {
  return [
    signal.workspaceId,
    signal.sourceId,
    signal.observationId,
    signal.contentHash,
  ].every((value) => typeof value === 'string' && value.trim().length > 0);
}

function normalizedOccurredAt(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : new Date(0).toISOString();
}

function utcDayBucket(value: string): string {
  return normalizedOccurredAt(value).slice(0, 10);
}

function boundedChangeCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(1_000_000, Math.trunc(value));
}

function observationSummary(
  signal: Extract<WorkspaceMemorySignal, { kind: 'observation' }>,
): string | null {
  const add = boundedChangeCount(signal.changeCounts?.add);
  const remove = boundedChangeCount(signal.changeCounts?.remove);
  const replace = boundedChangeCount(signal.changeCounts?.replace);
  if (add === null || remove === null || replace === null) return null;
  if (add + remove + replace === 0 && signal.truncated !== true) return null;
  const label = (count: number, singular: string): string =>
    `${count} ${singular}${count === 1 ? '' : 's'}`;
  return [
    `Workspace data changed: ${label(add, 'addition')}, ${label(remove, 'removal')}, and ${label(replace, 'replacement')}.`,
    signal.truncated === true
      ? 'Additional structural changes were omitted from the bounded comparison.'
      : '',
  ].filter(Boolean).join(' ');
}

function sourceUriFor(refs: {
  workspaceId: string;
  sourceId: string;
  observationId: string;
}): string {
  return [
    `workspace://${encodeURIComponent(refs.workspaceId)}`,
    `sources/${encodeURIComponent(refs.sourceId)}`,
    `observations/${encodeURIComponent(refs.observationId)}`,
  ].join('/');
}

function episodeIdentity(input: {
  workspaceId: string;
  sourceId: string;
  observationId: string;
  contentHash: string;
  eventKind: WorkspaceMemorySignal['kind'];
  discriminator: string;
  occurredAt: string;
}): { sessionId: string; callId: string } {
  const sessionId = `workspace:${input.workspaceId}`;
  // Automatic observations are deliberately coalesced into one compact
  // episode per Workspace/source/UTC day. The exact observation ledger remains
  // append-only in workspace.db; memory is only a bounded, searchable signal.
  // Explicit corrections and effect outcomes retain event-level identity.
  const fingerprint = input.eventKind === 'observation'
    ? [
      BRIDGE_VERSION,
      input.workspaceId,
      input.sourceId,
      input.eventKind,
      `utc-day:${utcDayBucket(input.occurredAt)}`,
    ].join('\u001f')
    : [
      BRIDGE_VERSION,
      input.workspaceId,
      input.sourceId,
      input.observationId,
      input.contentHash,
      input.eventKind,
      input.discriminator,
    ].join('\u001f');
  return {
    sessionId,
    callId: `workspace-memory:${digest(fingerprint).slice(0, 32)}`,
  };
}

function payloadBytes(input: MemoryEpisodeInput): number {
  return byteLength(JSON.stringify(input));
}

/**
 * The individual fields are already bounded. This final envelope guard keeps
 * the invariant true if JSON overhead or a future allowlisted field grows.
 */
function fitPayload(input: MemoryEpisodeInput): MemoryEpisodeInput {
  let content = input.content ?? '';
  const metadata = { ...(input.metadata ?? {}) };
  let provenance = typeof metadata.provenanceSummary === 'string'
    ? metadata.provenanceSummary
    : '';
  const fitted: MemoryEpisodeInput = { ...input, metadata, content };

  while (payloadBytes(fitted) > MAX_WORKSPACE_MEMORY_PAYLOAD_BYTES) {
    if (byteLength(content) > MIN_CONTENT_BYTES) {
      content = clipUtf8(content, Math.max(
        MIN_CONTENT_BYTES,
        Math.floor(byteLength(content) * 0.8),
      ));
      fitted.content = content;
      continue;
    }
    if (byteLength(provenance) > MIN_PROVENANCE_BYTES) {
      provenance = clipUtf8(provenance, Math.max(
        MIN_PROVENANCE_BYTES,
        Math.floor(byteLength(provenance) * 0.8),
      ));
      metadata.provenanceSummary = provenance;
      continue;
    }
    break;
  }
  return fitted;
}

function prepareEpisode(signal: WorkspaceMemorySignal): PreparedEpisode | null {
  const refs = {
    workspaceId: safeReference(signal.workspaceId, 'workspace'),
    sourceId: safeReference(signal.sourceId, 'source'),
    observationId: safeReference(signal.observationId, 'observation'),
    contentHash: safeReference(signal.contentHash, 'content'),
  };
  const provenanceSummary =
    sanitizedText(signal.provenanceSummary, MAX_PROVENANCE_BYTES)
    || 'Workspace event.';
  const sourceUri = sourceUriFor(refs);

  let kind: MemoryEpisodeInput['kind'];
  let subtype: string;
  let title: string;
  let content: string;
  let wake: boolean;
  let discriminator: string;
  let metadata: Record<string, unknown>;

  if (signal.kind === 'observation') {
    const summary = observationSummary(signal);
    if (!summary) return null;
    content = summary;
    kind = 'tool_result';
    subtype = signal.previousContentHash === null
      ? 'workspace_observation_first'
      : 'workspace_observation_changed';
    title = signal.previousContentHash === null
      ? 'Workspace baseline observation'
      : 'Workspace observation changed';
    wake = false;
    discriminator = signal.previousContentHash ?? 'first';
    metadata = {
      bridgeVersion: BRIDGE_VERSION,
      workspaceId: refs.workspaceId,
      sourceId: refs.sourceId,
      observationId: refs.observationId,
      contentHash: refs.contentHash,
      previousContentHash: signal.previousContentHash === null
        ? null
        : safeReference(signal.previousContentHash, 'content'),
      eventKind: signal.kind,
      bucketUtcDay: utcDayBucket(signal.occurredAt),
      provenanceSummary,
    };
  } else if (signal.kind === 'user_correction') {
    const correction = sanitizedText(signal.correction, MAX_CONTENT_BYTES);
    if (!correction) return null;
    content = `User correction: ${correction}`;
    kind = 'user_turn';
    subtype = 'workspace_user_correction';
    title = 'Workspace user correction';
    wake = true;
    discriminator = digest(correction);
    metadata = {
      bridgeVersion: BRIDGE_VERSION,
      workspaceId: refs.workspaceId,
      sourceId: refs.sourceId,
      observationId: refs.observationId,
      contentHash: refs.contentHash,
      eventKind: signal.kind,
      provenanceSummary,
    };
  } else {
    const summary = sanitizedText(signal.summary, MAX_CONTENT_BYTES);
    content = summary
      ? `Workspace effect ${signal.decision}: ${summary}`
      : `Workspace effect ${signal.decision}.`;
    kind = 'tool_result';
    subtype = `workspace_effect_${signal.decision}`;
    title = `Workspace effect ${signal.decision}`;
    wake = true;
    discriminator = signal.decision;
    metadata = {
      bridgeVersion: BRIDGE_VERSION,
      workspaceId: refs.workspaceId,
      sourceId: refs.sourceId,
      observationId: refs.observationId,
      contentHash: refs.contentHash,
      eventKind: signal.kind,
      decision: signal.decision,
      provenanceSummary,
    };
  }

  const identity = episodeIdentity({
    ...refs,
    eventKind: signal.kind,
    discriminator,
    occurredAt: signal.occurredAt,
  });
  return {
    wake,
    input: fitPayload({
      kind,
      subtype,
      title,
      metadata,
      sourceApp: 'workspace',
      sessionId: identity.sessionId,
      callId: identity.callId,
      sourceUri,
      occurredAt: normalizedOccurredAt(signal.occurredAt),
      content,
      status: 'available',
    }),
  };
}

const defaultDependencies: WorkspaceObservationMemoryDependencies = {
  findEpisode: ({ sessionId, callId }) => {
    const row = openMemoryDb().prepare(`
      SELECT id
      FROM memory_episodes
      WHERE session_id = ? AND call_id = ?
      LIMIT 1
    `).get(sessionId, callId) as { id: string } | undefined;
    return row ?? null;
  },
  recordEpisode: (input) => recordMemoryEpisode(input),
};

function ensureWorkspaceProjectionReceiptSchema(db: Database.Database): void {
  if (projectionSchemaReady.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_memory_projection_receipts (
      workspace_id   TEXT NOT NULL,
      observation_id TEXT NOT NULL,
      disposition    TEXT NOT NULL CHECK (disposition IN ('captured','suppressed')),
      reason         TEXT NOT NULL,
      projected_at   TEXT NOT NULL,
      PRIMARY KEY (workspace_id, observation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_memory_projection_receipts_workspace
      ON workspace_memory_projection_receipts(workspace_id, projected_at);
  `);
  projectionSchemaReady.add(db);
}

function validatedWorkspaceSlug(workspaceId: string): string {
  if (
    typeof workspaceId !== 'string'
    || workspaceId.trim() !== workspaceId
    || !WORKSPACE_SLUG_RE.test(workspaceId)
  ) {
    throw new Error(`invalid workspace slug: ${String(workspaceId)}`);
  }
  return workspaceId;
}

function validatedObservationId(observationId: string): string {
  if (
    typeof observationId !== 'string'
    || observationId.trim() !== observationId
    || observationId.length < 1
    || observationId.length > 128
    || /[\u0000-\u001f\u007f]/.test(observationId)
  ) {
    throw new Error('invalid Workspace observation id');
  }
  return observationId;
}

/**
 * Metadata-only outbox receipts keep restart recovery proportional to missing
 * work. They contain no dataset values, paths, row identities, or model prose.
 */
export function listWorkspaceObservationMemoryProjectionIds(
  workspaceId: string,
  db: Database.Database = openMemoryDb(),
): Set<string> {
  const slug = validatedWorkspaceSlug(workspaceId);
  ensureWorkspaceProjectionReceiptSchema(db);
  const rows = db.prepare(`
    SELECT observation_id
    FROM workspace_memory_projection_receipts
    WHERE workspace_id = ?
  `).all(slug) as Array<{ observation_id: string }>;
  return new Set(rows.map((row) => row.observation_id));
}

export function hasWorkspaceObservationMemoryProjection(
  workspaceId: string,
  observationId: string,
  db: Database.Database = openMemoryDb(),
): boolean {
  const slug = validatedWorkspaceSlug(workspaceId);
  const id = validatedObservationId(observationId);
  ensureWorkspaceProjectionReceiptSchema(db);
  return Boolean(db.prepare(`
    SELECT 1
    FROM workspace_memory_projection_receipts
    WHERE workspace_id = ? AND observation_id = ?
    LIMIT 1
  `).get(slug, id));
}

export function recordWorkspaceObservationMemoryProjection(
  input: Omit<WorkspaceObservationProjectionReceipt, 'projectedAt'> & {
    projectedAt?: string;
  },
  db: Database.Database = openMemoryDb(),
): WorkspaceObservationProjectionReceipt {
  const workspaceId = validatedWorkspaceSlug(input.workspaceId);
  const observationId = validatedObservationId(input.observationId);
  const reason = sanitizedText(input.reason, 80) || 'unspecified';
  const projectedAt = normalizedOccurredAt(input.projectedAt ?? new Date().toISOString());
  ensureWorkspaceProjectionReceiptSchema(db);
  db.prepare(`
    INSERT INTO workspace_memory_projection_receipts
      (workspace_id, observation_id, disposition, reason, projected_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, observation_id) DO NOTHING
  `).run(
    workspaceId,
    observationId,
    input.disposition,
    reason,
    projectedAt,
  );
  const row = db.prepare(`
    SELECT workspace_id, observation_id, disposition, reason, projected_at
    FROM workspace_memory_projection_receipts
    WHERE workspace_id = ? AND observation_id = ?
  `).get(workspaceId, observationId) as {
    workspace_id: string;
    observation_id: string;
    disposition: WorkspaceObservationProjectionDisposition;
    reason: string;
    projected_at: string;
  };
  return {
    workspaceId: row.workspace_id,
    observationId: row.observation_id,
    disposition: row.disposition,
    reason: row.reason,
    projectedAt: row.projected_at,
  };
}

export function pruneWorkspaceObservationMemoryProjections(
  workspaceId: string,
  retainedObservationIds: Iterable<string>,
  db: Database.Database = openMemoryDb(),
): number {
  const slug = validatedWorkspaceSlug(workspaceId);
  const retained = [...new Set(
    [...retainedObservationIds].map((observationId) =>
      validatedObservationId(observationId)),
  )];
  ensureWorkspaceProjectionReceiptSchema(db);
  if (retained.length === 0) {
    return db.prepare(`
      DELETE FROM workspace_memory_projection_receipts
      WHERE workspace_id = ?
    `).run(slug).changes;
  }
  return db.prepare(`
    DELETE FROM workspace_memory_projection_receipts
    WHERE workspace_id = ?
      AND observation_id NOT IN (
        SELECT CAST(value AS TEXT)
        FROM json_each(?)
      )
  `).run(slug, JSON.stringify(retained)).changes;
}

/**
 * Strict hard-delete companion for Workspace files/history.
 *
 * The synthetic `workspace:<slug>` session is generation-local. Removing every
 * episode and derived row attached to that exact session prevents a recreated
 * slug from inheriting old episodic recall. The transaction clears or removes
 * every current FK shape before deleting episodes, then verifies integrity.
 * Callers should treat any thrown error as a failed Workspace hard delete.
 */
export function purgeWorkspaceObservationMemory(
  workspaceId: string,
  db: Database.Database = openMemoryDb(),
): WorkspaceMemoryPurgeResult {
  const slug = validatedWorkspaceSlug(workspaceId);
  const sessionId = `workspace:${slug}`;
  ensureWorkspaceProjectionReceiptSchema(db);
  const episodeSelector = `
    SELECT id
    FROM memory_episodes
    WHERE source_app = 'workspace' AND session_id = ?
  `;

  return db.transaction(() => {
    const episodesBefore = Number((db.prepare(`
      SELECT COUNT(*) AS count FROM (${episodeSelector})
    `).get(sessionId) as { count: number }).count);
    let pendingRowsDeleted = 0;
    for (const table of [
      'reflection_pending_extractions',
      'memory_reflection_receipts',
      'memory_reflection_candidates',
      'episodic_pointers',
    ]) {
      const exists = db.prepare(`
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
      `).get(table);
      if (!exists) continue;
      pendingRowsDeleted += db.prepare(
        `DELETE FROM "${table}" WHERE session_id = ?`,
      ).run(sessionId).changes;
    }

    // The bridge itself does not consolidate facts, but deleting an exact
    // synthetic-session derivative closes the future-proof privacy seam if a
    // later reflection path ever promotes one.
    const derivedFactsDeleted = db.prepare(`
      DELETE FROM consolidated_facts
      WHERE source_session_id = ? OR derived_from_session_id = ?
    `).run(sessionId, sessionId).changes;

    let evidenceRowsDeleted = 0;
    let evidenceReferencesCleared = 0;
    for (const [table, column] of [
      ['fact_evidence', 'episode_id'],
      ['entity_edge_evidence', 'episode_id'],
      ['entity_observations', 'episode_id'],
    ] as const) {
      evidenceRowsDeleted += db.prepare(`
        DELETE FROM "${table}"
        WHERE "${column}" IN (${episodeSelector})
      `).run(sessionId).changes;
    }
    for (const [table, column] of [
      ['entity_edges', 'evidence_episode_id'],
      ['entity_aliases', 'evidence_episode_id'],
      ['entity_identifiers', 'evidence_episode_id'],
      ['entity_redirects', 'evidence_episode_id'],
      ['entity_edge_validity_intervals', 'evidence_episode_id'],
      ['fact_entities', 'evidence_episode_id'],
      ['fact_resources', 'evidence_episode_id'],
      ['memory_reflection_candidates', 'episode_id'],
    ] as const) {
      evidenceReferencesCleared += db.prepare(`
        UPDATE "${table}"
        SET "${column}" = NULL
        WHERE "${column}" IN (${episodeSelector})
      `).run(sessionId).changes;
    }

    const episodesDeleted = db.prepare(`
      DELETE FROM memory_episodes
      WHERE source_app = 'workspace' AND session_id = ?
    `).run(sessionId).changes;
    if (episodesDeleted !== episodesBefore) {
      throw new Error(
        `Workspace memory purge verification failed for "${slug}"`,
      );
    }
    const projectionReceiptsDeleted = db.prepare(`
      DELETE FROM workspace_memory_projection_receipts
      WHERE workspace_id = ?
    `).run(slug).changes;
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new Error(
        `Workspace memory purge foreign-key check failed for "${slug}"`,
      );
    }
    return {
      workspaceId: slug,
      episodesDeleted,
      derivedFactsDeleted,
      pendingRowsDeleted,
      evidenceRowsDeleted,
      evidenceReferencesCleared,
      projectionReceiptsDeleted,
    };
  }).immediate();
}

export function createWorkspaceObservationMemoryBridge(
  dependencies: WorkspaceObservationMemoryDependencies = defaultDependencies,
  options: WorkspaceObservationMemoryOptions = {},
): {
  capture(signal: WorkspaceMemorySignal): Promise<WorkspaceMemoryCaptureResult>;
} {
  return {
    async capture(signal) {
      if (!validSignalReferences(signal)) {
        return {
          status: 'suppressed',
          reason: 'invalid_signal',
          episodeId: null,
          wake: false,
        };
      }

      if (signal.kind === 'observation') {
        if (signal.outcome !== 'succeeded') {
          return {
            status: 'suppressed',
            reason: 'unsuccessful_observation',
            episodeId: null,
            wake: false,
          };
        }
        if (signal.previousContentHash === signal.contentHash) {
          return {
            status: 'suppressed',
            reason: 'unchanged',
            episodeId: null,
            wake: false,
          };
        }
        if (signal.previousContentHash === null && !options.includeFirstObservation) {
          return {
            status: 'suppressed',
            reason: 'first_observation_disabled',
            episodeId: null,
            wake: false,
          };
        }
      }

      const prepared = prepareEpisode(signal);
      if (!prepared) {
        return {
          status: 'suppressed',
          reason: signal.kind === 'user_correction'
            ? 'empty_correction'
            : 'no_meaningful_change',
          episodeId: null,
          wake: false,
        };
      }

      try {
        const sessionId = prepared.input.sessionId;
        const callId = prepared.input.callId;
        if (!sessionId || !callId) throw new Error('missing episode identity');
        const existing = await dependencies.findEpisode({ sessionId, callId });
        if (existing) {
          return {
            status: 'deduped',
            reason: null,
            episodeId: existing.id,
            wake: false,
          };
        }
        const recorded = await dependencies.recordEpisode(prepared.input);
        return {
          status: 'recorded',
          reason: null,
          episodeId: recorded.id,
          wake: prepared.wake,
        };
      } catch {
        // Workspace state is already durable at this seam. Memory is a
        // best-effort projection and must never roll back or fail that write.
        return {
          status: 'failed',
          reason: 'memory_unavailable',
          episodeId: null,
          wake: false,
        };
      }
    },
  };
}
