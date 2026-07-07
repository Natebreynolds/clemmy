import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'clemmy-workflow-import-test-'));
process.env.CLEMENTINE_HOME = path.join(tmp, 'home');
mkdirSync(process.env.CLEMENTINE_HOME, { recursive: true });

const {
  importWorkflowFrameworkFromDirectory,
} = await import('./workflow-installer.js');
const { readWorkflow } = await import('../memory/workflow-store.js');
const { fireWorkflowSystemEvent, closeWorkflowTriggerDbForTest } = await import('../execution/workflow-trigger-engine.js');

function writeWorkflowPackage(root: string): void {
  const workflowDir = path.join(root, '.clementine', 'workflows', 'sample-brief');
  mkdirSync(path.join(workflowDir, 'references'), { recursive: true });
  mkdirSync(path.join(workflowDir, 'runs'), { recursive: true });
  writeFileSync(
    path.join(workflowDir, 'SKILL.md'),
    [
      '---',
      'name: sample-brief',
      'description: Sample imported workflow',
      'enabled: false',
      'trigger:',
      '  manual: true',
      'steps:',
      '  - id: normalize',
      '  - id: research',
      '    dependsOn:',
      '      - normalize',
      '    uses_skill: seo-audit',
      'synthesis:',
      '  prompt: Return JSON only.',
      '---',
      'Build a sample brief.',
      '',
      '## step: normalize',
      '',
      'Normalize input.',
      '',
      '## step: research',
      '',
      'Research using {{steps.normalize.output}}.',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(path.join(workflowDir, 'references', 'guide.md'), '# Guide\n', 'utf-8');
  writeFileSync(path.join(workflowDir, 'runs', 'old.jsonl'), 'do not import\n', 'utf-8');
}

test.after(() => {
  closeWorkflowTriggerDbForTest();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('importWorkflowFrameworkFromDirectory dry run previews workflows without copying', () => {
  const source = path.join(tmp, 'dry-source');
  writeWorkflowPackage(source);

  const result = importWorkflowFrameworkFromDirectory(source, { dryRun: true });

  assert.equal(result.discovered.length, 1);
  assert.equal(result.discovered[0].name, 'sample-brief');
  assert.equal(result.installed.length, 0);
  assert.match(result.skipped[0].reason, /would install/);
  assert.equal(readWorkflow('sample-brief'), null);
});

test('importWorkflowFrameworkFromDirectory installs workflow files and skips runs', () => {
  const source = path.join(tmp, 'install-source');
  writeWorkflowPackage(source);

  const result = importWorkflowFrameworkFromDirectory(source);

  assert.equal(result.installed.length, 1);
  const workflow = readWorkflow('sample-brief');
  assert.ok(workflow, 'workflow should read back');
  assert.equal(workflow?.data.steps[1].usesSkill, 'seo-audit');
  assert.ok(existsSync(path.join(workflow!.dir, 'references', 'guide.md')));
  assert.ok(existsSync(path.join(workflow!.dir, '.clementine-source.json')));
  assert.equal(existsSync(path.join(workflow!.dir, 'runs', 'old.jsonl')), false);

  const sourceMeta = JSON.parse(readFileSync(path.join(workflow!.dir, '.clementine-source.json'), 'utf-8')) as Record<string, unknown>;
  assert.equal(sourceMeta.kind, 'workflow-framework');
});

test('importWorkflowFrameworkFromDirectory syncs imported event triggers immediately', () => {
  closeWorkflowTriggerDbForTest();
  const source = path.join(tmp, 'event-source');
  const workflowDir = path.join(source, '.clementine', 'workflows', 'imported-event-flow');
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(
    path.join(workflowDir, 'SKILL.md'),
    [
      '---',
      'name: Imported Event Flow',
      'description: Imported event trigger workflow',
      'enabled: true',
      'trigger:',
      '  events:',
      '    - type: imported.lead.created',
      '      dedupeKey: lead-{{payload.id}}',
      'steps:',
      '  - id: handle',
      '    prompt: Handle the imported lead.',
      '---',
      'Handle imported leads.',
      '',
    ].join('\n'),
    'utf-8',
  );

  const result = importWorkflowFrameworkFromDirectory(source);
  assert.equal(result.installed.length, 1);

  const fired = fireWorkflowSystemEvent('imported.lead.created', { id: 'L-100' })
    .filter((entry) => entry.workflowName === 'imported-event-flow');
  assert.equal(fired.length, 1);
  assert.equal(fired[0].status, 'queued');
});

test('importWorkflowFrameworkFromDirectory protects existing workflow unless overwrite is true', () => {
  const source = path.join(tmp, 'conflict-source');
  writeWorkflowPackage(source);

  const skipped = importWorkflowFrameworkFromDirectory(source);
  assert.equal(skipped.installed.length, 0);
  assert.match(skipped.skipped[0].reason, /already exists/);

  const overwritten = importWorkflowFrameworkFromDirectory(source, { overwrite: true });
  assert.equal(overwritten.installed.length, 1);
});
