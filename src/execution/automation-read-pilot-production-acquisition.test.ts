/** Run: node scripts/run-tests-isolated.mjs src/execution/automation-read-pilot-production-acquisition.test.ts */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-read-pilot-acquisition-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const config = await import('../config.js');
const mcpConfig = await import('../runtime/mcp-config.js');
const acquisition = await import('./automation-read-pilot-production-acquisition.js');

function writeConfig(secret: string, secondSecret?: string): void {
  mkdirSync(path.dirname(config.MCP_SERVERS_FILE), { recursive: true });
  writeFileSync(config.MCP_SERVERS_FILE, JSON.stringify({
    'fixture-carrier': {
      type: 'stdio',
      command: process.execPath,
      args: ['fixture-server.mjs'],
      env: { FIXTURE_SECRET: secret },
      description: 'Configured fixture carrier',
      enabled: true,
    },
    ...(secondSecret === undefined ? {} : {
      'second-fixture-carrier': {
        type: 'stdio',
        command: process.execPath,
        args: ['second-fixture-server.mjs'],
        env: { FIXTURE_SECRET: secondSecret },
        description: 'Second configured fixture carrier',
        enabled: true,
      },
    }),
  }), 'utf8');
  mcpConfig.invalidateMcpServerDiscoveryCache();
}

test.after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('opaque acquisition references expire and fail closed across config or accepted-source drift', () => {
  const issuedAt = Date.UTC(2026, 7, 22, 12, 0, 0);
  const source = {
    sessionId: 'chat.reference-owner',
    sourceUserSeq: 7,
    proposalId: 'proposal.reference-owner',
    proposalRevision: 3,
    proposalDigest: 'a'.repeat(64),
    phaseId: 'phase.read',
    requirementId: 'requirement.read',
    requirementDigest: 'b'.repeat(64),
  };
  writeConfig('secret-before');

  const choices = acquisition.listConfiguredReadPilotAcquisitions(source, issuedAt);
  assert.equal(choices.length, 1);
  const reference = choices[0]!.acquisitionRef;
  assert.match(reference, /^pilot-acquisition:live-read-registry:[0-9]+:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(choices), /secret-before/);
  assert.equal(
    acquisition.resolveConfiguredReadPilotAcquisition(reference, source, issuedAt + 1).ok,
    true,
  );

  const otherSession = acquisition.resolveConfiguredReadPilotAcquisition(
    reference,
    { ...source, sessionId: 'chat.other-session' },
    issuedAt + 1,
  );
  assert.equal(otherSession.ok, false);
  if (!otherSession.ok) assert.equal(otherSession.code, 'acquisition_ref_stale');

  const otherTurn = acquisition.resolveConfiguredReadPilotAcquisition(
    reference,
    { ...source, sourceUserSeq: source.sourceUserSeq + 1 },
    issuedAt + 1,
  );
  assert.equal(otherTurn.ok, false);
  if (!otherTurn.ok) assert.equal(otherTurn.code, 'acquisition_ref_stale');

  const otherRequirement = acquisition.resolveConfiguredReadPilotAcquisition(
    reference,
    { ...source, requirementDigest: 'c'.repeat(64) },
    issuedAt + 1,
  );
  assert.equal(otherRequirement.ok, false);
  if (!otherRequirement.ok) assert.equal(otherRequirement.code, 'acquisition_ref_stale');

  writeConfig('secret-before', 'second-secret');
  const registryWide = acquisition.listConfiguredReadPilotAcquisitions(source, issuedAt + 2);
  assert.equal(registryWide.length, 1, 'configured servers never become per-server references');
  assert.equal(registryWide[0]?.carrierKind, 'live_read_registry');
  assert.doesNotMatch(JSON.stringify(registryWide), /fixture-carrier|second-secret|secret-before/);

  const expired = acquisition.resolveConfiguredReadPilotAcquisition(
    reference,
    source,
    issuedAt + (10 * 60 * 1_000) + 1,
  );
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.code, 'acquisition_ref_expired');

  writeConfig('secret-after');
  const drifted = acquisition.resolveConfiguredReadPilotAcquisition(reference, source, issuedAt + 1);
  assert.equal(drifted.ok, false);
  if (!drifted.ok) assert.equal(drifted.code, 'acquisition_ref_stale');
});
