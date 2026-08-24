import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  reconcileCanonicalEntityWorkspaceProjectionClaims,
} from './workflow-runner.js';
import type { FinalizeCanonicalEntityWorkflowCompletionInputV1 } from '../spaces/canonical-entity-workflow-finalizer.js';

test('boot recovery retries only an exact terminal top-level lineage claim after the post-commit crash cut', () => {
  const runsDirectory = mkdtempSync(path.join(os.tmpdir(), 'clem-entity-space-reconcile-'));
  try {
    writeFileSync(path.join(runsDirectory, 'run:claimed.json'), JSON.stringify({
      id: 'run:claimed',
      workflow: 'Mutable display title',
      workflowSlug: 'workflow:claimed',
      status: 'completed',
      terminalOutcome: 'succeeded',
      finishedAt: '2026-08-22T20:00:00.000Z',
      canonicalEntityWorkspaceProjectionClaim: { version: 1 },
      output: 'private@example.invalid',
      stepOutputs: { rawProviderPayload: { approved: true } },
    }));
    writeFileSync(path.join(runsDirectory, 'run:prose.json'), JSON.stringify({
      id: 'run:prose',
      workflow: 'workflow:prose',
      status: 'completed',
      terminalOutcome: 'succeeded',
      finishedAt: '2026-08-22T20:00:00.000Z',
      output: 'canonicalEntityWorkspaceProjectionClaim: true',
    }));
    writeFileSync(path.join(runsDirectory, 'run:running.json'), JSON.stringify({
      id: 'run:running',
      workflow: 'workflow:running',
      status: 'running',
      canonicalEntityWorkspaceProjectionClaim: { version: 1 },
    }));

    const seen: FinalizeCanonicalEntityWorkflowCompletionInputV1[] = [];
    const finalize = (input: FinalizeCanonicalEntityWorkflowCompletionInputV1) => {
      seen.push(input);
      return seen.length === 1
        ? {
            status: 'projected' as const,
            runId: input.runId,
            workflowId: input.workflowId,
            bindingId: 'binding:claimed',
            workspaceId: 'workspace:claimed',
            datasetId: 'dataset:claimed',
            headDigest: 'a'.repeat(64),
            projectionDigest: 'b'.repeat(64),
            coverage: {
              status: 'complete' as const,
              complete: true,
              observedPartitions: 1,
              exhaustion: 'exhausted' as const,
              reasons: [],
            },
            records: {
              observationsCommitted: 1,
              canonicalRecordsCreated: 1,
              duplicateObservations: 0,
            },
          }
        : {
            status: 'replayed' as const,
            runId: input.runId,
            workflowId: input.workflowId,
            bindingId: 'binding:claimed',
            workspaceId: 'workspace:claimed',
            datasetId: 'dataset:claimed',
            headDigest: 'a'.repeat(64),
            projectionDigest: 'b'.repeat(64),
            coverage: {
              status: 'complete' as const,
              complete: true,
              observedPartitions: 1,
              exhaustion: 'exhausted' as const,
              reasons: [],
            },
            records: {
              observationsCommitted: 1,
              canonicalRecordsCreated: 1,
              duplicateObservations: 0,
            },
          };
    };

    assert.deepEqual(
      reconcileCanonicalEntityWorkspaceProjectionClaims({ runsDirectory, finalize }),
      { eligible: 1, projected: 1, replayed: 0, blocked: 0, failed: 0 },
    );
    assert.deepEqual(
      reconcileCanonicalEntityWorkspaceProjectionClaims({ runsDirectory, finalize }),
      { eligible: 1, projected: 0, replayed: 1, blocked: 0, failed: 0 },
    );
    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.workflowId, 'workflow:claimed');
    assert.deepEqual(Object.keys(seen[0]!).sort(), [
      'claim', 'finishedAt', 'needsAttention', 'runId', 'status',
      'terminalOutcome', 'version', 'workflowId',
    ]);
    assert.equal(JSON.stringify(seen).includes('private@example.invalid'), false);
    assert.equal(JSON.stringify(seen).includes('rawProviderPayload'), false);
  } finally {
    rmSync(runsDirectory, { recursive: true, force: true });
  }
});
