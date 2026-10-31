/** The memory view supplied to a model is distinct from memory-search hits.
 * This is advisory context provenance, never effect or permission authority. */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { appendEvent, listEvents, openEventLog } from './eventlog.js';

type Identity = { sessionId: string; sourceUserSeq: number };

/** One section of memory as a model request carried it. */
export interface ModelMemoryManifestEntry {
  section: string;
  tier: 'core' | 'relevant' | 'now';
  tokens: number;
  bytes: number;
  refs: Array<{ type: string; id: string }>;
  /** The section tells the answerer how to work (its operating guidance), not
   *  what the owner said, wants or has. A completion review leaves it out. */
  guidance?: true;
}

/** A producer-owned memory fragment and the sections it is made of. */
export interface ModelMemoryFragment {
  text: string;
  manifest?: readonly ModelMemoryManifestEntry[];
  /** sha256 of the memory core when this fragment is the core. */
  coreSha?: string;
}

const views = new WeakMap<Function, readonly ModelMemoryFragment[]>();
const hash = (fragments: readonly string[]) => createHash('sha256').update(JSON.stringify(fragments)).digest('hex');
export const _digestForTests = hash;

// Memory rendered after the instructions (the turn's ranked tail rides as its
// own input item). Keyed by exact text: a request that carries the text
// carried that memory. Bounded, newest kept.
const MAX_REGISTERED_TAILS = 128;
const tails = new Map<string, ModelMemoryFragment>();

function normalizeFragments(fragments: readonly (string | ModelMemoryFragment)[]): ModelMemoryFragment[] {
  return fragments
    .map((fragment) => (typeof fragment === 'string' ? { text: fragment } : fragment))
    .filter((fragment) => fragment.text.trim().length > 0);
}

export function withInstructionMemory<T extends Function>(instructions: T, fragments: readonly (string | ModelMemoryFragment)[]): T {
  views.set(instructions, normalizeFragments(fragments));
  return instructions;
}

/** Register memory text a host sends outside the instructions, so the
 *  accepted-request record names it when a request carries it. */
export function registerMemoryTail(text: string, manifest?: readonly ModelMemoryManifestEntry[]): void {
  if (!text.trim()) return;
  tails.delete(text);
  tails.set(text, { text, ...(manifest ? { manifest } : {}) });
  while (tails.size > MAX_REGISTERED_TAILS) {
    const oldest = tails.keys().next().value;
    if (oldest === undefined) break;
    tails.delete(oldest);
  }
}

function requestTexts(finalInstructions: string | undefined, input: readonly unknown[]): string[] {
  return [finalInstructions ?? '', ...input.flatMap(item => {
    if (!item || typeof item !== 'object' || !('content' in item)) return [];
    const content = (item as { content: unknown }).content;
    if (typeof content === 'string') return [content];
    return Array.isArray(content) ? content.flatMap(part => part && typeof part.text === 'string' ? [part.text] : []) : [];
  })];
}

/** Every producer-owned fragment (instruction memory and registered tails)
 * that the final request actually carries, after filters, with its sections.
 * Never infer context from a model's claim or reload a later-edited file. */
export function visibleModelMemory(instructions: unknown, finalInstructions: string | undefined, input: readonly unknown[]): ModelMemoryFragment[] {
  const fragments = typeof instructions === 'function' ? views.get(instructions) : undefined;
  if (!fragments) return [];
  const text = requestTexts(finalInstructions, input);
  const carried = (fragment: ModelMemoryFragment) => text.some(value => value.includes(fragment.text));
  const carriedTails = [...tails.values()].filter(carried);
  // A short tail (a lone pointer from another turn) can be a substring of the
  // tail this request carries; it is part of that one, not a second view.
  const distinctTails = carriedTails.filter(tail => !carriedTails.some(other => other !== tail
    && other.text.length > tail.text.length && other.text.includes(tail.text)));
  return [...fragments.filter(carried), ...distinctTails];
}

/** Match producer-owned fragments against the final request, after filters. */
export function visibleInstructionMemory(instructions: unknown, finalInstructions: string | undefined, input: readonly unknown[]): string[] {
  return visibleModelMemory(instructions, finalInstructions, input).map(fragment => fragment.text);
}

