/**
 * Run: npx tsx --test src/tools/space-action-prepare.test.ts
 *
 * A chat/model turn may prepare one action already declared by a Workspace,
 * but it must not gain a second execution path. The tool below is expected to
 * reuse the Workspace button's exact approval authority and dispatch nothing
 * until that approval is resolved.
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
const {
  SPACE_ACTION_TOOL,
} = await import('../spaces/space-action-gate.js');
const spaceRunner = await import('../spaces/runner.js');

type Handler = (input: Record<string, unknown>) => Promise<unknown> | unknown;

function captureTools(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const server = {
    tool(name: string, _description: string, _schema: unknown, handler: Handler) {
      handlers[name] = handler;
    },
  };
  registerSpaceTools(server as never);
  return handlers;
}

function resultText(result: unknown): string {
  return (result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? '';
}

const tools = captureTools();

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

test('space_action_prepare binds one approval to the exact Workspace action and args with zero pre-approval dispatch', async () => {
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
    assert.equal(pending.length, 1, 'an exact retry converges on one approval');
    const [row] = pending;
    assert.ok(row);
    assert.equal(row.tool, SPACE_ACTION_TOOL);
    assert.equal(row.sessionId, `space-${slug}`);
    assert.equal(row.args?.spaceSlug, slug);
    assert.equal(row.args?.actionId, 'pause-campaign');
    assert.deepEqual(row.args?.callerArgs, {
      campaign_id: 'cmp-9',
      status: 'PAUSED',
    });
    assert.deepEqual(
      (row.args?.actionSnapshot as { composioSlug?: unknown } | undefined)?.composioSlug,
      'GOOGLEADS_PAUSE_CAMPAIGN',
      'authority comes from the declared action, not a caller-provided tool slug',
    );
    assert.match(first, new RegExp(row.approvalId));
    assert.match(duplicate, new RegExp(row.approvalId));
    assert.match(first, /not (?:run|dispatched)/i);
    assert.equal(providerDispatches, 0, 'preparing approval never reaches the provider');
  } finally {
    spaceRunner._setSpaceComposioDispatchForTests(null);
  }
});
