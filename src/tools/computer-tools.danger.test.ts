/**
 * Run: npx tsx --test src/tools/computer-tools.danger.test.ts
 *
 * G6 — a static-site / serverless DEPLOY is a public external write that should
 * pause for approval the first time it's run ad-hoc in chat. (A scheduled
 * workflow run auto-approves it via the step's ['*'] plan-scope, so the daily
 * 8am redeploy is NOT blocked — that path doesn't go through this gate.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellCommandNeedsApproval } from './computer-tools.js';

test('G6: deploy commands require approval', () => {
  for (const cmd of [
    'netlify deploy --dir dist --prod --site abc123',
    'netlify deploy --dir dist --prod --json --create-site my-site',
    'vercel deploy --prod',
    'vercel --prod',
    'wrangler deploy',
    'firebase deploy',
    'surge ./dist my-site.surge.sh',
  ]) {
    assert.equal(shellCommandNeedsApproval(cmd), true, `should gate: ${cmd}`);
  }
});

test('G6: read-only / harmless commands still do NOT require approval (no over-gating)', () => {
  for (const cmd of [
    'netlify --version',
    'netlify status',
    'netlify sites:list --json',
    'firecrawl --version',
    'echo hello',
    'ls -la',
    // Salesforce READS — `sf org display` prints org/token info, `sf data
    // query` is a SOQL SELECT. Neither mutates. Regression for a read-only
    // prospect pull (sf org display && sf data query) parking for approval
    // because `sf org display` was lumped with the org mutations (2026-06-17).
    'sf org display --json',
    'sf org display --json && sf data query --json --query "SELECT Id, Name FROM Account WHERE Market_Leader__c = TRUE LIMIT 60"',
    'sf data query --query "SELECT Id FROM Contact"',
  ]) {
    assert.equal(shellCommandNeedsApproval(cmd), false, `should NOT gate: ${cmd}`);
  }
});

test('G6: Salesforce data/org MUTATIONS still require approval (no under-gating)', () => {
  for (const cmd of [
    'sf data update record --sobject Account --record-id 001 --values "Name=X"',
    'sf data delete record --sobject Account --record-id 001',
    // `create` was MISSING from the alternation — this exact shape wrote real
    // CRM Tasks with zero approval (proof converse-first, 2026-07-02).
    "sf data create record --sobject Task --values \"WhatId=006 Subject='Follow up'\" --target-org me@org.com",
    'sf data import tree --files data.json',
    'sf org login web',
    'sf org delete scratch --target-org my-org',
  ]) {
    assert.equal(shellCommandNeedsApproval(cmd), true, `should gate: ${cmd}`);
  }
});

test('literal nested shell mutations require approval while nested reads/builds stay productive', () => {
  for (const cmd of [
    "bash -lc 'curl -X POST https://api.example.com/send -d x=1'",
    `sh -c "git push origin main"`,
    `zsh -lc "bash -c 'rm -rf dist'"`,
    `bash -lc "$RUNTIME_COMMAND"`,
    `env FOO=x bash -lc "curl -X POST https://api.example.com/send -d x=1"`,
    `/usr/bin/env -i sh -c "git push origin main"`,
    `command bash -c "rm -rf dist"`,
    `env -S "bash -lc 'curl -X POST https://api.example.com/send -d x=1'"`,
    `exec bash -c "curl -X POST https://api.example.com/send -d x=1"`,
    `nohup bash -c "curl -X POST https://api.example.com/send -d x=1"`,
    `nice sh -c "git push origin main"`,
    `timeout 30s bash -c "rm -rf dist"`,
    `time bash -c "curl -X POST https://api.example.com/send -d x=1"`,
    `sudo bash -c "curl -X POST https://api.example.com/send -d x=1"`,
  ]) {
    assert.equal(shellCommandNeedsApproval(cmd), true, `should gate nested/opaque execution: ${cmd}`);
  }
  for (const cmd of [
    "bash -lc 'npm test -- --runInBand'",
    `zsh -c "npx tsc --noEmit"`,
    `sh -lc "ffmpeg -i a.mov b.mp4"`,
    `env NODE_ENV=test bash -lc "npm test -- --runInBand"`,
    `command zsh -c "npx tsc --noEmit"`,
    `timeout 30s bash -c "npx tsc --noEmit"`,
    `time -p bash -c "npm test -- --runInBand"`,
    `nice bash -c "ffmpeg -i a.mov b.mp4"`,
    `echo "bash -lc 'curl -X POST https://example.com -d x=1'"`,
    `echo "env FOO=x bash -lc 'curl -X POST https://example.com -d x=1'"`,
  ]) {
    assert.equal(shellCommandNeedsApproval(cmd), false, `should preserve nested productive work/data: ${cmd}`);
  }
});
