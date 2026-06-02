/**
 * Run: npx tsx --test src/runtime/skill-installer.test.ts
 *
 * Regression coverage for normalizeRepoUrl. The function is the front
 * door for "paste anything and we'll install it" — any change that
 * silently breaks one of the accepted shapes shows up here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRepoUrl, deriveUpdateAvailable } from './skill-installer.js';

test('normalizeRepoUrl: full https URL', () => {
  const r = normalizeRepoUrl('https://github.com/nutlope/hallmark');
  assert.equal(r.url, 'https://github.com/nutlope/hallmark.git');
  assert.equal(r.owner, 'nutlope');
  assert.equal(r.repo, 'hallmark');
  assert.equal(r.basename, 'hallmark');
});

test('normalizeRepoUrl: https URL with .git suffix', () => {
  const r = normalizeRepoUrl('https://github.com/nutlope/hallmark.git');
  assert.equal(r.url, 'https://github.com/nutlope/hallmark.git');
});

test('normalizeRepoUrl: https URL with trailing slash', () => {
  const r = normalizeRepoUrl('https://github.com/nutlope/hallmark/');
  assert.equal(r.url, 'https://github.com/nutlope/hallmark.git');
});

test('normalizeRepoUrl: SSH form', () => {
  const r = normalizeRepoUrl('git@github.com:nutlope/hallmark.git');
  assert.equal(r.url, 'git@github.com:nutlope/hallmark.git');
  assert.equal(r.owner, 'nutlope');
});

test('normalizeRepoUrl: owner/repo shorthand', () => {
  const r = normalizeRepoUrl('nutlope/hallmark');
  assert.equal(r.url, 'https://github.com/nutlope/hallmark.git');
  assert.equal(r.owner, 'nutlope');
  assert.equal(r.repo, 'hallmark');
});

test('normalizeRepoUrl: owner/repo with leading @ (npm-scoped paste)', () => {
  const r = normalizeRepoUrl('@nutlope/hallmark');
  assert.equal(r.url, 'https://github.com/nutlope/hallmark.git');
});

test('normalizeRepoUrl: npx skills add command', () => {
  const r = normalizeRepoUrl('npx skills add nutlope/hallmark');
  assert.equal(r.url, 'https://github.com/nutlope/hallmark.git');
  assert.equal(r.owner, 'nutlope');
  assert.equal(r.repo, 'hallmark');
});

test('normalizeRepoUrl: npx -y skills add command', () => {
  const r = normalizeRepoUrl('npx -y skills add nutlope/hallmark');
  assert.equal(r.url, 'https://github.com/nutlope/hallmark.git');
});

test('normalizeRepoUrl: pnpm dlx skills add command', () => {
  const r = normalizeRepoUrl('pnpm dlx skills add nutlope/hallmark');
  assert.equal(r.url, 'https://github.com/nutlope/hallmark.git');
});

test('normalizeRepoUrl: bunx skills add command', () => {
  const r = normalizeRepoUrl('bunx skills add nutlope/hallmark');
  assert.equal(r.url, 'https://github.com/nutlope/hallmark.git');
});

test('normalizeRepoUrl: trimmed whitespace tolerated', () => {
  const r = normalizeRepoUrl('   nutlope/hallmark   ');
  assert.equal(r.url, 'https://github.com/nutlope/hallmark.git');
});

test('normalizeRepoUrl: case-insensitive npx prefix', () => {
  const r = normalizeRepoUrl('NPX skills add nutlope/hallmark');
  assert.equal(r.url, 'https://github.com/nutlope/hallmark.git');
});

test('normalizeRepoUrl: rejects empty input', () => {
  assert.throws(() => normalizeRepoUrl(''), /Empty/);
  assert.throws(() => normalizeRepoUrl('   '), /Empty/);
});

test('normalizeRepoUrl: rejects extremely long input', () => {
  const huge = 'a/'.repeat(500);
  assert.throws(() => normalizeRepoUrl(huge), /too long/);
});

test('normalizeRepoUrl: rejects bare name (no owner)', () => {
  assert.throws(() => normalizeRepoUrl('hallmark'), /Unsupported/);
});

test('normalizeRepoUrl: rejects 3-segment path', () => {
  assert.throws(() => normalizeRepoUrl('nutlope/hallmark/sub'), /Unsupported/);
});

test('normalizeRepoUrl: rejects random URL', () => {
  assert.throws(() => normalizeRepoUrl('https://www.usehallmark.com/'), /Unsupported/);
});

test('normalizeRepoUrl: rejects non-github https URL', () => {
  assert.throws(() => normalizeRepoUrl('https://gitlab.com/owner/repo'), /Unsupported/);
});

// ── deriveUpdateAvailable — the honest "is there an update" signal ──

test('deriveUpdateAvailable: differing shas → update available', () => {
  assert.equal(deriveUpdateAvailable('aaa111', 'bbb222'), true);
});

test('deriveUpdateAvailable: identical shas → no update', () => {
  assert.equal(deriveUpdateAvailable('aaa111', 'aaa111'), false);
});

test('deriveUpdateAvailable: missing remote sha → no update (can\'t claim one)', () => {
  assert.equal(deriveUpdateAvailable('aaa111', undefined), false);
});

test('deriveUpdateAvailable: missing installed baseline → no update', () => {
  assert.equal(deriveUpdateAvailable(undefined, 'bbb222'), false);
});

test('deriveUpdateAvailable: both missing → no update', () => {
  assert.equal(deriveUpdateAvailable(undefined, undefined), false);
});
