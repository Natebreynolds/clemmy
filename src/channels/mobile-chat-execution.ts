import { getHarnessChatCancellation } from '../runtime/harness/eventlog.js';

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
