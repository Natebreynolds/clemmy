/**
 * Run: npx tsx --test src/runtime/harness/guardrails.test.ts
 *
 * Contracts the harness guardrail registry must keep:
 *   - policy_violation refuses Composio-shaped or computer-shaped
 *     prompts when the corresponding policy flag is off, and passes
 *     them through when on
 *   - missing_capability refuses input that mentions a known CLI
 *     that's missing locally (uses _testSeed to avoid spawning)
 *   - secret_leak scans agentOutput (string or JSON) for common
 *     secret shapes and trips
 *   - extractInputText handles strings and structured items
 *   - the registry arrays are populated
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-harness-guardrails-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic imports — capabilities and proactivity-policy both read BASE_DIR
// at module load (config.ts:11), so they must load AFTER the env is set.
const { _testSeed: seedCapability } = await import('../../agents/capabilities.js');
const {
  extractInputText,
  policyViolationGuardrail,
  missingCapabilityGuardrail,
  secretLeakGuardrail,
  scanSecrets,
  harnessInputGuardrails,
  harnessOutputGuardrails,
} = await import('./guardrails.js');

test.after(() => {
  try {
    rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const POLICY_FILE = path.join(TMP_HOME, 'state', 'proactivity-policy.json');

function writePolicy(patch: Record<string, unknown>): void {
  const existing = existsSync(POLICY_FILE) ? JSON.parse(readFileSync(POLICY_FILE, 'utf-8')) : {};
  writeFileSync(POLICY_FILE, JSON.stringify({ ...existing, ...patch }, null, 2), 'utf-8');
}

// stub run-context object the guardrail SDK contract expects but
// these guardrails don't actually read.
const FAKE_CTX = { context: undefined } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const FAKE_AGENT = {} as any; // eslint-disable-line @typescript-eslint/no-explicit-any

test('extractInputText: plain string passes through', () => {
  assert.equal(extractInputText('hello world'), 'hello world');
});

test('extractInputText: walks string content on items', () => {
  const input = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'second' },
  ];
  assert.equal(extractInputText(input), 'first\nsecond');
});

test('extractInputText: walks input_text parts', () => {
  const input = [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'alpha' },
        { type: 'input_image', image: 'data:foo' },
        { type: 'input_text', text: 'beta' },
      ],
    },
  ];
  assert.equal(extractInputText(input), 'alpha\nbeta');
});

test('policy_violation: passes when both flags are on', async () => {
  writePolicy({ allowComposioActions: true, allowComputerActions: true });
  const result = await policyViolationGuardrail.execute({
    input: 'send a slack to bob',
    agent: FAKE_AGENT,
    context: FAKE_CTX,
  });
  assert.equal(result.tripwireTriggered, false);
});

test('policy_violation: trips on composio-shaped prompt when allowComposioActions=false', async () => {
  writePolicy({ allowComposioActions: false, allowComputerActions: true });
  const result = await policyViolationGuardrail.execute({
    input: 'send a slack to bob',
    agent: FAKE_AGENT,
    context: FAKE_CTX,
  });
  assert.equal(result.tripwireTriggered, true);
  assert.equal((result.outputInfo as { reason: string }).reason, 'composio_actions_disabled');
});

test('policy_violation: trips on computer-shaped prompt when allowComputerActions=false', async () => {
  writePolicy({ allowComposioActions: true, allowComputerActions: false });
  const result = await policyViolationGuardrail.execute({
    input: 'click the submit button',
    agent: FAKE_AGENT,
    context: FAKE_CTX,
  });
  assert.equal(result.tripwireTriggered, true);
  assert.equal((result.outputInfo as { reason: string }).reason, 'computer_actions_disabled');
});

test('policy_violation: a benign prompt is never blocked', async () => {
  writePolicy({ allowComposioActions: false, allowComputerActions: false });
  const result = await policyViolationGuardrail.execute({
    input: 'summarize my recent vault notes',
    agent: FAKE_AGENT,
    context: FAKE_CTX,
  });
  assert.equal(result.tripwireTriggered, false);
});

test('missing_capability: trips on a known CLI that is missing', async () => {
  // Restore baseline so the policy guardrail doesn't interfere if tests
  // are reordered later.
  writePolicy({ allowComposioActions: true, allowComputerActions: true });
  seedCapability('kubectl', {
    name: 'kubectl',
    available: false,
    error: 'not found in PATH',
    checkedAt: new Date().toISOString(),
  });
  const result = await missingCapabilityGuardrail.execute({
    input: 'run kubectl get pods on the staging cluster',
    agent: FAKE_AGENT,
    context: FAKE_CTX,
  });
  assert.equal(result.tripwireTriggered, true);
  const info = result.outputInfo as { reason: string; missing: { name: string }[] };
  assert.equal(info.reason, 'missing_capabilities');
  assert.deepEqual(
    info.missing.map((m) => m.name),
    ['kubectl'],
  );
});

test('missing_capability: passes when the CLI is available', async () => {
  seedCapability('git', {
    name: 'git',
    available: true,
    version: 'git version 2.42.0',
    source: '/usr/bin/git',
    checkedAt: new Date().toISOString(),
  });
  const result = await missingCapabilityGuardrail.execute({
    input: 'show me git log',
    agent: FAKE_AGENT,
    context: FAKE_CTX,
  });
  assert.equal(result.tripwireTriggered, false);
});

test('missing_capability: no known CLI mentioned -> pass', async () => {
  const result = await missingCapabilityGuardrail.execute({
    input: 'write me a haiku about october',
    agent: FAKE_AGENT,
    context: FAKE_CTX,
  });
  assert.equal(result.tripwireTriggered, false);
});

test('secret_leak: trips on an OpenAI-shaped key in the output', async () => {
  const result = await secretLeakGuardrail.execute({
    agentOutput: 'here is the key: sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890',
    agent: FAKE_AGENT,
    context: FAKE_CTX,
  });
  assert.equal(result.tripwireTriggered, true);
  const info = result.outputInfo as { matches: { kind: string }[] };
  assert.equal(info.matches[0].kind, 'openai_api_key');
});

test('secret_leak: trips on a PEM private key block', async () => {
  const result = await secretLeakGuardrail.execute({
    agentOutput: '-----BEGIN RSA PRIVATE KEY-----\nMIIBOg...\n-----END RSA PRIVATE KEY-----',
    agent: FAKE_AGENT,
    context: FAKE_CTX,
  });
  assert.equal(result.tripwireTriggered, true);
  const info = result.outputInfo as { matches: { kind: string }[] };
  assert.ok(info.matches.some((m) => m.kind === 'private_key'));
});

test('secret_leak: passes on clean output', async () => {
  const result = await secretLeakGuardrail.execute({
    agentOutput: 'all good — nothing to see here',
    agent: FAKE_AGENT,
    context: FAKE_CTX,
  });
  assert.equal(result.tripwireTriggered, false);
});

test('secret_leak: scans stringified object output', async () => {
  // The guardrail is typed for TextOutput agents but its execute body
  // stringifies anything — verify by casting through unknown.
  const exec = secretLeakGuardrail.execute as (args: unknown) => Promise<{ tripwireTriggered: boolean; outputInfo: unknown }>;
  const result = await exec({
    agentOutput: { plan: 'deploy', token: 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz12345678901234' },
    agent: FAKE_AGENT,
    context: FAKE_CTX,
  });
  assert.equal(result.tripwireTriggered, true);
});

test('scanSecrets: previews are truncated to 12 chars', () => {
  const matches = scanSecrets('AKIA1234567890ABCDEF and AKIAZZZZZZZZZZZZZZZZ');
  const m = matches.find((x) => x.kind === 'aws_access_key');
  assert.ok(m);
  assert.equal(m!.count, 2);
  assert.equal(m!.preview.length, 13); // 12 chars + ellipsis
});

test('harness registries are populated', () => {
  assert.equal(harnessInputGuardrails.length, 2);
  assert.equal(harnessOutputGuardrails.length, 1);
});
