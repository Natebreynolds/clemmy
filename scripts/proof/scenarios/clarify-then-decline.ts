/**
 * Two-turn conversational-authority proof: Clem asks one explicit clarification
 * before a local write, the user declines, and Clem acknowledges naturally
 * without re-running discovery or exposing the declined task's tool surface.
 * Everything lives in the disposable proof home.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  narrationCheck,
  openHarnessDb,
  reportBackCheck,
  sessionMetrics,
  stormCheck,
} from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';

interface ProofEvent {
  seq: number;
  type: string;
  data_json: string;
}

function sessionEvents(daemon: DaemonHandle, sessionId: string, afterSeq = 0): ProofEvent[] {
  const db = openHarnessDb(daemon.home);
  const rows = db.prepare(
    'SELECT seq, type, data_json FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC',
  ).all(sessionId, afterSeq) as ProofEvent[];
  db.close();
  return rows;
}

function eventData(event: ProofEvent): Record<string, unknown> {
  try {
    const parsed = JSON.parse(event.data_json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

interface AwaitingQuestion {
  question: string;
  options: string[];
  purpose: string | null;
}

function awaitingQuestions(events: ProofEvent[]): AwaitingQuestion[] {
  return events
    .filter((event) => event.type === 'awaiting_user_input')
    .flatMap((event) => {
      const data = eventData(event);
      if (typeof data.question !== 'string' || !data.question.trim()) return [];
      return [{
        question: data.question,
        options: Array.isArray(data.options)
          ? data.options.filter((option): option is string => typeof option === 'string')
          : [],
        purpose: typeof data.purpose === 'string' ? data.purpose : null,
      }];
    });
}

function binaryClarification(question: AwaitingQuestion): boolean {
  const optionText = question.options.join('\n');
  const choiceText = optionText || question.question;
  return question.purpose === 'clarification'
    && /(?:^|\b)(?:yes|go ahead|create)(?:\b|$)/i.test(choiceText)
    && /(?:^|\b)(?:no|don['’]?t|do not|skip)(?:\b|$)/i.test(choiceText);
}

/** Protect truthfulness without prescribing tone, wording, or whether Clem
 * offers an ordinary conversational follow-up. */
