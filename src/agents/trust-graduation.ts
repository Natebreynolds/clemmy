/**
 * Trust graduation proposals — "earn the grant, don't assume it."
 *
 * Success history is recorded everywhere in the harness (approval
 * resolutions, pending-action executions, the durable audit ledger) but,
 * before this module, nothing in the TRUST layer ever read it: a user who
 * approved the same clean send to the same people twenty times still got a
 * card the twenty-first time. This module closes that loop the way every
 * other "Clem suggests, the user owns" surface does — it observes the
 * approval history and, when a stable pattern of clean sends accrues,
 * PROPOSES a narrowly-scoped send-trust grant. It never grants anything:
 * the only apply path is the user's explicit approve, which calls the
 * existing grantSendTrust (plan-scope stays the sole grant authority).
 *
 * A "clean send" is deliberately conservative and fully deterministic
 * (no LLM judge): a human-approved, irreversible send whose recipients
 * were extractable and under the mass-send floor, whose linked action
 * executed (or, unlinked, settled without failure), and which survived a
 * 24h settle window with no intersecting rejection, revocation, or late
 * failure. Scope never exceeds what was observed: exact recipients by
 * default; a domain only when many distinct recipients on a private
 * (non-public-mail) domain recur.
 *
 * Safety properties:
 *   - Never grants at proposal time; only approveTrustProposal grants, via
 *     grantSendTrust, and re-checks coverage at approve time (already
 *     covered ⇒ superseded, nothing granted).
 *   - Declining grants nothing and starts a 30-day cooldown for any subset
 *     of the declined scope.
 *   - One pending proposal per scope, global cap 2 pending, 14-day expiry.
 *   - CLEMMY_TRUST_GRADUATION=off is the kill switch (default on). With
 *     CLEMMY_SEND_TRUST off there is nothing to grant, so it no-ops.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR, getRuntimeEnv } from '../config.js';
import { withFileLockSyncStrict } from '../runtime/atomic-json.js';
import { addNotification, markNotificationRead } from '../runtime/notifications.js';
import { appendAuditRecord } from '../runtime/audit-ledger.js';
import { classifyExternalWrite } from '../runtime/harness/confirm-first-gate.js';
import { listPending } from '../runtime/harness/approval-registry.js';
import { listPendingActions } from '../runtime/harness/pending-actions.js';
import {
  extractSendTargets,
  findSendTrustGrantForProposal,
  grantSendTrustForProposal,
  inferToolkit,
  isSendTrustScopeCovered,
  listAllSendTrustGrants,
  SEND_TRUST_MAX_RECIPIENTS,
} from './plan-scope.js';

const logger = pino({ name: 'clementine-next.trust-graduation' });

const STORE_FILE = path.join(BASE_DIR, 'state', 'trust-graduation-proposals.json');
const STORE_STATE_LOCK_FILE = path.join(BASE_DIR, 'state', 'trust-graduation-proposals-state');
const MAX_STORED_PROPOSALS = 40;

/** Evidence window: only clean sends within this many days count. Wider than
 *  the pending expiry so a steady pattern keeps its evidence alive. */
const EVIDENCE_WINDOW_DAYS = 30;
/** A recipient must recur at least this many times before it is "stable" enough
 *  to propose auto-trust for. */
const STABLE_RECURRENCES = 3;
/** Domain escalation floor: only widen recipients → a whole domain when this
 *  many DISTINCT stable recipients share one private domain. */
const DOMAIN_ESCALATION_MIN_RECIPIENTS = 4;
/** At most this many pending proposals exist at once (notification-noise floor). */
const MAX_PENDING = 2;
/** A pending proposal older than this is expired (fresh evidence may re-propose). */
const PENDING_EXPIRY_DAYS = 14;

/** Public mail providers never escalate to a domain grant — "@gmail.com" is not
 *  an org boundary. Recipients on these domains still propose as exact addresses.
 *  Global: works for every user, no account-specific data. */
const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net',
  'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'fastmail.com', 'hey.com',
  'qq.com', '163.com', '126.com',
]);

// ── Config (kill-switch, not rollout flag) ───────────────────────────

function trustGraduationEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_TRUST_GRADUATION', 'on') || 'on').toLowerCase() !== 'off';
}
/** Mirrors plan-scope's send-trust switch: with it off there is nothing to
 *  grant, so proposing would be pure noise. */
function sendTrustEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_SEND_TRUST', 'on') || 'on').toLowerCase() !== 'off';
}
function minSends(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_TRUST_GRADUATION_MIN_SENDS', '5') || '5', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}
function settleMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_TRUST_GRADUATION_SETTLE_HOURS', '24') || '24', 10);
  const hours = Number.isFinite(raw) && raw >= 0 ? raw : 24;
  return hours * 60 * 60 * 1000;
}
function declineCooldownMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_TRUST_GRADUATION_DECLINE_COOLDOWN_DAYS', '30') || '30', 10);
  const days = Number.isFinite(raw) && raw >= 0 ? raw : 30;
  return days * 24 * 60 * 60 * 1000;
}

// ── Types ────────────────────────────────────────────────────────────

export type TrustProposalStatus = 'pending' | 'approved' | 'declined' | 'superseded' | 'expired';

export const TRUST_PROPOSAL_SCOPE_REVISION = 1 as const;

/** Canonical, user-visible proof of the exact authority a decision applies to.
 * Surfaces should round-trip scopeRevision + scopeDigest from the proposal they
 * rendered; the remaining fields make successful decisions independently
 * auditable without re-reading mutable proposal state. */
export interface TrustProposalScopeReceipt {
  scopeRevision: typeof TRUST_PROPOSAL_SCOPE_REVISION;
  scopeDigest: string;
  toolkits: string[];
  recipients: string[];
  domains: string[];
  maxRecipients: number;
}

export interface TrustProposalScopeExpectation {
  scopeRevision: number;
  scopeDigest: string;
}

export interface TrustProposalEvidence {
  cleanSendCount: number;
  distinctDays: number;
  firstAt: string;
  lastAt: string;
  sampleApprovalIds: string[];
}

