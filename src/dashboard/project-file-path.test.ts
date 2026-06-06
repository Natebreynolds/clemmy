import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveProjectFilePath } from './console-routes.js';

const HOME = '/Users/tester';
const WS = ['/Users/tester/Developer', '/Users/tester/work/clientA'];

test('allows the workspace root itself', () => {
  const g = resolveProjectFilePath(WS, HOME, '/Users/tester/Developer', '');
  assert.equal(g.ok, true);
  if (g.ok) assert.equal(g.target, '/Users/tester/Developer');
});

test('allows a project directly under a workspace dir', () => {
  const g = resolveProjectFilePath(WS, HOME, '/Users/tester/Developer/myproj', 'src/index.ts');
  assert.equal(g.ok, true);
  if (g.ok) assert.equal(g.target, '/Users/tester/Developer/myproj/src/index.ts');
});

test('rejects a root outside every workspace dir', () => {
  const g = resolveProjectFilePath(WS, HOME, '/etc', 'passwd');
  assert.equal(g.ok, false);
  if (!g.ok) assert.equal(g.status, 403);
});

test('rejects ../ traversal that escapes the project root', () => {
  const g = resolveProjectFilePath(WS, HOME, '/Users/tester/Developer/myproj', '../../../../etc/passwd');
  assert.equal(g.ok, false);
  if (!g.ok) assert.equal(g.status, 400);
});

test('rejects a sneaky sibling-prefix escape', () => {
  // /Users/tester/Developer-secret must NOT be treated as under /Users/tester/Developer
  const g = resolveProjectFilePath(WS, HOME, '/Users/tester/Developer-secret', 'x');
  assert.equal(g.ok, false);
  if (!g.ok) assert.equal(g.status, 403);
});

test('rejects an empty root', () => {
  const g = resolveProjectFilePath(WS, HOME, '', 'anything');
  assert.equal(g.ok, false);
  if (!g.ok) assert.equal(g.status, 400);
});

test('expands a ~-prefixed root against homedir', () => {
  const g = resolveProjectFilePath(WS, HOME, '~/Developer/proj', 'a.txt');
  assert.equal(g.ok, true);
  if (g.ok) assert.equal(g.target, path.join('/Users/tester/Developer/proj', 'a.txt'));
});

test('normalizes interior ../ that stays within root', () => {
  const g = resolveProjectFilePath(WS, HOME, '/Users/tester/Developer/proj', 'src/../README.md');
  assert.equal(g.ok, true);
  if (g.ok) assert.equal(g.target, '/Users/tester/Developer/proj/README.md');
});