/** This session's model-memory rows, newest first. */
function memoryRows(sessionId: string, sinceSeq?: number) {
  return listEvents(sessionId, { types: ['guardrail_tripped'], desc: true,
    ...(sinceSeq !== undefined ? { sinceSeq } : {}) })
    .reverse().filter(event => event.data.kind === 'model_memory_context');
}

/** A current source's model view can only have been recorded after its user
 * event. This is a read bound, not authority; unknown/legacy identities keep
 * their old unrestricted lookup and no request text is hydrated to prove it. */
function canonicalMemorySource(identity: Identity): Identity | undefined {
  if (!identity || typeof identity !== 'object' || nodeTypes.isProxy(identity)) return undefined;
  const session = Object.getOwnPropertyDescriptor(identity, 'sessionId');
  const source = Object.getOwnPropertyDescriptor(identity, 'sourceUserSeq');
  if (!session || !source || !Object.hasOwn(session, 'value') || !Object.hasOwn(source, 'value')
    || typeof session.value !== 'string' || !session.value
    || !Number.isSafeInteger(source.value) || source.value < 1) return undefined;
  const row = openEventLog().prepare(`SELECT seq FROM events
    WHERE seq = ? AND session_id = ? AND type = 'user_input_received'`)
    .get(source.value, session.value) as { seq: number } | undefined;
  if (!row) return undefined;
  // The metadata probe lends no durable capability. Recheck the inert input
  // before using its bound, including under instrumented/reentrant readers.
  const currentSession = Object.getOwnPropertyDescriptor(identity, 'sessionId');
  const currentSource = Object.getOwnPropertyDescriptor(identity, 'sourceUserSeq');
  if (!currentSession || !currentSource || !Object.hasOwn(currentSession, 'value') || !Object.hasOwn(currentSource, 'value')
    || currentSession.value !== session.value || currentSource.value !== source.value) return undefined;
  return { sessionId: session.value, sourceUserSeq: source.value };
}

function latest(identity: Identity) {
  const canonical = canonicalMemorySource(identity);
  if (canonical) return memoryRows(canonical.sessionId, canonical.sourceUserSeq - 1)
    .find(event => event.data.sourceUserSeq === canonical.sourceUserSeq);
  return memoryRows(identity.sessionId).find(event => event.data.sourceUserSeq === identity.sourceUserSeq);
}

/** The fragment as a completion review reads it: every section but the
 *  answerer's operating guidance. Sections are cut by the producer's own
 *  manifest (in order, joined by a blank line); a fragment whose manifest does
 *  not rebuild its exact bytes is reviewed whole. */
export function reviewMemoryText(fragment: ModelMemoryFragment): string {
  const manifest = fragment.manifest;
  if (!manifest?.length || !manifest.some(entry => entry.guidance)) return fragment.text;
  const bytes = Buffer.from(fragment.text, 'utf8');
  const kept: string[] = [];
  let at = 0;
  for (const [index, entry] of manifest.entries()) {
    if (index > 0) {
      if (bytes.subarray(at, at + 2).toString('utf8') !== '\n\n') return fragment.text;
      at += 2;
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || at + entry.bytes > bytes.length) return fragment.text;
    if (!entry.guidance) kept.push(bytes.subarray(at, at + entry.bytes).toString('utf8'));
    at += entry.bytes;
  }
  return at === bytes.length ? kept.join('\n\n') : fragment.text;
}

