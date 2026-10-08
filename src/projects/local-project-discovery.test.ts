import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A synthetic profile and Clementine home: os.homedir() reads HOME on POSIX
// and USERPROFILE on Windows, both pointed at the fixture before any import.
const ROOT = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'clem-local-discovery-')));
const PROFILE = path.join(ROOT, 'profile');
const HOME = path.join(ROOT, 'clem-home');
mkdirSync(path.join(HOME, 'state'), { recursive: true });
process.env.HOME = PROFILE;
process.env.USERPROFILE = PROFILE;
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
delete process.env.WORKSPACE_DIRS;

function folder(relative: string, files: Record<string, string> = {}): string {
  const dir = path.join(PROFILE, relative);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith('/')) mkdirSync(path.join(dir, name), { recursive: true });
    else writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

// A tester's real layout (2026-10-08): the project sat directly in the home
// folder, where the default scan never looked.
const proposal = folder('proposal-builder', { '.git/': '', 'CLAUDE.md': '# Proposal builder\n' });
const notes = folder('research-notes', { 'AGENTS.md': 'How to work here\n' });
const documentsApp = folder(path.join('Documents', 'app'), { 'package.json': '{"description":"documents app"}' });
const githubDesktop = folder(path.join('Documents', 'GitHub', 'site'), { '.git/': '' });
folder('AppData', { 'package.json': '{}' });
folder('.cache', { 'package.json': '{}' });
folder('Pictures', { 'Makefile': '' });
folder('loose-folder', { 'todo.txt': 'nothing marks this as a project' });

const shared = await import('../tools/shared.js');
const local = await import('./local-projects.js');

after(() => { rmSync(ROOT, { recursive: true, force: true }); });

test('a project kept directly in the home folder is offered, not silently granted', () => {
  shared.clearWorkspaceProjectCache();
  const roster = shared.listWorkspaceProjects().map((row) => row.path);
  assert.ok(roster.includes(documentsApp), 'Documents stays a default work folder');
  assert.ok(roster.includes(githubDesktop), "GitHub Desktop's Documents\\GitHub is a default work folder");
  assert.equal(roster.includes(proposal), false, 'the home folder itself is never a work folder by default');
  const found = local.foundLocalProjects();
  assert.deepEqual(found.map((row) => row.path).sort(), [notes, proposal].sort(), 'home projects, by marker; system, hidden and unmarked folders are not offered');
  assert.ok(found.every((row) => row.found === true));
  assert.equal(found.find((row) => row.path === proposal)?.git, true);
});

test('linking a found project by name adds exactly that folder and keeps the defaults', () => {
  shared.clearWorkspaceProjectCache();
  const choice = local.chooseLocalProject('Proposal-Builder');
  assert.equal(choice.kind, 'found');
  assert.equal(choice.kind === 'found' && choice.project.found, true);
  const admitted = local.admitLocalProject((choice as { project: Parameters<typeof local.admitLocalProject>[0] }).project);
  assert.equal(admitted.found, undefined);
  const env = readFileSync(path.join(HOME, '.env'), 'utf8');
  const dirs = (/^WORKSPACE_DIRS=(.*)$/m.exec(env)?.[1] ?? '').split(',');
  assert.ok(dirs.includes(proposal), 'the linked folder is a work folder now');
  assert.ok(dirs.includes(path.join(PROFILE, 'Documents')), 'adding one folder never drops the defaults in use');
  assert.equal(dirs.includes(PROFILE), false, 'the rest of the home is not added');
  const roster = shared.listWorkspaceProjects().map((row) => row.path);
  assert.ok(roster.includes(proposal) && roster.includes(documentsApp));
  assert.equal(local.foundLocalProjects().some((row) => row.path === proposal), false, 'once added it is on the roster, not offered again');
  assert.deepEqual(shared.addWorkspaceDir(proposal), dirs, 'adding it again changes nothing');
});

test('an unknown name lists the roster and what was found; a comma path is refused', () => {
  shared.clearWorkspaceProjectCache();
  const choice = local.chooseLocalProject('no-such-project');
  assert.equal(choice.kind, 'not_found');
  const paths = choice.kind === 'not_found' ? choice.choices.map((row) => row.path) : [];
  assert.ok(paths.includes(notes) && paths.includes(documentsApp));
  assert.throws(() => shared.addWorkspaceDir(path.join(PROFILE, 'a,b')), /comma/);
});

test('Windows lists OneDrive projects without reading their cloud-only files', { skip: process.platform !== 'win32' }, () => {
  const oneDrive = path.join(PROFILE, 'OneDrive');
  process.env.OneDrive = oneDrive;
  try {
    const cloud = path.join(oneDrive, 'Documents', 'cloud-project');
    mkdirSync(cloud, { recursive: true });
    writeFileSync(path.join(cloud, 'package.json'), '{"description":"must not be read"}');
    // Back to no chosen list, so the defaults (OneDrive included) are in use.
    rmSync(path.join(HOME, '.env'), { force: true });
    shared.clearWorkspaceProjectCache();
    const row = shared.listWorkspaceProjects().find((entry) => entry.path === path.resolve(cloud));
    assert.ok(row, 'OneDrive Documents is a default work folder on Windows');
    assert.equal(row.description, '', 'a cloud-only file is never read to describe the project');
  } finally {
    delete process.env.OneDrive;
  }
});
