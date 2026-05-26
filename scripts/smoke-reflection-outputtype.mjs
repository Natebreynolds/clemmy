#!/usr/bin/env node
// scripts/smoke-reflection-outputtype.mjs
//
// Hits real Codex N times via _testOnly_runExtractor and reports how
// many invocations produced a valid Extraction vs returned null
// (thrown OR invalid-shape). Lets us measure the "reflection extractor
// returned invalid shape" failure rate before/after wiring outputType
// + normalizeZodForCodexStrict into the reflection agent.
//
// Usage:
//   npm run build && node scripts/smoke-reflection-outputtype.mjs
//   N=12 node scripts/smoke-reflection-outputtype.mjs        # custom iterations
//   LABEL=baseline node scripts/smoke-reflection-outputtype.mjs > baseline.txt
//   LABEL=modified node scripts/smoke-reflection-outputtype.mjs > modified.txt
//
// Reads OPENAI_API_KEY from the same place the daemon does
// (~/.clementine-next/state/secrets-vault.json or env). No DB writes —
// runs the pure extractor only.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DIST = path.join(REPO_ROOT, 'dist');

if (!existsSync(path.join(DIST, 'memory/reflection.js'))) {
  console.error('✗ dist/ not built. Run: npm run build');
  process.exit(2);
}

// Intercept pino output so we can count "invalid shape" warnings even
// when the function returns null (the catch path swallows the diff).
let invalidShapeCount = 0;
let extractorThrownCount = 0;
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === 'string' ? chunk : chunk?.toString?.() ?? '';
  if (s.includes('reflection extractor returned invalid shape')) invalidShapeCount += 1;
  if (s.includes('reflection extractor failed')) extractorThrownCount += 1;
  // Silence noisy pino lines from the run itself; keep our own logging.
  if (s.includes('"name":"clementine.memory.reflection"')) return true;
  return origWrite(chunk, ...rest);
};

const { _testOnly_runExtractor } = await import(pathToFileURL(path.join(DIST, 'memory/reflection.js')).href);

// Sanity: key present? Pipe vault → process.env so the OpenAI SDK
// (which reads OPENAI_API_KEY directly) actually sees it.
const { getOpenAiApiKey } = await import(pathToFileURL(path.join(DIST, 'config.js')).href);
const key = getOpenAiApiKey();
if (!key) {
  console.error('✗ No OPENAI_API_KEY available (checked env + secrets-vault.json)');
  process.exit(2);
}
process.env.OPENAI_API_KEY = key;

// Adversarial ~3000-char tool output that mirrors the production
// composio_execute_tool failure pattern: chunky raw JSON with nested
// objects, escape sequences, numeric+string field mixes, and several
// extractable entities/facts. The shape (not just the length) is what
// trips a freeform-JSON extractor — the model wants to mirror the
// input structure instead of producing our 3-key schema.
const SAMPLE_TOOL_OUTPUT = [
  '{"results": {"messages": [',
  'Email digest for nathan@breakthroughcoaching.ai (last 24h):',
  '',
  '1. Marlow Bennett <marlow@acmecorp.io> — Re: Pricing for the Q3 retainer',
  '   "Confirming we are happy to move forward at the $12k/mo tier discussed Tuesday.',
  '   Please loop in your legal to review the redlined SOW by Friday. Our CFO Diane',
  '   Park will be the primary signatory."',
  '',
  '2. Acme Corp Billing <billing@acmecorp.io> — Invoice INV-2026-0451 issued',
  '   Amount: $12,000.00 — Due 2026-06-15 — Reference: BC-RETAINER-Q3-2026',
  '',
  '3. Sarah Chen <sarah@thoughtworks.com> — Speaking slot at the AI for Coaches conference',
  '   "Confirmed your 30-min keynote for July 22 in Austin. Topic: \'Long-running personal',
  '   AI assistants in practice.\' I will send the green-room logistics next week."',
  '',
  '4. Calendly notification — Jordan Kim booked a 45-min discovery call for next Tuesday',
  '   2026-06-02 @ 14:00 PDT. Source: jt-coaching.com/discovery.',
  '',
  '{"id":"msg_001","from":{"name":"Marlow Bennett","email":"marlow@acmecorp.io","company":{"name":"Acme Corp","tier":"enterprise","mrr":12000}},"subject":"Re: Pricing for the Q3 retainer","received_at":"2026-05-25T14:22:00Z","labels":["pricing","contract","high-priority"],"body_preview":"Confirming we are happy to move forward at the $12k/mo tier...","attachments":[{"name":"SOW-v3-redlined.pdf","size_bytes":284192,"mime":"application/pdf"}],"thread":{"id":"thr_xyz","message_count":7,"participants":["marlow@acmecorp.io","diane.park@acmecorp.io","nathan@breakthroughcoaching.ai"]}}',
  '{"id":"msg_002","from":{"name":"Acme Corp Billing","email":"billing@acmecorp.io"},"subject":"Invoice INV-2026-0451 issued","received_at":"2026-05-25T15:01:00Z","metadata":{"amount":12000.00,"currency":"USD","due_date":"2026-06-15","reference":"BC-RETAINER-Q3-2026","payment_url":"https://billing.acmecorp.io/pay/INV-2026-0451"}}',
  '{"id":"msg_003","from":{"name":"Sarah Chen","email":"sarah@thoughtworks.com","title":"Conference Program Chair","org":"AI for Coaches"},"subject":"Speaking slot confirmed","received_at":"2026-05-25T16:14:00Z","event":{"name":"AI for Coaches 2026","date":"2026-07-22","city":"Austin","duration_minutes":30,"topic":"Long-running personal AI assistants in practice","stage":"keynote"}}',
  '{"id":"msg_004","source":"calendly","attendee":{"name":"Jordan Kim","email":"jordan@jt-coaching.com","timezone":"America/Los_Angeles"},"event":{"type":"discovery_call","duration_minutes":45,"scheduled_at":"2026-06-02T21:00:00Z","calendly_url":"https://calendly.com/breakthrough-coaching/discovery/jordan-kim"}}',
  ']}, "_meta":{"tool":"composio.OUTLOOK_LIST_RECENT_MESSAGES","took_ms":1843,"request_id":"req_abc123def456","page":1,"page_size":4,"has_more":false}}',
].join('\n');

