import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exactProviderDataPayload, projectProviderResult } from './provider-read-evidence.js';

test('exact provider payload accepts only the closed successful SDK envelope, including durable JSON bytes', () => {
  const envelope = {
    data: { id: 'resource-1', handle: 'provider://resources/resource-1' },
    error: null,
    successful: true,
    logId: 'log-1',
    sessionInfo: { id: 'sdk-session-1' },
  };
  assert.deepEqual(exactProviderDataPayload(envelope), envelope.data);
  assert.deepEqual(exactProviderDataPayload(JSON.stringify(envelope)), envelope.data);

  const arbitrary = { data: envelope.data, successful: true, modelClaim: 'not provider authority' };
  assert.equal(exactProviderDataPayload(arbitrary), arbitrary);
  assert.equal(exactProviderDataPayload(JSON.stringify(arbitrary)), JSON.stringify(arbitrary));
  const failed = { data: envelope.data, successful: false, error: 'denied' };
  assert.equal(exactProviderDataPayload(failed), failed);
});

test('auxiliary empty arrays never prove an empty provider result', () => {
  for (const value of [
    { successful: true, warnings: [], message: 'results unavailable' },
    { success: true, errors: [], metadata: [] },
    { ok: true, data: { warnings: [], errors: [], metadata: [] } },
  ]) {
    assert.deepEqual(projectProviderResult(value, []), {
      containsExpectedTarget: false,
      hasEmptyResult: false,
      hasNonEmptyResult: false,
    });
  }
});

test('only explicit provider result carriers and counts establish empty-result evidence', () => {
  for (const value of [
    [],
    { resources: [] },
    { data: [] },
    { response: { results: [] } },
    { result: { count: 0 } },
  ]) {
    const projection = projectProviderResult(value, []);
    assert.equal(projection.hasEmptyResult, true);
    assert.equal(projection.hasNonEmptyResult, false);
  }

  assert.deepEqual(projectProviderResult({ successful: true, payload: [] }, []), {
    containsExpectedTarget: false,
    hasEmptyResult: false,
    hasNonEmptyResult: false,
  }, 'an unrecognized response shape must fail closed');
});

test('a non-empty result dominates empty siblings and request echoes are not targets', () => {
  assert.deepEqual(projectProviderResult({
    request: { resourceId: 'site-echo-only' },
    resources: [],
    documents: [{ id: 'site-live' }],
    warnings: [],
  }, ['site-echo-only', 'site-live']), {
    containsExpectedTarget: true,
    hasEmptyResult: true,
    hasNonEmptyResult: true,
  });
});

test('target search crosses provider-specific nested arrays without treating them as empty-result carriers', () => {
  assert.deepEqual(projectProviderResult({
    data: {
      valueRanges: [{ values: [['site-live']] }],
      diagnostics: [],
    },
  }, ['site-live']), {
    containsExpectedTarget: true,
    hasEmptyResult: false,
    hasNonEmptyResult: true,
  });
});

test('nonempty status or message content beneath a result envelope blocks global absence', () => {
  for (const value of [
    { resources: [], data: { status: 'active' } },
    { resources: [], data: { message: '1 resource found' } },
  ]) {
    const projection = projectProviderResult(value, []);
    assert.equal(projection.hasEmptyResult, true);
    assert.equal(projection.hasNonEmptyResult, true);
  }
});

test('nonempty diagnostic collections remain auxiliary even beneath a result envelope', () => {
  assert.deepEqual(projectProviderResult({
    data: { warnings: ['deprecated field'], errors: [], metadata: ['request-id'] },
  }, []), {
    containsExpectedTarget: false,
    hasEmptyResult: false,
    hasNonEmptyResult: false,
  });
});
