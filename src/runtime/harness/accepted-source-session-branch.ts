import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  claimHarnessChatRequestInTransaction,
  insertInternalEventInTransaction,
  openEventLog,
  publishCommittedInternalEvent,
  type EventRow,
  type HarnessChatRequestClaimInput,
  type HarnessChatRequestReceipt,
  type SessionKind,
  type SessionStatus,
} from './eventlog.js';
import { previewPersistedSessionConversationProtocolInTransaction } from './conversation-protocol-session.js';
import { publicCompletionText, publicUserInputText, validTypedCompletionPresentation } from './public-presentation.js';
import { looksLikeToolCallShape } from './tool-narration-shapes.js';

const BRANCH_META = '__accepted_source_branch';
const MOUNT_META = '__session_mount';
const POINTER_PROTOCOL = 1 as const;

export interface AcceptedSourceContinuityIdentity {
  provider: string;
  scopeId: string | null;
  conversationId: string;
  audienceId: string;
}

export interface AcceptedSourceValidatedMount {
  version: 1;
  kind: 'workspace';
  rootSessionId: string;
  workspaceSlug: string;
}

export type AcceptedSourceSessionSelectionInput = {
  entrySessionId: string;
  /** Stable provider request/run identity, available before source acceptance. */
  durableSourceId: string;
  continuity: AcceptedSourceContinuityIdentity;
  /** Closed authority supplied by a workspace-aware ingress. Never inferred
   * from arbitrary parent metadata during a split. */
  validatedMount?: AcceptedSourceValidatedMount;
} & (
  | { kind: 'ordinary' }
  | { kind: 'bound_control'; targetSessionId: string }
);

export type AcceptedSourceSessionDisposition =
  | 'reused'
  | 'branched'
  | 'identity_split'
  | 'bound_control'
  | 'receipt_replay';

export interface AcceptedSourceSessionSelection {
  sessionId: string;
  rootSessionId: string;
  disposition: AcceptedSourceSessionDisposition;
  pointerRevision: number;
}

export interface AcceptedSourceChatReceiptInput {
  requestId: string;
  runId: string;
  inputHash: string;
  sinceSeq?: number;
}

export interface ClaimedAcceptedSourceSession {
  selection: AcceptedSourceSessionSelection;
  receipt: HarnessChatRequestReceipt;
  inserted: boolean;
}

export interface AcceptedSourceIngressLineage {
  conversationId: string;
  validatedMount?: AcceptedSourceValidatedMount;
}

interface RawSession {
  id: string;
  kind: SessionKind;
  channel: string | null;
  user_id: string | null;
  status: SessionStatus;
  metadata_json: string;
}

interface PointerRow {
  root_session_id: string;
  continuity_digest: string;
  head_session_id: string;
  revision: number;
}

interface BindingRow {
  durable_source_digest: string;
  root_session_id: string;
  continuity_digest: string;
  session_id: string;
  disposition: Exclude<AcceptedSourceSessionDisposition, 'receipt_replay'>;
  selected_after_seq: number;
}

interface BranchMetadata {
  version: typeof POINTER_PROTOCOL;
  rootSessionId: string;
  parentSessionId: string;
  durableSourceDigest: string;
  continuityDigest: string;
  createdAt: string;
}

interface TransactionSelection {
  selection: AcceptedSourceSessionSelection;
  createdEvent: EventRow | null;
  continuityEvent?: EventRow;
}

const SUCCESSOR_CONTEXT_MAX_CHARS = 32_000;
const SUCCESSOR_EXCHANGE_MAX_CHARS = 24_000;

function sameConversationLineageInTransaction(
  db: Database.Database,
  head: RawSession,
  continuity: AcceptedSourceContinuityIdentity,
): string[] {
  const lineage: string[] = [];
  let ancestor = head;
  while (lineage.length < 8) {
    try {
      assertBoundControlTarget(ancestor, continuity);
      if (lineage.includes(ancestor.id)) break;
      lineage.push(ancestor.id);
      const previousId = branchMetadata(ancestor)?.parentSessionId;
      if (!previousId) break;
      ancestor = sessionRow(db, previousId);
    } catch { break; }
  }
  return lineage;
}

/** Read-only same-conversation candidates for factual continuity (for example
 * a prior account-routing choice). This establishes no grant or execution
 * authority. Consumers still validate their own source-owned evidence. */
