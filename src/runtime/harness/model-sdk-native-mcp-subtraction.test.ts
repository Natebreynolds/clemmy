/**
 * Provider SDKs are model transports, not execution owners. Third-party MCP
 * servers may be discovered and selected, but their body must cross the local
 * call_tool/work_call carrier so Clementine owns one logical call, one physical
 * attempt, consent, and settlement.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-native-mcp-cut-'));

const ROOT = path.resolve(import.meta.dirname, '../../..');

function source(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

test('no production Agent factory attaches an executable external MCP server', () => {
  const factories = [
    'src/agents/orchestrator.ts',
    'src/agents/sub-agents.ts',
    'src/agents/workflow-step-agent.ts',
  ];
  for (const file of factories) {
    const text = source(file);
    assert.doesNotMatch(text, /getOrCreateExternalMcpServers\s*\(/, file);
  }

  const openai = source('src/runtime/openai.ts');
  assert.doesNotMatch(openai, /getOrCreateConfiguredMcpServers|mcpServers\s*:/,
    'the legacy OpenAI runtime cannot hand raw configured servers to its Agent');
});

test('Claude native MCP projection is permanently zero-width', async () => {
  const { buildScopedNativeMcpServers } = await import('./claude-agent-sdk.js');
  for (const value of [undefined, '', 'dataforseo__serp_organic_live_advanced']) {
    assert.deepEqual(buildScopedNativeMcpServers(value), {});
    assert.deepEqual(buildScopedNativeMcpServers(value, {
      mode: 'resolved_tools',
      scope: { reason: 'exact', allowedServerSlugs: ['dataforseo'], maxTools: 1 },
    }), {});
  }
});

test('CLI model and guest surfaces cannot inherit executable MCP configuration', async () => {
  const { buildClaudeHeadlessArgs } = await import('./claude-headless-model.js');
  const headless = buildClaudeHeadlessArgs('sonnet', () => false);
  assert.deepEqual(
    headless.slice(headless.indexOf('--tools'), headless.indexOf('--tools') + 2),
    ['--tools', ''],
    'the compatibility-minimal Claude model wire remains tool-less',
  );

  const { buildGuestArgs } = await import('../../execution/guest-harness.js');
  const claudeGuest = buildGuestArgs({
    harness: 'claude',
    projectPath: process.env.CLEMENTINE_HOME!,
    prompt: 'inspect the project',
  });
  assert.ok(claudeGuest.includes('--strict-mcp-config'));
  assert.equal(claudeGuest.some((arg) => arg.startsWith('mcp__')), false);

  const codexGuest = buildGuestArgs({
    harness: 'codex',
    projectPath: process.env.CLEMENTINE_HOME!,
    prompt: 'inspect the project',
  });
  assert.ok(codexGuest.includes('--ignore-user-config'));
  assert.deepEqual(
    codexGuest.slice(codexGuest.indexOf('-c'), codexGuest.indexOf('-c') + 2),
    ['-c', 'mcp_servers={}'],
  );
});
