import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyText,
  classifyTrackedPath,
  formatFindings,
  scanExistingTrackedFiles,
} from './check-public-hygiene.mjs';

test('classifies prohibited tracked artifact paths', () => {
  assert(classifyTrackedPath('.env.local').has('environment-file'));
  assert.equal(classifyTrackedPath('.env.example').size, 0);
  assert(classifyTrackedPath('release/signing.p12').has('credential-or-signing-file'));
  assert(classifyTrackedPath('state/events.ndjson').has('database-or-event-store'));
  assert(classifyTrackedPath('backups/memory-snapshot.json').has('memory-snapshot'));
  assert(classifyTrackedPath('scripts/memory-graph-snapshot.json').has('memory-snapshot'));
  assert(classifyTrackedPath('.playwright-mcp/session.log').has('run-or-generated-artifact'));
  assert(classifyTrackedPath('.claude/mailbox/task.json').has('local-agent-state'));
  assert(classifyTrackedPath('.codex/session.json').has('local-agent-state'));
  assert.equal(classifyTrackedPath('.claude/skills/example/SKILL.md').size, 0);
  assert(classifyTrackedPath('client-audit.md').has('private-work-product'));
  assert(classifyTrackedPath('account-evidence-review.md').has('private-work-product'));
  assert(classifyTrackedPath('review-2026-07-18.md').has('private-work-product'));
  assert(classifyTrackedPath('workspaces/account/brief.md').has('private-work-product'));
  assert.equal(classifyTrackedPath('docs/review-2026-07-18.md').size, 0);
  assert(classifyTrackedPath('desktop-capture.png').has('root-media-capture'));
  assert.equal(classifyTrackedPath('apps/web/public/screenshots/desktop-capture.png').size, 0);
});

test('classifies sensitive text without rejecting synthetic examples', () => {
  const privateKeyHeader = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  const personalPath = ['/Users', 'a.researcher', 'project'].join('/');
  const credentialUrl = ['https://user:actual-credential', 'service.company'].join('@');
  const appleTeamAssignment = ['APPLE_TEAM_ID', '"A1B2C3D4E5"'].join('=');
  const liveSessionId = ['sess', 'mr4nd0m7'].join('-');
  const airtableId = ['rec', 'A1b2C3d4E5f6G7'].join('');
  const salesforceId = ['001', 'A1b2C3d4E5f6'].join('');
  const googleResourceUrl = ['https://docs.google.com/document/d', '1Ab2Cd3Ef4Gh5Ij6Kl7Mn8'].join('/');
  assert(classifyText(`${personalPath}\n${privateKeyHeader}`).has('personal-home-path'));
  assert(classifyText(privateKeyHeader).has('private-key-material'));
  assert(classifyText(credentialUrl).has('credential-bearing-url'));
  assert(classifyText(appleTeamAssignment).has('apple-signing-identity'));
  assert(classifyText(['APNS_TEAM_ID', 'A1B2C3D4E5'].join('=')).has('apple-signing-identity'));
  assert(classifyText(liveSessionId).has('live-session-identifier'));
  assert(classifyText(airtableId).has('provider-resource-id'));
  assert(classifyText(salesforceId).has('provider-resource-id'));
  assert(classifyText(googleResourceUrl).has('provider-resource-id'));

  assert.equal(classifyText('/Users/example/project').size, 0);
  assert.equal(classifyText('https://user:password@example.com').size, 0);
  assert.equal(classifyText('APPLE_TEAM_ID="<apple-team-id>"').size, 0);
  assert.equal(classifyText('sess-mobile-route').size, 0);
  assert.equal(classifyText('https://docs.google.com/spreadsheets/d/fixture_google_sheet_0000000001/edit').size, 0);
});

test('scans existing Git-tracked files only and never reports matching values', () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'public-hygiene-test-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    writeFileSync(path.join(repo, '.gitignore'), '.env\n');
    writeFileSync(path.join(repo, 'safe.txt'), 'Public fixture in /Users/example/project.\n');
    writeFileSync(path.join(repo, '.env'), 'TOKEN=do-not-print-this-value\n');
    execFileSync('git', ['add', '.gitignore', 'safe.txt'], { cwd: repo });
    assert.deepEqual(scanExistingTrackedFiles(repo), []);

    execFileSync('git', ['add', '--force', '.env'], { cwd: repo });
    const findings = scanExistingTrackedFiles(repo);
    assert.deepEqual(findings, [{ category: 'environment-file', filePath: '.env' }]);
    assert(!formatFindings(findings).includes('do-not-print-this-value'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