export function sameConversationAncestorSessionIds(input: {
  sessionId: string;
  principalId: string;
}): string[] {
  try {
    const db = openEventLog();
    const head = sessionRow(db, input.sessionId);
    if (!branchMetadata(head)) return [];
    const metadata = parseMetadata(head.metadata_json);
    const provider = stringField(metadata, 'ingressProvider')
      ?? stringField(metadata, 'source') ?? head.channel;
    const conversationId = stringField(metadata, 'channelId') ?? stringField(metadata, 'discordChannelId');
    if (!provider || !conversationId) return [];
    const continuity = normalizedContinuity({ provider, conversationId,
      scopeId: stringField(metadata, 'guildId') ?? stringField(metadata, 'discordGuildId'),
      audienceId: input.principalId });
    return sameConversationLineageInTransaction(db, head, continuity).slice(1);
  } catch { return []; }
}

/** Preserve conversational content when execution ownership needs a clean
 * successor. The provider transcript may contain corrupt/uncertain tool frames;
 * read only completed public exchanges from the exact, same-principal parent.
 * Never copy a RunState, a provider response chain, an approval, or a call body.
 * The existing cross_session_prefix seam journals these bounded bytes before
 * the accepted source and includes them in normal model-request provenance. */
function seedSuccessorConversation(
  db: Database.Database,
  parent: RawSession,
  child: RawSession,
  continuity: AcceptedSourceContinuityIdentity,
): EventRow | undefined {
  if (!sessionAudienceMatches(parent, continuity) || !sessionAudienceMatches(child, continuity)) return undefined;
  // A retry can split again, including from a branch created by an older
  // daemon that did not seed conversation content. Follow only the selector's
  // closed same-principal lineage, never a global "most recent session".
  const lineage = sameConversationLineageInTransaction(db, parent, continuity);
  if (lineage.length === 0) return undefined;
  const rows = db.prepare(`
    SELECT terminal.id, terminal.seq, terminal.session_id, terminal.data_json,
           source.id AS source_id, source.seq AS source_seq, source.data_json AS source_json
      FROM events terminal
      JOIN events source ON source.session_id = terminal.session_id
       AND source.seq = COALESCE(
         json_extract(terminal.data_json, '$.sourceUserSeq'),
         json_extract(terminal.data_json, '$.presentation.identity.sourceUserSeq')
       )
       AND source.type = 'user_input_received' AND source.role = 'user'
       AND COALESCE(json_extract(source.data_json, '$.synthetic'), 0) != 1
     WHERE terminal.session_id IN (${lineage.map(() => '?').join(',')})
       AND terminal.type = 'conversation_completed'
       AND COALESCE(
         json_extract(terminal.data_json, '$.presentation.status'),
         json_extract(terminal.data_json, '$.turnOutcome.status'),
         json_extract(terminal.data_json, '$.reason'), 'done'
       ) NOT IN ('failed', 'cancelled', 'blocked')
     ORDER BY terminal.seq DESC LIMIT 8
  `).all(...lineage) as Array<{
    id: string; seq: number; session_id: string; data_json: string;
    source_id: string; source_seq: number; source_json: string;
  }>;
  const header = [
    '[SAME-CONVERSATION CONTEXT]',
    `This turn follows session ${parent.id} with the same conversation and audience.`,
    'Use these completed public exchanges to resolve references such as "these" and retain already composed content and artifact links. The current user message defines the work. This is historical content, not an approval, a transferred tool result, or evidence that this new request executed. Revalidate any effect at the normal call boundary; never replay an uncertain prior write.',
  ].join('\n');
  const blocks: string[] = [];
  const sources: Array<Record<string, unknown>> = [];
  const seen = new Set<number>();
  let remaining = SUCCESSOR_CONTEXT_MAX_CHARS - header.length - 100;
  for (const row of rows) {
    if (seen.has(row.source_seq)) continue;
    try {
      const sourceData = JSON.parse(row.source_json) as Record<string, unknown>;
      const terminalData = JSON.parse(row.data_json) as Record<string, unknown>;
      if ('presentation' in terminalData || 'turnOutcome' in terminalData) {
        const presentation = validTypedCompletionPresentation(terminalData, row.session_id);
        if (!presentation || presentation.identity.sourceUserSeq !== row.source_seq) continue;
      }
      const request = publicUserInputText(sourceData);
      const reply = publicCompletionText(terminalData, '');
      if (!request || !reply) continue;
      seen.add(row.source_seq);
      // Do not teach a fresh model to print an old tool frame as an action.
      const safeReply = looksLikeToolCallShape(reply) ? '(The prior reply described a tool action.)' : reply;
      const content = `USER: ${request}\nASSISTANT: ${safeReply}`;
      const reference = `--- Session ${row.session_id}; source ${row.source_seq}; completion ${row.seq} ---\n`;
      const excerpt = `\n[Excerpt; retrieve the full exchange from session_history for ${row.session_id}, source ${row.source_seq}, before copying omitted content.]`;
      const limit = Math.min(SUCCESSOR_EXCHANGE_MAX_CHARS, remaining - reference.length - excerpt.length);
      if (limit <= 0) break;
      const clipped = content.length > limit;
      const block = reference + content.slice(0, limit) + (clipped ? excerpt : '');
      blocks.push(block);
      sources.push({
        sessionId: row.session_id,
        sourceEventId: row.source_id,
        sourceUserSeq: row.source_seq,
        sourceDigest: digest(sourceData),
        terminalEventId: row.id,
        terminalSeq: row.seq,
        terminalDigest: digest(terminalData),
        truncated: clipped,
      });
      remaining -= block.length + 2;
    } catch { /* An unreadable optional exchange cannot prevent a fresh source. */ }
  }
  if (blocks.length === 0) return undefined;
  const text = `${header}\n\n${blocks.reverse().join('\n\n')}\n\n[End of same-conversation context.]`;
  return insertInternalEventInTransaction(db, {
    sessionId: child.id,
    turn: 0,
    role: 'system',
    type: 'cross_session_prefix',
    data: {
      kind: 'accepted_source_successor',
      version: 1,
      priorSessionIds: lineage,
      continuityDigest: continuityDigest(continuity),
      sources: sources.reverse(),
      totalChars: text.length,
      text,
    },
  });
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizedContinuity(input: AcceptedSourceContinuityIdentity): AcceptedSourceContinuityIdentity {
  const provider = input.provider.trim().toLowerCase();
  const scopeId = input.scopeId?.trim() || null;
  const conversationId = input.conversationId.trim();
  const audienceId = input.audienceId.trim();
  if (!provider || !conversationId || !audienceId) {
    throw new Error('accepted-source continuity requires provider, conversation, and audience identity');
  }
  if ([provider, scopeId ?? '', conversationId, audienceId].some((value) => value.length > 512)) {
    throw new Error('accepted-source continuity identity is too long');
  }
  return { provider, scopeId, conversationId, audienceId };
}

function normalizedValidatedMount(
  input: AcceptedSourceValidatedMount | undefined,
): AcceptedSourceValidatedMount | undefined {
  if (!input) return undefined;
  const rootSessionId = input.rootSessionId.trim();
  const workspaceSlug = input.workspaceSlug.trim();
  if (!rootSessionId || !workspaceSlug || rootSessionId !== `space-${workspaceSlug}`) {
    throw new Error('validated workspace mount identity is invalid');
  }
  if (rootSessionId.length > 512 || workspaceSlug.length > 256) {
    throw new Error('validated workspace mount identity is too long');
  }
  return { version: 1, kind: 'workspace', rootSessionId, workspaceSlug };
}

function continuityDigest(identity: AcceptedSourceContinuityIdentity): string {
  return digest({ protocol: 'clementine.accepted_source_continuity.v1', ...identity });
}

function durableSourceDigest(provider: string, durableSourceIdInput: string): string {
  const durableSourceId = durableSourceIdInput.trim();
  if (!durableSourceId) throw new Error('durableSourceId is required');
  if (durableSourceId.length > 1024) throw new Error('durableSourceId is too long');
  return digest({ protocol: 'clementine.accepted_source_selection.v1', provider, durableSourceId });
}

function parseMetadata(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('session metadata is not an object');
  }
  return parsed as Record<string, unknown>;
}

