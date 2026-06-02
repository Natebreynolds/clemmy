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
  ]) {
    assert.equal(shellCommandNeedsApproval(cmd), false, `should NOT gate: ${cmd}`);
  }
});
