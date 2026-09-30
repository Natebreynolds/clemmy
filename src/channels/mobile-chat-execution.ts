import { getHarnessChatCancellation } from '../runtime/harness/eventlog.js';

/** Wait for a durable accepted turn, or a replay that needs no new turn, before
 * acknowledging contextual mobile work. Execution may continue after admission. */
export function createMobileChatAdmission(): {
  accepted: () => void;
  wait: Promise<void>;
  observe: <T>(execution: Promise<T>) => void;
} {
  let accepted!: () => void;
  let rejected!: (error: unknown) => void;
  const wait = new Promise<void>((resolve, reject) => {
    accepted = () => resolve();
    rejected = reject;
  });
  // The execution can fail before the HTTP caller reaches its await. Keep that
  // rejection handled while preserving it on the original promise for callers.
  void wait.catch(() => {});
  return {
    accepted,
    wait,
    observe: execution => { void execution.then(accepted, rejected); },
  };
}

/** The phone can Stop after its receipt is acknowledged while asynchronous
 * session setup is still running. Recheck the durable decision immediately
 * before entering the gateway; preparing context never authorizes a run. */
export async function prepareAndDispatchMobileChat<T>(input: {
  requestId: string;
  prepare: () => Promise<void>;
  dispatch: () => Promise<T>;
}): Promise<T> {
  await input.prepare();
  if (getHarnessChatCancellation(input.requestId)) throw new Error('CHAT_REQUEST_CANCELLED');
  return input.dispatch();
}
