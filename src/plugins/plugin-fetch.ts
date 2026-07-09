/**
 * Download a plugin archive from a URL so it can flow through the SAME
 * resolve → preview → consent → install path as a local .clemplug. The
 * network is the only new concern here; everything downstream is unchanged.
 */
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const ARCHIVE_EXT_RE = /\.(clemplug|tgz|tar\.gz)(\?.*)?$/i;
const OK_CONTENT_TYPES = ['application/gzip', 'application/x-gzip', 'application/x-tar', 'application/octet-stream'];

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export async function downloadPluginArchive(url: string): Promise<{ file: string; cleanup: () => void }> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`Not a valid URL: ${url}`); }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) {
    throw new Error('Plugin URLs must use https (http allowed for localhost only)');
  }

  const res = await fetch(parsed, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!ARCHIVE_EXT_RE.test(parsed.pathname) && contentType && !OK_CONTENT_TYPES.includes(contentType)) {
    throw new Error(`URL does not look like a plugin archive (content-type ${contentType}; expected a .clemplug/.tgz link)`);
  }
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`Archive exceeds ${MAX_DOWNLOAD_BYTES / (1024 * 1024)}MB download limit`);
  if (!res.body) throw new Error('Download returned no body');

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'clemplug-dl-'));
  const cleanup = (): void => rmSync(tmp, { recursive: true, force: true });
  const base = path.basename(parsed.pathname).replace(/[^a-zA-Z0-9._-]/g, '_');
  const file = path.join(tmp, ARCHIVE_EXT_RE.test(base) ? base.replace(/\?.*$/, '') : 'plugin.clemplug');

  try {
    let received = 0;
    const guard = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller): void {
        received += chunk.byteLength;
        if (received > MAX_DOWNLOAD_BYTES) throw new Error(`Archive exceeds ${MAX_DOWNLOAD_BYTES / (1024 * 1024)}MB download limit`);
        controller.enqueue(chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body.pipeThrough(guard) as never), createWriteStream(file));
    return { file, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