export function declineReplyIsTruthful(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (/\b(?:I|we)(?:['’]ve| have)?\s+(?:already\s+)?(?:created|wrote|saved)\b/i.test(normalized)) return false;
  if (/\b(?:note|file)\s+(?:was|has been)\s+(?:created|written|saved)\b/i.test(normalized)) return false;
  return true;
}

export const clarifyThenDecline: ScenarioDef = {
  name: 'clarify-then-decline',
  summary: 'clarification -> natural decline acknowledgement with zero rediscovery or tools',
  routeExpectation: 'exact-brain',
  expectedModelTurns: 2,
  async run(daemon: DaemonHandle) {
    const sessionId = `proof-decline-${Date.now().toString(36)}`;
    const relativeTarget = path.join('proof', 'clarify-then-decline.md');
    const target = path.join(daemon.home, relativeTarget);
    mkdirSync(path.dirname(target), { recursive: true });

    // The first synchronous desktop turn owns session creation. The durable
    // accepted ingress intentionally rejects arbitrary unknown session ids;
    // use it for the continuation only, once the exact session exists.
    const turn1 = await daemon.chat(
      `I may want a local cancellation note created at the exact workspace-relative path ${JSON.stringify(relativeTarget)}. `
      + 'The only unresolved choice is whether I want the note created at all. Before creating or modifying anything, '
      + 'ask one concise clarification in your natural voice using ask_user_question with purpose clarification and two explicit choices: one yes/create choice and one no/do-not-create choice. '
      + 'Do not create the file until I answer, and do not substitute an approval or background offer for the clarification.',
      sessionId,
      300_000,
    );
    const firstEvents = sessionEvents(daemon, sessionId);
    const cutoff = firstEvents.at(-1)?.seq ?? 0;
    const firstQuestions = awaitingQuestions(firstEvents);
    const existedAfterQuestion = existsSync(target);

    const turn2 = await daemon.acceptedChat('No.', sessionId, 300_000);
    const secondEvents = sessionEvents(daemon, sessionId, cutoff);
    const secondTools = secondEvents.filter((event) => event.type === 'tool_called');
    const secondQuestions = awaitingQuestions(secondEvents);
    const approvalEvents = secondEvents.filter((event) => event.type === 'approval_requested');
    const primerEvents = secondEvents.filter((event) => event.type === 'turn_memory_primer');
    const primer = primerEvents.at(-1) ? eventData(primerEvents.at(-1)!) : null;
    const contextPacketEvents = secondEvents.filter((event) => event.type === 'agent_context_packet');
    const contextPacket = contextPacketEvents.at(-1) ? eventData(contextPacketEvents.at(-1)!) : null;
    const capabilityEvents = secondEvents.filter((event) => event.type === 'capability_resolution');
    const toolPolicyEvents = secondEvents.filter((event) => event.type === 'tool_policy_resolved');
    const toolSearchEvents = secondEvents.filter((event) => event.type === 'tool_search_scope');
    const toolJitEvents = secondEvents.filter((event) => event.type === 'tool_jit_scope');
    const scopeEvents = secondEvents.filter((event) => event.type === 'mcp_tool_scope');
    const scope = scopeEvents.at(-1) ? eventData(scopeEvents.at(-1)!) : null;
    const scopeServers = Array.isArray(scope?.allowedServerSlugs) ? scope.allowedServerSlugs : [];
    const remainedAbsent = !existsSync(target);

    const checks: Check[] = [
      { name: 'turn 1 HTTP 200', pass: turn1.httpStatus === 200, detail: `status ${turn1.httpStatus}` },
      {
        name: 'turn 1 asks one typed binary clarification without prescribing wording',
        pass: firstQuestions.length === 1 && binaryClarification(firstQuestions[0]!),
        detail: `questions ${JSON.stringify(firstQuestions)}; reply ${turn1.text.slice(0, 180)}`,
      },
      {
        name: 'the declined artifact is never created',
        pass: !existedAfterQuestion && remainedAbsent,
        detail: `after question=${existedAfterQuestion}; after decline=${!remainedAbsent}`,
      },
      { name: 'turn 2 durable continuation accepted', pass: turn2.httpStatus === 202, detail: `status ${turn2.httpStatus}` },
      reportBackCheck(turn2.text),
      narrationCheck(turn2.text),
      stormCheck(daemon.log()),
      {
        name: 'decline receives a non-empty truthful terminal reply without reopening the question',
        pass: declineReplyIsTruthful(turn2.text)
          && secondQuestions.length === 0
          && approvalEvents.length === 0,
        detail: turn2.text.slice(0, 240),
      },
      {
        name: 'decline performs zero tool calls',
        pass: secondTools.length === 0,
        detail: secondTools.length === 0
          ? 'none'
          : secondTools.map((event) => String(eventData(event).tool ?? 'unknown')).join(', '),
      },
      {
        name: 'decline skips the query primer using literal B',
        pass: primerEvents.length === 1
          && primer?.queryPreview === 'No.'
          && primer?.skippedReason === 'declined_continuation'
          && Number(primer?.hitCount ?? -1) === 0
          && primer?.injected === false,
        detail: primer ? JSON.stringify(primer) : `primer events ${primerEvents.length}`,
      },
      {
        name: 'decline explicitly skips semantic enrichment',
        pass: contextPacketEvents.length === 1
          && contextPacket?.semanticEnrichmentSkippedReason === 'declined_continuation'
          && capabilityEvents.length === 0,
        detail: JSON.stringify({
          contextPacketEvents: contextPacketEvents.length,
          skippedReason: contextPacket?.semanticEnrichmentSkippedReason ?? null,
          capabilityResolutionEvents: capabilityEvents.length,
        }),
      },
      {
        name: 'decline advertises zero local schemas and performs no tool-surface acquisition',
        pass: toolPolicyEvents.length >= 1
          && toolPolicyEvents.every((event) => {
            const data = eventData(event);
            return Number(data.outputCount ?? -1) === 0
              && data.shortCircuitReason === 'declined_continuation'
              && data.semanticAcquisitionSkipped === true
              && data.schemaWarmSkipped === true
              && Number(data.advertisedSchemaCount ?? -1) === 0
              && Number(data.catalogCount ?? -1) === 0;
          })
          && toolSearchEvents.length === 0
          && toolJitEvents.length === 0,
        detail: JSON.stringify({
          toolPolicies: toolPolicyEvents.map((event) => eventData(event)),
          toolSearchEvents: toolSearchEvents.length,
          toolJitEvents: toolJitEvents.length,
        }),
      },
      {
        name: 'decline exposes zero native external MCP authority',
        pass: scopeEvents.length === 1
          && scope != null
          && scope.allowAll === false
          && Number(scope.maxTools ?? -1) === 0
          && scopeServers.length === 0,
        detail: scope ? JSON.stringify(scope) : `mcp_tool_scope events ${scopeEvents.length}`,
      },
    ];

    let metrics = null;
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, sessionId);
      db.close();
    } catch { /* metrics are supplementary */ }

    return {
      checks,
      latency: [
        { wallMs: turn1.wallMs, ttftMs: metrics?.latency[0]?.ttftMs ?? null },
        { wallMs: turn2.wallMs, ttftMs: metrics?.latency[1]?.ttftMs ?? null },
      ],
      sessionId,
      metrics: metrics
        ? {
            turns: metrics.turns,
            toolCallTotal: metrics.toolCallTotal,
            toolCalls: metrics.toolCalls,
            declineWallMs: turn2.wallMs,
          }
        : { declineWallMs: turn2.wallMs },
    };
  },
};
