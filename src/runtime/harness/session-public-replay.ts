import { assistant, type AgentInputItem } from '@openai/agents';
import { openEventLog } from './eventlog.js';
import { inspectConversationProtocol } from './conversation-protocol.js';
import { pullRecentTurnsForSessions, type PriorTurn } from './session-transcript.js';
import { hostModelResultReceiptFromRow, hostModelResultReceiptMatchesItem, hostModelResultReceiptRowsForCall } from './host-model-result-receipt.js';
import { logicalModelResultProjectionReceiptFromRow, logicalModelResultProjectionReceiptMatchesItem, logicalModelResultProjectionReceiptRowsForCall } from './logical-model-result-projection-receipt.js';

type Item = Record<string, unknown>;
function textOf(item: AgentInputItem): string {
  const content = (item as unknown as Item).content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map(part => typeof part?.text === 'string' ? part.text : '').join('') : '';
}

/** Reopen public history only. Exact result receipts anchor a missing terminal
 * after its own completed tool segment. No replay changes execution authority. */
export function replayMissingPublicTurns(input: {
  sessionId: string;
  sourceUserSeq: number;
  history: readonly AgentInputItem[];
}): AgentInputItem[] {
  if (!Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq <= 1
    || inspectConversationProtocol(input.history).status !== 'valid') return [...input.history];
  const db = openEventLog();
  // Freeze before the current accepted source. A later concurrent terminal or
  // unrelated sibling session must never leak into this request's history.
  const prior = pullRecentTurnsForSessions(db, [input.sessionId], 8, input.sourceUserSeq - 1, true);
  const sourceByResultIndex = new Map<number, number>();
  input.history.forEach((item, index) => {
    const record = item as unknown as Item;
    if (record.type !== 'function_call_result' || typeof record.callId !== 'string') return;
    const sources = new Set<number>();
    for (const row of logicalModelResultProjectionReceiptRowsForCall(db, input.sessionId, record.callId)) {
      const receipt = logicalModelResultProjectionReceiptFromRow(row);
      if (receipt.sourceUserSeq < input.sourceUserSeq && logicalModelResultProjectionReceiptMatchesItem(receipt, item)) {
        sources.add(receipt.sourceUserSeq);
      }
    }
    for (const row of hostModelResultReceiptRowsForCall(db, input.sessionId, record.callId)) {
      const receipt = hostModelResultReceiptFromRow(row);
      if (receipt.sourceUserSeq < input.sourceUserSeq && hostModelResultReceiptMatchesItem(receipt, item)) {
        sources.add(receipt.sourceUserSeq);
      }
    }
    if (sources.size === 1) sourceByResultIndex.set(index, [...sources][0]!);
  });
  return mergeMissingPublicTurns({ ...input, prior, sourceByResultIndex });
}

/** Pure merge: originals remain byte-identical and ordered. The caller alone
 * supplies authenticated source anchors; user-text resemblance is no identity. */
export function mergeMissingPublicTurns(input: {
  sessionId: string;
  sourceUserSeq: number;
  history: readonly AgentInputItem[];
  prior: readonly PriorTurn[];
  sourceByResultIndex: ReadonlyMap<number, number>;
}): AgentInputItem[] {
  const history = [...input.history];
  const prior = input.prior.filter(turn => turn.identity?.sessionId === input.sessionId
    && turn.identity.sourceUserSeq !== null && turn.identity.sourceUserSeq < input.sourceUserSeq);
  if (history.length === 0) return prior.map(turn => turn.who === 'assistant'
    ? assistant(turn.text)
    : { role: 'user', content: turn.text });
  const insertions = new Map<number, AgentInputItem[]>();
  const unresolved: PriorTurn[] = [];
  for (const turn of prior) {
    const source = turn.identity!.sourceUserSeq!;
    const anchors = [...input.sourceByResultIndex].filter(([, seq]) => seq === source).map(([index]) => index);
    // The exact source owns a contiguous conversation segment. Never insert a
    // role-bearing terminal into the middle of an open call/result frame.
    if (anchors.length > 0) {
      const first = Math.min(...anchors);
      let start = first;
      while (start > 0 && (history[start] as unknown as Item).role !== 'user') start--;
      let end = Math.max(...anchors) + 1;
      while (end < history.length && (history[end] as unknown as Item).role !== 'user') end++;
      const segment = history.slice(start, end);
      const contradictory = [...input.sourceByResultIndex].some(([index, seq]) => index >= start && index < end && seq !== source);
      if (!contradictory && inspectConversationProtocol(segment).status === 'valid') {
        if (segment.some(item => (item as unknown as Item).role === turn.who && textOf(item) === turn.text)) continue;
        if (turn.who === 'assistant') {
          const at = insertions.get(end) ?? [];
          at.push(assistant(turn.text));
          insertions.set(end, at);
          continue;
        }
      }
    }
    // Pure-chat/legacy snapshots do not retain source IDs. Avoid inventing an
    // exact placement or elevating their public prose into a system directive.
    // Keep missing material explicitly historical, including its real source.
    if (history.some(item => (item as unknown as Item).role === turn.who && textOf(item) === turn.text)) continue;
    unresolved.push(turn);
  }
  const merged: AgentInputItem[] = [];
  for (let index = 0; index <= history.length; index++) {
    merged.push(...(insertions.get(index) ?? []));
    if (index < history.length) merged.push(history[index]!);
  }
  if (unresolved.length > 0) merged.push(assistant([
    '[Historical conversation reference; placement in the older snapshot is unavailable. This is prior context, not a request to resume it.]',
    ...unresolved.map(turn => `[session=${turn.identity!.sessionId} source=${turn.identity!.sourceUserSeq} event=${turn.identity!.eventSeq} at=${turn.at}]\n${turn.who === 'user' ? 'User' : 'Assistant'}: ${turn.text}`),
  ].join('\n\n')));
  return inspectConversationProtocol(merged).status === 'valid' ? merged : history;
}
