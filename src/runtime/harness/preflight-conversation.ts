/**
 * One tool-less, model-authored conversational beat before consequential work.
 *
 * The openness judge owns the decision. This module only gives that decision a
 * natural voice:
 *   - OPEN asks one concrete question and owns a typed needs-input terminal;
 *   - SETTLED briefly reflects the request, then returns to the execution brain
 *     in the same turn without publishing a terminal.
 */
import { Agent, Runner } from '@openai/agents';
import type { Model } from '@openai/agents-core';
import { appendEvent, listEvents } from './eventlog.js';
import { commitTurnOutcome } from './delivery-committer.js';
import { publicConversationPreambleData } from './public-presentation.js';
import type { TurnOpenness } from './turn-openness.js';
import {
  assertPublicPresentationText,
  presentationEventFromCompletionData,
  turnOutcomeId,
  type PresentationEvent,
  type TurnIdentity,
} from './turn-outcome.js';
import type { TurnPreflightDecision } from './turn-control.js';

const MAX_CONVERSATION_CONTEXT_CHARS = 8_000;
const MAX_MEMORY_CONTEXT_CHARS = 6_000;
const MAX_CAPABILITY_CONTEXT_CHARS = 8_000;
const MAX_OPEN_DIMENSION_CHARS = 240;
/** A conversational acknowledgement must never become the long pole before
 * execution. The independent openness pass has its own 4s ceiling; keep this
 * one-line voice pass comparably bounded and degrade settled turns to silence. */
export const DEFAULT_PREFLIGHT_CONVERSATION_AUTHOR_TIMEOUT_MS = 6_000;

/** Exact durable source for questions selected by the openness judge. */
export const PREFLIGHT_OPENNESS_SOURCE = 'preflight_openness';

interface PreflightConversationPacketBaseV1 {
  version: 1;
  objective: string;
  decision: TurnPreflightDecision;
  conversationContext: string;
  memoryContext: string;
  capabilityContext: string;
}

export type PreflightConversationPacketV1 =
  | (PreflightConversationPacketBaseV1 & {
      kind: 'ask';
      openness: TurnOpenness;
    })
  | (PreflightConversationPacketBaseV1 & {
      kind: 'proceed';
      openness: null;
    });

export interface PreflightConversationPort {
  render(packet: PreflightConversationPacketV1): Promise<string>;
}

export type PreflightConversationDisposition =
  | {
      kind: 'ask';
      presentation: PresentationEvent;
    }
  | {
      kind: 'proceed';
      /** Model-authored acknowledgement to prepend to same-turn execution. */
      preamble: string;
    };

interface OneTurnRunner {
  run(
    agent: Agent<any, any>,
    prompt: string,
    options: { maxTurns: number },
  ): Promise<{ finalOutput?: unknown }>;
}

