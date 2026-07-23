/**
 * Curated-identity evolution — "Clem suggests, the user owns."
 *
 * The curated halves of IDENTITY.md and SOUL.md are seeded once at
 * install and, before this module, nothing ever proposed changing them:
 * the identity-md-builder only grows the AUTO section below the marker.
 * This module closes the loop for the curated half without ever writing
 * it unilaterally: a low-cadence distiller reads the durable facts the
 * user has accumulated, drafts a revised curated section, and parks it
 * as a PENDING PROPOSAL. Only an explicit owner approval applies it —
 * mirroring the workflow-designation contract (suggest, never
 * auto-route).
 *
 * Safety properties:
 *   - Never touches the file at proposal time; only approve writes, and
 *     through composeCuratedMemory so the AUTO section survives.
 *   - Approval is staleness-checked: if the user edited the curated text
 *     after the proposal was drafted, the proposal is marked superseded
 *     instead of clobbering their edit.
 *   - At most one pending proposal, at most one draft per 7 days, and
 *     only when enough NEW durable evidence accumulated since the last
 *     one — quiet by default.
 *   - CLEMMY_IDENTITY_EVOLUTION=0 is the kill switch (default on).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import pino from 'pino';
import { Agent, Runner } from '@openai/agents';
import { BASE_DIR, getRuntimeEnv, MODELS } from '../config.js';
import { extractJsonCandidate } from '../runtime/harness/json-repair.js';
import { addNotification } from '../runtime/notifications.js';
import { IDENTITY_FILE, SOUL_FILE, composeCuratedMemory, sanitizeCuratedMemory, splitCuratedMemory } from './vault.js';
import { listActiveFacts, type ConsolidatedFact } from './facts.js';
import { isDurableUserFact } from './identity-md-builder.js';

const logger = pino({ name: 'clementine-next.memory.identity-evolution' });

const STORE_FILE = path.join(BASE_DIR, 'state', 'identity-proposals.json');
/** At most one drafted proposal per week, regardless of how it resolved. */
const PROPOSAL_MIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** Minimum NEW durable facts since the last proposal before drafting —
 *  below this there is nothing meaningful to fold into the identity. */
const MIN_NEW_DURABLE_FACTS = 5;
/** Curated sections are clipped to 4000 chars at prompt-injection time
 *  (vault.ts); a proposal may never exceed what the prompt can carry. */
const MAX_PROPOSED_CHARS = 4000;
const MAX_STORED_PROPOSALS = 40;

export type IdentityProposalTarget = 'identity' | 'soul';
export type IdentityProposalStatus = 'pending' | 'approved' | 'rejected' | 'superseded';

export interface IdentityProposal {
  id: string;
  target: IdentityProposalTarget;
  /** Curated text (marker-stripped) at draft time — the staleness anchor
   *  and the "before" side of the review diff. */
  currentText: string;
  proposedText: string;
  /** One short paragraph: what changed and which evidence supports it. */
  rationale: string;
  derivedFromFactIds: number[];
  status: IdentityProposalStatus;
  createdAt: string;
  resolvedAt?: string;
  resolvedReason?: string;
}

