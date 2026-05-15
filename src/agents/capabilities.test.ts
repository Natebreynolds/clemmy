/**
 * Run: npx tsx --test src/agents/capabilities.test.ts
 *
 * Verifies:
 *   - Registry has the expected names + categories
 *   - getCapabilityDescriptor lookup works (and returns undefined for unknown)
 *   - listKnownCapabilities returns a copy (mutation-safe)
 *   - checkCapability returns available=true for ubiquitous tools (node)
 *     and available=false for clearly-missing ones
 *   - Cache hit returns the same shape on repeat call
 *   - clearCapabilityCache + _testSeed (used in deterministic tests)
 *   - renderCapabilityResult formats both branches
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_REGISTRY,
  checkCapability,
  clearCapabilityCache,
  getCapabilityDescriptor,
  listKnownCapabilities,
  renderCapabilityResult,
  _testSeed,
} from './capabilities.js';

// ─── registry ──────────────────────────────────────────────────

test('registry: includes the well-known CLIs', () => {
  const names = CAPABILITY_REGISTRY.map((c) => c.name);
  for (const required of ['sf', 'gh', 'gcloud', 'aws', 'kubectl', 'stripe', 'docker', 'git']) {
    assert.equal(names.includes(required), true, `registry missing ${required}`);
  }
});

test('registry: every entry has the required fields', () => {
  for (const c of CAPABILITY_REGISTRY) {
    assert.ok(c.name, 'name required');
    assert.ok(c.friendlyName, `friendlyName required for ${c.name}`);
    assert.ok(c.installHint, `installHint required for ${c.name}`);
    assert.ok(c.probeArgs.length > 0, `probeArgs required for ${c.name}`);
    assert.ok(c.category, `category required for ${c.name}`);
  }
});

test('getCapabilityDescriptor: returns the right entry and undefined for unknown', () => {
  assert.equal(getCapabilityDescriptor('sf')?.friendlyName, 'Salesforce CLI (v2)');
  assert.equal(getCapabilityDescriptor('not-a-real-cli'), undefined);
});

test('listKnownCapabilities: returns a fresh array (mutation safe)', () => {
  const a = listKnownCapabilities();
  const b = listKnownCapabilities();
  assert.notEqual(a, b);
  assert.equal(a.length, b.length);
});

// ─── real probes ───────────────────────────────────────────────

test('checkCapability: returns available=true for node (always installed in this env)', async () => {
  clearCapabilityCache();
  const result = await checkCapability('node');
  assert.equal(result.available, true);
  assert.ok(result.version, 'should capture version');
  assert.ok(result.source, 'should resolve a path');
  assert.match(result.source ?? '', /node/);
});

test('checkCapability: returns available=false for clearly-missing command', async () => {
  clearCapabilityCache();
  const result = await checkCapability('totally-not-a-real-cli-xyz-7991');
  assert.equal(result.available, false);
  assert.ok(result.error, 'error should be populated');
});

test('checkCapability: caches result by default', async () => {
  clearCapabilityCache();
  _testSeed('fake-cli-xyz', {
    name: 'fake-cli-xyz',
    available: true,
    version: 'seeded-v1.0',
    source: '/seeded/path',
    checkedAt: new Date().toISOString(),
  });
  const result = await checkCapability('fake-cli-xyz');
  assert.equal(result.available, true);
  assert.equal(result.version, 'seeded-v1.0');
  assert.equal(result.source, '/seeded/path');
});

test('checkCapability: useCache=false forces a real probe even if seeded', async () => {
  clearCapabilityCache();
  _testSeed('totally-not-a-real-cli-xyz-7991', {
    name: 'totally-not-a-real-cli-xyz-7991',
    available: true,
    version: 'fake',
    checkedAt: new Date().toISOString(),
  });
  const result = await checkCapability('totally-not-a-real-cli-xyz-7991', { useCache: false });
  assert.equal(result.available, false, 'real probe should report missing');
});

// ─── empty / weird input ──────────────────────────────────────

test('checkCapability: empty name returns available=false with error', async () => {
  const result = await checkCapability('  ');
  assert.equal(result.available, false);
  assert.match(result.error ?? '', /empty/);
});

// ─── renderer ──────────────────────────────────────────────────

test('renderCapabilityResult: available branch shows version + path', () => {
  const out = renderCapabilityResult(
    { name: 'sf', available: true, version: 'sf 2.130.9', source: '/usr/local/bin/sf', checkedAt: new Date().toISOString() },
    getCapabilityDescriptor('sf'),
  );
  assert.match(out, /Salesforce CLI/);
  assert.match(out, /2\.130\.9/);
  assert.match(out, /\/usr\/local\/bin\/sf/);
});

test('renderCapabilityResult: missing branch shows install hint', () => {
  const out = renderCapabilityResult(
    { name: 'gh', available: false, error: 'command not found', checkedAt: new Date().toISOString() },
    getCapabilityDescriptor('gh'),
  );
  assert.match(out, /GitHub CLI/);
  assert.match(out, /brew install gh/);
});

test('renderCapabilityResult: works without a descriptor', () => {
  const out = renderCapabilityResult({
    name: 'custom-cli',
    available: true,
    version: '1.0.0',
    checkedAt: new Date().toISOString(),
  });
  assert.match(out, /custom-cli/);
  assert.match(out, /1\.0\.0/);
});
