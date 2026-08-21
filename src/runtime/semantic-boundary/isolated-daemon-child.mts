/** Isolated daemon process: normal typed bootstrap + local HTTP, no channels. */
import http from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Agent } from '@openai/agents';

const HOME = process.env.CLEMENTINE_HOME;
const PORT = Number(process.env.CLEMENTINE_ISOLATED_PORT ?? '0');
if (!HOME || process.env.CLEMENTINE_ISOLATED_VERTICAL !== '1') {
  process.stderr.write('isolated daemon requires CLEMENTINE_HOME and CLEMENTINE_ISOLATED_VERTICAL=1\n');
  process.exit(2);
}
if (!Number.isInteger(PORT) || PORT <= 0) {
  process.stderr.write('isolated daemon requires CLEMENTINE_ISOLATED_PORT\n');
  process.exit(2);
}

mkdirSync(HOME, { recursive: true });

const { configureTypedExecutionRuntime } = await import('./configure-typed-execution-runtime.js');
const { isolatedVerticalEnabled, ISOLATED_SESSION_ID, ISOLATED_UNSEEN_REQUEST } = await import('./isolated-vertical.js');
const { createSession, listEvents } = await import('../harness/eventlog.js');
const { runConversation } = await import('../harness/loop.js');

if (!isolatedVerticalEnabled()) {
  process.stderr.write('isolated vertical refused to arm\n');
  process.exit(2);
}

configureTypedExecutionRuntime();
try {
  createSession({ id: ISOLATED_SESSION_ID, kind: 'chat', userId: 'user-1' });
} catch {
  // Restart against the same home reuses the durable session.
}

function acceptedSourceSeq(): number | undefined {
  const events = listEvents(ISOLATED_SESSION_ID, { types: ['user_input_received'] });
  const first = events[0];
  return first && Number.isSafeInteger(first.seq) && first.seq > 0 ? first.seq : undefined;
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? '/';
  if (req.method === 'GET' && (url === '/health' || url === '/ready')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pid: process.pid }));
    return;
  }
  if (req.method === 'POST' && url === '/chat') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: { input?: string } = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { input?: string };
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid json' }));
      return;
    }
    const input = typeof body.input === 'string' && body.input.trim()
      ? body.input.trim()
      : ISOLATED_UNSEEN_REQUEST;
    const sourceUserSeq = acceptedSourceSeq();
    try {
      const result = await runConversation({
        sessionId: ISOLATED_SESSION_ID,
        input,
        ...(sourceUserSeq
          ? { sourceUserSeq, reuseRecordedUserInput: true }
          : {}),
        agent: new Agent({ name: 'isolated-daemon', instructions: 'unused', tools: [] }),
      });
      const terminals = listEvents(ISOLATED_SESSION_ID, { types: ['conversation_completed'] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: result.status,
        error: result.error ?? null,
        terminals: terminals.length,
        sourceUserSeq: acceptedSourceSeq() ?? null,
      }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, '127.0.0.1', () => {
    server.removeListener('error', reject);
    resolve();
  });
});
writeFileSync(path.join(HOME, 'ready'), JSON.stringify({ pid: process.pid, port: PORT }));
process.stdout.write(`isolated-daemon-ready pid=${process.pid} port=${PORT}\n`);
if (!existsSync(path.join(HOME, 'ready'))) process.exit(3);
