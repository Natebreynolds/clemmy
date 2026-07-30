/**
 * Run: npx tsx --test src/tools/workspace-capabilities.test.ts
 *
 * Pins WorkspaceProject capability detection: slash commands (including one
 * nesting level of Claude Code "dir:name" namespacing), skills, .mcp.json,
 * and AGENTS.md must surface on the cached project list — this is the data
 * Clem's routing memory and the Projects panel chips are built from.
 * Offline, deterministic, per-test temp home.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-workspace-caps-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { listWorkspaceProjects, clearWorkspaceProjectCache, updateEnvKey } = await import('./shared.js');

function seedProject(root: string, name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, description: `${name} fixture` }));
  return dir;
}

test('workspace capabilities: commands, skills, mcp, AGENTS.md are detected', (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'clemmy-caps-ws-'));
  t.after(() => {
    rmSync(workspace, { recursive: true, force: true });
    updateEnvKey('WORKSPACE_DIRS', '');
    clearWorkspaceProjectCache();
  });

  const rich = seedProject(workspace, 'proposal-fixture');
  mkdirSync(path.join(rich, '.claude', 'commands', 'audits'), { recursive: true });
  writeFileSync(path.join(rich, '.claude', 'commands', 'seo-audit.md'), '# seo audit');
  writeFileSync(path.join(rich, '.claude', 'commands', 'build-brief.md'), '# brief');
  writeFileSync(path.join(rich, '.claude', 'commands', 'audits', 'deep.md'), '# nested');
  writeFileSync(path.join(rich, '.claude', 'commands', 'notes.txt'), 'not a command');
  mkdirSync(path.join(rich, '.claude', 'skills', 'law-firm-redesign'), { recursive: true });
  writeFileSync(path.join(rich, '.mcp.json'), '{}');
  writeFileSync(path.join(rich, 'AGENTS.md'), '# codex instructions');

  const plain = seedProject(workspace, 'plain-fixture');

  updateEnvKey('WORKSPACE_DIRS', workspace);
  clearWorkspaceProjectCache();
  const projects = listWorkspaceProjects();

  const richProject = projects.find((p) => p.path === rich);
  assert.ok(richProject, 'rich fixture project should be detected');
  assert.deepEqual(richProject.capabilities.commands, ['audits:deep', 'build-brief', 'seo-audit']);
  assert.deepEqual(richProject.capabilities.skills, ['law-firm-redesign']);
  assert.equal(richProject.capabilities.hasMcp, true);
  assert.equal(richProject.capabilities.hasAgentsMd, true);

  const plainProject = projects.find((p) => p.path === plain);
  assert.ok(plainProject, 'plain fixture project should be detected');
  assert.deepEqual(plainProject.capabilities, { commands: [], skills: [], hasMcp: false, hasAgentsMd: false });
});