export interface TrustProposal {
  id: string;
  /** Stable hash of the proposed scope — dedupe key for "one pending per scope". */
  scopeKey: string;
  /** Immutable identity of every authority-bearing field rendered for review. */
  scopeRevision: typeof TRUST_PROPOSAL_SCOPE_REVISION;
  scopeDigest: string;
  toolkits: string[];
  recipients: string[];
  domains?: string[];
  maxRecipients: number;
  evidence: TrustProposalEvidence;
  rationale: string;
  status: TrustProposalStatus;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolvedReason?: string;
  grantId?: string;
}

interface ProposalFile {
  version: 'v1';
  proposals: TrustProposal[];
}

/** A normalized, already-verified clean send — the unit scope derivation reads. */
export interface CleanSendObservation {
  approvalId: string;
  toolkit: string;
  /** Lowercased recipients (emails + handles). */
  recipients: string[];
  /** ISO resolution time — the settle/day anchor. */
  resolvedAt: string;
}

/** A derived candidate scope before it is gated/persisted. */
export interface TrustCandidate {
  scopeKey: string;
  toolkits: string[];
  recipients: string[];
  domains: string[];
  maxRecipients: number;
  evidence: TrustProposalEvidence;
}

// ── Store ────────────────────────────────────────────────────────────

function loadStoreUnmigrated(): ProposalFile {
  try {
    if (!existsSync(STORE_FILE)) return { version: 'v1', proposals: [] };
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf-8')) as ProposalFile;
    if (!Array.isArray(parsed?.proposals)) return { version: 'v1', proposals: [] };
    return { version: 'v1', proposals: parsed.proposals };
  } catch {
    return { version: 'v1', proposals: [] };
  }
}

function saveStore(store: ProposalFile): void {
  mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  const proposals = store.proposals.slice(-MAX_STORED_PROPOSALS);
  const tmp = `${STORE_FILE}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 'v1', proposals }, null, 2), 'utf-8');
  renameSync(tmp, STORE_FILE);
}

/** All proposal generations, including maintenance expiry/drafting, share one
 * strict lease. Atomic rename prevents torn JSON; this lease prevents two valid
 * but stale snapshots from each becoming the next authority generation. */
function withProposalStateMutation<T>(work: () => T): T {
  mkdirSync(path.dirname(STORE_STATE_LOCK_FILE), { recursive: true });
  return withFileLockSyncStrict(STORE_STATE_LOCK_FILE, work);
}

/** Focused race tests widen the old load/check/write window. The pause sits
 * inside the proposal lease, so a second process must not reach it. */
function pauseTrustResolutionForTest(): void {
  const raw = Number.parseInt(process.env.CLEMENTINE_TEST_TRUST_RESOLUTION_PAUSE_MS ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return;
  const delayMs = Math.min(raw, 2_000);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

export function listTrustProposals(status?: TrustProposalStatus): TrustProposal[] {
  const proposals = readStoreWithScopeMigration().proposals;
  return (status ? proposals.filter((p) => p.status === status) : proposals)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getTrustProposal(id: string): TrustProposal | null {
  return readStoreWithScopeMigration().proposals.find((p) => p.id === id) ?? null;
}

// ── Helpers ──────────────────────────────────────────────────────────

function domainOf(recipient: string): string | null {
  const at = recipient.indexOf('@');
  return at > 0 ? recipient.slice(at + 1) : null;
}

function canonicalScopeValues(scope: {
  toolkits: readonly string[];
  recipients: readonly string[];
  domains?: readonly string[];
  maxRecipients: number;
}): Omit<TrustProposalScopeReceipt, 'scopeRevision' | 'scopeDigest'> {
  const canonical = (values: readonly string[]) => [...new Set(values
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean))].sort();
  const canonicalDomains = [...new Set((scope.domains ?? [])
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean))].sort();
  return {
    toolkits: canonical(scope.toolkits),
    recipients: canonical(scope.recipients),
    domains: canonicalDomains,
    maxRecipients: Math.max(1, Math.floor(scope.maxRecipients)),
  };
}

function digestScopeValues(
  values: Omit<TrustProposalScopeReceipt, 'scopeRevision' | 'scopeDigest'>,
): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    scopeRevision: TRUST_PROPOSAL_SCOPE_REVISION,
    ...values,
  })).digest('hex')}`;
}

/** Return the canonical receipt for the proposal's CURRENT scope fields. This
 * intentionally recomputes the digest: callers can compare it with the stored
 * scopeDigest to detect state corruption or an in-place scope rewrite. */
export function trustProposalScopeReceipt(
  proposal: Pick<TrustProposal, 'toolkits' | 'recipients' | 'domains' | 'maxRecipients'>,
): TrustProposalScopeReceipt {
  const values = canonicalScopeValues(proposal);
  return {
    scopeRevision: TRUST_PROPOSAL_SCOPE_REVISION,
    scopeDigest: digestScopeValues(values),
    ...values,
  };
}

function proposalScopeIsIntact(proposal: TrustProposal): boolean {
  const receipt = trustProposalScopeReceipt(proposal);
  return proposal.scopeRevision === receipt.scopeRevision
    && proposal.scopeDigest === receipt.scopeDigest;
}

function expectationMatchesProposal(
  proposal: TrustProposal,
  expected: TrustProposalScopeExpectation | undefined,
): boolean {
  // A pending decision without the receipt rendered to the user is ID-only
  // authority and must fail closed. Already-terminal/recovered decisions are
  // handled before this check because they create no new authority.
  return expected !== undefined && (
    expected.scopeRevision === proposal.scopeRevision
    && expected.scopeDigest === proposal.scopeDigest
  );
}

function scopeKeyFor(toolkits: string[], recipients: string[], domains: string[]): string {
  const canon = JSON.stringify({
    toolkits: [...toolkits].sort(),
    recipients: [...recipients].sort(),
    domains: [...domains].sort(),
  });
  return `tgp-${createHash('sha256').update(canon).digest('hex').slice(0, 16)}`;
}

