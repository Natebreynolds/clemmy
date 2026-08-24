import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LEGACY_ENVELOPE_LOG_ID_MAX_BYTES,
  reconcileStoredEnvelopeMetadata,
} from './result-facts.js';

test('exact stored envelope metadata remains authoritative without legacy narrowing', () => {
  const rederived = { providerState: 'complete', arbitraryMetadata: 7 };
  assert.deepEqual(
    reconcileStoredEnvelopeMetadata({
      storedJson: JSON.stringify({ arbitraryMetadata: 7, providerState: 'complete' }),
      rederived,
      rawPayload: { successful: false, error: 'provider rejected the operation' },
    }),
    { matches: true, metadata: rederived, legacyRehydrated: false },
  );
});

test('missing legacy metadata accepts only a clean bounded positive acknowledgement', () => {
  const rederived = { successful: true, logId: 'legacy-log-1' };
  assert.deepEqual(
    reconcileStoredEnvelopeMetadata({
      storedJson: null,
      rederived,
      rawPayload: {
        successful: true,
        logId: 'legacy-log-1',
        data: { items: [{ id: 'alpha-1' }] },
      },
    }),
    { matches: true, metadata: rederived, legacyRehydrated: true },
  );
});

test('missing legacy metadata rejects every shape outside the narrow whitelist', () => {
  const cleanPayload = {
    successful: true,
    logId: 'legacy-log-1',
    data: { items: [{ id: 'alpha-1' }] },
  };
  const rejected = [
    { label: 'extra key', metadata: { successful: true, logId: 'log-1', status: 'ok' } },
    { label: 'missing success flag', metadata: { logId: 'log-1' } },
    { label: 'non-boolean success flag', metadata: { successful: 'true', logId: 'log-1' } },
    { label: 'one false success flag', metadata: { successful: true, ok: false, logId: 'log-1' } },
    { label: 'missing log id', metadata: { successful: true } },
    { label: 'empty log id', metadata: { successful: true, logId: '   ' } },
    {
      label: 'oversized log id',
      metadata: { successful: true, logId: 'x'.repeat(LEGACY_ENVELOPE_LOG_ID_MAX_BYTES + 1) },
    },
  ] as const;

  for (const fixture of rejected) {
    assert.deepEqual(
      reconcileStoredEnvelopeMetadata({
        storedJson: null,
        rederived: fixture.metadata,
        rawPayload: cleanPayload,
      }),
      { matches: false },
      fixture.label,
    );
  }

  assert.deepEqual(
    reconcileStoredEnvelopeMetadata({
      storedJson: null,
      rederived: { successful: true, logId: 'log-1' },
      rawPayload: { successful: true, logId: 'log-1', error: 'provider failed' },
    }),
    { matches: false },
    'provider contradiction',
  );
});

test('non-null stored envelope metadata never receives legacy mismatch compatibility', () => {
  assert.deepEqual(
    reconcileStoredEnvelopeMetadata({
      storedJson: JSON.stringify({ successful: true, logId: 'forged-log' }),
      rederived: { successful: true, logId: 'real-log' },
      rawPayload: { successful: true, logId: 'real-log', data: { items: [] } },
    }),
    { matches: false },
  );
});
