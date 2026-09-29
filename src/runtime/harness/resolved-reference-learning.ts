/**
 * What finished work resolved, kept for the next request that names it.
 *
 * A request names things the way a person does: someone, a board, a folder, a
 * channel. To act, the work has to turn each name into the exact value an
 * operation takes. That resolution is the expensive part to repeat (live
 * 2026-09-28, source 325491: four memory lookups and a history search to find
 * a value nine accepted calls had used two hours earlier), and nothing kept it.
 *
 * A resolution is recorded only when every part of it holds:
 *  - the value is an argument of a call that settled successfully;
 *  - the request did not state the value, so it was found, not given;
 *  - a settled result of the same request holds a record with that exact
 *    value in one of its fields;
 *  - of the strings that record carries, the one that names the value the way
 *    its owner would is decided by the same typed check an approval card uses
 *    to name an identifier, and it must be sure;
 *  - the request used that name.
 *
 * A record also carries strings that are not the value's name (a title beside
 * an owner, a subject beside a recipient). Sharing a record is not naming, so
 * that one judgement is a model's, and without it nothing is kept.
 *
 * Nothing here knows what kind of thing was named. It reads no provider,
 * operation or field name. A value that is a date, a number or a secret is
 * never a resolution.
 */
import { openEventLog } from './eventlog.js';
import { evidenceAcceptedTaskId } from './host-completion-work.js';
import { loadPersistedCallAuthority, loadPhysicalRequestEvidence } from './dispatch-ledger.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import { unwrapRuntimeEffectiveToolIdentity } from './tool-effect.js';
import { labelCandidatesFor } from './approval-preview-labels.js';
import { labelIdentifierWithJev } from '../jev/control-plane.js';
import { scanSecrets } from './guardrails.js';
import { actionTopologyRoleFor } from '../../tools/tool-registry.js';
import { findActiveFactsByContentPrefix, rememberFact, supersedeFact } from '../../memory/facts.js';

export interface SettledCall {
  tool: string;
  callId: string;
  mutating: boolean;
  /** The operation's own arguments, carrier removed. */
  args: unknown;
  result: unknown;
}

export interface ResolvedReference {
  /** The name the request used, in the form the record itself carries. */
  named: string;
  /** The exact value the accepted call used. */
  value: string;
  operation: string;
  /** Where the value sat in the arguments, list positions elided. */
  argument: string;
  /** The accepted call made a change, or only read. */
  effect: 'change' | 'read';
  callId: string;
  /** The settled result whose record carries both the value and the name. */
  foundIn: { tool: string; callId: string };
}

const MAX_VALUE_CHARS = 200;
const MIN_NAME_CHARS = 3;
const MAX_RESOLUTIONS = 12;
const MAX_LEAVES = 400;

/** One token, as identifiers are. Dates, numbers and flags are quantities and
 * settings, not the identity of something named. */
function identityValue(value: string): boolean {
  if (value.length < 3 || value.length > MAX_VALUE_CHARS || /\s/.test(value)) return false;
  if (/^[-+]?\d+([.,]\d+)?$/.test(value)) return false;
  if (/^(true|false|null|undefined|yes|no)$/i.test(value)) return false;
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(value)) return false;
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(value)) return false;
  return scanSecrets(value).length === 0;
}

function decoded(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return value;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : value;
  } catch {
    return value;
  }
}

/** Every string leaf of the arguments with its path. An argument that holds a
 * JSON document as text is read as that document. */