interface ProposalStoreMigration {
  store: ProposalFile;
  changed: boolean;
  quarantined: TrustProposal[];
}

function own(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function safeCanonicalScopeValues(record: Record<string, unknown>): Omit<
  TrustProposalScopeReceipt,
  'scopeRevision' | 'scopeDigest'
> {
  const strings = (value: unknown): string[] => (
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  );
  const rawMaxRecipients = record.maxRecipients;
  const maxRecipients = typeof rawMaxRecipients === 'number' && Number.isFinite(rawMaxRecipients)
    ? Math.max(1, Math.min(SEND_TRUST_MAX_RECIPIENTS, Math.floor(rawMaxRecipients)))
    : 1;
  return canonicalScopeValues({
    toolkits: strings(record.toolkits),
    recipients: strings(record.recipients),
    domains: strings(record.domains),
    maxRecipients,
  });
}

function validatedCanonicalScopeValues(
  proposal: TrustProposal,
): { values: Omit<TrustProposalScopeReceipt, 'scopeRevision' | 'scopeDigest'> } | { error: string } {
  const record = proposal as unknown as Record<string, unknown>;
  if (!Array.isArray(record.toolkits) || record.toolkits.some((entry) => typeof entry !== 'string')) {
    return { error: 'toolkits must be a string array' };
  }
  if (!Array.isArray(record.recipients) || record.recipients.some((entry) => typeof entry !== 'string')) {
    return { error: 'recipients must be a string array' };
  }
  if (
    record.domains !== undefined
    && (!Array.isArray(record.domains) || record.domains.some((entry) => typeof entry !== 'string'))
  ) {
    return { error: 'domains must be a string array when present' };
  }
  if (
    typeof record.maxRecipients !== 'number'
    || !Number.isFinite(record.maxRecipients)
    || !Number.isInteger(record.maxRecipients)
    || record.maxRecipients < 1
    || record.maxRecipients > SEND_TRUST_MAX_RECIPIENTS
  ) {
    return { error: `maxRecipients must be an integer from 1 to ${SEND_TRUST_MAX_RECIPIENTS}` };
  }

  const values = canonicalScopeValues({
    toolkits: record.toolkits as string[],
    recipients: record.recipients as string[],
    domains: record.domains as string[] | undefined,
    maxRecipients: record.maxRecipients,
  });
  if (values.toolkits.length === 0) return { error: 'toolkit scope is empty' };
  if (values.recipients.length === 0 && values.domains.length === 0) {
    return { error: 'recipient scope is empty' };
  }
  return { values };
}

function storedScopeIsCanonical(
  proposal: TrustProposal,
  values: Omit<TrustProposalScopeReceipt, 'scopeRevision' | 'scopeDigest'>,
): boolean {
  const record = proposal as unknown as Record<string, unknown>;
  const exactStrings = (stored: unknown, canonical: readonly string[]): boolean => (
    Array.isArray(stored)
    && stored.length === canonical.length
    && stored.every((entry, index) => entry === canonical[index])
  );
  const domainsAreCanonical = values.domains.length > 0
    ? exactStrings(record.domains, values.domains)
    : record.domains === undefined;
  return exactStrings(record.toolkits, values.toolkits)
    && exactStrings(record.recipients, values.recipients)
    && domainsAreCanonical
    && record.maxRecipients === values.maxRecipients;
}

function validateStoredPendingScopeReceipt(proposal: TrustProposal): string | null {
  const record = proposal as unknown as Record<string, unknown>;
  if (record.scopeRevision !== TRUST_PROPOSAL_SCOPE_REVISION) {
    return `unsupported scope revision ${String(record.scopeRevision)}`;
  }
  if (typeof record.scopeDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(record.scopeDigest)) {
    return 'scope digest is malformed';
  }

  const validated = validatedCanonicalScopeValues(proposal);
  if ('error' in validated) return validated.error;
  const { values } = validated;
  if (!storedScopeIsCanonical(proposal, values)) {
    return 'scope fields are not in canonical form';
  }

  if (record.scopeDigest !== digestScopeValues(values)) {
    return 'scope digest does not match the canonical scope';
  }
  return null;
}

function bindCanonicalScope(
  proposal: TrustProposal,
  values: Omit<TrustProposalScopeReceipt, 'scopeRevision' | 'scopeDigest'>,
): void {
  proposal.toolkits = values.toolkits;
  proposal.recipients = values.recipients;
  proposal.domains = values.domains.length > 0 ? values.domains : undefined;
  proposal.maxRecipients = values.maxRecipients;
  proposal.scopeRevision = TRUST_PROPOSAL_SCOPE_REVISION;
  proposal.scopeDigest = digestScopeValues(values);
}

function quarantinePendingLegacyScope(
  proposal: TrustProposal,
  reason: string,
  now: Date,
): void {
  const record = proposal as unknown as Record<string, unknown>;
  bindCanonicalScope(proposal, safeCanonicalScopeValues(record));
  proposal.status = 'superseded';
  proposal.resolvedAt = proposal.resolvedAt ?? now.toISOString();
  proposal.resolvedReason = `legacy proposal quarantined: ${reason}`;
}

/**
 * Upgrade or validate every pending row while the proposal lease is held.
 * Pre-receipt rows use their legacy scopeKey as the integrity anchor; rows that
 * already carry a receipt must prove that exact immutable generation. Any
 * mismatch is terminally quarantined rather than re-sealed around potentially
 * rewritten authority. This migration never calls the grant authority.
 */
function migratePendingScopeReceipts(store: ProposalFile, now: Date): ProposalStoreMigration {
  let changed = false;
  const quarantined: TrustProposal[] = [];
  for (const proposal of store.proposals) {
    if (proposal.status !== 'pending') continue;
    const record = proposal as unknown as Record<string, unknown>;
    const hasRevision = own(record, 'scopeRevision');
    const hasDigest = own(record, 'scopeDigest');
    // Receipt-bearing rows still pass through this locked read barrier. Merely
    // owning both keys is not proof: a malformed revision/digest, non-canonical
    // scope, or digest mismatch must become terminal before a
    // desktop/mobile pending list can render an immortal, unresolvable card.
    if (hasRevision && hasDigest) {
      const receiptError = validateStoredPendingScopeReceipt(proposal);
      if (receiptError !== null) {
        quarantinePendingLegacyScope(proposal, receiptError, now);
        quarantined.push(proposal);
        changed = true;
      }
      continue;
    }
    if (hasRevision || hasDigest) {
      quarantinePendingLegacyScope(proposal, 'partial scope receipt', now);
      quarantined.push(proposal);
      changed = true;
      continue;
    }

    const validated = validatedCanonicalScopeValues(proposal);
    if ('error' in validated) {
      quarantinePendingLegacyScope(proposal, validated.error, now);
      quarantined.push(proposal);
      changed = true;
      continue;
    }

    const { values } = validated;
    const expectedScopeKey = scopeKeyFor(values.toolkits, values.recipients, values.domains);
    if (
      typeof record.scopeKey !== 'string'
      || record.scopeKey !== expectedScopeKey
    ) {
      quarantinePendingLegacyScope(proposal, 'scope fields do not match the legacy scope key', now);
      quarantined.push(proposal);
      changed = true;
      continue;
    }

    const before = JSON.stringify({
      scopeRevision: record.scopeRevision,
      scopeDigest: record.scopeDigest,
      toolkits: record.toolkits,
      recipients: record.recipients,
      domains: record.domains,
      maxRecipients: record.maxRecipients,
    });
    bindCanonicalScope(proposal, values);
    const after = JSON.stringify({
      scopeRevision: proposal.scopeRevision,
      scopeDigest: proposal.scopeDigest,
      toolkits: proposal.toolkits,
      recipients: proposal.recipients,
      domains: proposal.domains,
      maxRecipients: proposal.maxRecipients,
    });
    if (before !== after) changed = true;
  }
  return { store, changed, quarantined };
}

/** Caller must already hold the proposal-state lease. */
function loadStoreWithScopeMigration(now: Date): ProposalStoreMigration {
  const migration = migratePendingScopeReceipts(loadStoreUnmigrated(), now);
  if (migration.changed) saveStore(migration.store);
  return migration;
}

/** Action surfaces receive only locked, migrated proposal generations. */
function readStoreWithScopeMigration(): ProposalFile {
  const migration = withProposalStateMutation(() => loadStoreWithScopeMigration(new Date()));
  for (const proposal of migration.quarantined) markTerminalProposalNotificationRead(proposal);
  return migration.store;
}

/** Do two recipient sets intersect (case-insensitive)? */
function intersects(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a.map((x) => x.toLowerCase()));
  return b.some((x) => set.has(x.toLowerCase()));
}

