import { createHash } from 'node:crypto';

export const HTTP_READ_MAX_BYTES = 1024 * 1024;

function readUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTP(S) URL without embedded credentials.');
  }
  return url;
}

/** A fixed GET, with no ambient cookies, auth, scripting, or filesystem effects. */
export async function boundedHttpRead(input: string, fetchImpl: typeof fetch = fetch) {
  let url = readUrl(input);
  const signal = AbortSignal.timeout(20_000);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetchImpl(url, {
      method: 'GET', redirect: 'manual', credentials: 'omit', signal,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('HTTP redirect omitted its Location header.');
      if (redirects === 5) throw new Error('HTTP read exceeded five redirects.');
      url = readUrl(new URL(location, url).href);
      continue;
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (reader) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > HTTP_READ_MAX_BYTES) {
          await reader.cancel();
          throw new Error('HTTP response exceeded the 1 MiB read limit; no complete body was retained.');
        }
        chunks.push(part.value);
      }
    } finally {
      reader?.releaseLock();
    }
    const body = Buffer.concat(chunks);
    return {
      ok: response.ok, status: response.status, url: url.href,
      contentType: response.headers.get('content-type'), bytes: body.byteLength,
      sha256: createHash('sha256').update(body).digest('hex'),
      body: body.toString('utf8'),
    };
  }
  throw new Error('HTTP redirect limit exceeded.');
}
