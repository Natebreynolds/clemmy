/**
 * Run: npx tsx --test src/channels/discord-trust-actions.test.ts
 *
 * Desktop↔Discord parity for trust-graduation proposals: a pending
 * trustProposalId in a notification's metadata attaches one-tap
 * approve/decline buttons; a missing/resolved proposal attaches none
 * (no dead buttons). Uses a tmp CLEMENTINE_HOME so getTrustProposal reads
 * a seeded store, not the developer's real home.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-discord-trust-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

function scopeReceipt(scope: {
  toolkits: string[];
  recipients: string[];
  domains?: string[];
  maxRecipients: number;
}) {
  const canonical = {
    scopeRevision: 1 as const,
    toolkits: [...scope.toolkits].sort(),
    recipients: [...scope.recipients].sort(),
    domains: [...(scope.domains ?? [])].sort(),
    maxRecipients: scope.maxRecipients,
  };
  return {
    scopeRevision: canonical.scopeRevision,
    scopeDigest: `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`,
  };
}

const pendingScope = {
  toolkits: ['gmail_send_email'], recipients: ['x@acme.com'], maxRecipients: 1,
};
const doneScope = {
  toolkits: ['gmail_send_email'], recipients: ['y@acme.com'], maxRecipients: 1,
};
const actionScope = {
  toolkits: ['gmail_send_email'], recipients: ['z@acme.com'], maxRecipients: 1,
};

// Seed a pending proposal directly into the store the module reads.
writeFileSync(path.join(TMP_HOME, 'state', 'trust-graduation-proposals.json'), JSON.stringify({
  version: 'v1',
  proposals: [
    {
      id: 'tgp-pending1', scopeKey: 'k1', ...pendingScope, ...scopeReceipt(pendingScope),
      evidence: { cleanSendCount: 5, distinctDays: 2, firstAt: '', lastAt: '', sampleApprovalIds: [] },
      rationale: 'r', status: 'pending', createdAt: new Date().toISOString(),
    },
    {
      id: 'tgp-done1', scopeKey: 'k2', ...doneScope, ...scopeReceipt(doneScope),
      evidence: { cleanSendCount: 5, distinctDays: 2, firstAt: '', lastAt: '', sampleApprovalIds: [] },
      rationale: 'r', status: 'approved', createdAt: new Date().toISOString(),
    },
    {
      id: 'tgp-action1', scopeKey: 'k3', ...actionScope, ...scopeReceipt(actionScope),
      evidence: { cleanSendCount: 5, distinctDays: 2, firstAt: '', lastAt: '', sampleApprovalIds: [] },
      rationale: 'r', status: 'pending', createdAt: new Date().toISOString(),
    },
  ],
}), 'utf-8');

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildActionsForNotification, __test__ } = await import('./discord.js');

function customIds(rows: ReturnType<typeof buildActionsForNotification>): string[] {
  if (!rows) return [];
  const ids: string[] = [];
  for (const row of rows) {
    const components = (row as { components?: Array<{ data?: { custom_id?: string } }> }).components ?? [];
    for (const comp of components) {
      const id = comp?.data?.custom_id;
      if (id) ids.push(id);
    }
  }
  return ids;
}

test('pending trustProposalId attaches approve/decline buttons', () => {
  const ids = customIds(buildActionsForNotification({ trustProposalId: 'tgp-pending1' }));
  assert.equal(ids.length, 2, 'expected approve + decline');
  assert.ok(ids.some((id) => id.includes('trust-approve:tgp-pending1')));
  assert.ok(ids.some((id) => id.includes('trust-decline:tgp-pending1')));
  assert.ok(ids.every((id) => id.length <= 100), 'receipt-bound IDs must fit Discord custom_id');
  for (const id of ids) {
    const token = id.split(':')[3];
    assert.deepEqual(__test__.decodeTrustProposalScopeToken(token), scopeReceipt(pendingScope));
  }
});

test('Discord trust action round-trips the receipt and ID-only fails closed', () => {
  assert.equal(__test__.resolveDiscordTrustProposalAction({
    action: 'trust-decline',
    proposalId: 'tgp-action1',
  }), null, 'a legacy ID-only button cannot resolve the proposal');

  const declineId = customIds(buildActionsForNotification({ trustProposalId: 'tgp-action1' }))
    .find((id) => id.includes(':trust-decline:'));
  assert.ok(declineId);
  const result = __test__.resolveDiscordTrustProposalAction({
    action: 'trust-decline',
    proposalId: 'tgp-action1',
    scopeToken: declineId.split(':')[3],
  });
  assert.equal(result?.reason, 'declined');
  assert.deepEqual(result?.scopeReceipt && {
    scopeRevision: result.scopeReceipt.scopeRevision,
    scopeDigest: result.scopeReceipt.scopeDigest,
  }, scopeReceipt(actionScope));
});

test('already-resolved trustProposalId attaches no dead buttons', () => {
  assert.equal(customIds(buildActionsForNotification({ trustProposalId: 'tgp-done1' })).length, 0);
});

test('missing trustProposalId attaches no buttons', () => {
  assert.equal(customIds(buildActionsForNotification({ trustProposalId: 'tgp-nope' })).length, 0);
});
