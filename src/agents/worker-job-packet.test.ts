/**
 * Run: npx tsx --test src/agents/worker-job-packet.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerJobPrompt, WorkerToolInputSchema, workerPacketKey } from './worker-job-packet.js';

const validPacket = {
  objective: 'Research one firm and return an SEO summary for the parent batch.',
  item: 'firm=Example Legal Group; domain=example-legal.example',
  resolvedTools: [
    'SEO read: DATAFORSEO_LABS_GOOGLE_KEYWORDS_FOR_SITE',
    'Draft write later: OUTLOOK_CREATE_DRAFT',
    'Schema: target:string, location_name:string, language_name:string',
  ].join('\n'),
  context: 'Use the parent-provided firm/domain and Acme outbound memory rules. No other firms are in scope.',
  instructions: 'Read-only SEO research in this worker. Do not send email. Return ERROR if the SEO tool cannot provide data after one retry.',
  expectedOutput: 'JSON object with firm, domain, seoFindings, emailAngle, sources, or final line ERROR: <reason>.',
  intent: null,
};

test('WorkerToolInputSchema requires a parent-planned packet, not a legacy raw prompt', () => {
  assert.equal(WorkerToolInputSchema.safeParse({ input: 'research this firm' }).success, false);
  assert.equal(WorkerToolInputSchema.safeParse(validPacket).success, true);
});

test('buildWorkerJobPrompt renders resolved tools as authoritative and blocks rediscovery', () => {
  const prompt = buildWorkerJobPrompt(validPacket);

  assert.match(prompt, /\[WORKER JOB PACKET\]/);
  assert.match(prompt, /parent-planned fan-out/);
  assert.match(prompt, /Do not call composio_search_tools/);
  assert.match(prompt, /DATAFORSEO_LABS_GOOGLE_KEYWORDS_FOR_SITE/);
  assert.match(prompt, /OUTLOOK_CREATE_DRAFT/);
  assert.match(prompt, /final line must start with ERROR:/);
});

test('buildWorkerJobPrompt forbids substituting a different list for the parent-pinned target', () => {
  const prompt = buildWorkerJobPrompt(validPacket);
  assert.match(prompt, /parent-pinned binding target/);
  assert.match(prompt, /do NOT re-discover, search for, or substitute a different list/i);
});

test('buildWorkerJobPrompt allows no-tool local workers without forcing discovery', () => {
  const prompt = buildWorkerJobPrompt({
    ...validPacket,
    objective: 'Summarize one local markdown file for a parent batch.',
    item: 'file=/tmp/example.md',
    resolvedTools: 'none needed; use read_file only if the path is in scope',
    context: 'The parent already selected the local file path.',
    instructions: 'Do not call external tools.',
    expectedOutput: 'One paragraph summary or ERROR: <reason>.',
  });

  assert.match(prompt, /none needed/);
  assert.match(prompt, /If resolvedTools says "none needed"/);
});

// ── Wave 4 Stage 1: packet key drives durable-resume idempotency ─────────────

test('workerPacketKey: identical packets → identical key (a resumed run replays the same call)', () => {
  const a = workerPacketKey({ ...validPacket });
  const b = workerPacketKey({ ...validPacket });
  assert.equal(a, b);
  assert.match(a, /^[a-z0-9]+-[a-z0-9]+$/, 'stable two-part (~64-bit) key');
});

test('workerPacketKey: changing ANY material field yields a distinct key (a real re-processing runs, not reused)', () => {
  const base = workerPacketKey({ ...validPacket });
  assert.notEqual(workerPacketKey({ ...validPacket, item: `${validPacket.item} (different)` }), base);
  assert.notEqual(workerPacketKey({ ...validPacket, instructions: `${validPacket.instructions} Also do X.` }), base);
  assert.notEqual(workerPacketKey({ ...validPacket, resolvedTools: 'a_different_tool' }), base);
  assert.notEqual(workerPacketKey({ ...validPacket, objective: 'A different objective entirely for this item.' }), base);
  assert.notEqual(workerPacketKey({ ...validPacket, context: 'Different source facts.' }), base);
  assert.notEqual(workerPacketKey({ ...validPacket, expectedOutput: 'A different shape.' }), base);
});

test('workerPacketKey: length-prefixing defeats the field-boundary collision (adversarial review F2)', () => {
  // Two DISTINCT packets that a plain-space join would serialize identically:
  // 'Summarize the' + 'company Acme' vs 'Summarize the company' + 'Acme'. They
  // must now hash DIFFERENTLY so a resume of one never reuses the other's result.
  const p1 = { ...validPacket, objective: 'Summarize the', item: 'company Acme Corp' };
  const p2 = { ...validPacket, objective: 'Summarize the company', item: 'Acme Corp' };
  assert.notEqual(workerPacketKey(p1), workerPacketKey(p2), 'field boundaries are unambiguous');
});

test('workerCallItems filters junk item strings and template placeholders', async () => {
  const { workerCallItems } = await import('./worker-job-packet.js');
  const { deepEqual, equal } = await import('node:assert/strict');
  deepEqual(workerCallItems({ item: 'null', items: ['Firm A', 'Firm B'] }), ['Firm A', 'Firm B']);
  deepEqual(workerCallItems({ item: 'Firm C', items: ['undefined', 'Firm A'] }), ['Firm C', 'Firm A']);
  equal(workerCallItems({ item: 'none', items: null }), null);
  // Unresolved template placeholders never become work items (live 2026-07-22:
  // a worker ran for the literal "{{single site host}}").
  deepEqual(workerCallItems({ item: '{{single site host}}', items: ['stripe.com', '<site>', '${HOST}', '%TARGET%', 'linear.app'] }), ['stripe.com', 'linear.app']);
  equal(workerCallItems({ item: '{{company}}', items: null }), null);
  // Legit values that merely CONTAIN braces/angles survive.
  deepEqual(workerCallItems({ item: 'Bolt<new> Inc', items: null }), ['Bolt<new> Inc']);
});

test('workerResultIndicatesFailure catches unprefixed runner errors and hollow output', async () => {
  const { workerResultIndicatesFailure } = await import('./worker-job-packet.js');
  const { equal } = await import('node:assert/strict');
  equal(workerResultIndicatesFailure('ERROR: worker failed'), true);
  equal(workerResultIndicatesFailure('An error occurred while running the tool. Please try again. Error: Error: 400 Unknown Model, please check the model code.'), true);
  equal(workerResultIndicatesFailure(''), true);
  equal(workerResultIndicatesFailure('   '), true);
  equal(workerResultIndicatesFailure('Attorney: Jane Roe, (555) 123-4567'), false);
});

test('uniformFailureSignature: identical infra failures collapse to one signature; diverse failures do not', async () => {
  const { uniformFailureSignature, workerFailureSignature } = await import('./worker-job-packet.js');
  const { equal, ok } = await import('node:assert/strict');
  const a = 'ERROR: worker for "Cursor" failed: 400 Unknown Model, please check the model code.';
  const b = 'ERROR: worker for "Replit" failed: 400 Unknown Model, please check the model code.';
  const sig = uniformFailureSignature([a, b]);
  ok(sig, 'identical failure class detected across items');
  equal(workerFailureSignature(a), workerFailureSignature(b));
  // Diverse failures never collapse.
  equal(uniformFailureSignature([a, 'ERROR: worker for "Bolt" failed: timeout after 120s']), null);
  // A single item is never "uniform".
  equal(uniformFailureSignature([a]), null);
});

test('fanout uniform-failure memo refuses futile respawns and clears on success', async () => {
  const { markFanoutUniformFailure, fanoutUniformFailure, clearFanoutUniformFailure } = await import('./worker-respawn-guard.js');
  const { equal, ok } = await import('node:assert/strict');
  clearFanoutUniformFailure('sess-uf');
  equal(fanoutUniformFailure('sess-uf'), null);
  markFanoutUniformFailure('sess-uf', 'error: <n> unknown model');
  ok(fanoutUniformFailure('sess-uf'));
  clearFanoutUniformFailure('sess-uf');
  equal(fanoutUniformFailure('sess-uf'), null);
});
