/**
 * Generic DependencyRequest — the canonical parked-task dependency.
 *
 * A connection event does not satisfy. Authoritative, freshly observed,
 * account-bound capability (or the matching user act) does. Index miss,
 * compiler failure, and author timeout are not connection_missing.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  appendEvent,
  getEvent,
  getToolOutput,
  getToolOutputForInvocation,
  listEvents,
  openEventLog,
} from './eventlog.js';
import { readConsumedTaskContinuityPacket } from '../../memory/task-continuity.js';
import { renderTypedControlState } from './typed-control-state.js';

export const DEPENDENCY_REQUEST_VERSION = 1 as const;

export type DependencyKind =
  | 'connection_missing'
  | 'capability_contract_missing'
  | 'capability_certification_required'
  | 'account_or_resource_choice'
  | 'user_input'
  | 'approval'
  | 'spend_authority'
  | 'argument_provenance_missing'
  | 'external_wait'
  | 'transient_catalog_or_provider_state'
  | 'policy_resolution';

export type DependencyStatus = 'open' | 'resolving' | 'satisfied' | 'cancelled';

export interface DependencyRequestV1 {
  version: typeof DEPENDENCY_REQUEST_VERSION;
  requestId: string;
  kind: DependencyKind;
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  owner: 'user' | 'host';
  wake: { kind: string };
  status: DependencyStatus;
  text: string;
  connectionSubject?: ConnectionDependencySubject;
  createdAt: string;
  satisfiedAt?: string;
}

function ensureTable(): void {
  const db = openEventLog();
  db.exec(`
    CREATE TABLE IF NOT EXISTS dependency_requests (
      request_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      session_id TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL,
      turn INTEGER NOT NULL,
      owner TEXT NOT NULL,
      wake_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      text TEXT NOT NULL,
      subject_kind TEXT,
      subject_provider TEXT,
      subject_toolkit TEXT,
      subject_capability TEXT,
      subject_capability_ref TEXT,
      subject_discovery_query TEXT,
      subject_discovery_role TEXT,
      continue_option_id TEXT,
      continue_option_label TEXT,
      created_at TEXT NOT NULL,
      satisfied_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dependency_requests_open
      ON dependency_requests (status, session_id);
  `);
  const columns = new Set((db.prepare('PRAGMA table_info(dependency_requests)').all() as Array<{
    name: string;
  }>).map((column) => column.name));
  for (const [name, declaration] of [
    ['subject_kind', 'TEXT'],
    ['subject_provider', 'TEXT'],
    ['subject_toolkit', 'TEXT'],
    ['subject_capability', 'TEXT'],
    ['subject_capability_ref', 'TEXT'],
    ['subject_discovery_query', 'TEXT'],
    ['subject_discovery_role', 'TEXT'],
    ['continue_option_id', 'TEXT'],
    ['continue_option_label', 'TEXT'],
  ] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE dependency_requests ADD COLUMN ${name} ${declaration}`);
  }
}

export type ConnectionDependencySubject = {
  kind: 'exact_capability_connection';
  provider: 'authorized_composio';
  toolkit: string;
  capability: string;
  capabilityRef: string;
  discoveryQuery: string;
  discoveryRole?: string;
  continueOptionId: string;
  continueOptionLabel: string;
} | {
  kind: 'provider_reconnect_and_rerun';
  provider: 'authorized_composio';
  discoveryQuery: string;
  discoveryRole?: string;
  continueOptionId: string;
  continueOptionLabel: string;
};

type ConnectionDependencyObservedSubject =
  | Omit<Extract<ConnectionDependencySubject, { kind: 'exact_capability_connection' }>,
      'continueOptionId' | 'continueOptionLabel'>
  | Omit<Extract<ConnectionDependencySubject, { kind: 'provider_reconnect_and_rerun' }>,
      'continueOptionId' | 'continueOptionLabel'>;

export function dependencyCopy(kind: DependencyKind): string {
  if (kind === 'connection_missing') {
    return renderTypedControlState({
      status: 'needs_input',
      hold: { owner: 'user', wake: { kind: 'user_connection' }, gate: 'credential_connection_required' },
    });
  }
  if (kind === 'capability_certification_required') {
    return 'This connected app is visible but not certified for the required effect contract. Review the contract — I will continue this exact request. Nothing was started.';
  }
  if (kind === 'capability_contract_missing') {
    return 'I understood the task, but no attested capability contract covers it yet. Nothing was started. I will continue this exact request.';
  }
  return renderTypedControlState({
    status: 'needs_input',
    hold: { owner: 'user', wake: { kind: 'user_answer' } },
  });
}

export function parkDependencyRequest(input: {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  kind: DependencyKind;
  text?: string;
  connectionSubject?: ConnectionDependencySubject;
}): DependencyRequestV1 {
  ensureTable();
  const existing = openEventLog().prepare(
    `SELECT * FROM dependency_requests
      WHERE session_id = ? AND source_user_seq = ? AND status = 'open'`,
  ).get(input.sessionId, input.sourceUserSeq) as {
    request_id: string;
    kind: DependencyKind;
    session_id: string;
    source_user_seq: number;
    turn: number;
    owner: 'user' | 'host';
    wake_kind: string;
    status: DependencyStatus;
    text: string;
    subject_kind: string | null;
    subject_provider: string | null;
    subject_toolkit: string | null;
    subject_capability: string | null;
    subject_capability_ref: string | null;
    subject_discovery_query: string | null;
    subject_discovery_role: string | null;
    continue_option_id: string | null;
    continue_option_label: string | null;
    created_at: string;
    satisfied_at: string | null;
  } | undefined;
  if (existing) {
    // Rolling-upgrade repair: pre-subject connection parks are durable and
    // legitimately replay after restart, but their nullable legacy row cannot
    // ever be satisfied safely. Enrich only a wholly unbound, still-open row
    // from the newly observed canonical discovery subject. Partial/malformed
    // subjects remain fail-closed; model copy cannot enter this path because
    // parkObservedConnectionDependencyForSource supplies the host projection.
    if (
      existing.kind === 'connection_missing'
      && input.kind === 'connection_missing'
      && input.connectionSubject
      && !existing.subject_kind
      && !existing.subject_provider
      && !existing.subject_toolkit
      && !existing.subject_capability
      && !existing.subject_capability_ref
      && !existing.subject_discovery_query
      && !existing.subject_discovery_role
      && !existing.continue_option_id
      && !existing.continue_option_label
    ) {
      const subject = input.connectionSubject;
      const canonicalText = input.text?.trim() || dependencyCopy(input.kind);
      const enriched = openEventLog().prepare(`
        UPDATE dependency_requests
           SET text = ?, subject_kind = ?, subject_provider = ?,
               subject_toolkit = ?, subject_capability = ?,
               subject_capability_ref = ?, subject_discovery_query = ?,
               subject_discovery_role = ?, continue_option_id = ?,
               continue_option_label = ?
         WHERE request_id = ? AND status = 'open' AND kind = 'connection_missing'
           AND subject_kind IS NULL AND subject_provider IS NULL
           AND subject_toolkit IS NULL AND subject_capability IS NULL
           AND subject_capability_ref IS NULL AND subject_discovery_query IS NULL
           AND subject_discovery_role IS NULL AND continue_option_id IS NULL
           AND continue_option_label IS NULL
      `).run(
        canonicalText,
        subject.kind,
        subject.provider,
        subject.kind === 'exact_capability_connection' ? subject.toolkit : null,
        subject.kind === 'exact_capability_connection' ? subject.capability : null,
        subject.kind === 'exact_capability_connection' ? subject.capabilityRef : null,
        subject.discoveryQuery,
        subject.discoveryRole ?? null,
        subject.continueOptionId,
        subject.continueOptionLabel,
        existing.request_id,
      );
      if (enriched.changes === 1) {
        return {
          version: 1,
          requestId: existing.request_id,
          kind: existing.kind,
          sessionId: existing.session_id,
          sourceUserSeq: existing.source_user_seq,
          turn: existing.turn,
          owner: existing.owner,
          wake: { kind: existing.wake_kind },
          status: existing.status,
          text: canonicalText,
          connectionSubject: subject,
          createdAt: existing.created_at,
        };
      }
    }
    return {
      version: 1,
      requestId: existing.request_id,
      kind: existing.kind,
      sessionId: existing.session_id,
      sourceUserSeq: existing.source_user_seq,
      turn: existing.turn,
      owner: existing.owner,
      wake: { kind: existing.wake_kind },
      status: existing.status,
      text: existing.text,
      ...(() => {
        if (
          existing.kind !== 'connection_missing'
          || existing.subject_provider !== 'authorized_composio'
          || !existing.subject_discovery_query
          || !existing.continue_option_id
          || !existing.continue_option_label
        ) return {};
        const common = {
          provider: 'authorized_composio' as const,
          discoveryQuery: existing.subject_discovery_query,
          ...(existing.subject_discovery_role
            ? { discoveryRole: existing.subject_discovery_role }
            : {}),
          continueOptionId: existing.continue_option_id,
          continueOptionLabel: existing.continue_option_label,
        };
        if (existing.subject_kind === 'provider_reconnect_and_rerun') {
          return {
            connectionSubject: {
              ...common,
              kind: 'provider_reconnect_and_rerun' as const,
            },
          };
        }
        if (
          existing.subject_kind === 'exact_capability_connection'
          && existing.subject_toolkit
          && existing.subject_capability
          && existing.subject_capability_ref
        ) {
          return {
            connectionSubject: {
              ...common,
              kind: 'exact_capability_connection' as const,
              toolkit: existing.subject_toolkit,
              capability: existing.subject_capability,
              capabilityRef: existing.subject_capability_ref,
            },
          };
        }
        return {};
      })(),
      createdAt: existing.created_at,
      ...(existing.satisfied_at ? { satisfiedAt: existing.satisfied_at } : {}),
    };
  }
  const now = new Date().toISOString();
  const requestId = `dep:${createHash('sha256')
    .update(`${input.sessionId}:${input.sourceUserSeq}:${randomUUID()}`)
    .digest('hex')
    .slice(0, 24)}`;
  const owner: 'user' | 'host' = (
    input.kind === 'external_wait' || input.kind === 'transient_catalog_or_provider_state'
  ) ? 'host' : 'user';
  const wake = owner === 'host' ? 'host_retry' : (
    input.kind === 'connection_missing' ? 'user_connection'
      : input.kind === 'approval' ? 'user_approval'
        : 'user_answer'
  );
  const text = input.text?.trim() || dependencyCopy(input.kind);
  openEventLog().prepare(
    `INSERT INTO dependency_requests (
      request_id, kind, session_id, source_user_seq, turn, owner, wake_kind, status, text,
      subject_kind, subject_provider,
      subject_toolkit, subject_capability, subject_capability_ref,
      subject_discovery_query, subject_discovery_role, continue_option_id,
      continue_option_label, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    requestId,
    input.kind,
    input.sessionId,
    input.sourceUserSeq,
    input.turn,
    owner,
    wake,
    text,
    input.connectionSubject?.kind ?? null,
    input.connectionSubject?.provider ?? null,
    input.connectionSubject?.kind === 'exact_capability_connection'
      ? input.connectionSubject.toolkit
      : null,
    input.connectionSubject?.kind === 'exact_capability_connection'
      ? input.connectionSubject.capability
      : null,
    input.connectionSubject?.kind === 'exact_capability_connection'
      ? input.connectionSubject.capabilityRef
      : null,
    input.connectionSubject?.discoveryQuery ?? null,
    input.connectionSubject?.discoveryRole ?? null,
    input.connectionSubject?.continueOptionId ?? null,
    input.connectionSubject?.continueOptionLabel ?? null,
    now,
  );
  try {
    appendEvent({
      sessionId: input.sessionId,
      turn: input.turn,
      role: 'system',
      type: 'dependency_request',
      data: { requestId, kind: input.kind, sourceUserSeq: input.sourceUserSeq, status: 'open' },
    });
  } catch { /* table row is authority */ }
  return {
    version: 1,
    requestId,
    kind: input.kind,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    turn: input.turn,
    owner,
    wake: { kind: wake },
    status: 'open',
    text,
    ...(input.connectionSubject ? { connectionSubject: input.connectionSubject } : {}),
    createdAt: now,
  };
}