// ── Clean-send collection (reads the approval history) ────────────────

/**
 * Read the resolved-approval history and return the sends that qualify as
 * CLEAN by the deterministic predicate. Only sends within the evidence window
 * and past the settle window are returned; the rest are simply not yet clean.
 */
export function collectCleanSends(now: Date = new Date()): CleanSendObservation[] {
  const nowMs = now.getTime();
  const windowStart = nowMs - EVIDENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  let resolved: ReturnType<typeof listPending>;
  try {
    resolved = listPending({ status: 'resolved' });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'trust-graduation: could not read approvals');
    return [];
  }

  // Rejections that could disqualify a later-in-time approved send to the same
  // people (the user pushing back on that recipient scope).
  const rejections = resolved
    .filter((r) => r.resolution === 'rejected' && r.resolvedAt)
    .map((r) => ({ at: r.resolvedAt as string, recipients: recipientsOf(r.tool, r.args) }));

  // Send-trust revocations (incl. already-revoked grants) are a pullback of
  // trust: a clean send predating a revocation of an overlapping scope no
  // longer counts toward re-proposing that scope.
  let revocations: Array<{ at: string; recipients: string[]; domains: string[] }> = [];
  try {
    revocations = listAllSendTrustGrants()
      .filter((g) => g.revokedAt)
      .map((g) => ({ at: g.revokedAt as string, recipients: g.recipients ?? [], domains: g.domains ?? [] }));
  } catch { /* revocation read is best-effort */ }

  // Index pending actions by the approvalId they are linked to (terminal status
  // is the execution-success signal where present).
  const actionByApproval = new Map<string, string>(); // approvalId → status
  try {
    for (const rec of listPendingActions({ status: 'all', limit: 100 })) {
      if (rec.approvalId) actionByApproval.set(rec.approvalId, rec.status);
    }
  } catch { /* action linkage is best-effort; unlinked sends fall back to settle */ }

  const out: CleanSendObservation[] = [];
  for (const row of resolved) {
    if (row.resolution !== 'approved') continue;
    if (row.resolver === 'reaper') continue; // never a human decision
    if (!row.resolvedAt) continue;
    const resolvedMs = Date.parse(row.resolvedAt);
    if (!Number.isFinite(resolvedMs)) continue;
    if (resolvedMs < windowStart) continue;                 // outside evidence window
    if (nowMs - resolvedMs < settleMs()) continue;          // not yet settled

    // Irreversible send only.
    let irreversible = false;
    try { irreversible = classifyExternalWrite(row.tool ?? '', row.args).irreversible; } catch { irreversible = false; }
    if (!irreversible) continue;

    const recipients = recipientsOf(row.tool, row.args);
    if (recipients.length === 0 || recipients.length > SEND_TRUST_MAX_RECIPIENTS) continue;

    // Linked action executed, or (unlinked) no failure evidence after settle.
    const actionStatus = actionByApproval.get(row.approvalId);
    if (actionStatus === 'failed') continue;

    // Later rejection intersecting this recipient scope disqualifies.
    if (rejections.some((rej) => rej.at >= row.resolvedAt! && intersects(rej.recipients, recipients))) continue;

    // A revocation of an overlapping scope after this send disqualifies.
    const revoked = revocations.some((rev) => {
      if (rev.at < row.resolvedAt!) return false;
      const recipHit = intersects(rev.recipients, recipients);
      const domainHit = recipients.some((r) => {
        const d = domainOf(r);
        return d ? rev.domains.map((x) => x.toLowerCase()).includes(d.toLowerCase()) : false;
      });
      return recipHit || domainHit;
    });
    if (revoked) continue;

    out.push({
      approvalId: row.approvalId,
      toolkit: inferToolkit(row.tool ?? '', row.args),
      recipients,
      resolvedAt: row.resolvedAt,
    });
  }
  return out;
}

