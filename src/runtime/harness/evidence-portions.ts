/** Split for a selected model's request capacity, never discard source text.
 * Callers retain the original evidence and must account for every portion. */
export function evidencePortions(text: string, fits: (portion: string) => boolean): string[] {
  if (fits(text)) return [text];
  if (!fits('')) throw new Error('The review instructions exceed the selected model context window.');
  const parts: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let low = 0;
    let high = text.length - offset;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(text.slice(offset, offset + middle))) low = middle;
      else high = middle - 1;
    }
    // Keep UTF-16 surrogate pairs intact at the transport boundary.
    if (low && /[\uD800-\uDBFF]/.test(text[offset + low - 1]!)
      && /[\uDC00-\uDFFF]/.test(text[offset + low] ?? '')) low--;
    if (!low) throw new Error('The selected review window cannot fit the next source character.');
    // Prefer a complete paragraph when one fits; the next part keeps the
    // delimiter as well, so concatenation reconstructs the exact source.
    const paragraph = text.lastIndexOf('\n\n', offset + low - 2);
    if (paragraph > offset + low / 2) low = paragraph + 2 - offset;
    parts.push(text.slice(offset, offset + low));
    offset += low;
  }
  return parts;
}
