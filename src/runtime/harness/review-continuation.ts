/**
 * A later review round of one accepted request continues the earlier round's
 * conversation instead of starting a fresh one.
 *
 * The reviewer's provider reuses its cache only for a request that extends the
 * previous request exactly. A fresh round that repeats the same objective and
 * evidence is read again at full price: live 2026-10-18, re-reviews whose
 * evidence had not changed (about 10k input tokens) reused only the 3,840
 * tokens of fixed instructions. A continued round sends the earlier round's
 * exact items, its verdict, and one new message with what changed: the revised
 * response, what was added to the evidence since the first round, and the
 * finding. The reviewer still judges the revised response as a complete review
 * against the whole objective and all of the evidence it holds; nothing here
 * narrows the check.
 */
import { createHash } from 'node:crypto';
import type { ReviewInputComposition, ReviewInputOwner } from './review-input-observation.js';

const CONVERSATION_TTL_MS = 10 * 60_000;
const MAX_CONVERSATIONS = 16;
/** A continuation must be meaningfully smaller than a fresh round to be worth it. */
const MAX_DELTA_SHARE = 0.8;

const LABELS: Readonly<Record<string, string>> = {
  effective_objective: 'the objective',
  private_review_evidence: 'the evidence',
  coverage_ledger: 'the coverage ledger',
  retained_skill_references: 'the skill references',
  standing_instructions: 'the standing instructions',
  memory_requirement_context: 'the memory requirement',
};

interface ReviewConversation {
  instructionsDigest: string;
  /** The round's exact items: its input, any evidence lookups, and its verdict. */
  history: unknown[];
  /** Each named part of the first round's prompt, so later rounds send only what changed. */
  firstParts: ReadonlyMap<string, string>;
  at: number;
}

const conversations = new Map<string, ReviewConversation>();

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** One conversation per accepted request, attempt and reviewer model. */
export function reviewConversationKey(owner: ReviewInputOwner | undefined, modelId: string): string | null {
  if (!owner || typeof owner.sessionId !== 'string' || !owner.sessionId || !Number.isSafeInteger(owner.sourceUserSeq)
    || owner.sourceUserSeq <= 0 || typeof owner.attemptId !== 'string' || !owner.attemptId || !modelId) return null;
  return `${owner.sessionId}|${owner.sourceUserSeq}|${owner.attemptId}|${modelId}`;
}

interface PromptPart { name: string; text: string; startByte: number }

function promptParts(composition: ReviewInputComposition): PromptPart[] {
  const bytes = Buffer.from(composition.text, 'utf8');
  return composition.components.map((component) => ({
    name: component.name,
    text: bytes.subarray(component.startByte, component.endByte).toString('utf8'),
    startByte: component.startByte,
  }));
}

/** Named parts before the candidate response, keyed by name (repeats joined). */
function partsBefore(parts: readonly PromptPart[], endByte: number): Map<string, string> {
  const named = new Map<string, string>();
  for (const part of parts) {
    if (part.startByte >= endByte || part.name === 'candidate_response') continue;
    named.set(part.name, named.has(part.name) ? `${named.get(part.name)}\n${part.text}` : part.text);
  }
  return named;
}

/** The byte where the candidate response's own heading line starts. */
function responseHeadingByte(composition: ReviewInputComposition): number | null {
  const candidate = composition.components.find((component) => component.name === 'candidate_response');
  if (!candidate) return null;
  const head = Buffer.from(composition.text, 'utf8').subarray(0, candidate.startByte).toString('utf8');
  const lineStart = head.lastIndexOf('\n', head.length - 2) + 1;
  return Buffer.byteLength(head.slice(0, lineStart), 'utf8');
}

function prune(now: number): void {
  for (const [key, row] of conversations) if (now - row.at > CONVERSATION_TTL_MS) conversations.delete(key);
  while (conversations.size > MAX_CONVERSATIONS) {
    const oldest = conversations.keys().next().value as string | undefined;
    if (!oldest) break;
    conversations.delete(oldest);
  }
}

/** After a round that answered: keep its exact conversation for the next round. */
export function rememberReviewRound(key: string, input: {
  instructions: string;
  history: readonly unknown[];
  prompt: ReviewInputComposition;
  continued: boolean;
}): void {
  const now = Date.now();
  prune(now);
  const earlier = conversations.get(key);
  const heading = responseHeadingByte(input.prompt);
  if (heading === null || input.history.length === 0) {
    conversations.delete(key);
    return;
  }
  const firstParts = input.continued && earlier ? earlier.firstParts : partsBefore(promptParts(input.prompt), heading);
  conversations.delete(key);
  conversations.set(key, { instructionsDigest: digest(input.instructions), history: [...input.history], firstParts, at: now });
}

/** The next round as a continuation, or null when a fresh round is the honest choice. */
export function continuedReviewRound(key: string, input: {
  instructions: string;
  prompt: ReviewInputComposition;
  /** Handles the reviewer may open this round; always restated with the round. */
  evidenceReferences: string;
}): { history: unknown[]; message: string } | null {
  const now = Date.now();
  prune(now);
  const earlier = conversations.get(key);
  if (!earlier || earlier.instructionsDigest !== digest(input.instructions)) return null;
  const heading = responseHeadingByte(input.prompt);
  if (heading === null) return null;
  const current = partsBefore(promptParts(input.prompt), heading);
  // A changed objective is a different review, not a revision of one.
  if ((current.get('effective_objective') ?? '') !== (earlier.firstParts.get('effective_objective') ?? '')) return null;
  const updates: string[] = [];
  for (const [name, text] of current) {
    const first = earlier.firstParts.get(name);
    if (first === text) continue;
    const label = LABELS[name] ?? 'the review context';
    if (first !== undefined && text.startsWith(first)) {
      const added = text.slice(first.length).trim();
      if (added) updates.push(`Added to ${label} since your first review:\n${added}`);
    } else {
      updates.push(`${label.charAt(0).toUpperCase()}${label.slice(1)} now reads (this replaces the earlier version):\n${text}`);
    }
  }
  const tail = Buffer.from(input.prompt.text, 'utf8').subarray(heading).toString('utf8');
  const message = [
    '=== REVISED RESPONSE: REVIEW AGAIN ===',
    'After your review above, the assistant revised its response. The response you reviewed above is superseded. '
      + 'Review the revised response below as a complete review, against the whole objective and all of the evidence in this conversation, '
      + 'including anything added here. Your earlier verdict is context, not a conclusion.',
    ...updates,
    tail,
  ].join('\n\n') + input.evidenceReferences;
  if (Buffer.byteLength(message, 'utf8') > MAX_DELTA_SHARE * Buffer.byteLength(input.prompt.text, 'utf8')) return null;
  return { history: [...earlier.history], message };
}

/** Test-only: forget every remembered conversation. */
export function _resetReviewConversationsForTests(): void {
  conversations.clear();
}
