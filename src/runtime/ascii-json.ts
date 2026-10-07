/** JSON whose bytes are all ASCII: every character outside printable ASCII
 * is a \uXXXX escape, which every JSON reader decodes back to the exact
 * string. Windows PowerShell 5.1 reads redirected stdin in the console code
 * page it started with, so raw UTF-8 bytes cannot be relied on to arrive.
 * No imports: the credential policy bundle must stay config independent. */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
