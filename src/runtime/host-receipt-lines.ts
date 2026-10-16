/**
 * A tool that wrote something hands back the host's proof of the write: a
 * machine marker with its JSON facts, and artifact fields beside it. Those are
 * evidence the run record keeps; text a person reads gets the sentence that
 * says what was written.
 */
const HOST_RECEIPT_MARKER = /\[clementine:[a-z0-9-]+:v\d+\]\s*(?:\{[^\n]*\})?/g;
const HOST_RECEIPT_FIELD_LINE = /^\s*(?:artifactId|handle|contentDigest|receipt|createdId):\s.*$/gm;

export function withoutHostReceiptLines(text: string): string {
  if (!/\[clementine:[a-z0-9-]+:v\d+\]/.test(text)) return text;
  return text
    .replace(HOST_RECEIPT_MARKER, '')
    .replace(HOST_RECEIPT_FIELD_LINE, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}
