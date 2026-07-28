/**
 * Strip inline markdown to calm plain text for compact surfaces (banner
 * titles, one-line summaries, card hints) where rendering full markdown would
 * be noise but showing raw `**bold**` / `[label](url)` syntax is a leak.
 * Deterministic and additive — long content is the caller's line-clamp job.
 */
export function stripInlineMarkdown(text: string): string {
  if (!text) return '';
  let out = text;
  // Fenced/inline code: keep the content, drop the ticks.
  out = out.replace(/```[a-z]*\n?/gi, '').replace(/`([^`]*)`/g, '$1');
  // Links/images: keep the human label, drop the URL.
  out = out.replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, (_m, label: string) => label || '');
  // Bold / italics / strikethrough markers.
  out = out.replace(/(\*\*|__)(.*?)\1/g, '$2');
  out = out.replace(/(^|[\s(])(\*|_)([^*_]+)\2(?=[\s).,;:!?]|$)/g, '$1$3');
  out = out.replace(/~~(.*?)~~/g, '$1');
  // Heading markers at line starts.
  out = out.replace(/^#{1,6}\s+/gm, '');
  // Truncated previews can cut a bold span in half, leaving a dangling "**" no
  // pair-regex can close — in these one-line surfaces a marker run is always
  // noise, never content.
  out = out.replace(/\*{2,}|__+/g, '');
  // A bare long URL reads as noise in a one-liner — show its host.
  out = out.replace(/https?:\/\/[^\s)]{28,}/g, (url) => {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
  });
  return out.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' · ').trim();
}
