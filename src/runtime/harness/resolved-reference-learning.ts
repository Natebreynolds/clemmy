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
 *  - of the strings that record carries, a typed check picks the one the
 *    request's words called it;
 *  - the request used that name.
 *
 * A record also carries strings that are not the value's name (a title beside
 * an owner, a subject beside a recipient). Sharing a record is not naming, so
 * that one judgement is a model's, and without it nothing is kept.
 *
 * What is kept carries a grade and what the grade rests on. Learning is not
 * all or nothing: live 2026-09-29 the check leaned to the right name at 0.72
 * against a bar of 0.80, and the whole resolution was thrown away.
 *  - confirmed: the check was sure, or it leaned to the name and the owner
 *    approved the call that used the value;
 *  - provisional: the check leaned to the name and nothing else spoke for it.
 *    It is kept as a lead to look up again, worded as one, and it never
 *    replaces a confirmed resolution;
 *  - under a lean, or with no answer, nothing is kept.
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
import { nameResolvedValueWithJev, RESOLUTION_NAME_LEAN, RESOLUTION_NAME_SURE } from '../jev/control-plane.js';
import { judgeEvidenceJsonValue } from './judge-evidence-tools.js';
import { scanSecrets } from './guardrails.js';
import { actionTopologyRoleFor } from '../../tools/tool-registry.js';
import {
  defaultFactWriteScope, factsInExactScope, findActiveFactsByContentPrefix, rememberFact, supersedeFact,
} from '../../memory/facts.js';
import { personApprovalForCall } from './approved-call-evidence.js';

export interface SettledCall {
  tool: string;
  callId: string;
  mutating: boolean;
  /** The operation's own arguments, carrier removed. */
  args: unknown;
  result: unknown;
}

export type ResolutionGrade = 'confirmed' | 'provisional';

/** What a grade rests on. */
export interface ResolutionBasis {
  /** How sure the naming check was of the name, 0 to 1. */
  namingConfidence: number;
  /** Absent on a provisional resolution: nothing confirmed it. */
  confirmedBy?: 'naming_check' | 'owner_approval';
  /** The approval the owner gave, when that is what confirmed it. */
  approvalId?: string;
}

