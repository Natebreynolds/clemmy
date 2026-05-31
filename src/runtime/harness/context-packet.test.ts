/**
 * Run: npx tsx --test src/runtime/harness/context-packet.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-context-packet-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

mkdirSync(path.join(TMP_HOME, 'skills', 'proposal-builder'), { recursive: true });
writeFileSync(
  path.join(TMP_HOME, 'skills', 'proposal-builder', 'SKILL.md'),
  [
    '---',
    'name: proposal-builder',
    'description: Build branded SEO audit proposals from site research and meeting notes',
    '---',
    '',
    'Use DataForSEO, local notes, and the proposal HTML framework.',
  ].join('\n'),
  'utf-8',
);

mkdirSync(path.join(TMP_HOME, 'vault', '00-System', 'workflows', 'seo-proposal', 'scripts'), { recursive: true });
writeFileSync(
  path.join(TMP_HOME, 'vault', '00-System', 'workflows', 'seo-proposal', 'SKILL.md'),
  [
    '---',
    'name: SEO Proposal Workflow',
    'description: Build an SEO proposal from website research',
    'enabled: true',
    'when_to_use: Use when the user asks to build a branded SEO audit or proposal from a website.',
    'steps:',
    '  - id: research',
    '---',
    '',
    '## step: research',
    '',
    'Research the site and produce proposal inputs.',
  ].join('\n'),
  'utf-8',
);

const { buildAgentContextPacket } = await import('./context-packet.js');

test.after(() => {
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

test('context packet ranks relevant skills and workflows for the current request', () => {
  const packet = buildAgentContextPacket(
    'Can you build a branded SEO audit proposal from this website and my notes?',
    { enabled: true, hitCount: 2, source: 'hybrid', injected: true },
  );

  assert.equal(packet.memory.hitCount, 2);
  assert.equal(packet.skills[0]?.name, 'proposal-builder');
  assert.equal(packet.workflows[0]?.name, 'seo-proposal');
  assert.deepEqual(packet.toolScope.allowedServerSlugs, ['dataforseo']);
  assert.match(packet.text, /AGENT CONTEXT PACKET/);
  assert.match(packet.text, /External MCP scope: dataforseo/);
  assert.match(packet.text, /call skill_read/);
  assert.match(packet.text, /reusable-process candidates/);
});
