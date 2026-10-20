/** Canonical approval row/group display readers. Never a decision or dispatch grant. */
import type { PendingApprovalRow, PendingApprovalStatus, ApprovalResolution, ConversationalApprovalPresentation } from './approval-registry.js';
import { exactApprovalAuthorityMatches } from './approval-authority.js';

export interface ApprovalSqlRow {
  approval_id: string;
  session_id: string;
  channel: string | null;
  channel_id: string | null;
  requested_at: string;
  expires_at: string;
  subject: string;
  tool: string | null;
  args_json: string | null;
  status: PendingApprovalStatus;
  resolution: ApprovalResolution | null;
  resolver: string | null;
  resolved_at: string | null;
  resume_key: string | null;
  consumed_at: string | null;
  resend_consumed_at: string | null;
  presentation_json: string | null;
  reminded_at: string | null;
}

export function parseConversationalPresentation(json: string | null): ConversationalApprovalPresentation | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Partial<ConversationalApprovalPresentation>;
    if (
      value.version !== 1
      || value.kind !== 'autonomous_send_consent'
      || typeof value.question !== 'string'
      || typeof value.actionLabel !== 'string'
      || !value.actionLabel.trim()
      || value.actionLabel.length > 24
      || typeof value.target !== 'string'
      || !(value.subject === null || typeof value.subject === 'string')
      || !(value.bodyPreview === null || typeof value.bodyPreview === 'string')
      || !(value.resultUrl === null || typeof value.resultUrl === 'string')
      || !Number.isSafeInteger(value.sourceUserSeq)
      || Number(value.sourceUserSeq) <= 0
      || !value.originReplyTarget
      || typeof value.originReplyTarget !== 'object'
      || typeof value.originReplyTargetDigest !== 'string'
      || typeof value.conversationKey !== 'string'
      || !value.conversationKey.trim()
      || typeof value.audienceUserId !== 'string'
      || !(value.promptEventId === null || typeof value.promptEventId === 'string')
      || !(value.promptEventSeq === null || Number.isSafeInteger(value.promptEventSeq))
      || !(value.presentedAt === null || typeof value.presentedAt === 'string')
      || !(value.responseSourceUserSeq === null || Number.isSafeInteger(value.responseSourceUserSeq))
      || !(value.responseUserId === null || typeof value.responseUserId === 'string')
    ) return null;
    const target = value.transportTarget;
    const transportTarget = target && typeof target === 'object'
      && (
        (target.provider === 'discord' && typeof target.channelId === 'string' && typeof target.messageId === 'string')
        || (target.provider === 'slack' && typeof target.channelId === 'string' && typeof target.messageTs === 'string'
          && (target.threadTs === undefined || typeof target.threadTs === 'string'))
      )
      ? target as ConversationalApprovalPresentation['transportTarget']
      : null;
    return { ...value, transportTarget } as ConversationalApprovalPresentation;
  } catch {
    return null;
  }
}

export function rowToPublic(row: ApprovalSqlRow): PendingApprovalRow {
  return {
    approvalId: row.approval_id,
    sessionId: row.session_id,
    channel: row.channel,
    channelId: row.channel_id,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    subject: row.subject,
    tool: row.tool,
    args: row.args_json ? safeParse(row.args_json) : null,
    status: row.status,
    resolution: row.resolution,
    resolver: row.resolver,
    resolvedAt: row.resolved_at,
    resumeKey: row.resume_key,
    consumedAt: row.consumed_at,
    presentation: parseConversationalPresentation(row.presentation_json),
    remindedAt: row.reminded_at ?? null,
  };
}

export function safeParse(json: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export const APPROVAL_GROUP_TOOL = '__host_approval_group__';
export interface ApprovalGroupMember {
  approvalId: string;
  sessionId: string;
  tool: string | null;
  args: Record<string, unknown> | null;
  resumeKey: string | null;
}

export function isApprovalGroup(row: PendingApprovalRow): boolean {
  return row.tool === APPROVAL_GROUP_TOOL;
}

/** Fail closed on changed, missing, duplicate, cross-session or nested members. */
export function approvalGroupMembersRead(row: PendingApprovalRow, get: (id: string) => PendingApprovalRow | undefined): PendingApprovalRow[] | null {
  if (!isApprovalGroup(row) || row.args?.version !== 1 || !Array.isArray(row.args.members)
    || row.args.members.length < 2) return null;
  const members: PendingApprovalRow[] = [];
  const ids = new Set<string>();
  for (const value of row.args.members) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const snapshot = value as ApprovalGroupMember;
    if (typeof snapshot.approvalId !== 'string' || ids.has(snapshot.approvalId)) return null;
    const member = get(snapshot.approvalId);
    if (!member || member.sessionId !== row.sessionId || isApprovalGroup(member)
      || !member.resumeKey || !exactApprovalAuthorityMatches(member, snapshot)) return null;
    ids.add(member.approvalId);
    members.push(member);
  }
  return members;
}

export function isFormalApprovalSurface(row: PendingApprovalRow): boolean {
  return row.presentation?.kind !== 'autonomous_send_consent';
}
