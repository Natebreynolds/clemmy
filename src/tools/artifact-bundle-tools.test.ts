import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-artifact-bundle-tool-'));
process.env.CLEMENTINE_HOME = TEST_HOME;

const { registerArtifactBundleTools } = await import('./artifact-bundle-tools.js');

type Handler = (args: {
  bundle_id: string;
  mode: 'content_addressed';
  files: Array<{ path: string; content: string }>;
}) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;

function capture(): { shape: Record<string, unknown>; handler: Handler } {
  let shape: Record<string, unknown> | undefined;
  let handler: Handler | undefined;
  registerArtifactBundleTools({
    tool(_name: string, _description: string, parameters: Record<string, unknown>, execute: Handler) {
      shape = parameters;
      handler = execute;
    },
  } as never);
  assert.ok(shape && handler);
  return { shape, handler };
}

test.after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('artifact_bundle_save exposes the closed safety mode and returns an exact reusable directory', async () => {
  const { shape, handler } = capture();
  assert.ok(shape.mode);
  assert.ok(shape.files);

  const args = {
    bundle_id: 'workflow-site',
    mode: 'content_addressed' as const,
    files: [
      { path: 'index.html', content: '<h1>Workflow site</h1>' },
      { path: 'data.json', content: '{"ok":true}' },
    ],
  };
  const first = JSON.parse((await handler(args)).content[0]!.text) as {
    created: boolean;
    revisionDigest: string;
    directory: string;
  };
  const replay = JSON.parse((await handler(args)).content[0]!.text) as typeof first;
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.revisionDigest, first.revisionDigest);
  assert.equal(replay.directory, first.directory);
});
