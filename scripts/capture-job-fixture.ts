/**
 * capture-job-fixture — turn a REAL session into a replayable JobFixture
 * (Lane A trust-layer P2). The deterministic offline job evals (eval:jobs) run
 * against captured fixtures so pass^k measures the agent's nondeterminism, never
 * a live API's. Periodically re-capture a known-good run to refresh fixtures
 * against product drift; the JSON diff is reviewable.
 *
 * Run: npx tsx scripts/capture-job-fixture.ts <sessionId> [outPath]
 *   - prints the JobFixture JSON to stdout, and also writes it to outPath when given
 *     (e.g. src/runtime/eval/fixtures/<id>.json).
 *
 * Light PII redaction: email addresses → [email] (never touches numbers, so the
 * figures-grounded check stays faithful). Review every captured fixture before
 * committing — it embeds whatever the run actually saw.
 */
import { writeFileSync } from 'node:fs';
import type { JobFixture, JobFixtureEvent, JobFixtureToolOutput } from '../src/runtime/eval/job-case.js';
import type { EventType } from '../src/runtime/harness/eventlog.js';

const sessionId = process.argv[2];
const outPath = process.argv[3];
if (!sessionId) {
  console.error('usage: tsx scripts/capture-job-fixture.ts <sessionId> [outPath]');
  process.exit(2);
}

const { listEvents, getToolOutput } = await import('../src/runtime/harness/eventlog.js');

// The event types the replay + assertions need (keeps fixtures lean + reviewable).
const CAPTURE_TYPES = new Set<EventType>([
  'user_input_received', 'tool_called', 'tool_returned',
  'external_write', 'external_write_failed', 'run_failed',
  'conversation_completed', 'conversation_limit_exceeded', 'guardrail_tripped',
]);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const redact = (s: string): string => s.replace(EMAIL_RE, '[email]');
const redactData = (d: Record<string, unknown>): Record<string, unknown> =>
  JSON.parse(redact(JSON.stringify(d ?? {})));

const all = listEvents(sessionId);
if (all.length === 0) {
  console.error(`no events for session ${sessionId}`);
  process.exit(1);
}

const events: JobFixtureEvent[] = all
  .filter((e) => CAPTURE_TYPES.has(e.type))
  .map((e) => ({ turn: e.turn, role: e.role, type: e.type, data: redactData(e.data) }));

// Collect tool_outputs for every callId referenced by a tool call/return.
const callIds = new Set<string>();
for (const e of all) {
  const cid = (e.data as { callId?: string }).callId;
  if (cid) callIds.add(cid);
}
const toolOutputs: JobFixtureToolOutput[] = [];
for (const callId of callIds) {
  const rec = getToolOutput(sessionId, callId);
  if (rec) toolOutputs.push({ callId, tool: rec.tool, output: redact(rec.output) });
}

// The deliverable: the last conversation_completed reply/summary.
const completed = all.filter((e) => e.type === 'conversation_completed');
const last = completed[completed.length - 1]?.data as { reply?: string; summary?: string } | undefined;
const finalAnswerText = redact(String(last?.reply ?? last?.summary ?? ''));

const objective = redact(String(
  (all.find((e) => e.type === 'user_input_received')?.data as { text?: string } | undefined)?.text ?? '',
));

const fixture: JobFixture = {
  id: `captured-${sessionId}`,
  objective,
  maxToolCalls: Math.max(40, all.filter((e) => e.type === 'tool_called').length + 10),
  events,
  toolOutputs,
  finalAnswerText,
};

const json = `${JSON.stringify(fixture, null, 2)}\n`;
if (outPath) {
  writeFileSync(outPath, json);
  console.error(`wrote ${outPath} (${events.length} events, ${toolOutputs.length} tool outputs)`);
}
process.stdout.write(json);