interface ToolSearchUnavailableProjection {
  source?: unknown;
  code?: unknown;
  dependencySubject?: unknown;
}

interface ToolSearchResultProjection {
  name?: unknown;
  capabilityRef?: unknown;
  planningProvenance?: unknown;
  carrier?: unknown;
  selectedAccount?: unknown;
}

interface ToolSearchSelectedAccountProjection {
  toolkit?: unknown;
  accountIdentity?: unknown;
  accountIdentityKind?: unknown;
  email?: unknown;
}

interface ToolSearchUnavailableSubjectProjection {
  version?: unknown;
  kind?: unknown;
  source?: unknown;
  query?: unknown;
  roleKey?: unknown;
  toolkit?: unknown;
  capability?: unknown;
  capabilityRef?: unknown;
}

export interface ConnectionDependencyPresentation {
  question: string;
  options: readonly [string, string];
  subject: ConnectionDependencySubject;
}

function toolkitDisplayName(toolkit: string): string {
  return toolkit.split('_')
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}

function connectionPresentationForSubject(
  subject: ConnectionDependencyObservedSubject,
): ConnectionDependencyPresentation {
  if (subject.kind === 'exact_capability_connection') {
    const label = toolkitDisplayName(subject.toolkit);
    const question = `${label} isn’t connected, so I can’t use ${subject.capability} for this task yet. `
      + `[Open Connections](/m/?tab=settings&toolkit=${encodeURIComponent(subject.toolkit)}`
      + `&capability=${encodeURIComponent(subject.capability)}) on this Mac and connect ${label}, `
      + 'then choose how you want me to continue:';
    const options = [
      `I’ve connected ${label} — continue this same task`,
      'Pause so I can change the research scope',
    ] as const;
    return {
      question,
      options,
      subject: {
        ...subject,
        continueOptionId: 'opt-1',
        continueOptionLabel: options[0],
      },
    };
  }
  const question = 'A connected research provider isn’t available for this task yet. '
    + '[Open Connections](/m/?tab=settings) on this Mac and connect a suitable provider, '
    + 'then choose how you want me to continue:';
  const options = [
    'I’ve connected a provider — continue this same task',
    'Pause so I can change the research scope',
  ] as const;
  return {
    question,
    options,
    subject: {
      ...subject,
      continueOptionId: 'opt-1',
      continueOptionLabel: options[0],
    },
  };
}

