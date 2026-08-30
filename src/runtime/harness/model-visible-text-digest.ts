import { createHash } from 'node:crypto';

/** Content-free identity for an exact UTF-8 text block placed in model-visible
 * context. Writers compute this from the final rendered bytes, never from the
 * memory candidates or snippets which preceded rendering. */
export function modelVisibleTextSha256(text: string | null | undefined): string | null {
  return text
    ? createHash('sha256').update(text, 'utf8').digest('hex')
    : null;
}
