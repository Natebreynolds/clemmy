import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-workflow-code-certification-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;

const { WORKFLOWS_DIR } = await import('../memory/vault.js');
const { certifyWorkflowCode } = await import('./workflow-code-certification.js');

beforeEach(() => {
  rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
});

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function workflow(runner: string, source?: string) {
  return {
    name: 'code-cert',
    description: 'Certify deterministic code.',
    enabled: false,
    trigger: { manual: true },
    steps: [{
      id: 'transform',
      prompt: 'Transform the payload.',
      deterministic: { runner, ...(source === undefined ? {} : { source }) },
    }],
  } as never;
}

function script(slug: string, name: string, source: string): void {
  const dir = path.join(WORKFLOWS_DIR, slug, 'scripts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), source, 'utf-8');
}

test('certifies JavaScript syntax and emits an exact content bundle hash', () => {
  script('code-cert', 'transform.mjs', 'const input = await new Promise((resolve) => resolve({ ok: true }));\nconsole.log(JSON.stringify(input));\n');
  const first = certifyWorkflowCode(workflow('transform.mjs'), 'code-cert');

  assert.equal(first.ok, true);
  assert.equal(first.artifactCount, 1);
  assert.equal(first.readyCount, 1);
  assert.equal(first.artifacts[0].status, 'ready');
  assert.match(first.artifacts[0].sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.match(first.bundleHash ?? '', /^[a-f0-9]{64}$/);

  script('code-cert', 'transform.mjs', 'console.log("changed");\n');
  const changed = certifyWorkflowCode(workflow('transform.mjs'), 'code-cert');
  assert.notEqual(changed.bundleHash, first.bundleHash, 'certification identifies the exact code revision');
});

test('syntax-invalid and missing runners are hard certification blockers', () => {
  script('code-cert', 'broken.mjs', 'const = ;\n');
  const invalid = certifyWorkflowCode(workflow('broken.mjs'), 'code-cert');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.artifacts[0].status, 'invalid');
  assert.match(invalid.blockingReasons[0], /broken\.mjs/);

  const missing = certifyWorkflowCode(workflow('missing.mjs'), 'code-cert');
  assert.equal(missing.ok, false);
  assert.equal(missing.artifacts[0].status, 'missing');
  assert.match(missing.blockingReasons[0], /does not exist/);
});

test('inline authored code is certified before materialization and unsafe paths fail closed', () => {
  const inline = certifyWorkflowCode(
    workflow('generated.mjs', 'process.stdin.resume();\nprocess.stdin.on("end", () => console.log("{}"));\n'),
    'code-cert',
  );
  assert.equal(inline.ok, true);
  assert.equal(inline.artifacts[0].status, 'ready');

  const escape = certifyWorkflowCode(workflow('../outside.mjs'), 'code-cert');
  assert.equal(escape.ok, false);
  assert.equal(escape.artifacts[0].status, 'invalid');
  assert.match(escape.blockingReasons[0], /inside scripts|outside scripts/);
});

test('deduplicates a reusable runner referenced by both a step and a loop probe', () => {
  script('code-cert', 'probe.mjs', 'console.log(JSON.stringify({ done: true }));\n');
  const def = {
    name: 'code-cert',
    description: 'Shared deterministic helper.',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'prepare', prompt: 'Prepare.', deterministic: { runner: 'probe.mjs' } },
      {
        id: 'wait',
        prompt: 'Wait.',
        loopUntil: {
          probe: { runner: 'probe.mjs' },
          until: { type: 'object', required_keys: ['done'] },
        },
      },
    ],
  } as never;
  const cert = certifyWorkflowCode(def, 'code-cert');

  assert.equal(cert.artifactCount, 1);
  assert.deepEqual(cert.artifacts[0].stepIds, ['prepare', 'wait']);
  assert.deepEqual(cert.artifacts[0].uses, ['step', 'loop_probe']);
});

test('a workflow with no code artifacts has no bundle hash and remains valid', () => {
  const cert = certifyWorkflowCode({
    name: 'model-only',
    description: 'Model only.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'reason', prompt: 'Reason about it.' }],
  }, 'model-only');
  assert.equal(cert.ok, true);
  assert.equal(cert.artifactCount, 0);
  assert.equal(cert.bundleHash, null);
});