function clip(value: string, maxChars: number): string {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 29))}\n...[context truncated]`;
}

function renderAuthority(decision: TurnPreflightDecision): string {
  return JSON.stringify({
    destination: decision.destination ?? null,
    destinationInstanceUnstated: decision.destinationInstanceUnstated === true,
    allowedMutationEffects: decision.allowedMutationEffects ?? [],
    allowedDestinations: decision.allowedDestinations ?? [],
    allowedActionFamilies: decision.allowedActionFamilies ?? [],
  });
}

function boundedOpenDimensions(openness: TurnOpenness): string[] {
  return openness.open
    .map((dimension) => dimension.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((dimension) => dimension.slice(0, MAX_OPEN_DIMENSION_CHARS));
}

export function preflightConversationPrompt(packet: PreflightConversationPacketV1): string {
  const common = [
    'Accepted user request:',
    packet.objective,
    '',
    'Typed destination and authority facts:',
    renderAuthority(packet.decision),
    '',
    'Relevant conversation context (private context, not text to quote mechanically):',
    clip(packet.conversationContext, MAX_CONVERSATION_CONTEXT_CHARS) || '(none)',
    '',
    'Relevant recalled memory (use only what genuinely bears on this request):',
    clip(packet.memoryContext, MAX_MEMORY_CONTEXT_CHARS) || '(none)',
    '',
    'Resolved capability facts:',
    clip(packet.capabilityContext, MAX_CAPABILITY_CONTEXT_CHARS) || '(none)',
  ];
  if (packet.kind === 'ask') {
    return [
      ...common,
      '',
      'Load-bearing dimensions independently found OPEN:',
      ...boundedOpenDimensions(packet.openness).map((dimension) => `- ${dimension}`),
      '',
      'Write only the one conversational question the user should see before execution pauses.',
    ].join('\n');
  }
  return [
    ...common,
    '',
    'Openness verdict: SETTLED — no load-bearing value is missing.',
    '',
    'Write only a brief conversational acknowledgement of your reading. Execution follows immediately in this same turn.',
  ].join('\n');
}

function preflightConversationInstructions(kind: PreflightConversationPacketV1['kind']): string {
  const common = [
    'You are Clementine speaking naturally to the user immediately before consequential work.',
    'No tool or business work has run yet. Never claim that you searched, created, sent, changed, or verified anything.',
    'Use relevant conversation history and recalled memory so the response sounds continuous and informed, not generic.',
    'Briefly state your concrete reading of the request. Do not write a plan card, checklist, bullets, headings, protocol, JSON, or tool discussion.',
    'The wording is yours. Produce only the user-facing message.',
  ];
  if (kind === 'ask') {
    return [
      ...common,
      'A separate judge found a genuinely load-bearing value open. Ask exactly ONE concrete question that obtains that value, then stop.',
      'Do not ask for generic permission to begin and do not add unrelated questions.',
    ].join(' ');
  }
  return [
    ...common,
    'The request is settled. Briefly acknowledge your reading and proceed; this message is a same-turn preamble, not a checkpoint.',
    'Do not ask a question, request confirmation, or tell the user to wait.',
  ].join(' ');
}

/** Active-brain, one-turn authoring pass with a physically empty tool surface. */
export function createAgentsPreflightConversationPort(input: {
  model: string | Model;
  /** Test seam; production uses a fresh Runner. */
  runner?: OneTurnRunner;
  /** Hard wall-clock bound; maxTurns alone does not bound a hung provider. */
  timeoutMs?: number;
}): PreflightConversationPort {
  return {
    async render(packet) {
      const agent = new Agent({
        name: 'Clementine Preflight Conversation',
        model: input.model,
        instructions: preflightConversationInstructions(packet.kind),
        modelSettings: { reasoning: { effort: 'low' } },
        tools: [],
      });
      const runner = input.runner
        ?? new Runner({ workflowName: 'clementine-preflight-conversation' });
      const configuredTimeout = input.timeoutMs ?? DEFAULT_PREFLIGHT_CONVERSATION_AUTHOR_TIMEOUT_MS;
      const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? Math.trunc(configuredTimeout)
        : DEFAULT_PREFLIGHT_CONVERSATION_AUTHOR_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        runner.run(agent, preflightConversationPrompt(packet), { maxTurns: 1 }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Preflight conversation author timed out.')),
            timeoutMs,
          );
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      const finalOutput = result.finalOutput;
      return typeof finalOutput === 'string' ? finalOutput : String(finalOutput ?? '');
    },
  };
}

function exactAlignmentDecisionIsDurable(
  identity: TurnIdentity,
  decision: TurnPreflightDecision,
): boolean {
  return listEvents(identity.sessionId, { types: ['turn_preflight_decision'] })
    .some((event) => event.data.sourceUserSeq === identity.sourceUserSeq
      && event.data.phase === 'align'
      && event.data.intentKey === decision.intentKey
      && event.data.objective === decision.objective);
}

function exactCommittedQuestion(
  identity: TurnIdentity,
  decision: TurnPreflightDecision,
): PresentationEvent | null {
  const awaiting = listEvents(identity.sessionId, { types: ['awaiting_user_input'] })
    .find((candidate) => candidate.data.sourceUserSeq === identity.sourceUserSeq
      && candidate.data.source === PREFLIGHT_OPENNESS_SOURCE
      && candidate.data.intentKey === decision.intentKey);
  const events = listEvents(identity.sessionId, { types: ['conversation_completed'], desc: true });
  for (const event of events) {
    let presentation: PresentationEvent | null = null;
    try { presentation = presentationEventFromCompletionData(event.data); } catch { continue; }
    if (presentation?.identity.sourceUserSeq !== identity.sourceUserSeq) continue;
    if (!awaiting || event.seq <= awaiting.seq) {
      throw new Error('The accepted openness source already owns a non-openness terminal.');
    }
    if (
      presentation.status !== 'needs_input'
      || presentation.kind !== 'question'
      || presentation.needs?.kind !== 'input'
      || presentation.text !== awaiting.data.question
    ) {
      throw new Error('The accepted openness source already owns a non-openness terminal.');
    }
    return presentation;
  }
  return null;
}

function exactAwaitingQuestion(
  identity: TurnIdentity,
  decision: TurnPreflightDecision,
): string | null {
  const event = listEvents(identity.sessionId, { types: ['awaiting_user_input'], desc: true })
    .find((candidate) => candidate.data.sourceUserSeq === identity.sourceUserSeq
      && candidate.data.source === PREFLIGHT_OPENNESS_SOURCE
      && candidate.data.intentKey === decision.intentKey);
  return typeof event?.data.question === 'string' && event.data.question.trim()
    ? event.data.question.trim()
    : null;
}

/** A write-free provider fallover re-enters this module with the same accepted
 * source. Once either lane has durably published its opening, that exact prose
 * is the replay authority: asking another brain to re-author it can produce a
 * different sentence and turn the eventlog CAS into a false conflict. */
function exactPersistedPreamble(
  identity: TurnIdentity,
  decision: TurnPreflightDecision,
): string | null {
  const source = listEvents(identity.sessionId, { types: ['user_input_received'] })
    .find((event) => event.seq === identity.sourceUserSeq);
  if (
    !source
    || source.turn !== identity.turn
    || source.role !== 'user'
    || source.data.synthetic === true
  ) {
    throw new Error('The durable preamble source no longer matches the accepted user identity.');
  }
  const owned = listEvents(identity.sessionId, { types: ['conversation_preamble'] })
    .filter((event) => event.data.sourceUserSeq === identity.sourceUserSeq);
  if (owned.length === 0) return null;
  if (owned.length !== 1) {
    throw new Error('The accepted source has multiple durable conversation preambles.');
  }
  const event = owned[0]!;
  const data = publicConversationPreambleData(event.data);
  if (
    event.turn !== identity.turn
    || event.role !== 'Clem'
    || event.parentEventId !== source.id
    || !data
    || data.sourceUserSeq !== identity.sourceUserSeq
    || data.intentKey !== decision.intentKey
  ) {
    throw new Error('The durable conversation preamble conflicts with the accepted source.');
  }
  return data.text;
}

function failedOpenAuthorFallback(openness: TurnOpenness): string {
  const first = boundedOpenDimensions(openness)[0] ?? 'the one detail that changes the result';
  return `Could you clarify ${first}?`;
}

export interface PublishPreflightConversationInput {
  identity: TurnIdentity;
  decision: TurnPreflightDecision;
  openness: TurnOpenness | null;
  conversationContext?: string;
  memoryContext?: string;
  capabilityContext?: string;
  port: PreflightConversationPort;
  transport: 'openai_agents_harness' | 'claude_agent_sdk_brain';
  /**
   * A SETTLED-only authoring pass launched beside the independent openness
   * judge. The value is consumed only when that judge returns SETTLED; an OPEN
   * verdict still receives its distinct, post-verdict question author below.
   */
  settledProceedAuthor?: Promise<string>;
}

export type StartSettledPreflightConversationAuthorInput = Pick<
  PublishPreflightConversationInput,
  | 'identity'
  | 'decision'
  | 'conversationContext'
  | 'memoryContext'
  | 'capabilityContext'
  | 'port'
>;

/**
 * Start the active-brain SETTLED voice pass without waiting for the
 * cross-family openness verdict. The prompt is speculative, not authoritative:
 * callers publish it only after the independent judge actually settles the
 * request. Failures resolve to silence so a discarded OPEN-path promise can
 * never become an unhandled rejection.
 */
export function startSettledPreflightConversationAuthor(
  input: StartSettledPreflightConversationAuthorInput,
): Promise<string> {
  if (
    input.decision.phase !== 'align'
    || !input.decision.intentKey
    || !input.decision.objective?.trim()
  ) {
    throw new Error('Structural preflight conversation requires a typed align decision.');
  }
  if (!exactAlignmentDecisionIsDurable(input.identity, input.decision)) {
    throw new Error('Structural preflight alignment was not durably anchored to the accepted source.');
  }
  const persisted = exactPersistedPreamble(input.identity, input.decision);
  if (persisted) return Promise.resolve(persisted);

  const packet: PreflightConversationPacketV1 = {
    version: 1,
    kind: 'proceed',
    objective: input.decision.objective,
    decision: input.decision,
    conversationContext: input.conversationContext ?? '',
    memoryContext: input.memoryContext ?? '',
    capabilityContext: input.capabilityContext ?? '',
    openness: null,
  };
  return (async () => {
    try {
      const authored = assertPublicPresentationText(await input.port.render(packet));
      // A speculative settled author has no authority to create a checkpoint.
      return authored.includes('?') ? '' : authored;
    } catch {
      return '';
    }
  })();
}

/**
 * Author the judged conversational beat. Only OPEN publishes a terminal.
 * SETTLED returns a same-turn preamble and author failure degrades to silence,
 * never to a synthetic confirmation stop.
 */
export async function publishPreflightConversation(
  input: PublishPreflightConversationInput,
): Promise<PreflightConversationDisposition> {
  if (
    input.decision.phase !== 'align'
    || !input.decision.intentKey
    || !input.decision.objective?.trim()
  ) {
    throw new Error('Structural preflight conversation requires a typed align decision.');
  }
  if (!exactAlignmentDecisionIsDurable(input.identity, input.decision)) {
    throw new Error('Structural preflight alignment was not durably anchored to the accepted source.');
  }

  const packetBase: PreflightConversationPacketBaseV1 = {
    version: 1,
    objective: input.decision.objective,
    decision: input.decision,
    conversationContext: input.conversationContext ?? '',
    memoryContext: input.memoryContext ?? '',
    capabilityContext: input.capabilityContext ?? '',
  };

  if (!input.openness || boundedOpenDimensions(input.openness).length === 0) {
    const persisted = exactPersistedPreamble(input.identity, input.decision);
    if (persisted) return { kind: 'proceed', preamble: persisted };
    let preamble = '';
    try {
      const authored = assertPublicPresentationText(await (input.settledProceedAuthor
        ?? input.port.render({
          ...packetBase,
          kind: 'proceed',
          openness: null,
        })));
      // A settled author cannot turn its own preamble into a new checkpoint.
      preamble = authored.includes('?') ? '' : authored;
    } catch {
      preamble = '';
    }
    return { kind: 'proceed', preamble };
  }

  const committed = exactCommittedQuestion(input.identity, input.decision);
  if (committed) return { kind: 'ask', presentation: committed };

  let question = exactAwaitingQuestion(input.identity, input.decision);
  if (!question) {
    try {
      question = assertPublicPresentationText(await input.port.render({
        ...packetBase,
        kind: 'ask',
        openness: input.openness,
      }));
    } catch {
      question = failedOpenAuthorFallback(input.openness);
    }
    appendEvent({
      sessionId: input.identity.sessionId,
      turn: input.identity.turn,
      role: 'Clem',
      type: 'awaiting_user_input',
      data: {
        question,
        purpose: 'clarification',
        source: PREFLIGHT_OPENNESS_SOURCE,
        sourceUserSeq: input.identity.sourceUserSeq,
        intentKey: input.decision.intentKey,
      },
    });
  }

  const presentation = commitTurnOutcome({
    version: 2,
    id: turnOutcomeId(input.identity),
    identity: input.identity,
    status: 'needs_input',
    resumable: true,
    needs: { kind: 'input' },
    presentation: { kind: 'question', text: question },
  }, {
    legacyReason: 'awaiting_user_input',
    metadata: {
      transport: input.transport,
      preflightPhase: 'align',
      preflightIntentKey: input.decision.intentKey,
      preflightConversation: 'open',
    },
  }).presentation;
  return { kind: 'ask', presentation };
}