/**
 * Recover the one host-authored connection subject from canonical discovery.
 *
 * No question, option label, Markdown link, localization, or model prose is
 * read here. Those bytes are presentation only and are projected later from
 * this subject. The durable top-level tool_search result owns the provider,
 * exact query/role, and (when the adapter proved a named target) the exact
 * toolkit/operation/future planning-ref identity.
 */
function observedConnectionPresentationForSource(input: {
  sessionId: string;
  sourceUserSeq: number;
}): ConnectionDependencyPresentation | null {
  let returned: ReturnType<typeof listEvents>;
  try {
    returned = listEvents(input.sessionId, { types: ['tool_returned'] })
      .filter((event) => (
        event.data.sourceUserSeq === input.sourceUserSeq
        && event.data.tool === 'tool_search'
        && event.data.accounting === 'top_level'
        && event.data.topologyRole === 'control'
      ))
      .reverse();
  } catch {
    return null;
  }
  for (const event of returned) {
    const callId = typeof event.data.callId === 'string' ? event.data.callId.trim() : '';
    const durable = (() => {
      if (!callId) return null;
      try { return getToolOutput(input.sessionId, callId); } catch { return null; }
    })();
    const raw = durable?.tool === 'tool_search' && !durable.truncatedAtWrite
      ? durable.output
      : typeof event.data.result === 'string' ? event.data.result : '';
    if (!raw) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(raw) as unknown; } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const body = parsed as {
      query?: unknown;
      role_key?: unknown;
      brokerCoverage?: unknown;
      unavailable?: unknown;
      results?: unknown;
    };
    const discoveryQuery = typeof body.query === 'string' ? body.query.trim() : '';
    const discoveryRole = typeof body.role_key === 'string' ? body.role_key.trim() : '';
    if (
      body.brokerCoverage !== 'authorized_external_v1'
      || !discoveryQuery
      || discoveryQuery.length > 240
      || /[\u0000-\u001f\u007f]/.test(discoveryQuery)
      || (discoveryRole && !/^[a-z][a-z0-9_:-]{0,79}$/.test(discoveryRole))
    ) continue;
    const results = Array.isArray(body.results)
      ? body.results as ToolSearchResultProjection[]
      : [];
    if (results.some((entry) => (
      entry
      && typeof entry.capabilityRef === 'string'
      && entry.capabilityRef.trim().length > 0
      && entry.planningProvenance !== 'authorized_local_registry'
    ))) continue;
    const subjects: ConnectionDependencyObservedSubject[] = [];
    for (const unavailable of Array.isArray(body.unavailable)
      ? body.unavailable as ToolSearchUnavailableProjection[]
      : []) {
      if (
        !unavailable
        || unavailable.source !== 'authorized_composio'
        || (unavailable.code !== 'no_connections' && unavailable.code !== 'not_authenticated')
        || !unavailable.dependencySubject
        || typeof unavailable.dependencySubject !== 'object'
        || Array.isArray(unavailable.dependencySubject)
      ) continue;
      const projected = unavailable.dependencySubject as ToolSearchUnavailableSubjectProjection;
      if (
        projected.version !== 1
        || projected.source !== unavailable.source
        || projected.query !== discoveryQuery
        || (discoveryRole ? projected.roleKey !== discoveryRole : projected.roleKey !== undefined)
      ) continue;
      const common = {
        provider: 'authorized_composio' as const,
        discoveryQuery,
        ...(discoveryRole ? { discoveryRole } : {}),
      };
      if (projected.kind === 'provider_reconnect_and_rerun') {
        subjects.push({ ...common, kind: 'provider_reconnect_and_rerun' });
        continue;
      }
      const toolkit = typeof projected.toolkit === 'string'
        ? projected.toolkit.trim().toLowerCase()
        : '';
      const capability = typeof projected.capability === 'string'
        ? projected.capability.trim().toUpperCase()
        : '';
      const capabilityRef = typeof projected.capabilityRef === 'string'
        ? projected.capabilityRef.trim()
        : '';
      if (
        projected.kind !== 'exact_capability_connection'
        || !/^[a-z0-9][a-z0-9_]{0,79}$/.test(toolkit)
        || !/^[A-Z0-9][A-Z0-9_]{1,159}$/.test(capability)
        || !capability.startsWith(`${toolkit.toUpperCase()}_`)
        || capabilityRef !== `cap:resolved:${capability.toLowerCase()}`
      ) continue;
      subjects.push({
        ...common,
        kind: 'exact_capability_connection',
        toolkit,
        capability,
        capabilityRef,
      });
    }
    const unique = new Map(subjects.map((subject) => [JSON.stringify(subject), subject]));
    if (unique.size !== 1) continue;
    return connectionPresentationForSubject([...unique.values()][0]!);
  }
  return null;
}

