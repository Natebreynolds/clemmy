/** One ordinary host chat turn through the real host_v1 door, for tests.
 *
 * Import this module only after the test has pointed CLEMENTINE_HOME at an
 * isolated home. Only the model is scripted: it emits each move in order (a
 * move may read earlier tool outputs), then answers. The orchestrator build,
 * host dispatch, carriers, admission, settlement and the event-log hooks the
 * production loop attaches to its runner are production. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as eventlog from './eventlog.js';
import * as brackets from './brackets.js';
import * as catalogs from './host-capability-catalog-factory.js';
import { hostRunRunner } from './host-turn-runner.js';
import { attachEventLogHooks, extractSessionIdFromContext, type RunHooksLike } from './hooks.js';
import { buildOrchestratorAgent } from '../../agents/orchestrator.js';
import { primePrimaryModelPlanningCatalog } from '../semantic-boundary/admit-and-compile-accepted-source.js';

export const NO_MCP = { authority: 'none', reason: 'host chat turn fixture', allowedServerSlugs: [], toolPatterns: [], maxTools: 0 } as const;

export async function* modelStream(this: { getResponse(request: unknown): Promise<any> }, request: unknown) {
  const response = await this.getResponse(request);
  yield { type: 'response_started' } as never;
  yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
}

export interface SeenRequest { tools: string[]; toolsJson: string; instructions: string }
export type Move = { name: string; args: Record<string, unknown> };
export interface MoveContext { outputs: Map<string, string>; callId: (index: number) => string }
export type ToolLike = {
  name?: string;
  deferLoading?: unknown;
  description?: unknown;
  parameters?: { properties?: Record<string, unknown> };
};

export const idleModel = { async getResponse(): Promise<never> { throw new Error('not called'); }, getStreamedResponse: modelStream };

function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object' && (output as { type?: unknown }).type === 'text') {
    return String((output as { text?: unknown }).text ?? '');
  }
  return JSON.stringify(output ?? '');
}

export function acceptSource(sessionId: string, text: string, data: Record<string, unknown> = {}) {
  if (!eventlog.getSession(sessionId)) eventlog.createSession({ id: sessionId, kind: 'chat' });
  return eventlog.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text, ...data } });
}

export async function buildFor(
  sessionId: string,
  sourceUserSeq: number,
  prompt: string,
  model: unknown,
  extra: Record<string, unknown> = {},
) {
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  const primed = await primePrimaryModelPlanningCatalog({ sessionId, sourceUserSeq });
  assert.ok(primed.ok, 'the planning catalog primes for the accepted source');
  if (!primed.ok) throw new Error('unreachable');
  return buildOrchestratorAgent({
    sessionId, sourceUserSeq, userInput: prompt,
    hostFreshPlanning: primed.planning,
    allowToolJit: true,
    mcpToolScope: NO_MCP,
    model: model as never,
    ...extra,
  } as never);
}

export async function hostTurn(
  sessionId: string,
  prompt: string,
  moves: Array<(context: MoveContext) => Move>,
  data: Record<string, unknown> = {},
) {
  const source = acceptSource(sessionId, prompt, data);
  const requests: SeenRequest[] = [];
  const outputs = new Map<string, string>();
  const callId = (index: number) => `${sessionId}-${source.seq}-c${index}`;
  const model = {
    async getResponse(request: { tools?: Array<{ name?: string }>; systemInstructions?: unknown; input?: unknown[] }) {
      requests.push({
        tools: (request.tools ?? []).map((entry) => entry.name ?? '').filter(Boolean),
        toolsJson: JSON.stringify(request.tools ?? []),
        instructions: typeof request.systemInstructions === 'string' ? request.systemInstructions : '',
      });
      for (const row of request.input ?? []) {
        const item = row as { type?: string; callId?: string; output?: unknown };
        if (item.type === 'function_call_result' && item.callId) outputs.set(item.callId, outputText(item.output));
      }
      const index = requests.length - 1;
      const move = moves[index]?.({ outputs, callId });
      return {
        responseId: `${sessionId}-${source.seq}-r${requests.length}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: move
          ? [{ type: 'function_call', callId: callId(index), name: move.name, arguments: JSON.stringify(move.args) }]
          : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.' }] }],
      };
    },
    getStreamedResponse: modelStream,
  };
  const agent = await buildFor(sessionId, source.seq, prompt, model);
  const runner = new EventEmitter();
  Object.assign(runner, { run() { throw new Error('the legacy model loop must never run'); } });
  const detachLogHooks = attachEventLogHooks(runner as unknown as RunHooksLike, { getSessionId: extractSessionIdFromContext });
  try {
    await brackets.withHarnessRunContext({
    sessionId, sourceUserSeq: source.seq, counter: new brackets.ToolCallsCounter(40), behaviorScopeId: `${sessionId}::turn:${source.seq}`,
    }, () => hostRunRunner(runner as never, agent as never, [{ type: 'message', role: 'user', content: prompt }] as never, {
      maxTurns: moves.length + 3, hostTurnEngine: 'host_v1', context: { sessionId, sourceUserSeq: source.seq },
    } as never));
  } finally {
    detachLogHooks();
  }
  return { source, requests, outputs, agent, callId };
}

export const agentTools = (agent: unknown): ToolLike[] => ((agent as { tools?: ToolLike[] }).tools ?? []);
