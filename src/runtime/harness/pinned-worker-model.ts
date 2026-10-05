import { AsyncLocalStorage } from 'node:async_hooks';

// Host-only routing authority. This value never comes from a worker packet.
const pinnedWorkerModel = new AsyncLocalStorage<string>();

export function withPinnedWorkerModel<T>(modelId: string | undefined, work: () => T): T {
  return modelId ? pinnedWorkerModel.run(modelId, work) : work();
}

export function isPinnedWorkerModel(modelId: string): boolean {
  return pinnedWorkerModel.getStore() === modelId;
}
