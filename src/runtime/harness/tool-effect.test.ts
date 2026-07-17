import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyRuntimeToolEffect,
  isCanonicalTopLevelToolEvent,
  pairTransportMirrorToolCalls,
  projectCanonicalTopLevelToolEvents,
  runtimeToolAccountingMetadata,
} from './tool-effect.js';
import { toolCallCorrelationFingerprint } from './tool-correlation.js';

test('canonical projection excludes MCP transport mirrors without dropping native or legacy calls', () => {
  const events = [
    {
      type: 'tool_called',
      data: {
        tool: 'composio_execute_tool',
        callId: 'call-outlook',
        canonicalCallId: 'call-outlook',
        accounting: 'top_level',
      },
    },
    {
      type: 'tool_called',
      data: {
        tool: 'composio_execute_tool',
        callId: 'call-outlook',
        accounting: 'transport_mirror',
      },
    },
    {
      type: 'tool_called',
      data: { tool: 'mcp__gong__GONG_GET_CALL_TRANSCRIPT', callId: 'call-native-legacy' },
    },
    {
      type: 'tool_returned',
      data: { tool: 'composio_execute_tool', callId: 'call-outlook', accounting: 'top_level', ok: true },
    },
    {
      type: 'tool_returned',
      data: { tool: 'composio_execute_tool', callId: 'call-outlook', accounting: 'transport_mirror', ok: true },
    },
    { type: 'heartbeat', data: {} },
  ];

  assert.equal(isCanonicalTopLevelToolEvent(events[0], 'tool_called'), true);
  assert.equal(isCanonicalTopLevelToolEvent(events[1], 'tool_called'), false);
  assert.equal(isCanonicalTopLevelToolEvent(events[2], 'tool_called'), true, 'legacy/native rows remain countable');
  assert.equal(isCanonicalTopLevelToolEvent(events[5]), false, 'non-tool telemetry is never projected');
  assert.deepEqual(
    projectCanonicalTopLevelToolEvents(events, 'tool_called').map((event) => event.data.callId),
    ['call-outlook', 'call-native-legacy'],
  );
  assert.equal(projectCanonicalTopLevelToolEvents(events, 'tool_returned').length, 1);
});

