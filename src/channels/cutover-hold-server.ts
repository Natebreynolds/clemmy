import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import pino from 'pino';
import { WEBHOOK_PORT, WEBHOOK_SECRET, WEBHOOK_SECRET_IS_STRONG } from '../config.js';
import { getBuildInfo } from '../runtime/build-info.js';
import { CUTOVER_HOLD } from '../runtime/cutover-hold.js';

const logger = pino({ name: 'clementine-next.cutover-hold-server' });
const CUTOVER_BUILD_INFO_PATH = '/api/console/build-info';
const LOOPBACK_HOST = '127.0.0.1';

let server: http.Server | null = null;

function safeEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function bearerToken(req: http.IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

function sendJson(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const bytes = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(bytes.length));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Connection', 'close');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(bytes);
}

/**
 * The only network surface allowed during a live cutover. This is deliberately
 * not Express and does not import or register the ordinary webhook, Console,
 * mobile, Space, trigger, or external-channel route graphs.
 */
export function createCutoverHoldRequestHandler(): http.RequestListener {
  if (!CUTOVER_HOLD) {
    throw new Error('Refusing to construct the cutover listener without CLEMMY_CUTOVER_HOLD=on at process start.');
  }
  if (!WEBHOOK_SECRET_IS_STRONG) {
    throw new Error('Cutover hold requires a strong WEBHOOK_SECRET so build attestation cannot become public.');
  }

  return (req, res) => {
    let requestUrl: URL;
    try {
      requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      res.setHeader('Retry-After', '5');
      sendJson(req, res, 503, { error: 'cutover_hold' });
      return;
    }
    const buildInfoMethod = req.method === 'GET' || req.method === 'HEAD';
    const buildInfoPath = requestUrl.pathname === CUTOVER_BUILD_INFO_PATH;

    if (!buildInfoMethod || !buildInfoPath) {
      res.setHeader('Retry-After', '5');
      sendJson(req, res, 503, {
        error: 'cutover_hold',
        message: 'Clementine is sealed for release cutover verification.',
      });
      return;
    }

    if (!safeEqual(bearerToken(req), WEBHOOK_SECRET)) {
      sendJson(req, res, 401, { error: 'unauthorized' });
      return;
    }

    sendJson(req, res, 200, getBuildInfo() as unknown as Record<string, unknown>);
  };
}

export async function startCutoverHoldServer(): Promise<void> {
  if (server) return;
  const candidate = http.createServer(createCutoverHoldRequestHandler());
  candidate.keepAliveTimeout = 1;
  await new Promise<void>((resolve, reject) => {
    candidate.once('error', reject);
    candidate.listen(WEBHOOK_PORT, LOOPBACK_HOST, () => {
      candidate.removeListener('error', reject);
      resolve();
    });
  });
  server = candidate;
  logger.warn(
    { host: LOOPBACK_HOST, port: WEBHOOK_PORT },
    'Cutover hold active: only authenticated build-info is listening',
  );
}

export async function stopCutoverHoldServer(): Promise<void> {
  const active = server;
  server = null;
  if (!active) return;
  await new Promise<void>((resolve) => active.close(() => resolve()));
}

export const __test__ = {
  CUTOVER_BUILD_INFO_PATH,
  LOOPBACK_HOST,
};
