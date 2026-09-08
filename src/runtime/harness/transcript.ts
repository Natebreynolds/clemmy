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
  PUBLIC_RUN_FAILURE_TEXT,
  publicCompletionText,
  publicReplyText,
  publicUserInputText,
  validTypedCompletionPresentation,
  publicPlanArtifactRef,
  publicTaskMode,
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
    types: [
      'user_input_received',
      'conversation_completed',
      'conversation_superseded',
      // Her mid-task words replay too: the point of a check-in is that
      // someone who walked away can reopen the session and read it.
      'conversation_check_in',
      'plan_revision_published',
    ],
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
  type AssistantTurn = { seq: number; text: string; createdAt: string; planProposalId?: string; planArtifactRef?: UnifiedSessionTurn['planArtifactRef'] };
  type Unit = { order: number; turns: UnifiedSessionTurn[] };
  const sourceKey = (ownerSessionId: string, seq: number): string => `${ownerSessionId}:${seq}`;
  const positiveSeq = (value: unknown): number | null => (
    Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null
  );
  const claimsTyped = (data: Record<string, unknown>): boolean => (
    Object.prototype.hasOwnProperty.call(data, 'presentation')
      || Object.prototype.hasOwnProperty.call(data, 'turnOutcome')
  );
  const planProposalIdFrom = (data: Record<string, unknown>): string | undefined => {
    const value = typeof data.planProposalId === 'string' ? data.planProposalId.trim() : '';
    return /^plan-[a-z0-9][a-z0-9_-]{0,119}$/i.test(value) ? value : undefined;
  };

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

  // Publication is already durable while the final Plan reply may still be
  // running. Reopen keeps its exact review card without inventing a terminal.
  const publishedPlans = new Map<string, { ref: NonNullable<UnifiedSessionTurn['planArtifactRef']>; createdAt: string; text: string }>();
  for (const event of events) {
    if (event.type !== 'plan_revision_published' || event.role !== 'host') continue;
    const seq = positiveSeq(event.data.sourceUserSeq);
    const ref = publicPlanArtifactRef(event.data.planArtifactRef);
    if (!seq || !ref) continue;
    const key = sourceKey(event.sessionId, seq);
    const owner = sources.get(key);
    if (!owner || owner.event.id !== event.parentEventId || event.seq <= owner.event.seq
      || publicTaskMode(owner.event.data.taskMode)?.kind !== 'plan') continue;
    publishedPlans.set(key, { ref, createdAt: event.createdAt,
      text: event.data.readiness === 'ready' ? 'Plan ready for review.' : 'Plan draft available for review.' });
  }

  // Her check-ins, grouped by the source turn they belong to. The writer binds
  // each one to its exact real user source, so this needs no heuristics.
  const checkInsBySource = new Map<string, UnifiedSessionTurn[]>();
  for (const event of events) {
    if (event.type !== 'conversation_check_in') continue;
    const text = typeof event.data.text === 'string' ? event.data.text.trim() : '';
    const exactSeq = positiveSeq(event.data.sourceUserSeq);
    if (!text || exactSeq === null) continue;
    const key = sourceKey(event.sessionId, exactSeq);
    if (!sources.has(key)) continue;
    const list = checkInsBySource.get(key) ?? [];
    list.push({ role: 'assistant', text, createdAt: event.createdAt, checkIn: true });
    checkInsBySource.set(key, list);
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
        planProposalId: planProposalIdFrom(event.data),
        planArtifactRef: publicPlanArtifactRef(event.data.planArtifactRef),
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
        planProposalId: planProposalIdFrom(event.data),
      });
    } else {
      orphanAssistants.push({
        order: event.seq,
        turns: [{
          role: 'assistant',
          text,
          createdAt: event.createdAt,
          planProposalId: planProposalIdFrom(event.data),
        }],
      });
    }
  }

  const settled: Unit[] = [...orphanAssistants];
  const unpaired: Unit[] = [];
  for (const source of sources.values()) {
    const assistant = assistantBySource.get(source.key);
    const publishedPlan = publishedPlans.get(source.key);
    const userTurns: UnifiedSessionTurn[] = source.userText
      ? [{ role: 'user', text: source.userText, createdAt: source.event.createdAt,
        ...(publicTaskMode(source.event.data.taskMode) ? { taskMode: publicTaskMode(source.event.data.taskMode) } : {}) }]
      : [];
    if (assistant) {
      // A DAEMON-DRIVEN turn (synthetic source — an outcome relay the user
      // never typed) that FAILED renders nothing: painting "Something went
      // wrong on that turn" over a task whose outcome was already delivered
      // passively reads as the work failing (live 2026-08-04, a rate-limited
      // relay). The deferred re-fire speaks the real outcome once the brain
      // recovers; a successful relay reply still renders normally.
      if (userTurns.length === 0 && assistant.text === PUBLIC_RUN_FAILURE_TEXT) continue;
      settled.push({
        order: source.event.seq,
        turns: [
          ...userTurns,
          ...(checkInsBySource.get(source.key) ?? []),
          {
            role: 'assistant',
            text: assistant.text,
            createdAt: assistant.createdAt,
            planProposalId: assistant.planProposalId,
            ...(assistant.planArtifactRef || publishedPlan ? { planArtifactRef: assistant.planArtifactRef ?? publishedPlan!.ref } : {}),
          },
        ],
      });
    } else if (userTurns.length > 0) {
      // No reply yet — the turn is still running. This is exactly the case the
      // feature exists for: reopening mid-task must show what she has said so
      // far, not an empty wait.
      unpaired.push({
        order: source.event.seq,
        turns: [...userTurns, ...(checkInsBySource.get(source.key) ?? []),
          ...(publishedPlan ? [{ role: 'assistant' as const, text: publishedPlan.text,
            createdAt: publishedPlan.createdAt, planArtifactRef: publishedPlan.ref }] : [])],
      });
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