export function observedConnectionDependencyPresentationForSource(input: {
  sessionId: string;
  sourceUserSeq: number;
}): ConnectionDependencyPresentation | null {
  if (!Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq <= 0) return null;
  return observedConnectionPresentationForSource(input);
}

/**
 * Project one typed connection dependency from host-owned discovery evidence.
 *
 * The model's question/reason is presentation only. It cannot classify a
 * credential gap. The subtype is earned only when this exact accepted source
 * has a canonical top-level `tool_search` return whose broker reports a
 * missing/unauthenticated connection, and that same result supplied no
 * executable external ref.
 * A prior source, provider prose, an index miss, timeout, or an ordinary user
 * choice therefore cannot become `connection_missing`.
 */
export function parkObservedConnectionDependencyForSource(input: {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  text?: string;
}): DependencyRequestV1 | null {
  if (!Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq <= 0) return null;
  const presentation = observedConnectionPresentationForSource(input);
  if (!presentation) return null;
  return parkDependencyRequest({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    turn: input.turn,
    kind: 'connection_missing',
    connectionSubject: presentation.subject,
    // Connection copy is rendered from the same host-owned subject as the
    // dependency. Model prose is intentionally ignored here.
    text: presentation.question,
  });
}

export function satisfyOpenDependency(input: {
  sessionId: string;
  sourceUserSeq: number;
}): boolean {
  ensureTable();
  const now = new Date().toISOString();
  const result = openEventLog().prepare(
    `UPDATE dependency_requests SET status = 'satisfied', satisfied_at = ?
      WHERE session_id = ? AND source_user_seq = ? AND status = 'open'`,
  ).run(now, input.sessionId, input.sourceUserSeq);
  return result.changes > 0;
}

