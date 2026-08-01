/**
 * Read a harness eventlog session back into a clean user/assistant
 * transcript for display in the desktop Conversations UI.
 *
 * The legacy console implemented this extraction inline in the browser
 * (`humanHarnessText` in console.ts). This is the shared server-side
 * version so the unified `/api/console/sessions/:id` endpoint and any UI
 * agree on exactly one rendering of harness history.
 */
import type { UnifiedSessionTurn } from '../../types.js';
import { listEvents } from './eventlog.js';
import {
  publicCompletionText,
  publicReplyText,
  publicUserInputText,
  validTypedCompletionPresentation,
} from './public-presentation.js';

/**
 * Coerce a harness event payload into the human-facing reply text.
 * `conversation_completed` data can be a string, a JSON-string, or an
 * object with `reply`/`summary` — unwrap all three to the user-visible
 * text, falling back to `fallback`.
 */
export function humanHarnessText(value: unknown, fallback = ''): string {
  if (value == null) return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    return publicCompletionText(obj, fallback);
  }
  const text = String(value).trim();
  if (!text) return fallback;
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object') return humanHarnessText(parsed, fallback);
    } catch {
      // Not JSON after all; fall through to the raw text.
    }
  }
  return publicReplyText(text, fallback);
}

/**
 * Reconstruct an ordered user/assistant transcript from a harness
 * session's events. User turns come from `user_input_received` (data.text);
 * assistant turns from `conversation_completed` (data.reply ?? data.summary).
 * Empty assistant turns (reason-only completions) are skipped.
 *
 * Parse-exhaustion recovery (respond-bridge): a `conversation_completed` with
 * reason 'no_structured_output' (the internal "couldn't be structured" apology)
 * that is later followed by a `conversation_superseded` marker is dropped — the
 * recovered reply from the next brain is the ONE final answer the user sees. A
 * no_structured_output completion with NO superseding marker (recovery disabled
 * or unavailable) is a genuine dead end and still renders; the sole reply is
 * never silently dropped.
 */
export function reconstructHarnessTranscript(sessionId: string, limit = 1000): UnifiedSessionTurn[] {
  const events = listEvents(sessionId, {
    types: ['user_input_received', 'conversation_completed', 'conversation_superseded'],
    limit,
  });
  // Pair each `conversation_superseded` marker with the nearest preceding
  // un-claimed no_structured_output completion (the marker is appended right
  // after its apology, before the recovery hop). Only that specific apology is
  // suppressed, so a later independent apology in the same session still renders.
  const supersededIdx = new Set<number>();
  for (let i = 0; i < events.length; i++) {
    if (events[i].type !== 'conversation_superseded') continue;
    for (let j = i - 1; j >= 0; j--) {
      const prev = events[j];
      if (prev.type === 'conversation_completed'
        && prev.data.reason === 'no_structured_output'
        && !supersededIdx.has(j)) {
        supersededIdx.add(j);
        break;
      }
    }
  }
  type SourceRecord = {
    key: string;
    event: (typeof events)[number];
    userText: string;
  };
  type AssistantTurn = { seq: number; text: string; createdAt: string };
  type Unit = { order: number; turns: UnifiedSessionTurn[] };
  const sourceKey = (ownerSessionId: string, seq: number): string => `${ownerSessionId}:${seq}`;
  const positiveSeq = (value: unknown): number | null => (
    Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null
  );
  const claimsTyped = (data: Record<string, unknown>): boolean => (
    Object.prototype.hasOwnProperty.call(data, 'presentation')
      || Object.prototype.hasOwnProperty.call(data, 'turnOutcome')
  );

  const sources = new Map<string, SourceRecord>();
  for (const event of events) {
    if (event.type !== 'user_input_received') continue;
    const key = sourceKey(event.sessionId, event.seq);
    sources.set(key, {
      key,
      event,
      userText: event.data.synthetic === true ? '' : publicUserInputText(event.data),
    });
  }

  // Pair typed terminals by the exact accepted event and elect the durable
  // first writer. This deliberately ignores physical attempt/run identity.
  const assistantBySource = new Map<string, AssistantTurn>();
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.type !== 'conversation_completed' || supersededIdx.has(i)) continue;
    const presentation = validTypedCompletionPresentation(event.data, event.sessionId);
    if (!presentation) continue;
    const key = sourceKey(event.sessionId, presentation.identity.sourceUserSeq);
    if (!sources.has(key)) continue;
    const prior = assistantBySource.get(key);
    if (!prior || event.seq < prior.seq) {
      assistantBySource.set(key, {
        seq: event.seq,
        text: presentation.text,
        createdAt: event.createdAt,
      });
    }
  }

  const orphanAssistants: Unit[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.type !== 'conversation_completed'
      || supersededIdx.has(i)
      || claimsTyped(event.data)) continue;
    const text = humanHarnessText(event.data, '');
    if (!text) continue;
    const exactSeq = positiveSeq(event.data.sourceUserSeq);
    if (exactSeq !== null
      && assistantBySource.has(sourceKey(event.sessionId, exactSeq))) {
      continue;
    }
    let source = exactSeq === null
      ? null
      : sources.get(sourceKey(event.sessionId, exactSeq)) ?? null;
    if (!source) {
      const candidates = [...sources.values()].filter((candidate) => (
        candidate.event.sessionId === event.sessionId
        && candidate.event.turn === event.turn
        && candidate.event.seq < event.seq
        && !assistantBySource.has(candidate.key)
      ));
      if (candidates.length === 1) [source] = candidates;
      else if (candidates.length === 0) {
        // Some legacy relays incremented the numeric turn independently from
        // the accepted chat row. Fall back only when one visible human source
        // is possible; hidden synthetic edges never borrow that association.
        const visibleCandidates = [...sources.values()].filter((candidate) => (
          candidate.event.sessionId === event.sessionId
          && candidate.event.seq < event.seq
          && candidate.userText.length > 0
          && !assistantBySource.has(candidate.key)
        ));
        if (visibleCandidates.length === 1) [source] = visibleCandidates;
      }
    }
    if (source) {
      assistantBySource.set(source.key, {
        seq: event.seq,
        text,
        createdAt: event.createdAt,
      });
    } else {
      orphanAssistants.push({
        order: event.seq,
        turns: [{ role: 'assistant', text, createdAt: event.createdAt }],
      });
    }
  }

  const settled: Unit[] = [...orphanAssistants];
  const unpaired: Unit[] = [];
  for (const source of sources.values()) {
    const assistant = assistantBySource.get(source.key);
    const userTurns: UnifiedSessionTurn[] = source.userText
      ? [{ role: 'user', text: source.userText, createdAt: source.event.createdAt }]
      : [];
    if (assistant) {
      settled.push({
        order: source.event.seq,
        turns: [
          ...userTurns,
          { role: 'assistant', text: assistant.text, createdAt: assistant.createdAt },
        ],
      });
    } else if (userTurns.length > 0) {
      unpaired.push({ order: source.event.seq, turns: userTurns });
    }
  }
  settled.sort((left, right) => left.order - right.order);
  unpaired.sort((left, right) => left.order - right.order);
  return [...settled, ...unpaired].flatMap((unit) => unit.turns);
}

/** The most recent meaningful turn text, for a list preview. Empty if none. */
export function harnessPreview(sessionId: string): string {
  const events = listEvents(sessionId, {
    types: ['user_input_received', 'conversation_completed'],
    limit: 1,
    desc: true,
  });
  const latest = events[0];
  if (!latest) return '';
  if (latest.type === 'user_input_received') {
    return publicUserInputText(latest.data);
  }
  return humanHarnessText(latest.data, '');
}
