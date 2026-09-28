import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RunContext } from '@openai/agents';
import { BASE_DIR } from '../config.js';
import { getLocalRuntimeTools, getLocalToolCatalog } from './local-runtime-tools.js';
import { TOOL_REGISTRY } from './tool-registry.js';
import { HostLocalExecutionFailureResult } from '../runtime/harness/attempt-settlement.js';

test('view_image is a discoverable local read and preserves pixels through the host tool adapter', async () => {
  assert.ok(TOOL_REGISTRY.some(row => row.name === 'view_image' && row.sideEffect === 'read'));
  assert.ok(getLocalToolCatalog().some(row => row.name === 'view_image'));
  const view = getLocalRuntimeTools().find(row => row.name === 'view_image');
  assert.ok(view && view.type === 'function');
  const dir = path.join(BASE_DIR, 'state', 'attachments-files'); mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'controlled-view-image.png');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9N8AAAAASUVORK5CYII=';
  writeFileSync(file, Buffer.from(png, 'base64'));
  const output = await view.invoke(new RunContext({ sessionId: 'attachment-fixture' }), JSON.stringify({ path: file }));
  assert.ok(Array.isArray(output));
  assert.ok(output.some(row => row.type === 'image' && row.data === png && row.mimeType === 'image/png'));
  const forbidden = await view.invoke(new RunContext({ sessionId: 'attachment-fixture' }), JSON.stringify({ path: '/etc/passwd' }));
  assert.ok(forbidden instanceof HostLocalExecutionFailureResult, 'path refusal stays an execution failure, never a successful image');
});