test('transport pairing normalizes production-shaped inputs and skips resolved identical calls', () => {
  const longBody = 'confidential-firm-brief '.repeat(30);
  assert.ok(longBody.length > 500);
  const args = { tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT', arguments: { title: 'Firm brief', content: longBody } };
  const correlationFingerprint = toolCallCorrelationFingerprint('composio_execute_tool', args);
  const events = [
    { type: 'tool_called', data: { tool: 'composio_execute_tool', callId: 'toolu-returned', accounting: 'top_level', arguments: JSON.stringify(args), correlationFingerprint } },
    { type: 'tool_called', data: { tool: 'composio_execute_tool', callId: 'toolu-live', accounting: 'top_level', arguments: JSON.stringify(args), correlationFingerprint } },
    {
      type: 'tool_called',
      data: {
        tool: 'composio_execute_tool',
        callId: 'mcp-live',
        accounting: 'transport_mirror',
        args: { tool_slug: args.tool_slug, arguments: { title: 'Firm brief', content: `${longBody.slice(0, 300)}…` }, optional: null },
        correlationFingerprint,
      },
    },
  ];
  const pairs = pairTransportMirrorToolCalls(events, new Set(['toolu-returned']));
  assert.equal(pairs.canonicalToMirrorCallId.get('toolu-live'), 'mcp-live');
  assert.equal(pairs.mirrorToCanonicalCallId.get('mcp-live'), 'toolu-live');
  assert.equal(pairs.canonicalToMirrorCallId.has('toolu-returned'), false);
  assert.doesNotMatch(correlationFingerprint, /confidential-firm-brief/, 'the durable key never stores payload text');
});

test('native MCP production names distinguish sends from reads', () => {
  for (const name of [
    'outlook__send_mail',
    'outlook__outlook_send_email',
    'mcp__gmail__reply_to_thread',
    'mcp__googledocs__create_document',
    'mcp__hubspot__find_or_create_contact',
  ]) {
    const effect = classifyRuntimeToolEffect(name, {});
    assert.equal(effect.effect, 'external_write', name);
    assert.equal(effect.dangerousWrite, true, name);
  }
  for (const name of [
    'outlook__list_messages',
    'mcp__gmail__get_thread',
    'mcp__googledocs__get_document',
    'mcp__gong__GONG_GET_CALL_TRANSCRIPT',
    'mcp__vapi__retrieve_call',
    'mcp__twilio__list_calls',
    'dataforseo__serp_organic_live_advanced',
  ]) {
    const effect = classifyRuntimeToolEffect(name, {});
    assert.equal(effect.effect, 'read', name);
    assert.equal(effect.dangerousWrite, false, name);
  }
});

test('Composio gateways classify the inner operation rather than the wrapper', () => {
  assert.equal(classifyRuntimeToolEffect('composio_execute_tool', {
    tool_slug: 'OUTLOOK_SEND_EMAIL', arguments: '{}',
  }).dangerousWrite, true);
  assert.equal(classifyRuntimeToolEffect('composio_execute_tool', {
    tool_slug: 'OUTLOOK_LIST_MESSAGES', arguments: '{}',
  }).effect, 'read');
  assert.equal(classifyRuntimeToolEffect('composio_execute_tool', {
    tool_slug: 'HUBSPOT_FIND_OR_CREATE_CONTACT', arguments: '{}',
  }).effect, 'external_write', 'a read verb cannot hide a mixed-action write');
  assert.equal(classifyRuntimeToolEffect('composio_execute_tool', {
    tool_slug: 'DATAFORSEO_CREATE_SERP_GOOGLE_ORGANIC_TASK_POST', arguments: '{}',
  }).effect, 'read');
  assert.equal(classifyRuntimeToolEffect('composio_execute_tool', {
    tool_slug: 'GONG_GET_CALL_TRANSCRIPT', arguments: '{}',
  }).effect, 'read', 'CALL is the object of GET, not a telephony dispatch verb');
  assert.equal(classifyRuntimeToolEffect('composio_execute_tool', {
    tool_slug: 'GONG_GET_CALL_AND_UPDATE_CONTACT', arguments: '{}',
  }).effect, 'external_write', 'a real mutation token still wins over the call-read shape');
});

test('shell effects are behavioral: compute stays safe, sends/deploys are external writes', () => {
  for (const command of [
    'rg TODO src',
    'npm test -- --runInBand',
    'npm run build',
    'npx tsc --noEmit',
    'ffmpeg -i a.mov b.mp4',
    'node scripts/render-preview.mjs',
  ]) {
    const effect = classifyRuntimeToolEffect('run_shell_command', { command });
    assert.equal(effect.effect, 'compute', command);
    assert.equal(effect.dangerousWrite, false, command);
  }
  for (const command of ['rm -rf dist', 'git commit -m "release"', 'mkdir generated']) {
    const effect = classifyRuntimeToolEffect('run_shell_command', { command });
    assert.equal(effect.effect, 'local_write', command);
    assert.equal(effect.dangerousWrite, false, command);
  }
  for (const command of [
    'curl -X POST https://api.example.com/send -d to=a@example.com',
    'netlify deploy --prod --site abc',
    'npx netlify-cli sites:create --name client-snapshot',
    'git push origin main',
    'npm publish',
    'sf data create record --sobject Account --values "Name=Acme"',
    'kubectl apply -f deployment.yaml',
  ]) {
    const effect = classifyRuntimeToolEffect('run_shell_command', { command });
    assert.equal(effect.effect, 'external_write', command);
    assert.equal(effect.dangerousWrite, true, command);
  }
});

test('shell effects inspect only literal sh/bash/zsh command payloads', () => {
  for (const command of [
    "bash -lc 'curl -X POST https://api.example.com/send -d x=1'",
    `sh -c "git push origin main"`,
    `zsh -lc "bash -c 'npm publish'"`,
    `env FOO=x bash -lc "curl -X POST https://api.example.com/send -d x=1"`,
    `/usr/bin/env -i sh -c "git push origin main"`,
    `exec bash -c "curl -X POST https://api.example.com/send -d x=1"`,
    `nohup bash -c "curl -X POST https://api.example.com/send -d x=1"`,
    `nice sh -c "git push origin main"`,
    `time bash -c "curl -X POST https://api.example.com/send -d x=1"`,
    `sudo bash -c "curl -X POST https://api.example.com/send -d x=1"`,
  ]) {
    assert.equal(classifyRuntimeToolEffect('run_shell_command', { command }).effect, 'external_write', command);
  }
  for (const command of [
    "bash -lc 'rm -rf dist'",
    `zsh -c "git commit -m release"`,
    `command bash -c "rm -rf dist"`,
    `timeout 30s bash -c "rm -rf dist"`,
    `env -S "bash -lc 'curl -X POST https://api.example.com/send -d x=1'"`,
  ]) {
    assert.equal(classifyRuntimeToolEffect('run_shell_command', { command }).effect, 'local_write', command);
  }
  for (const command of [
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
    assert.equal(classifyRuntimeToolEffect('run_shell_command', { command }).effect, 'compute', command);
  }
  assert.equal(
    classifyRuntimeToolEffect('run_shell_command', { command: `bash -lc "$RUNTIME_COMMAND"` }).effect,
    'local_write',
    'dynamic shell code is opaque, not trusted compute',
  );
});

test('accounting metadata decodes hook arguments and exposes the inner provider action', () => {
  assert.deepEqual(runtimeToolAccountingMetadata(
    'composio_execute_tool',
    JSON.stringify({ tool_slug: 'HUBSPOT_FIND_OR_CREATE_CONTACT', arguments: '{}' }),
  ), {
    effect: 'external_write',
    toolSlug: 'HUBSPOT_FIND_OR_CREATE_CONTACT',
  });
  assert.deepEqual(runtimeToolAccountingMetadata(
    'mcp__clementine-local__composio_execute_tool',
    { tool_slug: 'DATAFORSEO_CREATE_SERP_TASK_POST' },
  ), {
    effect: 'read',
    toolSlug: 'DATAFORSEO_CREATE_SERP_TASK_POST',
  });
});