export interface ResolvedReference {
  grade: ResolutionGrade;
  basis: ResolutionBasis;
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

/** A result as its records. Many operations return their records as a JSON
 * document held in text, bare or inside a single-text response; it is read as
 * that document, the way a reviewer's evidence tools read it. Text that is
 * not a document stays text and carries no record. */
function recordsOf(result: unknown): unknown {
  try {
    return judgeEvidenceJsonValue({ text: typeof result === 'string' ? result : '', value: result });
  } catch {
    return result;
  }
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

/** Which of a record's strings the request's words called the value, and how
 * sure the reading is. No bar is applied by the reader. */
export type ReadName = (question: {
  operation: string; field: string; value: string; candidates: string[];
}) => Promise<{ name: string | null; confidence?: number } | null | undefined>;

/** Whether the owner approved the call that used this value, having been
 * shown it. Null when no such approval is on record. */
export type OwnerApproved = (input: { call: SettledCall; value: string }) => { approvalId: string } | null;

/** A value that was considered and not kept, and why. Never the value. */
export interface PassedOverResolution {
  operation: string;
  argument: string;
  reason: 'naming_unavailable' | 'naming_none' | 'naming_unsure' | 'name_not_in_request';
  namingConfidence?: number;
}

function graded(confidence: number, approved: { approvalId: string } | null): Pick<ResolvedReference, 'grade' | 'basis'> | null {
  if (confidence >= RESOLUTION_NAME_SURE) {
    return { grade: 'confirmed', basis: { namingConfidence: confidence, confirmedBy: 'naming_check' } };
  }
  if (confidence < RESOLUTION_NAME_LEAN) return null;
  // An approval alone confirms nothing about a name: the owner approved a
  // call, not a sentence about what its value is called. It counts only
  // beside a check that already leans to the same name.
  return approved
    ? { grade: 'confirmed', basis: { namingConfidence: confidence, confirmedBy: 'owner_approval', approvalId: approved.approvalId } }
    : { grade: 'provisional', basis: { namingConfidence: confidence } };
}

/** Resolutions a finished request's settled calls prove, each with its grade. */
export async function deriveResolvedReferences(input: {
  request: string;
  calls: readonly SettledCall[];
  readName: ReadName;
  ownerApproved?: OwnerApproved;
  /** Filled with what was considered and not kept. */
  passedOver?: PassedOverResolution[];
}): Promise<ResolvedReference[]> {
  const request = input.request.replace(/\s+/g, ' ').trim();
  if (!request) return [];
  const lowered = request.toLowerCase();
  const resolved: ResolvedReference[] = [];
  const seen = new Set<string>();
  // The same value is asked about once, whichever calls used it.
  const readings = new Map<string, Promise<{ name: string | null; confidence: number } | null>>();
  const pass = (call: SettledCall, argument: string, reason: PassedOverResolution['reason'], namingConfidence?: number): void => {
    input.passedOver?.push({ operation: call.tool, argument, reason, ...(namingConfidence === undefined ? {} : { namingConfidence }) });
  };
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
        for (const candidate of labelCandidatesFor([recordsOf(source.result)], leaf.value)) {
          if (!foundIn.has(candidate)) {
            foundIn.set(candidate, { tool: source.tool, callId: source.callId });
            candidates.push(candidate);
          }
        }
      }
      // Nothing the request said is among them: no question worth asking.
      if (!candidates.some((candidate) => namedInRequest(request, candidate))) continue;
      const asked = readings.get(leaf.value) ?? Promise.resolve()
        .then(() => input.readName({ operation: call.tool, field: leaf.path, value: leaf.value, candidates: candidates.slice(0, 20) }))
        .then((answer) => (answer ? { name: answer.name, confidence: Number.isFinite(answer.confidence) ? Number(answer.confidence) : 0 } : null))
        .catch(() => null);
      readings.set(leaf.value, asked);
      const reading = await asked;
      if (!reading) { pass(call, leaf.path, 'naming_unavailable'); continue; }
      const name = reading.name;
      const source = name ? foundIn.get(name) : undefined;
      if (!name || !source) { pass(call, leaf.path, 'naming_none', reading.confidence); continue; }
      if (!namedInRequest(request, name)) { pass(call, leaf.path, 'name_not_in_request', reading.confidence); continue; }
      let approved: { approvalId: string } | null = null;
      if (reading.confidence >= RESOLUTION_NAME_LEAN && reading.confidence < RESOLUTION_NAME_SURE) {
        try { approved = input.ownerApproved?.({ call, value: leaf.value }) ?? null; } catch { approved = null; }
      }
      const grade = graded(reading.confidence, approved);
      if (!grade) { pass(call, leaf.path, 'naming_unsure', reading.confidence); continue; }
      seen.add(key);
      resolved.push({
        ...grade,
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

const PROVISIONAL_MARK = ' (not confirmed: ';

export function resolvedReferenceContent(reference: ResolvedReference): string {
  const used = reference.effect === 'change' ? 'used in a change the provider accepted' : 'used in a read the provider answered';
  const found = `found in a ${reference.foundIn.tool} result`;
  if (reference.grade === 'provisional') {
    return `${resolvedReferenceLead(reference)}${reference.value}${PROVISIONAL_MARK}${used} once and ${found}, `
      + 'but that this is what the name refers to was not certain). Look it up again before using it.';
  }
  const by = reference.basis.confirmedBy === 'owner_approval'
    ? 'the owner approved the call that used it'
    : 'the name was checked against the record it came from';
  return `${resolvedReferenceLead(reference)}${reference.value} (confirmed: ${by}; ${used}; ${found}). `
    + 'Check it still holds before relying on it for something that cannot be undone.';
}

/** The grade a kept resolution was written with. One written before grades
 * existed was kept only on a sure naming check. */
export function resolvedReferenceGrade(content: string): ResolutionGrade {
  return content.includes(PROVISIONAL_MARK) ? 'provisional' : 'confirmed';
}

export interface LearnedResolution extends ResolvedReference {
  /** What happened to it in memory. `held`: a confirmed resolution for the
   * same name and argument stands, and a lead does not replace it. */
  outcome: 'kept' | 'replaced_earlier' | 'held';
}

/**
 * Keep what one finished, verified request resolved. Called only after the
 * same request's strategy was admitted as learned, so it inherits that
 * authority and adds none. A value that replaces an earlier one for the same
 * name and argument supersedes it; the earlier one stays in history. A
 * provisional resolution confirmed later is replaced by the confirmed one.
 */
export async function learnResolvedReferencesForAcceptedTask(input: {
  sessionId: string;
  sourceUserSeq: number;
  occurredAt?: string;
}, dependencies: { readName?: ReadName; ownerApproved?: OwnerApproved } = {}): Promise<{
  learned: number; superseded: number; held: number;
  references: LearnedResolution[]; passedOver: PassedOverResolution[];
}> {
  const request = acceptedRequestText(input.sessionId, input.sourceUserSeq);
  if (!request) return { learned: 0, superseded: 0, held: 0, references: [], passedOver: [] };
  const passedOver: PassedOverResolution[] = [];
  const derived = await deriveResolvedReferences({
    request, calls: settledCallsForSource(input), passedOver,
    readName: dependencies.readName
      ?? ((question) => nameResolvedValueWithJev({ ...question, request }, { sessionId: input.sessionId })
        .then((reading) => (reading.failedOpen ? null : reading))),
    ownerApproved: dependencies.ownerApproved
      ?? (({ call, value }) => personApprovalForCall({ ...input, callId: call.callId, value })),
  });
  let learned = 0;
  let superseded = 0;
  let held = 0;
  // A resolution is kept for the project and agent of the request that made
  // it, and is compared only with resolutions kept for the same.
  const keptFor = defaultFactWriteScope('reference', input.sessionId);
  const references: LearnedResolution[] = [];
  for (const reference of derived) {
    try {
      const content = resolvedReferenceContent(reference);
      const memory = {
        content,
        scope: keptFor,
        sessionId: input.sessionId,
        derivedFrom: { sessionId: input.sessionId, callId: reference.callId, tool: reference.operation },
        // Both ends are on receipts, but the world can change after them. A
        // lead is trusted as a lead.
        trustLevel: reference.grade === 'confirmed' ? 0.8 : 0.5,
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      };
      const standing = factsInExactScope(findActiveFactsByContentPrefix('reference', resolvedReferenceLead(reference)), keptFor);
      if (reference.grade === 'provisional'
        && standing.some((fact) => resolvedReferenceGrade(fact.content) === 'confirmed')) {
        held += 1;
        references.push({ ...reference, outcome: 'held' });
        continue;
      }
      const earlier = standing.filter((fact) => fact.content !== content);
      let replaced = 0;
      if (earlier.length > 0) {
        for (const fact of earlier) if (supersedeFact(fact.id, memory)) replaced += 1;
      } else {
        rememberFact({ kind: 'reference', ...memory });
      }
      superseded += replaced;
      learned += 1;
      references.push({ ...reference, outcome: replaced > 0 ? 'replaced_earlier' : 'kept' });
    } catch { /* memory stays additive */ }
  }
  return { learned, superseded, held, references, passedOver };
}