function recipientsOf(tool: string | null, args: unknown): string[] {
  const { emails, handles } = extractSendTargets(args);
  // Handles are only meaningful when scoped to a toolkit; keep both, lowercased.
  void tool;
  return [...emails, ...handles].map((r) => r.toLowerCase());
}

// ── Scope derivation (pure) ──────────────────────────────────────────

/**
 * Group clean sends by toolkit and derive one candidate scope per toolkit that
 * clears the threshold. Deterministic and pure — no store, no grant checks.
 */
export function deriveTrustCandidates(
  observations: CleanSendObservation[],
  now: Date = new Date(),
): TrustCandidate[] {
  const windowStart = now.getTime() - EVIDENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const inWindow = observations.filter((o) => {
    const t = Date.parse(o.resolvedAt);
    return Number.isFinite(t) && t >= windowStart;
  });

  const byToolkit = new Map<string, CleanSendObservation[]>();
  for (const o of inWindow) {
    const list = byToolkit.get(o.toolkit) ?? [];
    list.push(o);
    byToolkit.set(o.toolkit, list);
  }

  const candidates: TrustCandidate[] = [];
  for (const [toolkit, sends] of byToolkit) {
    // Count recurrences per recipient across the toolkit's clean sends.
    const counts = new Map<string, number>();
    for (const s of sends) {
      for (const r of new Set(s.recipients)) counts.set(r, (counts.get(r) ?? 0) + 1);
    }
    const stable = new Set([...counts].filter(([, c]) => c >= STABLE_RECURRENCES).map(([r]) => r));
    if (stable.size === 0) continue;

    // Supporting sends: those whose recipients are all stable (never propose a
    // scope wider than sends we actually observed going only to stable people).
    const supporting = sends.filter((s) => s.recipients.length > 0 && s.recipients.every((r) => stable.has(r)));
    if (supporting.length < minSends()) continue;
    const distinctDays = new Set(supporting.map((s) => s.resolvedAt.slice(0, 10))).size;
    if (distinctDays < 2) continue;

    // Domain escalation: a private domain shared by ≥N distinct stable
    // recipients widens to a domain grant; those recipients drop from the exact
    // list (still covered). Public mail domains never escalate.
    const domainCounts = new Map<string, Set<string>>();
    for (const r of stable) {
      const d = domainOf(r);
      if (!d || PUBLIC_MAIL_DOMAINS.has(d)) continue;
      const set = domainCounts.get(d) ?? new Set<string>();
      set.add(r);
      domainCounts.set(d, set);
    }
    const domains = [...domainCounts]
      .filter(([, recips]) => recips.size >= DOMAIN_ESCALATION_MIN_RECIPIENTS)
      .map(([d]) => d);
    const domainSet = new Set(domains);
    const recipients = [...stable]
      .filter((r) => { const d = domainOf(r); return !(d && domainSet.has(d)); })
      .sort();

    const times = supporting.map((s) => s.resolvedAt).sort();
    const evidence: TrustProposalEvidence = {
      cleanSendCount: supporting.length,
      distinctDays,
      firstAt: times[0],
      lastAt: times[times.length - 1],
      sampleApprovalIds: supporting.slice(0, 5).map((s) => s.approvalId),
    };
    const maxRecipients = Math.min(
      SEND_TRUST_MAX_RECIPIENTS,
      Math.max(1, ...supporting.map((s) => s.recipients.length)),
    );

    candidates.push({
      scopeKey: scopeKeyFor([toolkit], recipients, domains),
      toolkits: [toolkit],
      recipients,
      domains,
      maxRecipients,
      evidence,
    });
  }
  return candidates;
}

// ── Rationale (deterministic template — no LLM) ──────────────────────

function describeScope(c: Pick<TrustCandidate, 'recipients' | 'domains'>): string {
  const parts: string[] = [];
  if (c.recipients.length > 0) {
    parts.push(c.recipients.length <= 3
      ? c.recipients.join(', ')
      : `${c.recipients.slice(0, 3).join(', ')} +${c.recipients.length - 3} more`);
  }
  for (const d of c.domains) parts.push(`anyone @${d}`);
  return parts.join(' and ') || 'this recipient';
}

function buildRationale(c: TrustCandidate): string {
  const toolkit = c.toolkits[0] ?? 'send';
  return [
    `I've made ${c.evidence.cleanSendCount} approved, clean ${toolkit} sends to ${describeScope(c)} `,
    `across ${c.evidence.distinctDays} days with no rejections, revocations, or failures. `,
    `Want me to auto-send to that exact scope going forward instead of asking each time? `,
    `It stays under the ${SEND_TRUST_MAX_RECIPIENTS}-recipient mass-send floor, every send is still audited, `,
    `and you can revoke it anytime in Settings → Autonomy.`,
  ].join('');
}

// ── Tick ─────────────────────────────────────────────────────────────

function recoverCommittedProposalApproval(proposal: TrustProposal): boolean {
  const grant = findSendTrustGrantForProposal(proposal.id, {
    recipients: proposal.recipients,
    domains: proposal.domains,
    toolkits: proposal.toolkits,
    maxRecipients: proposal.maxRecipients,
  });
  if (!grant) return false;
  proposal.status = 'approved';
  proposal.resolvedAt = grant.sourceProposalResolvedAt ?? grant.grantedAt;
  proposal.resolvedBy = grant.sourceProposalResolvedBy ?? 'recovered-committed-grant';
  proposal.resolvedReason = grant.revokedAt
    ? 'owner approved (recovered committed grant; grant was later revoked)'
    : 'owner approved (recovered committed grant)';
  proposal.grantId = grant.id;
  return true;
}

