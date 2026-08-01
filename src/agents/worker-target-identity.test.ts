/**
 * Run: npx tsx --test src/agents/worker-target-identity.test.ts
 *
 * Pinned against the verbatim item labels from the live 2026-07-31 run where
 * six firms were scraped two or three times across dispatch waves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameWorkerTarget, targetHost, workerTargetIdentity } from './worker-target-identity.js';

test('the same firm across three waves is ONE unit of work despite relabeling', () => {
  // Verbatim from runs.jsonl, waves 22:47 / 22:54 / 22:58.
  const wave1 = 'Colucci, Colucci & Marcus | https://www.coluccilaw.com/ | position 12 for Boston injury law firm';
  const wave2 = 'Colucci Colucci & Marcus, P.C. | https://www.coluccilaw.com/ | Boston-area PI candidate from captured SERP corpus';
  const wave3 = 'Colucci, Colucci & Marcus, P.C. | https://www.coluccilaw.com/';
  assert.ok(sameWorkerTarget(wave1, wave2));
  assert.ok(sameWorkerTarget(wave2, wave3));
  assert.equal(workerTargetIdentity(wave1), 'host:coluccilaw.com');
});

test('an apostrophe that changed shape between waves no longer defeats matching', () => {
  // Straight quote in wave 22:54, curly in wave 22:58 — the run report flagged
  // this as a silent duplicate-row risk.
  const straight = "d'Oliveira & Associates Boston | https://www.good-legal-advice.com/massachusetts/boston/ | captured SERP position 12";
  const curly = 'd’Oliveira & Associates | https://www.good-legal-advice.com/massachusetts/boston/';
  assert.ok(sameWorkerTarget(straight, curly), 'domain identity is immune to name drift');

  // And without any URL, the fold still collapses both apostrophe forms.
  assert.ok(sameWorkerTarget("d'Oliveira & Associates", 'd’Oliveira & Associates'));
});

test('different firms are never conflated', () => {
  const a = 'Larson Law Boston | https://www.dlarsonlaw.com/';
  const b = 'Diller Law LLP | https://www.dillerlaw.com/';
  assert.ok(!sameWorkerTarget(a, b));
  // Same firm name, different sites → different work.
  assert.ok(!sameWorkerTarget('Smith Law | https://smithlaw.com/', 'Smith Law | https://smith-law.net/'));
});

test('host extraction ignores www and trailing punctuation, and survives a bare host', () => {
  assert.equal(targetHost('Firm | https://www.example.com/path?q=1'), 'example.com');
  assert.equal(targetHost('see topdoglaw.com for details'), 'topdoglaw.com');
  assert.equal(targetHost('no site named here'), null);
});

test('an unidentifiable item never matches anything, including itself', () => {
  assert.equal(workerTargetIdentity('   '), '');
  assert.ok(!sameWorkerTarget('', ''), 'empty identity must never be treated as a match');
  assert.ok(!sameWorkerTarget('!!!', '???'));
});

test('non-URL items still dedupe on a normalized text fold', () => {
  assert.ok(sameWorkerTarget('Boston personal injury lawyer', 'boston  personal-injury   lawyer'));
  assert.ok(!sameWorkerTarget('Boston personal injury lawyer', 'Boston car accident lawyer'));
});