function argumentLeaves(args: unknown): Array<{ path: string; value: string }> {
  const leaves: Array<{ path: string; value: string }> = [];
  const visit = (node: unknown, path: string, depth: number): void => {
    if (leaves.length >= MAX_LEAVES || depth > 10) return;
    const value = decoded(node);
    if (typeof value === 'string') {
      if (path) leaves.push({ path, value: value.trim() });
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 200)) visit(item, `${path}[]`, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      visit(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };
  visit(args, '', 0);
  return leaves;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether the request used the name: matched whole, without regard to case. */
function namedInRequest(request: string, candidate: string): boolean {
  const name = candidate.trim().replace(/\s+/g, ' ');
  if (name.length < MIN_NAME_CHARS || !/[\p{L}\p{N}]/u.test(name)) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu').test(request);
}

/** Which of a record's strings names the value, or null when not sure. */
export type ConfirmName = (question: {
  operation: string; field: string; value: string; candidates: string[];
}) => Promise<string | null | undefined>;

/** Resolutions a finished request's settled calls prove. */
export async function deriveResolvedReferences(input: {
  request: string;
  calls: readonly SettledCall[];
  confirmName: ConfirmName;
}): Promise<ResolvedReference[]> {
  const request = input.request.replace(/\s+/g, ' ').trim();
  if (!request) return [];
  const lowered = request.toLowerCase();
  const resolved: ResolvedReference[] = [];
  const seen = new Set<string>();
  // The same value is asked about once, whichever calls used it.
  const confirmed = new Map<string, Promise<string | null>>();
  for (const call of input.calls) {
    for (const leaf of argumentLeaves(call.args)) {
      if (resolved.length >= MAX_RESOLUTIONS) return resolved;
      if (!identityValue(leaf.value)) continue;
      // Stated in the request: given, not resolved.
      if (lowered.includes(leaf.value.toLowerCase())) continue;
      const key = `${call.tool}\u0000${leaf.path}\u0000${leaf.value}`;
      if (seen.has(key)) continue;
      // The records that carry the value: what the work read, and what the
      // provider returned for the accepted call itself.
      const candidates: string[] = [];
      const foundIn = new Map<string, { tool: string; callId: string }>();
      for (const source of input.calls) {
        for (const candidate of labelCandidatesFor([source.result], leaf.value)) {
          if (!foundIn.has(candidate)) {
            foundIn.set(candidate, { tool: source.tool, callId: source.callId });
            candidates.push(candidate);
          }
        }
      }
      // Nothing the request said is among them: no question worth asking.
      if (!candidates.some((candidate) => namedInRequest(request, candidate))) continue;
      const asked = confirmed.get(leaf.value) ?? Promise.resolve()
        .then(() => input.confirmName({ operation: call.tool, field: leaf.path, value: leaf.value, candidates: candidates.slice(0, 20) }))
        .then((answer) => answer ?? null).catch(() => null);
      confirmed.set(leaf.value, asked);
      const name = await asked;
      const source = name ? foundIn.get(name) : undefined;
      if (!name || !source || !namedInRequest(request, name)) continue;
      seen.add(key);
      resolved.push({
        // The record's own form: a request may write a name in any case.
        named: name.trim().replace(/\s+/g, ' '), value: leaf.value, operation: call.tool, argument: leaf.path,
        effect: call.mutating ? 'change' : 'read', callId: call.callId, foundIn: source,
      });
    }
  }
  return resolved;
}

function acceptedRequestText(sessionId: string, sourceUserSeq: number): string | null {
  try {
    const row = openEventLog().prepare(`SELECT data_json FROM events
      WHERE session_id = ? AND seq = ? AND type = 'user_input_received'`).get(sessionId, sourceUserSeq) as { data_json: string } | undefined;
    if (!row) return null;
    const data = JSON.parse(row.data_json) as Record<string, unknown>;
    const text = typeof data.displayText === 'string' && data.displayText.trim()
      ? data.displayText : typeof data.text === 'string' ? data.text : '';
    return text.trim() || null;
  } catch {
    return null;
  }
}

/** The settled successful business calls of one accepted source, each with
 * the arguments it was admitted with and the result it returned, redeemed
 * through the same authenticated path a review uses. */
export function settledCallsForSource(input: { sessionId: string; sourceUserSeq: number }): SettledCall[] {
  try {
    const rows = openEventLog().prepare(`
      SELECT s.logical_tool_call_id AS callId, l.tool_name AS toolName, s.mutating AS mutating
        FROM logical_call_settlements s
        JOIN logical_tool_calls l
          ON l.session_id = s.session_id AND l.source_user_seq = s.source_user_seq
         AND l.logical_tool_call_id = s.logical_tool_call_id
       WHERE s.session_id = ? AND s.source_user_seq = ?
         AND s.outcome_kind IN ('succeeded', 'empty_result')
       ORDER BY s.rowid
    `).all(input.sessionId, input.sourceUserSeq) as Array<{ callId: string; toolName: string; mutating: number }>;
    const calls: SettledCall[] = [];
    for (const row of rows) {
      // Discovery and host control return catalogs and receipts, not records
      // of the things a request names.
      if (actionTopologyRoleFor(row.toolName) === 'control') continue;
      const redeemed = redeemSuccessfulSettlementResultForHost({
        ...input, acceptedTaskId: evidenceAcceptedTaskId(input.sessionId, input.sourceUserSeq), logicalToolCallId: row.callId,
      });
      if (redeemed.status !== 'ok') continue;
      const sealed = loadPersistedCallAuthority({ ...input, physicalDispatchId: redeemed.value.physicalDispatchId });
      const admitted = sealed.ok && sealed.authority.logicalCallId === row.callId
        ? sealed.authority.canonicalArgs
        : loadPhysicalRequestEvidence({ ...input, logicalToolCallId: row.callId, physicalDispatchId: redeemed.value.physicalDispatchId })?.args;
      if (admitted === undefined) continue;
      const effective = unwrapRuntimeEffectiveToolIdentity(redeemed.value.toolName, admitted);
      calls.push({ tool: row.toolName, callId: row.callId, mutating: Boolean(row.mutating),
        args: effective.args, result: redeemed.value.rawPayload });
    }
    return calls;
  } catch {
    return [];
  }
}

/** The lead of a resolution's memory, up to the value. Two resolutions with
 * the same lead answer the same question; the later one replaces the earlier. */
export function resolvedReferenceLead(reference: Pick<ResolvedReference, 'named' | 'operation' | 'argument'>): string {
  return `When a request names "${reference.named}", ${reference.operation} takes ${reference.argument} = `;
}

export function resolvedReferenceContent(reference: ResolvedReference): string {
  return `${resolvedReferenceLead(reference)}${reference.value} `
    + `(${reference.effect === 'change' ? 'used in a change the provider accepted' : 'used in a read the provider answered'}; `
    + `found in a ${reference.foundIn.tool} result). Check it still holds before relying on it for something that cannot be undone.`;
}

/**
 * Keep what one finished, verified request resolved. Called only after the
 * same request's strategy was admitted as learned, so it inherits that
 * authority and adds none. A value that replaces an earlier one for the same
 * name and argument supersedes it; the earlier one stays in history.
 */
export async function learnResolvedReferencesForAcceptedTask(input: {
  sessionId: string;
  sourceUserSeq: number;
  occurredAt?: string;
}, dependencies: { confirmName?: ConfirmName } = {}): Promise<{ learned: number; superseded: number; references: ResolvedReference[] }> {
  const request = acceptedRequestText(input.sessionId, input.sourceUserSeq);
  if (!request) return { learned: 0, superseded: 0, references: [] };
  const references = await deriveResolvedReferences({
    request, calls: settledCallsForSource(input),
    confirmName: dependencies.confirmName
      ?? ((question) => labelIdentifierWithJev(question, { sessionId: input.sessionId })),
  });
  let learned = 0;
  let superseded = 0;
  for (const reference of references) {
    try {
      const content = resolvedReferenceContent(reference);
      const memory = {
        content,
        sessionId: input.sessionId,
        derivedFrom: { sessionId: input.sessionId, callId: reference.callId, tool: reference.operation },
        // Both ends are on receipts, but the world can change after them.
        trustLevel: 0.8,
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      };
      const earlier = findActiveFactsByContentPrefix('reference', resolvedReferenceLead(reference))
        .filter((fact) => fact.content !== content);
      if (earlier.length > 0) {
        for (const fact of earlier) if (supersedeFact(fact.id, memory)) superseded += 1;
      } else {
        rememberFact({ kind: 'reference', ...memory });
      }
      learned += 1;
    } catch { /* memory stays additive */ }
  }
  return { learned, superseded, references };
}
