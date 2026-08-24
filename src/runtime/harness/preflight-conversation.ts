/**
 * One tool-less, model-authored conversational beat before consequential work.
 *
 * The openness judge owns the decision. This module only gives that decision a
 * natural voice:
 *   - OPEN asks one concrete question and owns a typed needs-input terminal;
 *   - a typed material source choice asks for exact confirmation and owns the
 *     same durable stop, even when every ordinary task slot is settled;
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
import {
  PREFLIGHT_ALIGNMENT_SOURCE,
  validatedTurnSourceStrategyBinding,
  type TurnPreflightDecision,
  type TurnSourceStrategyBindingV1,
} from './turn-control.js';

const MAX_CONVERSATION_CONTEXT_CHARS = 8_000;
const MAX_MEMORY_CONTEXT_CHARS = 6_000;
const MAX_CAPABILITY_CONTEXT_CHARS = 8_000;
const MAX_OPEN_DIMENSION_CHARS = 240;
/** A conversational acknowledgement must never become the long pole before
 * execution. The independent openness pass has its own 4s ceiling; keep this
 * one-line voice pass comparably bounded and degrade settled turns to silence. */
export const DEFAULT_PREFLIGHT_CONVERSATION_AUTHOR_TIMEOUT_MS = 6_000;
/** A required material-source confirmation is still one tool-less voice pass,
 * but it has to turn a validated capability binding into a precise question.
 * Give that required checkpoint a little more provider runway while retaining
 * a hard wall-clock ceiling. This is packet-kind policy, never provider policy. */
