/** A toolkit mention in input data or a report is not a request to use it.
 * Inference is optional: only an explicit tool-use instruction may bind a
 * previously unbound step. Exact operation citations take precedence upstream.
 */
export function requestsToolkitUse(prompt: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b(?:use|using|prefer|call|invoke|run)\\b(?:[ \\t]+[\\w-]+){0,4}[ \\t]+${escaped}\\b`, 'i').test(prompt);
}