export function recordAcceptedModelMemory(
  identity: Identity,
  fragments: readonly (string | ModelMemoryFragment)[],
  responseId?: string,
): void {
  const visible = normalizeFragments(fragments);
  if (!visible.length) return;
  const texts = visible.map(fragment => fragment.text);
  const digest = hash(texts);
  if (latest(identity)?.data.digest === digest) return;
  const manifest = visible.flatMap(fragment => fragment.manifest ?? []);
  const sum = (tier?: ModelMemoryManifestEntry['tier']) => manifest
    .filter(entry => !tier || entry.tier === tier)
    .reduce((total, entry) => total + entry.tokens, 0);
  const coreSha = visible.find(fragment => fragment.coreSha)?.coreSha;
  const reviewFragments = visible.map(reviewMemoryText);
  const reviewSliced = reviewFragments.some((text, index) => text !== texts[index]);
  appendEvent({ sessionId: identity.sessionId, turn: 0, role: 'system', type: 'guardrail_tripped',
    data: { kind: 'model_memory_context', version: 2, sourceUserSeq: identity.sourceUserSeq,
      digest, fragments: texts, manifest,
      ...(reviewSliced ? { reviewFragments, reviewDigest: hash(reviewFragments) } : {}),
      totals: {
        tokens: sum(),
        bytes: manifest.reduce((total, entry) => total + entry.bytes, 0),
        coreTokens: sum('core'),
        relevantTokens: sum('relevant'),
        nowTokens: sum('now'),
      },
      ...(coreSha ? { coreSha } : {}),
      ...(responseId ? { responseId } : {}) } });
}

function readable(row: Record<string, unknown> | undefined): boolean {
  return Boolean(row)
    && (row!.version === 1 || row!.version === 2)
    && Array.isArray(row!.fragments) && (row!.fragments as unknown[]).every(value => typeof value === 'string')
    && row!.digest === hash(row!.fragments as string[]);
}

export function acceptedModelMemoryEvidence(identity: Identity): string | undefined {
  const row = latest(identity)?.data;
  if (!row) return undefined;
  if (!readable(row)) return 'The retained model memory context is unreadable; do not infer that the brain had no remembered context.';
  const review = Array.isArray(row.reviewFragments) && (row.reviewFragments as unknown[]).every(value => typeof value === 'string')
    && row.reviewDigest === hash(row.reviewFragments as string[]) ? row.reviewFragments as string[] : undefined;
  return 'Memory context actually included in an accepted model request for THIS source:\n'
    + (review ?? row.fragments as string[]).filter(text => text.trim()).join('\n\n')
    + (review ? '\nThe answerer\'s operating guidance from memory (how to work, skill discovery, run strategies, lessons from past checks) is left out here; the owner\'s facts, preferences, standing rules and current state are shown.' : '')
    + '\nThis is mixed memory context: explicit preferences, observations, and derived inferences, not uniform user instructions, fresh business observations, or permission to act. '
    + 'An empty memory-search result does not negate this separately supplied context. Apply current owner instructions first; '
    + 'verify that a remembered claim applies to this task and its named resource or project. Past task restrictions and inferred patterns are not standing rules; shared keywords do not prove applicability. '
    + 'Require disclosure only of material unverified assumptions the plan actually relies on. Do not require a memory recap or explanation of context that did not shape the plan, or treat omission of an unadopted inference as incomplete work.';
}

/** What memory a session's latest (or a named) accepted request carried, as
 *  sections with sizes and refs, never the memory text itself. */
export interface ModelMemoryManifestRecord {
  sessionId: string;
  sourceUserSeq: number;
  version: 1 | 2;
  recordedAt: string;
  responseId?: string;
  coreSha?: string;
  totals?: { tokens: number; bytes: number; coreTokens: number; relevantTokens: number; nowTokens: number };
  manifest: ModelMemoryManifestEntry[];
}

export function latestModelMemoryManifest(sessionId: string, sourceUserSeq?: number): ModelMemoryManifestRecord | undefined {
  const row = sourceUserSeq === undefined
    ? memoryRows(sessionId)[0]
    : latest({ sessionId, sourceUserSeq });
  if (!row || !readable(row.data)) return undefined;
  const data = row.data as Record<string, unknown>;
  return {
    sessionId,
    sourceUserSeq: Number(data.sourceUserSeq),
    version: data.version as 1 | 2,
    recordedAt: String(row.createdAt ?? ''),
    ...(typeof data.responseId === 'string' ? { responseId: data.responseId } : {}),
    ...(typeof data.coreSha === 'string' ? { coreSha: data.coreSha } : {}),
    ...(data.totals && typeof data.totals === 'object' ? { totals: data.totals as ModelMemoryManifestRecord['totals'] } : {}),
    manifest: Array.isArray(data.manifest) ? data.manifest as ModelMemoryManifestEntry[] : [],
  };
}