interface ProposalFile {
  version: 'v1';
  proposals: IdentityProposal[];
}

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
  // Resolved history is an audit trail, not an archive — keep it bounded.
  const proposals = store.proposals.slice(-MAX_STORED_PROPOSALS);
  const tmp = `${STORE_FILE}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 'v1', proposals }, null, 2), 'utf-8');
  renameSync(tmp, STORE_FILE);
}

export function listIdentityProposals(status?: IdentityProposalStatus): IdentityProposal[] {
  const proposals = loadStore().proposals;
  return (status ? proposals.filter((p) => p.status === status) : proposals)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function targetFile(target: IdentityProposalTarget): string {
  return target === 'identity' ? IDENTITY_FILE : SOUL_FILE;
}

function readCuratedTarget(target: IdentityProposalTarget): string {
  const file = targetFile(target);
  const raw = existsSync(file) ? readFileSync(file, 'utf-8') : '';
  return splitCuratedMemory(raw).curated;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ── Distiller ────────────────────────────────────────────────────────

export interface IdentityDistillerInput {
  target: IdentityProposalTarget;
  currentText: string;
  facts: Array<{ id: number; kind: string; content: string }>;
}

export interface IdentityDistillerOutput {
  proposedText: string;
  rationale: string;
}

type IdentityDistillerFn = (input: IdentityDistillerInput) => Promise<IdentityDistillerOutput | null>;

let distillerOverrideForTest: IdentityDistillerFn | null = null;
/** Test seam, mirrors reflection's extractor override. */
export function setIdentityDistillerForTest(fn: IdentityDistillerFn | null): void {
  distillerOverrideForTest = fn;
}

function buildDistillerAgent(target: IdentityProposalTarget): Agent<unknown> {
  const scope = target === 'identity'
    ? 'the Identity section: who Clementine is to this user and what their working relationship has become'
    : 'the Soul section: how Clementine communicates — tone, reply shape, initiative';
  return new Agent({
    name: 'IdentityEvolutionDistiller',
    model: MODELS.fast,
    modelSettings: { reasoning: { effort: 'low' } },
    instructions: [
      `You revise ${scope}. You receive the CURRENT curated text and a list of durable facts the user has confirmed over time.`,
      'Propose a revised version of the curated text that folds in what the evidence supports. Evolve, do not rewrite: keep the existing voice, person, and structure; change only sentences the facts justify changing, and add at most a few.',
      'Never invent biography, employers, names, or preferences that are not in the fact list. Never include secrets, tokens, or full email addresses.',
      'Keep the same top-level markdown heading the current text starts with. Stay under 3500 characters.',
      'Also write a 1-3 sentence rationale: what changed and which facts support it, in plain language addressed to the user.',
      'If the facts do not justify any meaningful change, return {"proposedText": "", "rationale": ""}.',
      'Return ONLY JSON: {"proposedText": "...", "rationale": "..."}.',
    ].join('\n'),
    tools: [],
  });
}

function parseDistillerOutput(value: unknown): IdentityDistillerOutput | null {
  let obj: unknown = value;
  if (typeof value === 'string') {
    const candidate = extractJsonCandidate(value);
    if (!candidate) return null;
    try { obj = JSON.parse(candidate); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const proposedText = (obj as Record<string, unknown>).proposedText;
  const rationale = (obj as Record<string, unknown>).rationale;
  if (typeof proposedText !== 'string' || typeof rationale !== 'string') return null;
  return { proposedText: proposedText.trim(), rationale: rationale.replace(/\s+/g, ' ').trim() };
}

async function runDistiller(input: IdentityDistillerInput): Promise<IdentityDistillerOutput | null> {
  if (distillerOverrideForTest) return distillerOverrideForTest(input);
  const runner = new Runner({ workflowName: 'clementine-identity-evolution' });
  const prompt = [
    `CURRENT ${input.target.toUpperCase()} SECTION:`,
    input.currentText,
    '',
    'DURABLE CONFIRMED FACTS:',
    ...input.facts.map((f) => `- [${f.kind}] ${f.content}`),
  ].join('\n');
  const result = await runner.run(buildDistillerAgent(input.target), prompt, { maxTurns: 1 });
  return parseDistillerOutput((result as { finalOutput?: unknown }).finalOutput);
}

// ── Generation gate + tick ───────────────────────────────────────────

function identityEvolutionEnabled(): boolean {
  return getRuntimeEnv('CLEMMY_IDENTITY_EVOLUTION', '1') !== '0';
}

/** Durable user/feedback facts, importance-ranked — the evidence pool. */
function selectEvidenceFacts(nowMs: number): ConsolidatedFact[] {
  const pool = [
    ...listActiveFacts({ kind: 'user', ranking: 'stanford', limit: 40 }),
    ...listActiveFacts({ kind: 'feedback', ranking: 'stanford', limit: 20 }),
  ];
  return pool.filter((fact) => isDurableUserFact(fact, nowMs)).slice(0, 24);
}

export interface ProposeResult {
  proposed: boolean;
  reason: 'disabled' | 'pending-exists' | 'too-soon' | 'not-enough-evidence' | 'no-change' | 'invalid-output' | 'drafted' | 'failed';
  proposalId?: string;
}

/**
 * Draft at most one identity/soul update proposal when the gates allow.
 * Called from the maintenance tick (~24h); the 7-day + evidence gates do
 * the real pacing. Never writes the target files.
 */
export async function maybeProposeIdentityUpdate(now = new Date()): Promise<ProposeResult> {
  if (!identityEvolutionEnabled()) return { proposed: false, reason: 'disabled' };

  const store = loadStore();
  if (store.proposals.some((p) => p.status === 'pending')) {
    return { proposed: false, reason: 'pending-exists' };
  }
  const lastCreated = store.proposals.map((p) => p.createdAt).sort().at(-1);
  if (lastCreated && now.getTime() - Date.parse(lastCreated) < PROPOSAL_MIN_INTERVAL_MS) {
    return { proposed: false, reason: 'too-soon' };
  }

  const facts = selectEvidenceFacts(now.getTime());
  const newSince = lastCreated
    ? facts.filter((f) => f.createdAt > lastCreated)
    : facts;
  if (newSince.length < MIN_NEW_DURABLE_FACTS) {
    return { proposed: false, reason: 'not-enough-evidence' };
  }

  // Tone/communication evidence goes to SOUL; everything else (the common
  // case) evolves IDENTITY. Deterministic pick — one proposal per cycle.
  const toneLike = newSince.filter((f) => /\btone\b|\bformal|casual|concise|terse|verbose|preamble|notify|ping|check-?in/i.test(f.content));
  const target: IdentityProposalTarget = toneLike.length > newSince.length / 2 ? 'soul' : 'identity';
  const currentText = readCuratedTarget(target);

  try {
    const output = await runDistiller({
      target,
      currentText,
      facts: facts.map((f) => ({ id: f.id, kind: f.kind, content: f.content })),
    });
    if (!output) return { proposed: false, reason: 'invalid-output' };
    if (!output.proposedText || !output.rationale) return { proposed: false, reason: 'no-change' };

    const proposedText = sanitizeCuratedMemory(output.proposedText).trim();
    const currentHeading = currentText.match(/^#[^\n]*/)?.[0];
    if (
      proposedText.length > MAX_PROPOSED_CHARS
      || !proposedText.startsWith('#')
      || (currentHeading && !proposedText.startsWith(currentHeading))
    ) {
      return { proposed: false, reason: 'invalid-output' };
    }
    if (normalizeText(proposedText) === normalizeText(currentText)) {
      return { proposed: false, reason: 'no-change' };
    }

    const proposal: IdentityProposal = {
      id: `idp-${randomUUID().slice(0, 12)}`,
      target,
      currentText,
      proposedText,
      rationale: output.rationale.slice(0, 600),
      derivedFromFactIds: facts.map((f) => f.id),
      status: 'pending',
      createdAt: now.toISOString(),
    };
    store.proposals.push(proposal);
    saveStore(store);

    try {
      addNotification({
        id: `identity-proposal-${proposal.id}`,
        kind: 'system',
        title: target === 'identity' ? 'Identity update suggested' : 'Personality update suggested',
        body: `Based on what I've learned about you, I drafted an update to my ${target === 'identity' ? 'identity' : 'personality'} description. Review and approve it in Memory → Files. ${proposal.rationale}`,
        createdAt: proposal.createdAt,
        read: false,
        metadata: { proposalId: proposal.id, target },
      });
    } catch { /* notification is best-effort */ }

    logger.info({ proposalId: proposal.id, target, evidence: facts.length }, 'identity update proposed');
    return { proposed: true, reason: 'drafted', proposalId: proposal.id };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'identity evolution distiller failed');
    return { proposed: false, reason: 'failed' };
  }
}