export const REQUIRED_SOURCE_STRATEGY_CONFIRMATION_AUTHOR_TIMEOUT_MS = 15_000;

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
    })
  | (PreflightConversationPacketBaseV1 & {
      kind: 'confirm_source_strategy';
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
    sourceStrategyPosture: decision.sourceStrategyPosture ?? null,
    confirmationDisposition: decision.confirmationDisposition ?? null,
    // Private authoring fact only. The active model turns the host-selected
    // opaque capability/account/schema binding into natural user language;
    // code never manufactures provider-facing copy from the identifier.
    sourceStrategyBinding: decision.sourceStrategyBinding ?? null,
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
  if (packet.kind === 'confirm_source_strategy') {
    return [
      ...common,
      '',
      'Confirmation disposition: MATERIAL SOURCE STRATEGY — ordinary task slots are settled, but materially different collection sources or procedures can change quality, provenance, cost, or reliability.',
      '',
      'Using only the resolved capability and standing-preference facts above, recommend one exact source strategy and one bounded fallback posture. State the aggregate collection and the single destination artifact in plain language. End with one direct question that lets the user confirm the recommendation or name a different source. Do not perform any business work yet.',
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
  if (kind === 'confirm_source_strategy') {
    return [
      ...common,
      'The host has found a material source-strategy choice. Recommend one exact source or proven procedure from the supplied facts; never invent a provider or connection.',
      'Describe one aggregate collection followed by one destination artifact, not one write per collected member.',
      'End with exactly ONE direct confirmation-or-correction question, then stop. Do not begin execution or claim any work ran.',
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
  /** Optional absolute wall override, clamped to the selected packet kind's
   * production ceiling. maxTurns alone does not bound a hung provider. */
  timeoutMs?: number;
  /** Test-only proportional clock seam. Production omits it (= 1); values can
   * shorten, but never extend, either production ceiling. */
  timeoutScale?: number;
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
      const productionCeiling = packet.kind === 'confirm_source_strategy'
        ? REQUIRED_SOURCE_STRATEGY_CONFIRMATION_AUTHOR_TIMEOUT_MS
        : DEFAULT_PREFLIGHT_CONVERSATION_AUTHOR_TIMEOUT_MS;
      const requestedTimeout = input.timeoutMs;
      const configuredTimeout = typeof requestedTimeout === 'number'
        && Number.isFinite(requestedTimeout)
        && requestedTimeout > 0
        ? Math.min(Math.trunc(requestedTimeout), productionCeiling)
        : productionCeiling;
      const requestedScale = input.timeoutScale;
      const timeoutScale = typeof requestedScale === 'number'
        && Number.isFinite(requestedScale)
        && requestedScale > 0
        ? Math.min(requestedScale, 1)
        : 1;
      const timeoutMs = Math.max(1, Math.trunc(configuredTimeout * timeoutScale));
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
      && event.data.objective === decision.objective
      && sourceStrategyBindingsEqual(
        event.data.sourceStrategyBinding,
        decision.sourceStrategyBinding,
      ));
}

function sourceStrategyBindingsEqual(left: unknown, right: unknown): boolean {
  if (left === undefined && right === undefined) return true;
  const validatedLeft = validatedTurnSourceStrategyBinding(left);
  const validatedRight = validatedTurnSourceStrategyBinding(right);
  return Boolean(validatedLeft && validatedRight
    && JSON.stringify(validatedLeft) === JSON.stringify(validatedRight));
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
  // The accepted source is its seq. The user row's turn is when that input
  // was recorded; a later loop turn on the same session is not a new source
  // (live 2026-08-14: second chat crashed red because identity.turn was 2
  // while the user event stayed on turn 1).
  if (
    !source
    || source.sessionId !== identity.sessionId
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
    event.turn !== source.turn
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

function exactAwaitingAlignment(
  identity: TurnIdentity,
  decision: TurnPreflightDecision,
): { question: string; sourceStrategyBinding?: TurnSourceStrategyBindingV1 } | null {
  const event = listEvents(identity.sessionId, { types: ['awaiting_user_input'], desc: true })
    .find((candidate) => candidate.data.sourceUserSeq === identity.sourceUserSeq
      && candidate.data.source === PREFLIGHT_ALIGNMENT_SOURCE
      && candidate.data.intentKey === decision.intentKey);
  if (!event) return null;
  if (!sourceStrategyBindingsEqual(
    event.data.sourceStrategyBinding,
    decision.sourceStrategyBinding,
  )) {
    throw new Error('Durable source-strategy confirmation conflicts with the accepted binding.');
  }
  const question = typeof event.data.question === 'string' ? event.data.question.trim() : '';
  if (!question) return null;
  const sourceStrategyBinding = validatedTurnSourceStrategyBinding(event.data.sourceStrategyBinding);
  return {
    question,
    ...(sourceStrategyBinding ? { sourceStrategyBinding } : {}),
  };
}

function exactCommittedAlignment(
  identity: TurnIdentity,
  decision: TurnPreflightDecision,
): PresentationEvent | null {
  const awaiting = listEvents(identity.sessionId, { types: ['awaiting_user_input'] })
    .find((candidate) => candidate.data.sourceUserSeq === identity.sourceUserSeq
      && candidate.data.source === PREFLIGHT_ALIGNMENT_SOURCE
      && candidate.data.intentKey === decision.intentKey);
  if (!awaiting) return null;
  if (!sourceStrategyBindingsEqual(
    awaiting.data.sourceStrategyBinding,
    decision.sourceStrategyBinding,
  )) {
    throw new Error('Committed source-strategy confirmation conflicts with the accepted binding.');
  }
  const events = listEvents(identity.sessionId, { types: ['conversation_completed'], desc: true });
  for (const event of events) {
    let presentation: PresentationEvent | null = null;
    try { presentation = presentationEventFromCompletionData(event.data); } catch { continue; }
    if (presentation?.identity.sourceUserSeq !== identity.sourceUserSeq) continue;
    if (
      event.seq > awaiting.seq
      && presentation.status === 'needs_input'
      && presentation.kind === 'question'
      && presentation.needs?.kind === 'input'
      && presentation.text === awaiting.data.question
    ) return presentation;
    return null;
  }
  return null;
}

/** Source confirmation is model-authored UX. The host validates that the
 * author actually produced the promised question; it never supplies canned
 * wording or silently turns an acknowledgement into consent. */
function sourceStrategyQuestion(authored: string): string {
  const question = authored.trim();
  if (!question || !/\?\s*$/.test(question)) {
    throw new Error('Source-strategy confirmation author did not produce one terminal question.');
  }
  return question;
}

function requiresSourceStrategyConfirmation(decision: TurnPreflightDecision): boolean {
  return decision.confirmationDisposition === 'material_source_strategy'
    && decision.sourceStrategyPosture === 'materially_variant';
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
  transport: 'host_harness' | 'claude_agent_sdk_brain';
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
  const confirmationRequired = requiresSourceStrategyConfirmation(input.decision);
  if (confirmationRequired) {
    const awaiting = exactAwaitingAlignment(input.identity, input.decision);
    if (awaiting) return Promise.resolve(awaiting.question);
  } else {
    const persisted = exactPersistedPreamble(input.identity, input.decision);
    if (persisted) return Promise.resolve(persisted);
  }

  const packet: PreflightConversationPacketV1 = {
    version: 1,
    kind: confirmationRequired ? 'confirm_source_strategy' : 'proceed',
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
      // A speculative ordinary SETTLED author has no authority to create a
      // checkpoint. Source-strategy confirmation takes the distinct typed path.
      return confirmationRequired ? sourceStrategyQuestion(authored) : (authored.includes('?') ? '' : authored);
    } catch {
      return '';
    }
  })();
}

/**
 * Author the judged conversational beat. OPEN and a host-typed material source
 * strategy publish a terminal. An ordinary SETTLED turn returns a same-turn
 * preamble; model prose alone can never manufacture a confirmation stop.
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
    if (requiresSourceStrategyConfirmation(input.decision)) {
      const committed = exactCommittedAlignment(input.identity, input.decision);
      if (committed) return { kind: 'ask', presentation: committed };

      const awaiting = exactAwaitingAlignment(input.identity, input.decision);
      let question = awaiting?.question ?? null;
      if (!question) {
        // ONE retry before failing closed. Authoring is a pure, side-effect-free
        // call, and a transient empty print-mode return killed two consecutive
        // live turns with the generic failure text (2026-08-21: an ads-scrape
        // request; the same packet authored fine seconds later). Fabricating
        // her question stays forbidden — a persistent outage still fails
        // closed, it just no longer loses the turn to one hiccup.
        const authorOnce = async (): Promise<string> => sourceStrategyQuestion(
          assertPublicPresentationText(await (input.settledProceedAuthor
            ?? input.port.render({
              ...packetBase,
              kind: 'confirm_source_strategy',
              openness: null,
            }))),
        );
        let authoredQuestion: string;
        try {
          authoredQuestion = await authorOnce();
        } catch (first) {
          try {
            authoredQuestion = sourceStrategyQuestion(
              assertPublicPresentationText(await input.port.render({
                ...packetBase,
                kind: 'confirm_source_strategy',
                openness: null,
              })),
            );
          } catch {
            throw first;
          }
        }
        question = authoredQuestion;
        appendEvent({
          sessionId: input.identity.sessionId,
          turn: input.identity.turn,
          role: 'Clem',
          type: 'awaiting_user_input',
          data: {
            question,
            purpose: 'clarification',
            source: PREFLIGHT_ALIGNMENT_SOURCE,
            sourceUserSeq: input.identity.sourceUserSeq,
            intentKey: input.decision.intentKey,
            confirmationDisposition: input.decision.confirmationDisposition,
            ...(input.decision.sourceStrategyBinding
              ? { sourceStrategyBinding: input.decision.sourceStrategyBinding }
              : {}),
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
          preflightConversation: 'source_strategy_confirmation',
        },
      }).presentation;
      return { kind: 'ask', presentation };
    }

    // SETTLED prints the plan line and PROCEEDS. Nathan's product line
    // (2026-08-18, after six construct runs): "I don't want to have to reply
    // with stuff like that." A precise named job is its own approval; the
    // beat informs, it never blocks, and "want me to start" is an illegal
    // needs_input. (The blocking-gate experiment lived for one day; its
    // payment machinery — pendingAlignmentForCurrentInput — remains for
    // OPEN questions only.) Author outage degrades to silence, never to a
    // synthetic confirmation stop.
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
