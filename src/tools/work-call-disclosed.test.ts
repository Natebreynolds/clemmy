import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostCapabilityDescriptorV1 } from '../runtime/semantic-boundary/turn-semantic-proposal.js';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-work-call-disclosed-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { disclosedWorkCallReadyOperations } = await import('./work-call.js');

after(() => {
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function descriptor(id: string, extra: Partial<HostCapabilityDescriptorV1> = {}): HostCapabilityDescriptorV1 {
  return {
    id,
    effect: 'read',
    purpose: 'read current calendar events',
    acceptedInputKinds: ['evidence'],
    producedOutputKinds: ['evidence'],
    applicableDeliverableKinds: ['evidence'],
    inputShape: 'evidence',
    outputShape: 'evidence',
    outputKind: 'evidence',
    deliverableKind: 'evidence',
    destinationPosture: null,
    evidenceKinds: ['tool_result'],
    handleRequired: false,
    readbackRequired: false,
    accountScope: 'runtime',
    manifestDigest: 'digest',
    ...extra,
  };
}

test('disclosed local operations keep their callable name', () => {
  const ready = disclosedWorkCallReadyOperations([
    descriptor('cap:local:write_file:default'),
  ]);
  assert.equal(ready.length, 1);
  assert.equal(ready[0]!.name, 'write_file');
  assert.equal(ready[0]!.capability_selector, 'cap:local:write_file:default');
});

test('disclosed resolved operations present the provider carrier and slug', () => {
  const ready = disclosedWorkCallReadyOperations([
    descriptor('cap:resolved:outlook_get_calendar_view:definition:abc123'),
  ]);
  assert.equal(ready.length, 1);
  assert.equal(ready[0]!.name, 'composio_execute_tool');
  assert.equal(ready[0]!.tool_slug, 'OUTLOOK_GET_CALENDAR_VIEW');
  assert.equal(ready[0]!.capability_selector, 'cap:resolved:outlook_get_calendar_view:definition:abc123');
});
