/** Request-local composition. It informs memory and presentation, never tool authority. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SessionMount } from './session-composition.js';
import type { MemoryScope } from '../../memory/memory-scope.js';
import { parseQuestionToolWireEdition, type QuestionToolWireEdition } from '../../agents/question-tools.js';

export type MemoryCaptureEdition = 'legacy_v1' | 'save_operation_v2' | 'tool_owned_v3';
export function parseMemoryCaptureEdition(value: unknown): MemoryCaptureEdition | null {
  return value === 'legacy_v1' || value === 'save_operation_v2' || value === 'tool_owned_v3' ? value : null;
}

export interface SourceSessionContextRef {
  sessionId: string;
  sourceUserSeq: number;
  digest: string;
}
export interface SourceSessionContext extends SourceSessionContextRef {
  mount: SessionMount;
  memoryScope: MemoryScope;
  /** Present only on contexts read or captured by the durable checked producer. */
  questionToolWireEdition?: QuestionToolWireEdition;
  memoryCaptureEdition?: MemoryCaptureEdition;
}
const scope = new AsyncLocalStorage<SourceSessionContext>();
const agents = new WeakMap<object, SourceSessionContextRef>();
const questionEditions = new WeakMap<object, SourceSessionContextRef & { edition: QuestionToolWireEdition }>();
const memoryEditions = new WeakMap<object, SourceSessionContextRef & { edition: MemoryCaptureEdition }>();

/** Only the checked durable producer may bind an extractor to a request. */
export function retainValidatedSourceMemoryCaptureEdition(
  context: SourceSessionContext, edition: MemoryCaptureEdition,
): SourceSessionContext {
  if (!parseMemoryCaptureEdition(edition) || !context.sessionId
    || !Number.isSafeInteger(context.sourceUserSeq) || context.sourceUserSeq <= 0
    || !/^[a-f0-9]{64}$/.test(context.digest)) throw new Error('Invalid memory capture context.');
  Object.defineProperty(context, 'memoryCaptureEdition', { value: edition, enumerable: true, writable: false, configurable: false });
  memoryEditions.set(context, { sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq, digest: context.digest, edition });
  return context;
}

export function sourceMemoryCaptureEdition(context: SourceSessionContext): MemoryCaptureEdition {
  const retained = memoryEditions.get(context);
  if (!retained) {
    if (Object.hasOwn(context, 'memoryCaptureEdition')) throw new Error('Memory capture context is not validated.');
    return 'legacy_v1';
  }
  if (retained.sessionId !== context.sessionId || retained.sourceUserSeq !== context.sourceUserSeq
    || retained.digest !== context.digest || context.memoryCaptureEdition !== retained.edition) {
    throw new Error('Memory capture context changed its accepted source.');
  }
  return retained.edition;
}

/** Internal checked producer hook: call only after exact source and durable
 * context validation. Plain context fields alone cannot select a new wire. */
export function retainValidatedSourceQuestionToolEdition(
  context: SourceSessionContext, edition: QuestionToolWireEdition,
): SourceSessionContext {
  if (!parseQuestionToolWireEdition(edition) || !context.sessionId
    || !Number.isSafeInteger(context.sourceUserSeq) || context.sourceUserSeq <= 0
    || !/^[a-f0-9]{64}$/.test(context.digest)) throw new Error('Invalid question tool wire context.');
  Object.defineProperty(context, 'questionToolWireEdition', { value: edition, enumerable: true, writable: false, configurable: false });
  questionEditions.set(context, { sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq, digest: context.digest, edition });
  return context;
}

export function sourceQuestionToolWireEdition(context: SourceSessionContext): QuestionToolWireEdition {
  const retained = questionEditions.get(context);
  if (!retained) {
    if (Object.hasOwn(context, 'questionToolWireEdition')) throw new Error('Question tool wire context is not validated.');
    return 'legacy_v1';
  }
  if (retained.sessionId !== context.sessionId || retained.sourceUserSeq !== context.sourceUserSeq
    || retained.digest !== context.digest || context.questionToolWireEdition !== retained.edition) {
    throw new Error('Question tool wire context changed its accepted source.');
  }
  return retained.edition;
}

export function questionToolWireEditionForSource(sessionId: string, sourceUserSeq?: number): QuestionToolWireEdition {
  const active = currentSourceSessionContext(sessionId);
  if (!active) return 'legacy_v1';
  if (sourceUserSeq !== undefined && sourceUserSeq !== active.sourceUserSeq) {
    throw new Error('Question tool wire context belongs to another accepted source.');
  }
  return sourceQuestionToolWireEdition(active);
}

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
