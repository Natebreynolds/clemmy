/**
 * Run: npx tsx --test src/runtime/harness/pending-action-view.test.ts
 *
 * Ask-first batch regression: a run_batch propose approval rendered as a bare
 * "Approve: run_batch: propose" — the plan (objective, count, recipients) was
 * in the payload but no pending action existed yet, so the rich card never
 * rendered. The view is now synthesized straight from the plan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-pav-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { pendingActionApprovalViewFromArgs } = await import('./pending-action-view.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

test('synthesizes a rich view from a run_batch propose plan (no pending_action_id)', () => {
  const view = pendingActionApprovalViewFromArgs({
    action: 'propose',
    plan: {
      tool: 'composio_execute_tool',
      composioSlug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
      sideEffect: 'send',
      objective: 'Send priority-account reactivation emails 11-20',
      items: [
        { id: 'ml-11-a@site.example', args: { to_email: 'a@site.example', subject: 'Hi' } },
        { id: 'ml-12-b@personal.example', args: { to_email: 'b@personal.example', subject: 'Hi' } },
      ],
    },
  });
  assert.ok(view, 'view synthesized from the plan');
  assert.equal(view!.kind, 'external_send');
  assert.equal(view!.toolName, 'run_batch');
  assert.match(view!.title, /Send priority-account reactivation emails 11-20/);
  assert.match(view!.targetSummary, /2 item\(s\)/);
  assert.match(view!.targetSummary, /ml-11-a@site\.example/);
  assert.match(view!.risk, /2 irreversible send/);
  assert.match(view!.preview, /a@site\.example/);
});

test('no plan and no pending_action_id → undefined (unchanged contract)', () => {
  assert.equal(pendingActionApprovalViewFromArgs({ action: 'status' }), undefined);
  assert.equal(pendingActionApprovalViewFromArgs(null), undefined);
  assert.equal(pendingActionApprovalViewFromArgs({ plan: { items: [] } }), undefined);
});

test('a queued command names the local files it would send, and why one cannot be sent', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { pendingActionOutgoingFiles } = await import('./pending-action-view.js');
  const folder = path.join(TMP_HOME, 'outputs');
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'deck.pdf'), 'x'.repeat(3000));
  const files = pendingActionOutgoingFiles({
    toolName: 'run_shell_command', kind: 'shell_command',
    payload: { command: `curl -F file=@deck.pdf -F notes=@missing.txt https://upload.example.test`, cwd: folder },
  } as never);
  assert.deepEqual(files, [
    'deck.pdf · 3 KB · in outputs',
    `missing.txt: cannot be sent (There is no file at ${path.join(folder, 'missing.txt')}.)`,
  ]);
  assert.deepEqual(pendingActionOutgoingFiles({ toolName: 'run_shell_command', kind: 'shell_command', payload: { command: 'curl -d ping=1 https://x.test' } } as never), []);
  assert.deepEqual(pendingActionOutgoingFiles({ toolName: 'outlook_send_email', kind: 'external_send', payload: { body: 'x' } } as never), []);
});
