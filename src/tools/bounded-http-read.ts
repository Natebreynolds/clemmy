import { createHash } from 'node:crypto';

export const HTTP_READ_MAX_BYTES = 1024 * 1024;
/** An image comes back as the image itself, so it may be larger than text;
 *  stay under the per-image request cap with base64 overhead. */
export const HTTP_READ_IMAGE_MAX_BYTES = 3_750_000;

const VIEWABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface BoundedHttpReadResult {
  ok: boolean;
  status: number;
  url: string;
  contentType: string | null;
  bytes: number;
  sha256: string;
  /** The body as text; absent when the body is an image. */
  body?: string;
  /** The body as an image the model can look at. */
  image?: { data: string; mimeType: string };
}

function readUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTP(S) URL without embedded credentials.');
  }
  return url;
}

function declaresViewableImage(contentType: string | null): boolean {
  return VIEWABLE_IMAGE_TYPES.has((contentType ?? '').split(';')[0]!.trim().toLowerCase());
}

/** The image type the bytes themselves are, or null. A declared image type is
 *  believed only when the bytes agree. */
export function sniffViewableImageType(body: Uint8Array): string | null {
  const at = (index: number) => body[index];
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif';
  if (body.length >= 12
    && Buffer.from(body.subarray(0, 4)).toString('latin1') === 'RIFF'
    && Buffer.from(body.subarray(8, 12)).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** A fixed GET, with no ambient cookies, auth, scripting, or filesystem effects. */
export async function boundedHttpRead(input: string, fetchImpl: typeof fetch = fetch): Promise<BoundedHttpReadResult> {
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
    const contentType = response.headers.get('content-type');
    const imageDeclared = response.ok && declaresViewableImage(contentType);
    const limit = imageDeclared ? HTTP_READ_IMAGE_MAX_BYTES : HTTP_READ_MAX_BYTES;
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (reader) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > limit) {
          await reader.cancel();
          throw new Error(imageDeclared
            ? `The image is over the ${(HTTP_READ_IMAGE_MAX_BYTES / 1_000_000).toFixed(2)} MB viewing limit; ask the source for a smaller size.`
            : 'HTTP response exceeded the 1 MiB read limit; no complete body was retained.');
        }
        chunks.push(part.value);
      }
    } finally {
      reader?.releaseLock();
    }
    const body = Buffer.concat(chunks);
    const evidence = {
      ok: response.ok, status: response.status, url: url.href,
      contentType, bytes: body.byteLength,
      sha256: createHash('sha256').update(body).digest('hex'),
    };
    const imageType = imageDeclared ? sniffViewableImageType(body) : null;
    if (imageType) return { ...evidence, image: { data: body.toString('base64'), mimeType: imageType } };
    return { ...evidence, body: body.toString('utf8') };
  }
  throw new Error('HTTP redirect limit exceeded.');
}
