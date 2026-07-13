/**
 * Run: npx tsx --test src/agents/worker-job-packet.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerJobPrompt, WorkerToolInputSchema, workerPacketKey } from './worker-job-packet.js';

const validPacket = {
  objective: 'Research one firm and return an SEO summary for the parent batch.',
  item: 'firm=Revill Law Firm; domain=revilllawfirm.com',
  resolvedTools: [
    'SEO read: DATAFORSEO_LABS_GOOGLE_KEYWORDS_FOR_SITE',
    'Draft write later: OUTLOOK_CREATE_DRAFT',
    'Schema: target:string, location_name:string, language_name:string',
  ].join('\n'),
  context: 'Use the parent-provided firm/domain and Scorpion outbound memory rules. No other firms are in scope.',
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
  assert.match(a, /^[a-z0-9]+$/, 'stable base36 key');
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