function expireStale(store: ProposalFile, now: Date): TrustProposal[] {
  const cutoff = now.getTime() - PENDING_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  const expired: TrustProposal[] = [];
  for (const p of store.proposals) {
    if (p.status === 'pending' && Date.parse(p.createdAt) < cutoff) {
      p.status = 'expired';
      p.resolvedAt = now.toISOString();
      p.resolvedReason = 'pending expired (no decision within 14 days)';
      expired.push(p);
    }
  }
  return expired;
}

/** Is this candidate's recipient set a subset of any recently-declined scope? */
function blockedByDeclineCooldown(store: ProposalFile, c: TrustCandidate, now: Date): boolean {
  const floor = now.getTime() - declineCooldownMs();
  for (const p of store.proposals) {
    if (p.status !== 'declined' || !p.resolvedAt) continue;
    if (Date.parse(p.resolvedAt) < floor) continue;
    const declinedRecipients = new Set(p.recipients.map((r) => r.toLowerCase()));
    const declinedDomains = new Set((p.domains ?? []).map((d) => d.toLowerCase()));
    const covered = (r: string) => declinedRecipients.has(r.toLowerCase())
      || (() => { const d = domainOf(r); return d ? declinedDomains.has(d.toLowerCase()) : false; })();
    const recipientsSubset = c.recipients.length > 0 && c.recipients.every(covered);
    const domainsSubset = c.domains.every((d) => declinedDomains.has(d.toLowerCase()));
    if (recipientsSubset && domainsSubset) return true;
  }
  return false;
}

/**
 * Maintenance-tick entry point — never throws. Expires stale pending proposals,
 * then drafts new ones for any scope that has graduated, respecting the pending
 * cap, per-scope dedupe, decline cooldown, and existing-grant coverage.
 */
export function tickTrustGraduation(now: Date = new Date()): void {
  try {
    if (!trustGraduationEnabled()) return;
    // Evidence collection can touch large approval histories. Keep it outside
    // the short proposal critical section; authority is re-checked under lock.
    const candidates = sendTrustEnabled()
      ? deriveTrustCandidates(collectCleanSends(now), now)
      : [];
    const { proposed, expired, recovered, quarantined } = withProposalStateMutation(() => {
      const migration = loadStoreWithScopeMigration(now);
      const { store } = migration;
      const recoveredRows: TrustProposal[] = [];
      for (const proposal of store.proposals) {
        if (proposal.status === 'pending' && recoverCommittedProposalApproval(proposal)) {
          recoveredRows.push(proposal);
        }
      }
      const expiredRows = expireStale(store, now);
      const proposedRows: TrustProposal[] = [];
      let pendingCount = store.proposals.filter((proposal) => proposal.status === 'pending').length;
      for (const candidate of candidates) {
        if (pendingCount >= MAX_PENDING) break;
        // Already granted → nothing to propose. Approval performs the same check
        // atomically with grant creation; this early check is noise suppression.
        if (isSendTrustScopeCovered({
          recipients: candidate.recipients,
          domains: candidate.domains,
          toolkits: candidate.toolkits,
        })) continue;
        if (store.proposals.some((proposal) => (
          proposal.status === 'pending' && proposal.scopeKey === candidate.scopeKey
        ))) continue;
        if (blockedByDeclineCooldown(store, candidate, now)) continue;

        const receipt = trustProposalScopeReceipt(candidate);
        const proposal: TrustProposal = {
          id: `tgp-${randomUUID().slice(0, 12)}`,
          scopeKey: candidate.scopeKey,
          scopeRevision: receipt.scopeRevision,
          scopeDigest: receipt.scopeDigest,
          toolkits: receipt.toolkits,
          recipients: receipt.recipients,
          domains: receipt.domains.length > 0 ? receipt.domains : undefined,
          maxRecipients: receipt.maxRecipients,
          evidence: candidate.evidence,
          rationale: buildRationale(candidate),
          status: 'pending',
          createdAt: now.toISOString(),
        };
        store.proposals.push(proposal);
        proposedRows.push(proposal);
        pendingCount += 1;
      }
      if (expiredRows.length > 0 || proposedRows.length > 0 || recoveredRows.length > 0) saveStore(store);
      return {
        proposed: proposedRows,
        expired: expiredRows,
        recovered: recoveredRows,
        quarantined: migration.quarantined,
      };
    });

    // The proposal file is canonical. Projections happen after its lease is
    // released and are stable-id/best-effort so no callback can extend the
    // authority critical section.
    for (const proposal of quarantined) markTerminalProposalNotificationRead(proposal);
    for (const proposal of expired) markTerminalProposalNotificationRead(proposal);
    for (const proposal of recovered) {
      markTerminalProposalNotificationRead(proposal);
      auditResolved(proposal, 'approved');
      logger.info({
        proposalId: proposal.id,
        grantId: proposal.grantId,
      }, 'trust graduation recovered a committed proposal grant');
    }
    for (const proposal of proposed) {
      try {
        appendAuditRecord({
          at: proposal.createdAt,
          kind: 'trust_graduation_proposed',
          proposalId: proposal.id,
          scopeKey: proposal.scopeKey,
          scopeRevision: proposal.scopeRevision,
          scopeDigest: proposal.scopeDigest,
          toolkits: proposal.toolkits,
          recipients: proposal.recipients,
          domains: proposal.domains ?? [],
          cleanSendCount: proposal.evidence.cleanSendCount,
          distinctDays: proposal.evidence.distinctDays,
        });
      } catch { /* ledger never blocks proposing */ }

      try {
        addNotification({
          id: `trust-proposal-${proposal.id}`,
          kind: 'approval',
          title: 'Send-trust suggestion',
          body: [
            proposal.rationale,
            '',
            `Scope: ${describeScope({ recipients: proposal.recipients, domains: proposal.domains ?? [] })} · via ${proposal.toolkits.join(', ')}`,
            'Approve or decline from Inbox → Needs you.',
          ].join('\n'),
          createdAt: proposal.createdAt,
          read: false,
          metadata: {
            trustProposalId: proposal.id,
            trustProposalScopeRevision: proposal.scopeRevision,
            trustProposalScopeDigest: proposal.scopeDigest,
            kind: 'trust_graduation_proposal',
          },
        });
      } catch { /* notification is best-effort */ }

      logger.info({
        proposalId: proposal.id,
        scopeKey: proposal.scopeKey,
        toolkit: proposal.toolkits[0],
      }, 'trust graduation proposed');
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'trust graduation tick failed');
  }
}

