/**
 * Minimal, sanitizing markdown → HTML for chat replies.
 *
 * The model's replies carry markdown (**bold**, lists, code fences, links) and
 * the mobile chat rendered the raw asterisks. This renderer escapes ALL input
 * first and only then adds markup, so no HTML in a reply can ever execute —
 * there is deliberately no raw-HTML passthrough and links are restricted to
 * http(s). Covers the structures chat replies actually use: paragraphs,
 * headings, bold/italic, inline code, fenced code blocks, links, blockquotes,
 * and unordered/ordered lists (single level — chat replies don't nest deeper
 * in practice, and a flat list renders those fine too).
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Inline transforms over already-escaped text. */
function renderInline(escaped: string): string {
  let out = escaped;
  // Inline code first, so its contents are exempt from the other transforms.
  const codeSpans: string[] = [];
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codeSpans.push(code);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  // Links: [text](http…) only — anything else stays literal text.
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, href: string) =>
    `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  // Bold before italic so ** doesn't get eaten as two singles.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${codeSpans[Number(i)]}</code>`);
  return out;
}

export function renderMarkdown(source: string): string {
  const text = source.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: { lang: string; lines: string[] } | null = null;
  let quote: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length) {
      html.push(`<p>${paragraph.map((l) => renderInline(escapeHtml(l))).join('<br>')}</p>`);
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (list) {
      const tag = list.ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${list.items.map((item) => `<li>${item}</li>`).join('')}</${tag}>`);
      list = null;
    }
  };
  const flushQuote = (): void => {
    if (quote.length) {
      html.push(`<blockquote>${quote.map((l) => renderInline(escapeHtml(l))).join('<br>')}</blockquote>`);
      quote = [];
    }
  };
  const flushAll = (): void => { flushParagraph(); flushList(); flushQuote(); };

  for (const line of lines) {
    if (code) {
      if (/^```/.test(line.trim())) {
        html.push(`<pre><code>${escapeHtml(code.lines.join('\n'))}</code></pre>`);
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }
    const trimmed = line.trim();
    const fence = trimmed.match(/^```(\w*)/);
    if (fence) {
      flushAll();
      code = { lang: fence[1] ?? '', lines: [] };
      continue;
    }
    if (!trimmed) {
      flushAll();
      continue;
    }
    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length + 2, 6); // h3–h6: chat bubbles never need h1
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }
    const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
    const numbered = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      flushQuote();
      const ordered = Boolean(numbered);
      const content = renderInline(escapeHtml((bullet?.[1] ?? numbered?.[2] ?? '')));
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(content);
      continue;
    }
    const quoted = trimmed.match(/^>\s?(.*)$/);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }
    if (list) {
      // A wrapped continuation line belongs to the previous list item.
      list.items[list.items.length - 1] += ` ${renderInline(escapeHtml(trimmed))}`;
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push(line);
  }
  if (code) html.push(`<pre><code>${escapeHtml(code.lines.join('\n'))}</code></pre>`);
  flushAll();
  return html.join('');
}
