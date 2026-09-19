import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeterEngine } from './src/engine.js';
import { trialsDir } from './src/paths.js';
import type { Lane, NativeSource, Pairing } from './src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, 'web');
const HOST = '127.0.0.1';
const PORT = Number(process.env.METER_PORT || 4177);

const engine = new MeterEngine();
const sse = new Set<ServerResponse>();

engine.onSnapshot((snap) => {
  const payload = `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`;
  for (const res of sse) {
    try { res.write(payload); } catch { sse.delete(res); }
  }
});

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  const isJson = type === 'application/json';
  const data = isJson
    ? Buffer.from(JSON.stringify(body))
    : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    'content-type': isJson ? 'application/json; charset=utf-8' : type,
    'cache-control': 'no-store',
    'content-length': data.length,
  });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function persistIfSealed(): void {
  const trial = engine.trial;
  if (!trial?.nativeSealedAt || !trial.clementineSealedAt) return;
  const dir = trialsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${trial.id}.json`), JSON.stringify(engine.snapshot(), null, 2));
}

function mime(file: string): string {
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'text/html; charset=utf-8';
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/live') {
      send(res, 200, engine.snapshot());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/clear') {
      engine.clear();
      send(res, 200, engine.snapshot());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/trial') {
      send(res, 200, engine.trialSnapshot());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/trial') {
      const body = await jsonBody(req);
      const pairing = body.pairing === 'claude' ? 'claude' : 'codex';
      const nativeSource = (['claude-code', 'cowork', 'codex'] as NativeSource[])
        .includes(body.nativeSource as NativeSource)
        ? body.nativeSource as NativeSource
        : (pairing === 'claude' ? 'claude-code' : 'codex');
      engine.create({
        name: typeof body.name === 'string' ? body.name : 'untitled task',
        pairing: pairing as Pairing,
        nativeSource,
        promptNote: typeof body.promptNote === 'string' ? body.promptNote : undefined,
      });
      send(res, 200, engine.snapshot());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/trial/reset') {
      engine.reset();
      send(res, 200, engine.snapshot());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/trial/arm') {
      engine.arm();
      send(res, 200, engine.snapshot());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/trial/bind') {
      const body = await jsonBody(req);
      const lane: Lane = body.lane === 'clementine' ? 'clementine' : 'native';
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      if (!sessionId) { send(res, 400, { error: 'sessionId required' }); return; }
      engine.bind(lane, sessionId);
      send(res, 200, engine.snapshot());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/trial/seal') {
      const body = await jsonBody(req);
      const lane: Lane = body.lane === 'clementine' ? 'clementine' : (body.lane === 'both' ? 'native' : 'native');
      if (body.lane === 'both') {
        engine.seal('native');
        engine.seal('clementine');
      } else {
        engine.seal(lane);
      }
      persistIfSealed();
      send(res, 200, engine.snapshot());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(`event: snapshot\ndata: ${JSON.stringify(engine.snapshot())}\n\n`);
      sse.add(res);
      req.on('close', () => sse.delete(res));
      return;
    }

    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    const full = path.normalize(path.join(webRoot, file));
    if (!full.startsWith(webRoot)) { send(res, 403, { error: 'forbidden' }); return; }
    if (!existsSync(full)) { send(res, 404, { error: 'not found' }); return; }
    send(res, 200, readFileSync(full), mime(full));
  } catch (err) {
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

engine.start();
server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`Usage sidecar on ${url}`);
  if (process.platform === 'darwin') execFile('open', [url]);
});
