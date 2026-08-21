/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/sdk-carriers.test.ts
 *
 * Vendor SDKs are transports on the one kernel. Hardening must not strip them.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-sdk-carriers-'));
process.env.CLEMENTINE_HOME = HOME;

const { query } = await import('@anthropic-ai/claude-agent-sdk');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { configureHarnessRuntime, extractAccountIdFromJwt } = await import('./codex-client.js');

test('Claude Agent SDK query transport is callable', () => {
  assert.equal(typeof query, 'function');
});

test('MCP SDK Client is callable', () => {
  const client = new Client({ name: 'clem-sdk-carrier-test', version: '0.0.0' });
  assert.equal(typeof client.connect, 'function');
  assert.equal(typeof client.listTools, 'function');
});

test('Codex OAuth wallet remains the harness model transport', () => {
  assert.equal(typeof configureHarnessRuntime, 'function');
  assert.equal(extractAccountIdFromJwt('not-a-jwt'), null);
});
