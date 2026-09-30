/** Request-local composition. It informs memory and presentation, never tool authority. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SessionMount } from './session-composition.js';
import type { MemoryScope } from '../../memory/memory-scope.js';

export interface SourceSessionContextRef {
  sessionId: string;
  sourceUserSeq: number;
  digest: string;
}
export interface SourceSessionContext extends SourceSessionContextRef {
  mount: SessionMount;
  memoryScope: MemoryScope;
}
const scope = new AsyncLocalStorage<SourceSessionContext>();
const agents = new WeakMap<object, SourceSessionContextRef>();

export function currentSourceSessionContext(sessionId: string): SourceSessionContext | undefined {
  const active = scope.getStore();
  return active?.sessionId === sessionId ? active : undefined;
}

export function withSourceSessionContext<T>(context: SourceSessionContext, run: () => T): T {
  const active = currentSourceSessionContext(context.sessionId);
  if (active) {
    if (active.sourceUserSeq !== context.sourceUserSeq || active.digest !== context.digest) {
      throw new Error('Nested task composition changed its accepted source.');
    }
    return run();
  }
  return scope.run(context, run);
}

/** Only construction under a validated source scope can bind this reference. */
export function bindAgentSourceSessionContext(agent: object, sessionId: string): void {
  const active = currentSourceSessionContext(sessionId);
  if (active) agents.set(agent, { sessionId, sourceUserSeq: active.sourceUserSeq, digest: active.digest });
}

export function boundAgentSourceSessionContext(agent: object): SourceSessionContextRef | undefined {
  const ref = agents.get(agent);
  return ref ? { ...ref } : undefined;
}
