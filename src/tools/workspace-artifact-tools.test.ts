/**
 * Run: npx tsx --test src/tools/workspace-artifact-tools.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-workspace-artifact-tools-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { registerWorkspaceArtifactTools, queryWorkspaceArtifact } = await import('./workspace-artifact-tools.js');

type ArtifactHandler = (input: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;

function captureArtifactQueryHandler(): ArtifactHandler {
  let handler: ArtifactHandler | null = null;
  registerWorkspaceArtifactTools({
    tool: (name: string, _description: string, _schema: unknown, cb: ArtifactHandler) => {
      if (name === 'workspace_artifact_query') handler = cb;
    },
  } as any);
  assert.ok(handler);
  return handler;
}

function writeArtifact(name: string, value: unknown): string {
  const filePath = path.join(TMP_HOME, 'vault', '00-System', 'workflows', 'Query Test', 'runs', 'run-1', 'workspace', 'artifacts', name);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
  return filePath;
}

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('workspace_artifact_query reaches tail rows in a large offloaded context artifact', async () => {
  const records = Array.from({ length: 4000 }, (_, i) => ({
    id: `A${i}`,
    email: `partner${i}@firm.example`,
    account: { domain: `firm-${i}.example` },
    notes: 'x'.repeat(60),
  }));
  const filePath = writeArtifact('context-upstream.fetch_accounts.json', { rows: records, count: records.length });
  assert.ok(JSON.stringify({ rows: records }).length > 200_000, 'fixture must exceed the old practical inline/read cap');

  const handler = captureArtifactQueryHandler();
  const result = await handler({
    path: filePath,
    json_path: 'rows',
    offset: 3995,
    limit: 5,
    fields: ['id', 'email', 'account.domain'],
  });

  const text = result.content[0].text;
  assert.match(text, /showing 5 record\(s\) \[3995-4000\] of 4000 matching \(4000 total\)/);
  assert.match(text, /partner3999@firm\.example/);
  assert.match(text, /account\.domain/);
  assert.doesNotMatch(text, /partner0@firm\.example/, 'query should not dump the full artifact');
});

test('workspace_artifact_query filters and projects without raw artifact hydration', () => {
  const filePath = writeArtifact('context-upstream.sheet.json', {
    rows: [
      { domain: 'alpha.example', score: 4, owner: { email: 'a@example.com' } },
      { domain: 'beta.example', score: 9, owner: { email: 'b@example.com' } },
      { domain: 'gamma.example', score: 7, owner: { email: 'g@example.com' } },
    ],
  });

  const text = queryWorkspaceArtifact({
    path: filePath,
    json_path: 'rows',
    filter_field: 'domain',
    filter_contains: 'beta',
    fields: ['domain', 'owner.email'],
  });

  assert.match(text, /showing 1 record/);
  assert.match(text, /beta\.example/);
  assert.match(text, /b@example\.com/);
  assert.doesNotMatch(text, /alpha\.example/);
});

test('workspace_artifact_query refuses paths outside Clementine/workspace roots', () => {
  const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-outside-artifact-'));
  const outside = path.join(outsideDir, 'payload.json');
  writeFileSync(outside, JSON.stringify([{ ok: true }]), 'utf-8');
  try {
    assert.throws(
      () => queryWorkspaceArtifact({ path: outside }),
      /outside allowed artifact roots/,
    );
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
  }
});
