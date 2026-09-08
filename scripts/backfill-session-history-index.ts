/** Optional deployment warm-up of the disposable public-history search index.
 * No implicit live home: the operator must select one explicitly. This does
 * not call a model/provider, read raw tool payloads, or resume any work. */
import path from 'node:path';
const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
const selectedHome = option('--home');
if (!selectedHome) throw new Error('Usage: node --import tsx scripts/backfill-session-history-index.ts --home /explicit/home [--max-batches 10]');
const batches = Number(option('--max-batches') ?? 10);
if (!Number.isSafeInteger(batches) || batches < 1 || batches > 10_000) throw new Error('--max-batches must be between 1 and 10000');
process.env.CLEMENTINE_HOME = path.resolve(selectedHome);
const { openEventLog, closeEventLog } = await import('../src/runtime/harness/eventlog.js');
const { advanceSessionHistoryIndex } = await import('../src/runtime/harness/session-history-search.js');
try {
  const boundary = (openEventLog().prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get() as { seq: number }).seq;
  const startedAt = performance.now();
  for (let batch = 1; batch <= batches; batch++) {
    const coverage = advanceSessionHistoryIndex(boundary);
    process.stdout.write(`${JSON.stringify({ batch, elapsedMs: Math.round(performance.now() - startedAt), coverage })}\n`);
    if (coverage.complete) break;
    // Yield between transactions; another process may read/accept work.
    await new Promise<void>(resolve => setImmediate(resolve));
  }
} finally { closeEventLog(); }