/**
 * Satisfy a parked connection dependency only from a fresh, durable discovery
 * return on the exact accepted continuation source.
 *
 * The user's “I've connected it” answer is not authority. The transition is
 * earned after the SDK has parked the complete top-level `tool_search` bytes
 * and their parented return event. The consumed continuity edge identifies the
 * one parent source; an authorized Composio planning ref plus its host-attached
 * selected-account evidence proves that a concrete current connection exists.
 */
export function satisfyObservedConnectionDependencyForContinuation(input: {
  sessionId: string;
  sourceUserSeq: number;
  returnedEventId: string;
}): boolean {
  if (!Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq <= 0) return false;
  const consumed = readConsumedTaskContinuityPacket({
    sessionId: input.sessionId,
    consumingSourceUserSeq: input.sourceUserSeq,
  });
  if (
    consumed.status !== 'consumed'
    || consumed.consumingSourceUserSeq !== input.sourceUserSeq
    || consumed.packet.sessionId !== input.sessionId
    || consumed.resolution.disposition !== 'selected'
    || typeof consumed.resolution.selectedOption !== 'string'
  ) return false;

  const parentSourceUserSeq = consumed.packet.originatingSourceUserSeq;
  ensureTable();
  const db = openEventLog();
  const open = db.prepare(`
    SELECT request_id, subject_kind, subject_provider,
           subject_toolkit, subject_capability,
           subject_capability_ref, subject_discovery_query,
           subject_discovery_role, continue_option_id, continue_option_label
      FROM dependency_requests
     WHERE session_id = ? AND source_user_seq = ?
       AND kind = 'connection_missing' AND status = 'open'
     ORDER BY created_at, request_id
  `).all(input.sessionId, parentSourceUserSeq) as Array<{
    request_id: string;
    subject_kind: string | null;
    subject_provider: string | null;
    subject_toolkit: string | null;
    subject_capability: string | null;
    subject_capability_ref: string | null;
    subject_discovery_query: string | null;
    subject_discovery_role: string | null;
    continue_option_id: string | null;
    continue_option_label: string | null;
  }>;
  if (open.length !== 1) return false;
  const expected = open[0]!;
  if (
    (expected.subject_kind !== 'exact_capability_connection'
      && expected.subject_kind !== 'provider_reconnect_and_rerun')
    || expected.subject_provider !== 'authorized_composio'
    || !expected.subject_discovery_query
    || !expected.continue_option_id
    || !expected.continue_option_label
    || consumed.resolution.selectedOption !== expected.continue_option_id
  ) return false;
  const optionIndexMatch = /^opt-([1-9]\d*)$/.exec(expected.continue_option_id);
  const optionIndex = optionIndexMatch ? Number(optionIndexMatch[1]) - 1 : -1;
  if (
    !Number.isSafeInteger(optionIndex)
    || optionIndex < 0
    || consumed.packet.pause.options[optionIndex] !== expected.continue_option_label
  ) return false;

  const returned = getEvent(input.returnedEventId);
  if (
    !returned
    || returned.sessionId !== input.sessionId
    || returned.type !== 'tool_returned'
    || returned.data.sourceUserSeq !== input.sourceUserSeq
    || returned.data.tool !== 'tool_search'
    || returned.data.accounting !== 'top_level'
    || returned.data.topologyRole !== 'control'
    || returned.data.ok !== true
  ) return false;
  const callId = typeof returned.data.callId === 'string' ? returned.data.callId.trim() : '';
  const invocationNonce = typeof returned.data.invocationNonce === 'string'
    ? returned.data.invocationNonce.trim()
    : '';
  if (!callId || !invocationNonce) return false;
  const durable = getToolOutputForInvocation(input.sessionId, callId, invocationNonce);
  if (!durable || durable.tool !== 'tool_search' || durable.truncatedAtWrite || !durable.output) return false;

  let parsed: unknown;
  try { parsed = JSON.parse(durable.output) as unknown; } catch { return false; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const body = parsed as {
    query?: unknown;
    role_key?: unknown;
    brokerCoverage?: unknown;
    results?: unknown;
  };
  if (
    body.brokerCoverage !== 'authorized_external_v1'
    || body.query !== expected.subject_discovery_query
    || (expected.subject_discovery_role !== null
      && body.role_key !== expected.subject_discovery_role)
    || !Array.isArray(body.results)
  ) return false;
  const observedAccountBoundCapability = (body.results as ToolSearchResultProjection[]).some((entry) => {
    if (
      !entry
      || typeof entry.capabilityRef !== 'string'
      || entry.planningProvenance !== 'authorized_composio'
      || entry.carrier !== 'work_call'
      || !entry.selectedAccount
      || typeof entry.selectedAccount !== 'object'
      || Array.isArray(entry.selectedAccount)
    ) return false;
    const account = entry.selectedAccount as ToolSearchSelectedAccountProjection;
    const toolkit = typeof account.toolkit === 'string' ? account.toolkit.trim() : '';
    const identity = typeof account.accountIdentity === 'string' ? account.accountIdentity.trim() : '';
    if (
      !toolkit
      || toolkit !== toolkit.toLowerCase()
      || !identity
      || identity !== account.accountIdentity
      || (account.accountIdentityKind !== 'email' && account.accountIdentityKind !== 'connection_id')
    ) return false;
    if (
      account.accountIdentityKind === 'email'
      && (typeof account.email !== 'string'
        || account.email.trim().toLowerCase() !== identity.toLowerCase())
    ) return false;
    if (expected.subject_kind === 'provider_reconnect_and_rerun') return true;
    return Boolean(
      expected.subject_toolkit
      && expected.subject_capability
      && expected.subject_capability_ref
      && toolkit === expected.subject_toolkit
      && entry.name === expected.subject_capability
      && entry.capabilityRef === expected.subject_capability_ref
    );
  });
  if (!observedAccountBoundCapability) return false;

  const satisfy = db.transaction(() => {
    const result = db.prepare(`
      UPDATE dependency_requests
         SET status = 'satisfied', satisfied_at = ?
       WHERE request_id = ? AND session_id = ? AND source_user_seq = ?
         AND kind = 'connection_missing' AND status = 'open'
    `).run(
      new Date().toISOString(),
      expected.request_id,
      input.sessionId,
      parentSourceUserSeq,
    );
    return result.changes === 1;
  });
  return satisfy.immediate();
}
