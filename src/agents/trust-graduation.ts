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
import { addNotification } from '../runtime/notifications.js';
import { appendAuditRecord } from '../runtime/audit-ledger.js';
import { classifyExternalWrite } from '../runtime/harness/confirm-first-gate.js';
import { listPending } from '../runtime/harness/approval-registry.js';
import { listPendingActions } from '../runtime/harness/pending-actions.js';
import {
  extractSendTargets,
  grantSendTrust,
  inferToolkit,
  isSendTrustScopeCovered,
  listAllSendTrustGrants,
  SEND_TRUST_MAX_RECIPIENTS,
} from './plan-scope.js';

const logger = pino({ name: 'clementine-next.trust-graduation' });

const STORE_FILE = path.join(BASE_DIR, 'state', 'trust-graduation-proposals.json');
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

function loadStore(): ProposalFile {
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

export function listTrustProposals(status?: TrustProposalStatus): TrustProposal[] {
  const proposals = loadStore().proposals;
  return (status ? proposals.filter((p) => p.status === status) : proposals)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getTrustProposal(id: string): TrustProposal | null {
  return loadStore().proposals.find((p) => p.id === id) ?? null;
}

// ── Helpers ──────────────────────────────────────────────────────────

function domainOf(recipient: string): string | null {
  const at = recipient.indexOf('@');
  return at > 0 ? recipient.slice(at + 1) : null;
}

function scopeKeyFor(toolkits: string[], recipients: string[], domains: string[]): string {
  const canon = JSON.stringify({
    toolkits: [...toolkits].sort(),
    recipients: [...recipients].sort(),
    domains: [...domains].sort(),
  });
  return `tgp-${createHash('sha256').update(canon).digest('hex').slice(0, 16)}`;
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

function expireStale(store: ProposalFile, now: Date): boolean {
  const cutoff = now.getTime() - PENDING_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  let changed = false;
  for (const p of store.proposals) {
    if (p.status === 'pending' && Date.parse(p.createdAt) < cutoff) {
      p.status = 'expired';
      p.resolvedAt = now.toISOString();
      p.resolvedReason = 'pending expired (no decision within 14 days)';
      changed = true;
    }
  }
  return changed;
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

    const store = loadStore();
    let changed = expireStale(store, now);

    // With send-trust off there is nothing to grant — still expire stale
    // pending, but never draft a suggestion we could not honor.
    if (!sendTrustEnabled()) { if (changed) saveStore(store); return; }

    const observations = collectCleanSends(now);
    const candidates = deriveTrustCandidates(observations, now);

    let pendingCount = store.proposals.filter((p) => p.status === 'pending').length;
    for (const c of candidates) {
      if (pendingCount >= MAX_PENDING) break;
      // Already granted → nothing to propose.
      if (isSendTrustScopeCovered({ recipients: c.recipients, domains: c.domains, toolkits: c.toolkits })) continue;
      // One pending per scope.
      if (store.proposals.some((p) => p.status === 'pending' && p.scopeKey === c.scopeKey)) continue;
      // Cooldown after a decline of the same/wider scope.
      if (blockedByDeclineCooldown(store, c, now)) continue;

      const proposal: TrustProposal = {
        id: `tgp-${randomUUID().slice(0, 12)}`,
        scopeKey: c.scopeKey,
        toolkits: c.toolkits,
        recipients: c.recipients,
        domains: c.domains.length ? c.domains : undefined,
        maxRecipients: c.maxRecipients,
        evidence: c.evidence,
        rationale: buildRationale(c),
        status: 'pending',
        createdAt: now.toISOString(),
      };
      store.proposals.push(proposal);
      pendingCount += 1;
      changed = true;

      try {
        appendAuditRecord({
          at: proposal.createdAt,
          kind: 'trust_graduation_proposed',
          proposalId: proposal.id,
          scopeKey: proposal.scopeKey,
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
            `Scope: ${describeScope(c)} · via ${proposal.toolkits.join(', ')}`,
            'Approve or decline from Inbox → Needs you.',
          ].join('\n'),
          createdAt: proposal.createdAt,
          read: false,
          metadata: { trustProposalId: proposal.id, kind: 'trust_graduation_proposal' },
        });
      } catch { /* notification is best-effort */ }

      logger.info({ proposalId: proposal.id, scopeKey: proposal.scopeKey, toolkit: c.toolkits[0] }, 'trust graduation proposed');
    }

    if (changed) saveStore(store);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'trust graduation tick failed');
  }
}

