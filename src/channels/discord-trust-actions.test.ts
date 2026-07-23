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
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-discord-trust-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

// Seed a pending proposal directly into the store the module reads.
writeFileSync(path.join(TMP_HOME, 'state', 'trust-graduation-proposals.json'), JSON.stringify({
  version: 'v1',
  proposals: [
    {
      id: 'tgp-pending1', scopeKey: 'k1', toolkits: ['gmail_send_email'], recipients: ['x@acme.com'],
      maxRecipients: 1, evidence: { cleanSendCount: 5, distinctDays: 2, firstAt: '', lastAt: '', sampleApprovalIds: [] },
      rationale: 'r', status: 'pending', createdAt: new Date().toISOString(),
    },
    {
      id: 'tgp-done1', scopeKey: 'k2', toolkits: ['gmail_send_email'], recipients: ['y@acme.com'],
      maxRecipients: 1, evidence: { cleanSendCount: 5, distinctDays: 2, firstAt: '', lastAt: '', sampleApprovalIds: [] },
      rationale: 'r', status: 'approved', createdAt: new Date().toISOString(),
    },
  ],
}), 'utf-8');

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildActionsForNotification } = await import('./discord.js');

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
});

test('already-resolved trustProposalId attaches no dead buttons', () => {
  assert.equal(customIds(buildActionsForNotification({ trustProposalId: 'tgp-done1' })).length, 0);
});

test('missing trustProposalId attaches no buttons', () => {
  assert.equal(customIds(buildActionsForNotification({ trustProposalId: 'tgp-nope' })).length, 0);
});