// ── Owner review — the ONLY apply path ───────────────────────────────

export interface ResolveTrustResult {
  ok: boolean;
  reason:
    | 'approved'
    | 'declined'
    | 'not-found'
    | 'not-pending'
    | 'superseded'
    | 'expired'
    | 'scope-mismatch';
  proposal?: TrustProposal;
  grantId?: string;
  /** Exact authority the decision did, or would have, covered. */
  scopeReceipt?: TrustProposalScopeReceipt;
}

interface TrustResolutionCommit {
  result: ResolveTrustResult;
  newlyResolved?: 'approved' | 'declined' | 'superseded' | 'expired';
}

function proposalHasExpired(proposal: TrustProposal, now: Date): boolean {
  const createdAtMs = Date.parse(proposal.createdAt);
  if (!Number.isFinite(createdAtMs)) return true;
  return createdAtMs <= now.getTime() - PENDING_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
}

function expireProposalAtDecision(
  proposal: TrustProposal,
  store: ProposalFile,
  now: Date,
): TrustResolutionCommit | null {
  if (!proposalHasExpired(proposal, now)) return null;
  proposal.status = 'expired';
  proposal.resolvedAt = now.toISOString();
  proposal.resolvedReason = 'pending expired before owner decision (no decision within 14 days)';
  saveStore(store);
  return {
    result: {
      ok: false,
      reason: 'expired',
      proposal,
      scopeReceipt: trustProposalScopeReceipt(proposal),
    },
    newlyResolved: 'expired',
  };
}

function rejectCorruptProposalScope(
  proposal: TrustProposal,
  store: ProposalFile,
  now: Date,
): TrustResolutionCommit {
  proposal.status = 'superseded';
  proposal.resolvedAt = now.toISOString();
  proposal.resolvedReason = 'stored proposal scope no longer matches its immutable digest';
  saveStore(store);
  return {
    result: {
      ok: false,
      reason: 'scope-mismatch',
      proposal,
      scopeReceipt: trustProposalScopeReceipt(proposal),
    },
    newlyResolved: 'superseded',
  };
}

function pendingScopeMismatch(
  proposal: TrustProposal,
): TrustResolutionCommit {
  return {
    result: {
      ok: false,
      reason: 'scope-mismatch',
      proposal,
      scopeReceipt: trustProposalScopeReceipt(proposal),
    },
  };
}

function markTerminalProposalNotificationRead(proposal: TrustProposal | undefined): void {
  if (!proposal || proposal.status === 'pending') return;
  try {
    markNotificationRead(`trust-proposal-${proposal.id}`);
  } catch {
    // Proposal state is canonical. The stable notification can be reconciled by
    // a terminal replay without turning an already-committed decision into 5xx.
  }
}

function finishTrustResolution(commit: TrustResolutionCommit): ResolveTrustResult {
  markTerminalProposalNotificationRead(commit.result.proposal);
  if (commit.newlyResolved && commit.result.proposal) {
    auditResolved(commit.result.proposal, commit.newlyResolved);
    if (commit.newlyResolved === 'approved') {
      logger.info({
        proposalId: commit.result.proposal.id,
        grantId: commit.result.grantId,
      }, 'trust graduation approved → grant committed');
    } else {
      logger.info({
        proposalId: commit.result.proposal.id,
        resolution: commit.newlyResolved,
      }, `trust graduation ${commit.newlyResolved}`);
    }
  }
  return commit.result;
}

/**
 * Approve a proposal under the proposal lease, then recover-or-create its exact
 * send grant under the plan-scope lease. The sourceProposalId correlation closes
 * the two-file crash window: if the grant committed first, a retry completes the
 * proposal as approved with that same grant rather than double-granting or
 * misreporting unrelated coverage.
 */
