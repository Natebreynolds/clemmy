import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterMcpToolsForScope } from '../runtime/mcp-tool-filter.js';
import {
  intersectExternalMcpToolScopes,
} from './external-mcp-scope-lock.js';

const tool = (name: string, description = '') => ({ name, description }) as never;

test('worker scope intersection narrows both server and tool pattern', () => {
  const scope = intersectExternalMcpToolScopes(
    {
      reason: 'parent Salesforce opportunity authority',
      allowedServerSlugs: ['salesforce-mcp'],
      toolPatterns: ['opportunit'],
      maxTools: 8,
      serverMaxTools: { salesforce: 5 },
    },
    {
      reason: 'packet exact query',
      allowedServerSlugs: ['salesforce'],
      toolPatterns: ['query'],
      maxTools: 3,
      serverMaxTools: { 'salesforce-mcp': 2 },
    },
  );

  assert.ok(scope);
  assert.deepEqual(scope.allowedServerSlugs, ['salesforce']);
  assert.equal(scope.maxTools, 3);
  assert.deepEqual(scope.serverMaxTools, { salesforce: 2 });
  const filtered = filterMcpToolsForScope([
    tool('salesforce__query_opportunities'),
    tool('salesforce__delete_opportunity'),
    tool('salesforce__query_accounts'),
    tool('airtable__query_opportunities'),
  ], scope);
  assert.deepEqual(filtered.map((item) => item.name), ['salesforce__query_opportunities']);
});

test('disjoint parent and packet servers collapse to local-only authority', () => {
  assert.equal(intersectExternalMcpToolScopes(
    { reason: 'parent', allowedServerSlugs: ['salesforce'] },
    { reason: 'packet', allowedServerSlugs: ['airtable'] },
  ), null);
});

test('broad parent yields to exact packet while retaining the tighter cap', () => {
  const scope = intersectExternalMcpToolScopes(
    { reason: 'bounded fail-open parent', failOpenCandidate: true, maxTools: 2 },
    { reason: 'packet', allowedServerSlugs: ['notion'], toolPatterns: ['create'] },
  );
  assert.ok(scope);
  assert.equal(scope.failOpenCandidate, undefined);
  assert.deepEqual(scope.allowedServerSlugs, ['notion']);
  assert.deepEqual(scope.toolPatterns, ['create']);
  assert.equal(scope.maxTools, 2);
});

test('explicit local-only authority wins on either side', () => {
  const concrete = { reason: 'packet', allowedServerSlugs: ['notion'] };
  assert.equal(intersectExternalMcpToolScopes(null, concrete), null);
  assert.equal(intersectExternalMcpToolScopes(concrete, null), null);
});
