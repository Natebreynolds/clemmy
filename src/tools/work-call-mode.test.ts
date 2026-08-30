import assert from 'node:assert/strict';
import test from 'node:test';

import {
  copyHostPlanningReadCapabilityResolver,
  registerHostPlanningReadCapabilityResolver,
  resolveHostPlanningReadCapability,
} from './work-call-mode.js';

const DIGEST = 'a'.repeat(64);

test('planning-read capability is opaque to lookalikes and copies only at configured wrapping', () => {
  const raw = { name: 'work_call' };
  registerHostPlanningReadCapabilityResolver(raw, (request) => (
    request.sessionId === 'session-a'
    && request.sourceUserSeq === 17
    && request.operationId === 'carrier__read'
      ? { capabilityId: 'cap:current:read', manifestDigest: DIGEST }
      : null
  ));

  const request = {
    sessionId: 'session-a',
    sourceUserSeq: 17,
    operationId: 'carrier__read',
  };
  assert.deepEqual(resolveHostPlanningReadCapability(raw, request), {
    capabilityId: 'cap:current:read',
    manifestDigest: DIGEST,
  });

  const structuralLookalike = { ...raw };
  assert.equal(resolveHostPlanningReadCapability(structuralLookalike, request), null);

  const configuredWrapper = { ...raw };
  copyHostPlanningReadCapabilityResolver(raw, configuredWrapper);
  assert.deepEqual(resolveHostPlanningReadCapability(configuredWrapper, request), {
    capabilityId: 'cap:current:read',
    manifestDigest: DIGEST,
  });
  assert.equal(resolveHostPlanningReadCapability(configuredWrapper, {
    ...request,
    sourceUserSeq: 18,
  }), null);
  assert.deepEqual(Reflect.ownKeys(configuredWrapper), ['name']);
});

test('planning-read bridge fails closed on malformed input, malformed output, and resolver errors', () => {
  const malformed = {};
  registerHostPlanningReadCapabilityResolver(malformed, () => ({
    capabilityId: 'cap:read',
    manifestDigest: 'not-a-digest',
  }));
  assert.equal(resolveHostPlanningReadCapability(malformed, {
    sessionId: 'session-a',
    sourceUserSeq: 1,
    operationId: 'carrier__read',
  }), null);

  const throwing = {};
  registerHostPlanningReadCapabilityResolver(throwing, () => {
    throw new Error('resolver failed');
  });
  assert.equal(resolveHostPlanningReadCapability(throwing, {
    sessionId: 'session-a',
    sourceUserSeq: 1,
    operationId: 'carrier__read',
  }), null);
  assert.equal(resolveHostPlanningReadCapability(throwing, {
    sessionId: 'session-a',
    sourceUserSeq: 0,
    operationId: 'carrier__read',
  }), null);
});