const N = Number.parseInt(process.env.N ?? '8', 10);
const LABEL = process.env.LABEL ?? 'unlabeled';

origWrite(`\n→ Reflection smoke (label=${LABEL}, n=${N}, model=${process.env.OPENAI_MODEL_FAST ?? 'default'})\n`);
origWrite(`   sample input length: ${SAMPLE_TOOL_OUTPUT.length} chars (gate=500)\n\n`);

const results = [];
const startedAt = Date.now();

for (let i = 0; i < N; i++) {
  const t0 = Date.now();
  let extraction = null;
  let threw = null;
  try {
    extraction = await _testOnly_runExtractor(SAMPLE_TOOL_OUTPUT);
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  const ms = Date.now() - t0;
  if (threw) {
    results.push({ ok: false, ms, reason: 'thrown', detail: threw.slice(0, 100) });
    origWrite(`  [${i + 1}/${N}] ✗ thrown (${ms}ms): ${threw.slice(0, 80)}\n`);
  } else if (!extraction) {
    results.push({ ok: false, ms, reason: 'returned_null' });
    origWrite(`  [${i + 1}/${N}] ✗ null  (${ms}ms)\n`);
  } else {
    const counts = `facts=${extraction.facts.length} entities=${extraction.entities.length} pointers=${extraction.pointers.length}`;
    results.push({ ok: true, ms, counts });
    origWrite(`  [${i + 1}/${N}] ✓ ok    (${ms}ms) ${counts}\n`);
  }
}

const totalMs = Date.now() - startedAt;
const ok = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
const avgMs = Math.round(results.reduce((acc, r) => acc + r.ms, 0) / Math.max(1, results.length));

origWrite('\n─── summary ─────────────────────────────────────────\n');
origWrite(`label              : ${LABEL}\n`);
origWrite(`iterations         : ${N}\n`);
origWrite(`successful         : ${ok}\n`);
origWrite(`returned null      : ${results.filter((r) => r.reason === 'returned_null').length}\n`);
origWrite(`thrown             : ${results.filter((r) => r.reason === 'thrown').length}\n`);
origWrite(`invalid-shape logs : ${invalidShapeCount}\n`);
origWrite(`extractor-fail logs: ${extractorThrownCount}\n`);
origWrite(`success rate       : ${((ok / N) * 100).toFixed(1)}%\n`);
origWrite(`avg latency        : ${avgMs}ms\n`);
origWrite(`total wall time    : ${totalMs}ms\n`);
origWrite('─────────────────────────────────────────────────────\n\n');

// Exit code: 0 if no invalid-shape warnings AND success rate >= 75%.
// Tolerate occasional Codex flake but not validation failures (those
// are the bug we're trying to fix).
const passed = invalidShapeCount === 0 && ok / N >= 0.75;
if (passed) {
  origWrite(`✓ PASS (label=${LABEL})\n`);
  process.exit(0);
} else {
  origWrite(`✗ FAIL (label=${LABEL}) — invalid_shape=${invalidShapeCount}, success=${((ok / N) * 100).toFixed(1)}%\n`);
  process.exit(1);
}
