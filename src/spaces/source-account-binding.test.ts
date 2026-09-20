import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedSpaceReadAccount } from './source-account-binding.js';
const entry = { kind: 'composio', status: 'proven', connection: 'active', effectClass: 'read', identifier: 'OUTLOOK_LIST_EVENTS', accountIdentity: 'account-a', sourceAccountRouting: { sessionId: 'current', checkedForSourceUserSeq: 42 } };
const resolution = (entries: unknown[], sourceUserSeq = 42) => ({ authoritativeForTask: true, sourceUserSeq, entries });
const select = (resolutions: unknown[]) => selectedSpaceReadAccount({ sessionId: 'current', sourceUserSeq: 42, operationId: 'OUTLOOK_LIST_EVENTS', resolutions: resolutions as ReturnType<typeof resolution>[] });
test('retains one exact read account despite repeated discovery', () => {
  assert.equal(select([resolution([entry]), resolution([entry])]), 'account-a');
});
test('does not infer an account across task, session, effect, or operation boundaries', () => {
  for (const changed of [ { sourceAccountRouting: { sessionId: 'other', checkedForSourceUserSeq: 42 } }, { sourceAccountRouting: { sessionId: 'current', checkedForSourceUserSeq: 41 } }, { effectClass: 'write' }, { identifier: 'OUTLOOK_LIST_MAIL' }, { connection: 'missing' }, { sourceAccountRouting: undefined } ]) assert.equal(select([resolution([{ ...entry, ...changed }])]), undefined);
  assert.equal(select([resolution([entry], 41)]), undefined);
  assert.equal(select([{ ...resolution([entry]), authoritativeForTask: false }]), undefined);
});
test('conflicting current account selections remain unresolved', () => {
  assert.equal(select([resolution([entry]), resolution([{ ...entry, accountIdentity: 'account-b' }])]), undefined);
});
