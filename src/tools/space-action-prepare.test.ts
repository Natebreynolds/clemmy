/**
 * Run: npx tsx --test src/tools/space-action-prepare.test.ts
 *
 * A chat/model turn may prepare one action already declared by a Workspace,
 * but it must not gain a second execution path. The tool below uses canonical
 * Auto for ordinary current Composio writes and retains one exact approval for
 * genuinely user-owned effects.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-action-prepare-'));

const { registerSpaceTools } = await import('./space-tools.js');
const { spaceStore } = await import('../spaces/store.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const spaceRunner = await import('../spaces/runner.js');

type Handler = (input: Record<string, unknown>) => Promise<unknown> | unknown;

const descriptions: Record<string, string> = {};
function captureTools(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const server = {
    tool(name: string, description: string, _schema: unknown, handler: Handler) {
      handlers[name] = handler;
      descriptions[name] = description;
    },
  };
  registerSpaceTools(server as never);
  return handlers;
}

function resultText(result: unknown): string {
  return (result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? '';
}

const tools = captureTools();

test('space_action_prepare model contract truthfully distinguishes ordinary Auto from user-owned approval', () => {
  const description = descriptions.space_action_prepare ?? '';
  assert.match(description, /ordinary current Composio create\/update executes/i);
  assert.match(description, /sends\/deletes\/admin work still create one exact approval/i);
  assert.match(description, /ambiguous accounts ask one account choice/i);
  assert.match(description, /executed only when the durable kernel says it ran/i);
});

test('Workspace runner catalog copy truthfully describes space_try_runner as static-only', () => {
  const inspection = descriptions.space_try_runner ?? '';
  const sourceRead = descriptions.space_get_runner ?? '';
  assert.match(inspection, /statically inspect/i);
  assert.match(inspection, /without executing/i);
  assert.match(sourceRead, /static safety\/provenance inspection without executing/i);
  assert.doesNotMatch(sourceRead, /space_try_runner executes|see the json/i);
});

test('space_action_prepare refuses an unknown declared action without minting authority', async () => {
  const slug = 'prepare-unknown-action';
  spaceStore.save({
    id: slug,
    title: 'Prepare unknown action',
    actions: [{
      id: 'pause-campaign',
      label: 'Pause campaign',
      composioSlug: 'GOOGLEADS_PAUSE_CAMPAIGN',
      confirm: true,
    }],
  });

  const before = approvalRegistry.listPending({
    sessionId: `space-${slug}`,
    status: 'pending',
  }).length;
  const output = resultText(await tools.space_action_prepare({
    slug,
    action_id: 'delete-everything',
    args_json: '{"campaign_id":"cmp-9"}',
  }));

  assert.match(output, /no declared action "delete-everything"/i);
  assert.equal(
    approvalRegistry.listPending({
      sessionId: `space-${slug}`,
      status: 'pending',
    }).length,
    before,
    'an unknown action must not create an approval',
  );
});

test('space_action_prepare refuses a Composio action without one-shot request identity and mints no blind approval', async () => {
  const slug = 'prepare-exact-action';
  spaceStore.save({
    id: slug,
    title: 'Ads steward',
    actions: [{
      id: 'pause-campaign',
      label: 'Pause over-budget campaign',
      composioSlug: 'GOOGLEADS_PAUSE_CAMPAIGN',
      argsTemplate: { customer_id: 'customer-proof' },
      confirm: true,
    }],
  });

  let providerDispatches = 0;
  spaceRunner._setSpaceComposioDispatchForTests(async () => {
    providerDispatches += 1;
    return {
      ok: true as const,
      result: { paused: true },
      connectionId: 'proof-connection',
      identity: 'proof@example.test',
    };
  });
  try {
    const first = resultText(await tools.space_action_prepare({
      slug,
      action_id: 'pause-campaign',
      args_json: '{"campaign_id":"cmp-9","status":"PAUSED"}',
    }));
    const duplicate = resultText(await tools.space_action_prepare({
      slug,
      action_id: 'pause-campaign',
      // Object key order must not mint a second mutation slot.
      args_json: '{"status":"PAUSED","campaign_id":"cmp-9"}',
    }));

    const pending = approvalRegistry.listPending({
      sessionId: `space-${slug}`,
      status: 'pending',
    });
    assert.equal(pending.length, 0, 'missing request identity cannot mint a blind approval');
    assert.match(first, /one-shot request identity is unavailable/i);
    assert.match(duplicate, /one-shot request identity is unavailable/i);
    assert.equal(providerDispatches, 0, 'identity refusal never reaches the provider');
  } finally {
    spaceRunner._setSpaceComposioDispatchForTests(null);
  }
});
