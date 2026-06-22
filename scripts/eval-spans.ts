/**
 * eval:spans — dump a session's OpenTelemetry GenAI spans (Lane A Phase 4,
 * export-on-read). Read-only over the event log; proves a run is externally
 * traceable and that failures resolve to ERROR spans.
 *
 * Run: npx tsx scripts/eval-spans.ts <sessionId> [--json]
 */
import { sessionToGenAiSpans } from '../src/runtime/eval/otel-spans.js';

const sessionId = process.argv[2];
if (!sessionId) {
  console.error('usage: tsx scripts/eval-spans.ts <sessionId> [--json]');
  process.exit(2);
}
const spans = sessionToGenAiSpans(sessionId);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(spans, null, 2));
} else {
  console.log(`\n  GenAI spans for session ${sessionId} — ${spans.length} span(s)\n`);
  for (const s of spans) {
    const ms = s.endTime ? new Date(s.endTime).getTime() - new Date(s.startTime).getTime() : 0;
    const err = s.status?.code === 'ERROR' ? `  ✗ ${s.status.message ?? ''}` : '';
    console.log(`  [${s.kind.padEnd(8)}] ${s.name.padEnd(40)} ${String(ms).padStart(6)}ms${err}`);
  }
  console.log('');
}
