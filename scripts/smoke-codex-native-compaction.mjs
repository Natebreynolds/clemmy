#!/usr/bin/env node
// scripts/smoke-codex-native-compaction.mjs
//
// Real Codex proof for the flag-only native compaction experiment.
//
// Usage:
//   npm run build
//   CLEMMY_CODEX_NATIVE_COMPACTION=1 CLEMMY_CODEX_NATIVE_COMPACTION_THRESHOLD=1000 node scripts/smoke-codex-native-compaction.mjs
//
// This intentionally uses the packaged dist adapter path, real Codex auth,
// and local function tools. It creates files in a temp directory only.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Agent, Runner, tool } from '@openai/agents';
import { z } from 'zod';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DIST = path.join(REPO_ROOT, 'dist');

if (!existsSync(path.join(DIST, 'runtime/harness/codex-model.js'))) {
  console.error('✗ dist/ not built. Run: npm run build');
  process.exit(2);
}

process.env.CLEMMY_CODEX_NATIVE_COMPACTION = process.env.CLEMMY_CODEX_NATIVE_COMPACTION || '1';
process.env.CLEMMY_CODEX_NATIVE_COMPACTION_THRESHOLD = process.env.CLEMMY_CODEX_NATIVE_COMPACTION_THRESHOLD || '1000';

const { configureHarnessRuntime } = await import(pathToFileURL(path.join(DIST, 'runtime/harness/codex-client.js')).href);
const configured = await configureHarnessRuntime();
if (!configured.ok) {
  console.error(`✗ ${configured.reason}`);
  process.exit(2);
}

const threshold = Number(process.env.CLEMMY_CODEX_NATIVE_COMPACTION_THRESHOLD);
const workspace = mkdtempSync(path.join(os.tmpdir(), 'clemmy-codex-native-compaction-'));
const toolCalls = [];
const marker = 'ORANGE-SATURN-47';

function safePath(filename) {
  const clean = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(workspace, clean || 'note.txt');
}

const writeNote = tool({
  name: 'smoke_write_note',
  description: 'Write one UTF-8 smoke-test note into the temporary workspace.',
  parameters: z.object({
    filename: z.string().min(1),
    content: z.string().min(1),
  }),
  execute: async ({ filename, content }) => {
    const filePath = safePath(filename);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
    toolCalls.push({ tool: 'smoke_write_note', filePath, bytes: Buffer.byteLength(content, 'utf8') });
    return JSON.stringify({ ok: true, filePath, bytes: Buffer.byteLength(content, 'utf8') });
  },
});

const readNote = tool({
  name: 'smoke_read_note',
  description: 'Read one UTF-8 smoke-test note from the temporary workspace.',
  parameters: z.object({
    filename: z.string().min(1),
  }),
  execute: async ({ filename }) => {
    const filePath = safePath(filename);
    const content = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
    toolCalls.push({ tool: 'smoke_read_note', filePath, bytes: Buffer.byteLength(content, 'utf8') });
    return JSON.stringify({ ok: existsSync(filePath), filePath, content });
  },
});

const listNotes = tool({
  name: 'smoke_list_notes',
  description: 'List files in the temporary smoke-test workspace.',
  parameters: z.object({}),
  execute: async () => {
    const files = readdirSync(workspace).sort();
    toolCalls.push({ tool: 'smoke_list_notes', files });
    return JSON.stringify({ workspace, files });
  },
});

const agent = new Agent({
  name: 'Native Codex Compaction Smoke',
  model: process.env.SMOKE_CODEX_MODEL || 'gpt-5.4',
  instructions: [
    'You are running a reliability smoke test for Clementine.',
    'Use the provided smoke tools multiple times.',
    `Remember this exact marker across the whole run: ${marker}.`,
    'Before final response, read back at least one file you wrote.',
    `The final response must include the exact marker ${marker}, the number of smoke tool calls you believe you made, and a concise pass/fail statement.`,
  ].join('\n'),
  modelSettings: {
    parallelToolCalls: false,
    contextManagement: [{ type: 'compaction', compactThreshold: Number.isFinite(threshold) ? threshold : 1000 }],
  },
  tools: [writeNote, readNote, listNotes],
});

const prompt = [
  'Run a native Codex compaction proof.',
  'Create at least three note files with distinct checkpoint facts.',
  'Then list the notes, read one note back, and finish with the exact marker.',
  '',
  'Checkpoint facts to preserve:',
  `1. Marker: ${marker}.`,
  '2. Alice owns the renewal tracker.',
  '3. The next task is packaging verification.',
  '4. The risk being tested is context overload during long tool-heavy runs.',
  '5. If compaction works, you should still remember all prior checkpoint facts at the end.',
  '',
  'Use several short tool calls instead of one large call.',
].join('\n');

const runner = new Runner({
  workflowName: 'codex-native-compaction-smoke',
  toolExecution: { maxFunctionToolConcurrency: 2 },
});

console.log('→ Codex native compaction real smoke');
console.log(`   workspace=${workspace}`);
console.log(`   threshold=${process.env.CLEMMY_CODEX_NATIVE_COMPACTION_THRESHOLD}`);

const startedAt = Date.now();
let result;
try {
  result = await runner.run(agent, prompt, { maxTurns: 12 });
} catch (err) {
  console.error('✗ run failed');
  console.error(err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
  process.exit(1);
}

const elapsedMs = Date.now() - startedAt;
const rawOutputs = result.rawResponses.flatMap((response) => response.output ?? []);
const compactionItems = rawOutputs.filter((item) => item?.type === 'compaction');
const finalOutput = typeof result.finalOutput === 'string'
  ? result.finalOutput
  : JSON.stringify(result.finalOutput ?? null);
const files = readdirSync(workspace).sort();

console.log('\n─── summary ─────────────────────────────────────────');
console.log(`elapsed_ms       : ${elapsedMs}`);
console.log(`raw_responses    : ${result.rawResponses.length}`);
console.log(`tool_calls       : ${toolCalls.length}`);
console.log(`files            : ${files.join(', ') || '(none)'}`);
console.log(`compaction_items : ${compactionItems.length}`);
console.log(`final_output     : ${finalOutput.slice(0, 1000)}`);
console.log('─────────────────────────────────────────────────────');

const failures = [];
if (toolCalls.length < 5) failures.push(`expected >=5 smoke tool calls, got ${toolCalls.length}`);
if (files.length < 3) failures.push(`expected >=3 files, got ${files.length}`);
if (compactionItems.length < 1) failures.push('expected at least one compaction output item');
if (!finalOutput.includes(marker)) failures.push(`final output did not preserve marker ${marker}`);

if (failures.length > 0) {
  console.error('\n✗ FAIL');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('\n✓ PASS');