export function approveTrustProposal(id: string, resolvedBy?: string, now?: Date): ResolveTrustResult;
export function approveTrustProposal(
  id: string,
  resolvedBy: string | undefined,
  expectedScope: TrustProposalScopeExpectation,
  now?: Date,
): ResolveTrustResult;
export function approveTrustProposal(
  id: string,
  resolvedBy = 'user',
  expectedScopeOrNow?: TrustProposalScopeExpectation | Date,
  decisionNow = new Date(),
): ResolveTrustResult {
  const expectedScope = expectedScopeOrNow instanceof Date ? undefined : expectedScopeOrNow;
  const now = expectedScopeOrNow instanceof Date ? expectedScopeOrNow : decisionNow;
  const commit = withProposalStateMutation((): TrustResolutionCommit => {
    const migration = loadStoreWithScopeMigration(now);
    const { store } = migration;
    const proposal = store.proposals.find((row) => row.id === id);
    if (!proposal) return { result: { ok: false, reason: 'not-found' } };
    if (migration.quarantined.includes(proposal)) {
      return {
        result: {
          ok: false,
          reason: 'scope-mismatch',
          proposal,
          scopeReceipt: trustProposalScopeReceipt(proposal),
        },
        newlyResolved: 'superseded',
      };
    }
    if (proposal.status !== 'pending') {
      return {
        result: {
          ok: false,
          reason: 'not-pending',
          proposal,
          grantId: proposal.grantId,
          scopeReceipt: trustProposalScopeReceipt(proposal),
        },
      };
    }
    if (recoverCommittedProposalApproval(proposal)) {
      saveStore(store);
      return {
        result: {
          ok: true,
          reason: 'approved',
          proposal,
          grantId: proposal.grantId,
          scopeReceipt: trustProposalScopeReceipt(proposal),
        },
        newlyResolved: 'approved',
      };
    }
    const expired = expireProposalAtDecision(proposal, store, now);
    if (expired) return expired;
    if (!proposalScopeIsIntact(proposal)) return rejectCorruptProposalScope(proposal, store, now);
    if (!expectationMatchesProposal(proposal, expectedScope)) return pendingScopeMismatch(proposal);
    pauseTrustResolutionForTest();

    const grantResult = grantSendTrustForProposal(proposal.id, {
      recipients: proposal.recipients,
      domains: proposal.domains,
      toolkits: proposal.toolkits,
      maxRecipients: proposal.maxRecipients,
      note: `graduated: ${proposal.evidence.cleanSendCount} approved clean sends (${proposal.id})`,
    }, {
      resolvedBy,
      resolvedAt: now.toISOString(),
    });
    const nowIso = now.toISOString();
    proposal.resolvedAt = grantResult.status === 'granted' && grantResult.recovered
      ? grantResult.grant.sourceProposalResolvedAt ?? grantResult.grant.grantedAt
      : nowIso;
    proposal.resolvedBy = grantResult.status === 'granted' && grantResult.recovered
      ? grantResult.grant.sourceProposalResolvedBy ?? resolvedBy
      : resolvedBy;

    if (grantResult.status === 'granted') {
      proposal.status = 'approved';
      proposal.resolvedReason = grantResult.recovered
        ? 'owner approved (recovered committed grant)'
        : 'owner approved';
      proposal.grantId = grantResult.grant.id;
      saveStore(store);
      return {
        result: {
          ok: true,
          reason: 'approved',
          proposal,
          grantId: grantResult.grant.id,
          scopeReceipt: trustProposalScopeReceipt(proposal),
        },
        newlyResolved: 'approved',
      };
    }

    proposal.status = 'superseded';
    proposal.resolvedReason = grantResult.status === 'covered'
      ? 'an existing grant already covers this scope'
      : 'send-trust is disabled, revoked during recovery, or the scope was refused';
    saveStore(store);
    return {
      result: {
        ok: false,
        reason: 'superseded',
        proposal,
        scopeReceipt: trustProposalScopeReceipt(proposal),
      },
      newlyResolved: 'superseded',
    };
  });
  return finishTrustResolution(commit);
}

/** Decline a proposal → grants nothing, starts the decline cooldown. */
export function declineTrustProposal(id: string, resolvedBy?: string, now?: Date): ResolveTrustResult;
export function declineTrustProposal(
  id: string,
  resolvedBy: string | undefined,
  expectedScope: TrustProposalScopeExpectation,
  now?: Date,
): ResolveTrustResult;
export function declineTrustProposal(
  id: string,
  resolvedBy = 'user',
  expectedScopeOrNow?: TrustProposalScopeExpectation | Date,
  decisionNow = new Date(),
): ResolveTrustResult {
  const expectedScope = expectedScopeOrNow instanceof Date ? undefined : expectedScopeOrNow;
  const now = expectedScopeOrNow instanceof Date ? expectedScopeOrNow : decisionNow;
  const commit = withProposalStateMutation((): TrustResolutionCommit => {
    const migration = loadStoreWithScopeMigration(now);
    const { store } = migration;
    const proposal = store.proposals.find((row) => row.id === id);
    if (!proposal) return { result: { ok: false, reason: 'not-found' } };
    if (migration.quarantined.includes(proposal)) {
      return {
        result: {
          ok: false,
          reason: 'scope-mismatch',
          proposal,
          scopeReceipt: trustProposalScopeReceipt(proposal),
        },
        newlyResolved: 'superseded',
      };
    }
    if (proposal.status !== 'pending') {
      return {
        result: {
          ok: false,
          reason: 'not-pending',
          proposal,
          grantId: proposal.grantId,
          scopeReceipt: trustProposalScopeReceipt(proposal),
        },
      };
    }
    if (recoverCommittedProposalApproval(proposal)) {
      saveStore(store);
      return {
        result: {
          ok: false,
          reason: 'not-pending',
          proposal,
          grantId: proposal.grantId,
          scopeReceipt: trustProposalScopeReceipt(proposal),
        },
        newlyResolved: 'approved',
      };
    }
    const expired = expireProposalAtDecision(proposal, store, now);
    if (expired) return expired;
    if (!proposalScopeIsIntact(proposal)) return rejectCorruptProposalScope(proposal, store, now);
    if (!expectationMatchesProposal(proposal, expectedScope)) return pendingScopeMismatch(proposal);
    pauseTrustResolutionForTest();
    proposal.status = 'declined';
    proposal.resolvedAt = now.toISOString();
    proposal.resolvedBy = resolvedBy;
    proposal.resolvedReason = 'owner declined';
    saveStore(store);
    return {
      result: {
        ok: true,
        reason: 'declined',
        proposal,
        scopeReceipt: trustProposalScopeReceipt(proposal),
      },
      newlyResolved: 'declined',
    };
  });
  return finishTrustResolution(commit);
}

function auditResolved(
  proposal: TrustProposal,
  resolution: 'approved' | 'declined' | 'superseded' | 'expired',
): void {
  const receipt = trustProposalScopeReceipt(proposal);
  try {
    appendAuditRecord({
      at: proposal.resolvedAt ?? new Date().toISOString(),
      kind: 'trust_graduation_resolved',
      proposalId: proposal.id,
      scopeKey: proposal.scopeKey,
      scopeRevision: receipt.scopeRevision,
      scopeDigest: receipt.scopeDigest,
      resolution,
      resolvedBy: proposal.resolvedBy ?? null,
      grantId: proposal.grantId ?? null,
      toolkits: proposal.toolkits,
      recipients: proposal.recipients,
      domains: proposal.domains ?? [],
    });
  } catch { /* the ledger never blocks resolution */ }
}
