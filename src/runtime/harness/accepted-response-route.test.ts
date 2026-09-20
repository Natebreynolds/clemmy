import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedResponseRoute, type ResponseRouteEvent } from './accepted-response-route.js';
const planned = { routeKind: 'harness' as const, requestedModel: 'primary', effectiveModel: 'primary', provider: 'codex', surface: 'webhook', transport: 'host_harness' };
const identity = { sessionId: 'fixture', sourceUserSeq: 10 };
const fallback: ResponseRouteEvent = { seq: 12, sessionId: 'fixture', role: 'system', type: 'turn_model_routed', data: { sourceUserSeq: 10, routeKind: 'harness_fallover', model: 'replacement', provider: 'claude' } };
test('the exact source fallback replaces effective identity and preserves the requested model', () => {
  assert.deepEqual(acceptedResponseRoute(planned, identity, [fallback]), { ...planned, effectiveModel: 'replacement', provider: 'claude', falloverFrom: 'primary' });
});
test('workers, judges, other turns and unscoped routes cannot label the response', () => {
  const invalid = [
    { ...fallback, sessionId: 'worker' }, { ...fallback, role: 'assistant' },
    { ...fallback, type: 'worker_model_executed' },
    { ...fallback, data: { ...fallback.data, sourceUserSeq: 11 } },
    { ...fallback, data: { ...fallback.data, sourceUserSeq: undefined } },
    { ...fallback, data: { ...fallback.data, routeKind: 'judge' } },
    { ...fallback, data: { ...fallback.data, provider: '' } },
    { ...fallback, seq: 9 },
  ];
  assert.equal(acceptedResponseRoute(planned, identity, invalid), planned);
  assert.equal(acceptedResponseRoute(planned, { ...identity, sourceUserSeq: NaN }, [fallback]), planned);
});
test('latest source route wins independently of input order', () => {
  const later = { ...fallback, seq: 13, data: { ...fallback.data, model: 'second' } };
  assert.equal(acceptedResponseRoute(planned, identity, [later, fallback]).effectiveModel, 'second');
  assert.equal(acceptedResponseRoute(planned, identity, []).effectiveModel, 'primary');
});
