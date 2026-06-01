/**
 * Run: npx tsx --test src/agents/worker-job-packet.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerJobPrompt, WorkerToolInputSchema } from './worker-job-packet.js';

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