function parseMetadataSafe(raw: string): Record<string, unknown> | null {
  try {
    return parseMetadata(raw);
  } catch {
    return null;
  }
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sessionRow(db: Database.Database, sessionId: string): RawSession {
  const row = db.prepare(`
    SELECT id, kind, channel, user_id, status, metadata_json
      FROM sessions WHERE id = ?
  `).get(sessionId) as RawSession | undefined;
  if (!row) throw new Error(`session not found: ${sessionId}`);
  return row;
}

function branchMetadata(row: RawSession): BranchMetadata | null {
  const value = parseMetadataSafe(row.metadata_json)?.[BRANCH_META];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const branch = value as Partial<BranchMetadata>;
  if (
    branch.version !== POINTER_PROTOCOL
    || typeof branch.rootSessionId !== 'string'
    || typeof branch.parentSessionId !== 'string'
    || typeof branch.durableSourceDigest !== 'string'
    || typeof branch.continuityDigest !== 'string'
    || typeof branch.createdAt !== 'string'
  ) return null;
  return branch as BranchMetadata;
}

function rootSessionIdFor(row: RawSession): string {
  return branchMetadata(row)?.rootSessionId ?? row.id;
}

function sessionAudienceMatches(row: RawSession, identity: AcceptedSourceContinuityIdentity): boolean {
  const branch = branchMetadata(row);
  if (branch) return branch.continuityDigest === continuityDigest(identity);
  const metadata = parseMetadataSafe(row.metadata_json);
  if (!metadata) return false;
  const provider = stringField(metadata, 'ingressProvider')
    ?? stringField(metadata, 'source')
    ?? row.channel?.trim().toLowerCase()
    ?? null;
  const conversation = stringField(metadata, 'channelId') ?? stringField(metadata, 'discordChannelId');
  const audience = row.user_id
    ?? stringField(metadata, 'userId')
    ?? stringField(metadata, 'discordUserId');
  const scope = stringField(metadata, 'guildId') ?? stringField(metadata, 'discordGuildId');
  return provider === identity.provider
    && conversation === identity.conversationId
    && audience === identity.audienceId
    && scope === identity.scopeId;
}

/** Recover only the closed ingress identity written by this selector. Raw
 * legacy workspace metadata is not authority; mount lineage must validate its
 * canonical `space-<slug>` root. */
export function resolveAcceptedSourceIngressLineage(input: {
  sessionId: string;
  provider: string;
  scopeId: string | null;
  audienceId: string;
}): AcceptedSourceIngressLineage | null {
  const db = openEventLog();
  let row: RawSession;
  try {
    row = sessionRow(db, input.sessionId);
  } catch {
    return null;
  }
  const metadata = parseMetadataSafe(row.metadata_json);
  if (!metadata) return null;
  const conversationId = stringField(metadata, 'channelId');
  if (!conversationId) return null;
  const identity = normalizedContinuity({
    provider: input.provider,
    scopeId: input.scopeId,
    conversationId,
    audienceId: input.audienceId,
  });
  if (!sessionAudienceMatches(row, identity)) return null;
  const rawMount = metadata[MOUNT_META];
  let validatedMount: AcceptedSourceValidatedMount | undefined;
  if (rawMount && typeof rawMount === 'object' && !Array.isArray(rawMount)) {
    const mount = rawMount as Partial<AcceptedSourceValidatedMount>;
    if (
      mount.version === 1
      && mount.kind === 'workspace'
      && typeof mount.rootSessionId === 'string'
      && typeof mount.workspaceSlug === 'string'
    ) {
      try {
        validatedMount = normalizedValidatedMount(mount as AcceptedSourceValidatedMount);
      } catch {
        return null;
      }
    }
  }
  return { conversationId, ...(validatedMount ? { validatedMount } : {}) };
}

/** Bound controls need more than a caller-selected session id. Any durable
 * audience/scope/conversation identity present on the target must agree. */
function assertBoundControlTarget(row: RawSession, identity: AcceptedSourceContinuityIdentity): void {
  const metadata = parseMetadata(row.metadata_json);
  const branch = branchMetadata(row);
  if (branch && branch.continuityDigest !== continuityDigest(identity)) {
    throw new Error('bound control target belongs to a different continuity principal');
  }
  const provider = stringField(metadata, 'ingressProvider')
    ?? stringField(metadata, 'source')
    ?? row.channel?.trim().toLowerCase()
    ?? null;
  if (!provider || provider !== identity.provider) {
    throw new Error('bound control target provider does not match');
  }
  const audience = row.user_id
    ?? stringField(metadata, 'userId')
    ?? stringField(metadata, 'discordUserId');
  if (!audience || audience !== identity.audienceId) {
    throw new Error('bound control target audience does not match');
  }
  const conversation = stringField(metadata, 'channelId') ?? stringField(metadata, 'discordChannelId');
  if (!conversation || conversation !== identity.conversationId) {
    throw new Error('bound control target conversation does not match');
  }
  const scope = stringField(metadata, 'guildId') ?? stringField(metadata, 'discordGuildId');
  if (scope !== identity.scopeId) {
    throw new Error('bound control target scope does not match');
  }
}

function ensurePointer(
  db: Database.Database,
  rootSessionId: string,
  continuity: string,
  initialHeadSessionId: string,
  now: string,
): PointerRow {
  db.prepare(`
    INSERT OR IGNORE INTO accepted_source_session_pointers
      (root_session_id, continuity_digest, head_session_id, revision, updated_at)
    VALUES (?, ?, ?, 0, ?)
  `).run(rootSessionId, continuity, initialHeadSessionId, now);
  const row = db.prepare(`
    SELECT root_session_id, continuity_digest, head_session_id, revision
      FROM accepted_source_session_pointers
     WHERE root_session_id = ? AND continuity_digest = ?
  `).get(rootSessionId, continuity) as PointerRow | undefined;
  if (!row) throw new Error('accepted-source pointer could not be persisted');
  return row;
}

function readPointer(
  db: Database.Database,
  rootSessionId: string,
  continuity: string,
): PointerRow | null {
  return (db.prepare(`
    SELECT root_session_id, continuity_digest, head_session_id, revision
      FROM accepted_source_session_pointers
     WHERE root_session_id = ? AND continuity_digest = ?
  `).get(rootSessionId, continuity) as PointerRow | undefined) ?? null;
}

function existingBinding(db: Database.Database, sourceDigest: string): BindingRow | null {
  return (db.prepare(`
    SELECT durable_source_digest, root_session_id, continuity_digest,
           session_id, disposition, selected_after_seq
      FROM accepted_source_session_bindings
     WHERE durable_source_digest = ?
  `).get(sourceDigest) as BindingRow | undefined) ?? null;
}

function bindSelection(
  db: Database.Database,
  input: {
    sourceDigest: string;
    rootSessionId: string;
    continuityDigest: string;
    sessionId: string;
    disposition: BindingRow['disposition'];
    selectedAfterSeq: number;
    now: string;
  },
): void {
  db.prepare(`
    INSERT INTO accepted_source_session_bindings
      (durable_source_digest, root_session_id, continuity_digest,
       session_id, disposition, selected_after_seq, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.sourceDigest,
    input.rootSessionId,
    input.continuityDigest,
    input.sessionId,
    input.disposition,
    input.selectedAfterSeq,
    input.now,
  );
}

function safeChildMetadata(input: {
  parent: RawSession;
  rootSessionId: string;
  sourceDigest: string;
  continuityDigest: string;
  continuity: AcceptedSourceContinuityIdentity;
  validatedMount?: AcceptedSourceValidatedMount;
  now: string;
}): Record<string, unknown> {
  const mount = input.validatedMount;
  return {
    source: mount ? 'workspace' : input.continuity.provider,
    ingressProvider: input.continuity.provider,
    channelId: input.continuity.conversationId,
    userId: input.continuity.audienceId,
    ...(input.continuity.scopeId ? { guildId: input.continuity.scopeId } : {}),
    ...(mount ? { spaceSlug: mount.workspaceSlug } : {}),
    ...(mount ? { [MOUNT_META]: mount } : {}),
    [BRANCH_META]: {
      version: POINTER_PROTOCOL,
      rootSessionId: input.rootSessionId,
      parentSessionId: input.parent.id,
      durableSourceDigest: input.sourceDigest,
      continuityDigest: input.continuityDigest,
      createdAt: input.now,
    } satisfies BranchMetadata,
  };
}

function deterministicChildId(input: {
  rootSessionId: string;
  parentSessionId: string;
  continuityDigest: string;
  sourceDigest: string;
}): string {
  return `sess-branch-${digest({
    protocol: 'clementine.accepted_source_successor.v1',
    ...input,
  }).slice(0, 40)}`;
}

function insertChildSession(
  db: Database.Database,
  input: {
    parent: RawSession;
    rootSessionId: string;
    continuity: AcceptedSourceContinuityIdentity;
    continuityDigest: string;
    sourceDigest: string;
    independentPrincipalRoot?: boolean;
    validatedMount?: AcceptedSourceValidatedMount;
    now: string;
  },
): { row: RawSession; event: EventRow; rootSessionId: string } {
  const id = deterministicChildId({
    rootSessionId: input.rootSessionId,
    parentSessionId: input.parent.id,
    continuityDigest: input.continuityDigest,
    sourceDigest: input.sourceDigest,
  });
  const rootSessionId = input.independentPrincipalRoot ? id : input.rootSessionId;
  const metadata = safeChildMetadata({ ...input, rootSessionId });
  db.prepare(`
    INSERT INTO sessions
      (id, kind, channel, user_id, created_at, updated_at, status,
       title, objective, token_budget, tokens_used, current_plan_id, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, NULL, NULL, 0, NULL, ?)
  `).run(
    id,
    input.parent.kind,
    input.parent.channel ?? input.continuity.provider,
    input.continuity.audienceId,
    input.now,
    input.now,
    JSON.stringify(metadata),
  );
  const row = sessionRow(db, id);
  const event = insertInternalEventInTransaction(db, {
    sessionId: id,
    turn: 0,
    role: 'system',
    type: 'session_started',
    data: {
      kind: row.kind,
      channel: row.channel,
      userId: row.user_id,
      title: null,
      objective: null,
    },
  });
  return { row, event, rootSessionId };
}

function previewIsExactlyReusable(
  preview: ReturnType<typeof previewPersistedSessionConversationProtocolInTransaction>,
): boolean {
  return preview.status === 'ready'
    && preview.migration === 'none'
    && JSON.stringify(preview.providerHistory) === JSON.stringify(preview.history);
}

/** A selection owns its chosen session until that source has either published
 * an exact terminal/dispatched edge or a later source is placed on a successor.
 * This closes the receipt/source gap: two provider deliveries cannot both see
 * one clean head and then begin overlapping attempts on it. */
function headHasUnsettledSelection(db: Database.Database, sessionId: string): boolean {
  const binding = db.prepare(`
    SELECT selected_after_seq
      FROM accepted_source_session_bindings
     WHERE session_id = ?
     ORDER BY created_at DESC, durable_source_digest DESC
     LIMIT 1
  `).get(sessionId) as { selected_after_seq: number } | undefined;
  if (!binding) return false;
  const source = db.prepare(`
    SELECT seq
      FROM events
     WHERE session_id = ? AND type = 'user_input_received' AND seq > ?
     ORDER BY seq ASC LIMIT 1
  `).get(sessionId, binding.selected_after_seq) as { seq: number } | undefined;
  if (!source) return true;
  const settled = db.prepare(`
    SELECT 1 AS ok
      FROM events
     WHERE session_id = ?
       AND type IN ('conversation_completed', 'async_work_dispatched')
       AND (
         json_extract(data_json, '$.sourceUserSeq') = ?
         OR json_extract(data_json, '$.terminalKey') = ?
       )
     LIMIT 1
  `).get(sessionId, source.seq, `turn:${source.seq}`) as { ok: number } | undefined;
  return !settled;
}

function canReuseProtocolHistory(db: Database.Database, sessionId: string): boolean {
  try {
    return previewIsExactlyReusable(previewPersistedSessionConversationProtocolInTransaction({
      db,
      sessionId,
    }));
  } catch {
    return false;
  }
}

function selectInTransaction(
  db: Database.Database,
  input: AcceptedSourceSessionSelectionInput,
): TransactionSelection {
  const continuity = normalizedContinuity(input.continuity);
  const validatedMount = normalizedValidatedMount(input.validatedMount);
  const continuityKey = continuityDigest(continuity);
  const sourceKey = durableSourceDigest(continuity.provider, input.durableSourceId);
  const prior = existingBinding(db, sourceKey);
  if (prior) {
    if (prior.continuity_digest !== continuityKey) {
      throw new Error('durable source is already bound to a different continuity principal');
    }
    sessionRow(db, prior.session_id);
    const pointer = readPointer(db, prior.root_session_id, continuityKey)
      ?? ensurePointer(
        db,
        prior.root_session_id,
        continuityKey,
        prior.session_id,
        new Date().toISOString(),
      );
    return {
      selection: {
        sessionId: prior.session_id,
        rootSessionId: prior.root_session_id,
        disposition: prior.disposition,
        pointerRevision: pointer.revision,
      },
      createdEvent: null,
    };
  }

  const now = new Date().toISOString();

  if (input.kind === 'bound_control') {
    const target = sessionRow(db, input.targetSessionId);
    assertBoundControlTarget(target, continuity);
    const rootSessionId = rootSessionIdFor(target);
    const pointer = ensurePointer(db, rootSessionId, continuityKey, target.id, now);
    bindSelection(db, {
      sourceDigest: sourceKey,
      rootSessionId,
      continuityDigest: continuityKey,
      sessionId: target.id,
      disposition: 'bound_control',
      selectedAfterSeq: latestEventSeqInTransaction(db, target.id),
      now,
    });
    return {
      selection: {
        sessionId: target.id,
        rootSessionId,
        disposition: 'bound_control',
        pointerRevision: pointer.revision,
      },
      createdEvent: null,
    };
  }

  const entry = sessionRow(db, input.entrySessionId);
  let rootSessionId = rootSessionIdFor(entry);
  let pointer = readPointer(db, rootSessionId, continuityKey);
  const head = pointer ? sessionRow(db, pointer.head_session_id) : entry;
  const identitySplit = !sessionAudienceMatches(head, continuity);
  if (identitySplit) {
    const child = insertChildSession(db, {
      parent: head,
      rootSessionId,
      continuity,
      continuityDigest: continuityKey,
      sourceDigest: sourceKey,
      independentPrincipalRoot: true,
      validatedMount,
      now,
    });
    rootSessionId = child.rootSessionId;
    pointer = ensurePointer(db, rootSessionId, continuityKey, child.row.id, now);
    bindSelection(db, {
      sourceDigest: sourceKey,
      rootSessionId,
      continuityDigest: continuityKey,
      sessionId: child.row.id,
      disposition: 'identity_split',
      selectedAfterSeq: latestEventSeqInTransaction(db, child.row.id),
      now,
    });
    return {
      selection: {
        sessionId: child.row.id,
        rootSessionId,
        disposition: 'identity_split',
        pointerRevision: pointer.revision,
      },
      createdEvent: child.event,
    };
  }

  pointer ??= ensurePointer(db, rootSessionId, continuityKey, head.id, now);
  const reusable = head.status === 'active'
    && !headHasUnsettledSelection(db, head.id)
    && canReuseProtocolHistory(db, head.id);

  let selected = head;
  let disposition: BindingRow['disposition'] = 'reused';
  let createdEvent: EventRow | null = null;
  let continuityEvent: EventRow | undefined;
  if (!reusable) {
    const child = insertChildSession(db, {
      parent: head,
      rootSessionId,
      continuity,
      continuityDigest: continuityKey,
      sourceDigest: sourceKey,
      validatedMount,
      now,
    });
    selected = child.row;
    createdEvent = child.event;
    continuityEvent = seedSuccessorConversation(db, head, child.row, continuity);
    disposition = 'branched';
    const advanced = db.prepare(`
      UPDATE accepted_source_session_pointers
         SET head_session_id = ?, revision = revision + 1, updated_at = ?
       WHERE root_session_id = ? AND continuity_digest = ?
         AND head_session_id = ? AND revision = ?
    `).run(
      selected.id,
      now,
      rootSessionId,
      continuityKey,
      pointer.head_session_id,
      pointer.revision,
    );
    if (advanced.changes !== 1) throw new Error('accepted-source pointer compare-and-swap lost');
    pointer = { ...pointer, head_session_id: selected.id, revision: pointer.revision + 1 };
  }

  // Older daemons created clean successors without the conversation prefix.
  // Recover it once even when that successor remains active and is reused;
  // otherwise a blocked retry can keep the missing context indefinitely.
  const parentSessionId = branchMetadata(selected)?.parentSessionId;
  if (disposition === 'reused' && parentSessionId && !db.prepare(`
    SELECT 1 FROM events WHERE session_id = ? AND type = 'cross_session_prefix'
      AND json_extract(data_json, '$.kind') = 'accepted_source_successor' LIMIT 1
  `).get(selected.id)) {
    try {
      continuityEvent = seedSuccessorConversation(db, sessionRow(db, parentSessionId), selected, continuity);
    } catch { /* Optional context recovery cannot prevent an accepted source. */ }
  }

  bindSelection(db, {
    sourceDigest: sourceKey,
    rootSessionId,
    continuityDigest: continuityKey,
    sessionId: selected.id,
    disposition,
    selectedAfterSeq: latestEventSeqInTransaction(db, selected.id),
    now,
  });
  return {
    selection: {
      sessionId: selected.id,
      rootSessionId,
      disposition,
      pointerRevision: pointer.revision,
    },
    createdEvent,
    ...(continuityEvent ? { continuityEvent } : {}),
  };
}

/**
 * Atomically bind one provider source to the audience's durable conversational
 * head. Discord/Slack call this only after their provider inbox has granted the
 * one processing lease; source retries reopen the immutable binding.
 */
export function selectSessionForAcceptedSource(
  input: AcceptedSourceSessionSelectionInput,
): AcceptedSourceSessionSelection {
  const db = openEventLog();
  const transaction = db.transaction(() => selectInTransaction(db, input));
  const result = transaction.immediate();
  if (result.createdEvent) publishCommittedInternalEvent(result.createdEvent);
  if (result.continuityEvent) publishCommittedInternalEvent(result.continuityEvent);
  return result.selection;
}

function receiptInTransaction(
  db: Database.Database,
  requestId: string,
): HarnessChatRequestReceipt | null {
  const row = db.prepare(`
    SELECT request_id, session_id, run_id, input_hash, since_seq, created_at
      FROM harness_chat_requests WHERE request_id = ?
  `).get(requestId) as {
    request_id: string;
    session_id: string;
    run_id: string;
    input_hash: string;
    since_seq: number;
    created_at: string;
  } | undefined;
  return row ? {
    requestId: row.request_id,
    sessionId: row.session_id,
    runId: row.run_id,
    inputHash: row.input_hash,
    sinceSeq: row.since_seq,
    createdAt: row.created_at,
  } : null;
}

function latestEventSeqInTransaction(db: Database.Database, sessionId: string): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?')
    .get(sessionId) as { seq: number };
  return row.seq;
}

/**
 * Desktop/mobile accepted-source seam. Existing receipts are authoritative and
 * bypass pointer/preview entirely. A new receipt, source binding, optional
 * successor, and pointer CAS commit in one IMMEDIATE transaction.
 */
export function claimSessionForAcceptedSource(
  input: AcceptedSourceSessionSelectionInput & { receipt: AcceptedSourceChatReceiptInput },
): ClaimedAcceptedSourceSession {
  const db = openEventLog();
  const transaction = db.transaction((): ClaimedAcceptedSourceSession & { createdEvent: EventRow | null; continuityEvent?: EventRow } => {
    const requestId = input.receipt.requestId.trim();
    const prior = receiptInTransaction(db, requestId);
    if (prior) {
      const continuity = normalizedContinuity(input.continuity);
      const continuityKey = continuityDigest(continuity);
      const sourceKey = durableSourceDigest(continuity.provider, input.durableSourceId);
      const binding = existingBinding(db, sourceKey);
      const receiptSession = sessionRow(db, prior.sessionId);
      if (binding) {
        if (
          binding.continuity_digest !== continuityKey
          || binding.session_id !== prior.sessionId
        ) {
          throw new Error('receipt is bound to a different continuity principal');
        }
      } else if (!sessionAudienceMatches(receiptSession, continuity)) {
        throw new Error('legacy receipt session does not match the continuity principal');
      }
      const claimed = claimHarnessChatRequestInTransaction(db, {
        requestId,
        sessionId: prior.sessionId,
        runId: input.receipt.runId,
        inputHash: input.receipt.inputHash,
        sinceSeq: prior.sinceSeq,
      });
      return {
        selection: {
          sessionId: prior.sessionId,
          rootSessionId: binding?.root_session_id ?? rootSessionIdFor(receiptSession),
          disposition: 'receipt_replay',
          pointerRevision: -1,
        },
        ...claimed,
        createdEvent: null,
      };
    }

    if (input.receipt.runId !== input.durableSourceId) {
      throw new Error('receipt runId must equal the durable accepted-source identity');
    }
    const selected = selectInTransaction(db, input);
    const claimInput: HarnessChatRequestClaimInput = {
      requestId,
      sessionId: selected.selection.sessionId,
      runId: input.receipt.runId,
      inputHash: input.receipt.inputHash,
      sinceSeq: input.receipt.sinceSeq
        ?? latestEventSeqInTransaction(db, selected.selection.sessionId),
    };
    return {
      selection: selected.selection,
      ...claimHarnessChatRequestInTransaction(db, claimInput),
      createdEvent: selected.createdEvent,
      ...(selected.continuityEvent ? { continuityEvent: selected.continuityEvent } : {}),
    };
  });
  const { createdEvent, continuityEvent, ...result } = transaction.immediate();
  if (createdEvent) publishCommittedInternalEvent(createdEvent);
  if (continuityEvent) publishCommittedInternalEvent(continuityEvent);
  return result;
}