/** Maintenance-tick entry point — never throws. */
export async function tickIdentityEvolution(): Promise<void> {
  try {
    await maybeProposeIdentityUpdate();
  } catch (err) {
    logger.warn({ err }, 'identity evolution tick failed');
  }
}

// ── Owner review ─────────────────────────────────────────────────────

export interface ApplyProposalResult {
  applied: boolean;
  reason: 'applied' | 'not-found' | 'not-pending' | 'stale';
  proposal?: IdentityProposal;
}

/**
 * Apply an approved proposal to the curated half of its target file.
 * Fails closed on staleness: if the user edited the curated text after
 * the draft was made, the proposal is marked superseded and nothing is
 * written — their edit wins.
 */
export function approveIdentityProposal(id: string, now = new Date()): ApplyProposalResult {
  const store = loadStore();
  const proposal = store.proposals.find((p) => p.id === id);
  if (!proposal) return { applied: false, reason: 'not-found' };
  if (proposal.status !== 'pending') return { applied: false, reason: 'not-pending', proposal };

  const nowIso = now.toISOString();
  const liveCurated = readCuratedTarget(proposal.target);
  if (normalizeText(liveCurated) !== normalizeText(proposal.currentText)) {
    proposal.status = 'superseded';
    proposal.resolvedAt = nowIso;
    proposal.resolvedReason = 'curated text changed after drafting';
    saveStore(store);
    return { applied: false, reason: 'stale', proposal };
  }

  const file = targetFile(proposal.target);
  const existingRaw = existsSync(file) ? readFileSync(file, 'utf-8') : '';
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, composeCuratedMemory(proposal.proposedText, existingRaw), 'utf-8');

  proposal.status = 'approved';
  proposal.resolvedAt = nowIso;
  proposal.resolvedReason = 'owner approved';
  saveStore(store);
  logger.info({ proposalId: id, target: proposal.target }, 'identity proposal approved and applied');
  return { applied: true, reason: 'applied', proposal };
}

export function rejectIdentityProposal(id: string, now = new Date()): boolean {
  const store = loadStore();
  const proposal = store.proposals.find((p) => p.id === id);
  if (!proposal || proposal.status !== 'pending') return false;
  proposal.status = 'rejected';
  proposal.resolvedAt = now.toISOString();
  proposal.resolvedReason = 'owner rejected';
  saveStore(store);
  return true;
}
