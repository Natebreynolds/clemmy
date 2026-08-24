import { parentPort, workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';
import type { claimSessionForAcceptedSource as ClaimSession } from './accepted-source-session-branch.js';

if (!parentPort) throw new Error('accepted-source claim worker requires a parent port');

const input = workerData as {
  gate: SharedArrayBuffer;
  claim: Parameters<typeof ClaimSession>[0];
};
const gate = new Int32Array(input.gate);
parentPort.postMessage({ kind: 'ready' });
Atomics.wait(gate, 0, 0);

try {
  const branchModulePath: string = './accepted-source-session-branch.ts';
  const { claimSessionForAcceptedSource } = await tsImport(branchModulePath, import.meta.url) as {
    claimSessionForAcceptedSource: typeof ClaimSession;
  };
  parentPort.postMessage({
    kind: 'result',
    result: claimSessionForAcceptedSource(input.claim),
  });
} catch (error) {
  parentPort.postMessage({
    kind: 'error',
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
}