// ── Owner review — the ONLY apply path ───────────────────────────────

export interface ResolveTrustResult {
  ok: boolean;
  reason: 'approved' | 'declined' | 'not-found' | 'not-pending' | 'superseded';
  proposal?: TrustProposal;
  grantId?: string;
}

/**
 * Approve a proposal → grant the exact proposed scope via grantSendTrust (the
 * sole grant authority). Re-checks coverage at approve time: if a live grant now
 * covers the scope, or grantSendTrust refuses (send-trust disabled / unscoped),
 * the proposal is marked superseded and nothing new is granted.
 */
export function approveTrustProposal(id: string, resolvedBy = 'user', now = new Date()): ResolveTrustResult {
  const store = loadStore();
  const proposal = store.proposals.find((p) => p.id === id);
  if (!proposal) return { ok: false, reason: 'not-found' };
  if (proposal.status !== 'pending') return { ok: false, reason: 'not-pending', proposal };

  const nowIso = now.toISOString();

  // Already covered since drafting → moot, don't double-grant.
  if (isSendTrustScopeCovered({ recipients: proposal.recipients, domains: proposal.domains, toolkits: proposal.toolkits })) {
    proposal.status = 'superseded';
    proposal.resolvedAt = nowIso;
    proposal.resolvedBy = resolvedBy;
    proposal.resolvedReason = 'an existing grant already covers this scope';
    saveStore(store);
    auditResolved(proposal, 'superseded');
    return { ok: false, reason: 'superseded', proposal };
  }

  const grant = grantSendTrust({
    recipients: proposal.recipients,
    domains: proposal.domains,
    toolkits: proposal.toolkits,
    maxRecipients: proposal.maxRecipients,
    note: `graduated: ${proposal.evidence.cleanSendCount} approved clean sends (${proposal.id})`,
  });
  if (!grant) {
    proposal.status = 'superseded';
    proposal.resolvedAt = nowIso;
    proposal.resolvedBy = resolvedBy;
    proposal.resolvedReason = 'send-trust is disabled or the scope was refused';
    saveStore(store);
    auditResolved(proposal, 'superseded');
    return { ok: false, reason: 'superseded', proposal };
  }

  proposal.status = 'approved';
  proposal.resolvedAt = nowIso;
  proposal.resolvedBy = resolvedBy;
  proposal.resolvedReason = 'owner approved';
  proposal.grantId = grant.id;
  saveStore(store);
  auditResolved(proposal, 'approved');
  logger.info({ proposalId: proposal.id, grantId: grant.id }, 'trust graduation approved → grant created');
  return { ok: true, reason: 'approved', proposal, grantId: grant.id };
}

/** Decline a proposal → grants nothing, starts the decline cooldown. */
export function declineTrustProposal(id: string, resolvedBy = 'user', now = new Date()): ResolveTrustResult {
  const store = loadStore();
  const proposal = store.proposals.find((p) => p.id === id);
  if (!proposal) return { ok: false, reason: 'not-found' };
  if (proposal.status !== 'pending') return { ok: false, reason: 'not-pending', proposal };
  proposal.status = 'declined';
  proposal.resolvedAt = now.toISOString();
  proposal.resolvedBy = resolvedBy;
  proposal.resolvedReason = 'owner declined';
  saveStore(store);
  auditResolved(proposal, 'declined');
  logger.info({ proposalId: proposal.id }, 'trust graduation declined');
  return { ok: true, reason: 'declined', proposal };
}

function auditResolved(proposal: TrustProposal, resolution: 'approved' | 'declined' | 'superseded'): void {
  try {
    appendAuditRecord({
      at: proposal.resolvedAt ?? new Date().toISOString(),
      kind: 'trust_graduation_resolved',
      proposalId: proposal.id,
      scopeKey: proposal.scopeKey,
      resolution,
      resolvedBy: proposal.resolvedBy ?? null,
      grantId: proposal.grantId ?? null,
      toolkits: proposal.toolkits,
      recipients: proposal.recipients,
      domains: proposal.domains ?? [],
    });
  } catch { /* the ledger never blocks resolution */ }
}
