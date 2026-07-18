/**
 * Run: npx tsx --test src/memory/skill-distiller-recovery.test.ts
 *
 * Recovery procedures from FAILED trajectories (Lane D Phase 1). Today only
 * successes distill; deriveRecoveryTip closes the asymmetry — a Composio slug,
 * or a CLI resolved through local_cli_list/local_cli_probe, that FAILED
 * non-transiently and then demonstrably succeeded is worth remembering. A
 * TRANSIENT blip (429/timeout) is NOT a lesson (poison guard).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessNovelty, deriveRecoveryTip } from './skill-distiller.js';
import type { TraceToolCall } from '../execution/trace-to-workflow.js';

const call = (slug: string, args: string, callId: string): TraceToolCall => ({
  tool: 'composio_execute_tool', args, callId, slug,
});

test('failed-then-corrected (non-transient) → recovery tip keyed to the error signature', () => {
  const calls = [
    call('GMAIL_SEND_EMAIL', '{"to":"a@b.com","subject":"s"}', 'c1'),
    call('GMAIL_SEND_EMAIL', '{"to":"a@b.com","subject":"s","body":"b"}', 'c2'),
  ];
  const returns = new Map([
    ['c1', 'could not send: missing required field body'],
    ['c2', 'sent ok'],
  ]);
  const tip = deriveRecoveryTip(calls, returns);
  assert.ok(tip, 'a corrected retry should mint a tip');
  assert.match(tip!, /GMAIL_SEND_EMAIL/);
  assert.match(tip!, /retry with corrected args/);
  assert.match(tip!, /missing required field body/);
});

test('TRANSIENT failure (timed out) retried → NO tip (poison guard)', () => {
  const calls = [
    call('GMAIL_SEND_EMAIL', '{"to":"a@b.com"}', 'c1'),
    call('GMAIL_SEND_EMAIL', '{"to":"a@b.com","retry":true}', 'c2'),
  ];
  // evidenceLooksFailedOrBlocked TRUE ("could not send") AND isTransientFailure TRUE ("timed out")
  const returns = new Map([['c1', 'could not send: request timed out'], ['c2', 'sent ok']]);
  assert.equal(deriveRecoveryTip(calls, returns), null);
});

test('single call (no retry) → null (nothing was figured out)', () => {
  const calls = [call('GMAIL_SEND_EMAIL', '{"to":"a@b.com"}', 'c1')];
  const returns = new Map([['c1', 'could not send: missing body']]);
  assert.equal(deriveRecoveryTip(calls, returns), null);
});

test('identical re-fire (same args twice) → null (a loop, not a corrected retry)', () => {
  const calls = [
    call('GMAIL_SEND_EMAIL', '{"to":"a@b.com"}', 'c1'),
    call('GMAIL_SEND_EMAIL', '{"to":"a@b.com"}', 'c2'),
  ];
  const returns = new Map([['c1', 'could not send: missing body'], ['c2', 'could not send: missing body']]);
  assert.equal(deriveRecoveryTip(calls, returns), null);
});

test('success-only trajectory → null', () => {
  const calls = [
    call('GMAIL_SEND_EMAIL', '{"to":"a@b.com"}', 'c1'),
    call('GMAIL_SEND_EMAIL', '{"to":"x@y.com"}', 'c2'),
  ];
  const returns = new Map([['c1', 'sent ok'], ['c2', 'sent ok']]);
  assert.equal(deriveRecoveryTip(calls, returns), null);
});

test('npx materialization failure → CLI discovery → resolved binary success becomes a reusable recovery', () => {
  const calls: TraceToolCall[] = [
    { tool: 'run_shell_command', args: JSON.stringify({ command: 'npx hyperframes-cli render composition.html' }), callId: 'c1' },
    { tool: 'local_cli_list', args: '{}', callId: 'c2' },
    { tool: 'local_cli_probe', args: JSON.stringify({ name: 'hyperframes' }), callId: 'c3' },
    { tool: 'run_shell_command', args: JSON.stringify({ command: '/opt/clementine/bin/hyperframes render composition.html' }), callId: 'c4' },
  ];
  const returns = new Map([
    ['c1', 'exit_code: 1\nstderr:\nnpm ERR! code EACCES: could not determine executable'],
    ['c2', 'hyperframes installed at /opt/clementine/bin/hyperframes'],
    ['c3', '{"available":true,"path":"/opt/clementine/bin/hyperframes"}'],
    ['c4', 'exit_code: 0\ncommand completed successfully'],
  ]);
  const novelty = assessNovelty(calls, returns);
  assert.equal(novelty.novel, true, novelty.reason);
  assert.equal(novelty.hadCliRecovery, true);

  const tip = deriveRecoveryTip(calls, returns);
  assert.ok(tip);
  assert.match(tip!, /hyperframes/);
  assert.match(tip!, /local_cli_list\/local_cli_probe/);
  assert.match(tip!, /resolved binary directly/);
});

test('routine changed CLI calls are not novel without a proven failure and discovery correction', () => {
  const calls: TraceToolCall[] = [
    { tool: 'local_cli_list', args: '{}', callId: 'c1' },
    { tool: 'run_shell_command', args: JSON.stringify({ command: 'netlify status' }), callId: 'c2' },
    { tool: 'run_shell_command', args: JSON.stringify({ command: 'netlify sites:list' }), callId: 'c3' },
  ];
  const returns = new Map([
    ['c1', 'netlify available'],
    ['c2', 'exit_code: 0\ncommand completed successfully'],
    ['c3', 'exit_code: 0\ncommand completed successfully'],
  ]);
  assert.equal(assessNovelty(calls, returns).novel, false);
  assert.equal(deriveRecoveryTip(calls, returns), null);
});

test('changed shell retry without local CLI discovery is not treated as causal learning', () => {
  const calls: TraceToolCall[] = [
    { tool: 'run_shell_command', args: JSON.stringify({ command: 'npx netlify-cli deploy' }), callId: 'c1' },
    { tool: 'run_shell_command', args: JSON.stringify({ command: '/opt/bin/netlify deploy' }), callId: 'c2' },
  ];
  const returns = new Map([
    ['c1', 'exit_code: 1\nnpm ERR! could not determine executable'],
    ['c2', 'exit_code: 0\ncommand completed successfully'],
  ]);
  assert.equal(assessNovelty(calls, returns).novel, false);
  assert.equal(deriveRecoveryTip(calls, returns), null);
});

test('a probe for a different CLI does not establish causal recovery', () => {
  const calls: TraceToolCall[] = [
    { tool: 'run_shell_command', args: JSON.stringify({ command: 'npx netlify-cli deploy' }), callId: 'c1' },
    { tool: 'local_cli_probe', args: JSON.stringify({ name: 'ffmpeg' }), callId: 'c2' },
    { tool: 'run_shell_command', args: JSON.stringify({ command: '/opt/bin/netlify deploy' }), callId: 'c3' },
  ];
  const returns = new Map([
    ['c1', 'exit_code: 1\nnpm ERR! could not determine executable'],
    ['c2', '{"available":true,"path":"/opt/bin/ffmpeg"}'],
    ['c3', 'exit_code: 0\ncommand completed successfully'],
  ]);
  assert.equal(assessNovelty(calls, returns).novel, false);
  assert.equal(deriveRecoveryTip(calls, returns), null);
});

test('a provider argument error is not mislabeled as package materialization recovery', () => {
  const calls: TraceToolCall[] = [
    { tool: 'run_shell_command', args: JSON.stringify({ command: 'npx netlify-cli deploy --wrong-flag' }), callId: 'c1' },
    { tool: 'local_cli_probe', args: JSON.stringify({ name: 'netlify' }), callId: 'c2' },
    { tool: 'run_shell_command', args: JSON.stringify({ command: '/opt/bin/netlify deploy --prod' }), callId: 'c3' },
  ];
  const returns = new Map([
    ['c1', 'exit_code: 1\nError: unknown option --wrong-flag'],
    ['c2', '{"available":true,"path":"/opt/bin/netlify"}'],
    ['c3', 'exit_code: 0\ncommand completed successfully'],
  ]);
  assert.equal(assessNovelty(calls, returns).novel, false);
  assert.equal(deriveRecoveryTip(calls, returns), null);
});

test('provider permission rejection behind npx is not mislabeled as local materialization', () => {
  const calls: TraceToolCall[] = [
    { tool: 'run_shell_command', args: JSON.stringify({ command: 'npx netlify-cli deploy --prod' }), callId: 'c1' },
    { tool: 'local_cli_probe', args: JSON.stringify({ command: 'netlify' }), callId: 'c2' },
    { tool: 'run_shell_command', args: JSON.stringify({ command: '/opt/bin/netlify deploy --prod' }), callId: 'c3' },
  ];
  const returns = new Map([
    ['c1', 'exit_code: 1\nError: permission denied for this Netlify team'],
    ['c2', 'netlify at /opt/bin/netlify'],
    ['c3', 'exit_code: 0\ncommand completed successfully'],
  ]);
  assert.equal(assessNovelty(calls, returns).novel, false);
  assert.equal(deriveRecoveryTip(calls, returns), null);
});
