/**
 * Minimal, sanitizing markdown → HTML for chat replies, shared by the desktop
 * console and the phone so an answer reads the same on both.
 *
 * The model's replies carry markdown (**bold**, lists, code fences, links,
 * tables). This renderer escapes ALL input first and only then adds markup, so
 * no HTML in a reply can ever execute — there is deliberately no raw-HTML
 * passthrough, and links are restricted to http(s) plus, where the surface
 * asks for it, the exact mobile Workspace route. Covers the structures chat
 * replies actually use: paragraphs, headings, bold/italic, inline code, fenced
 * code blocks, links (written or bare), blockquotes, pipe tables, and
 * unordered/ordered lists (single level — chat replies don't nest deeper in
 * practice, and a flat list renders those fine too).
 */

export interface RenderMarkdownOptions {
  /** Activate the same-origin mobile Workspace route. Only the phone serves
   *  it; elsewhere it stays text so model output cannot navigate the app. */
  workspaceLinks?: boolean;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const EXTERNAL = 'target="_blank" rel="noopener noreferrer"';
/** Sentence punctuation that ends a bare URL rather than belonging to it. */
const URL_TAIL_PIECE = /(?:[.,;:!?'*\])}]|&quot;)$/;
/** A bare URL stops at whitespace, markup, or an escaped bracket or quote. */
const BARE_URL = /https?:\/\/(?:(?!&lt;|&gt;|&quot;)[^\s<\u0000])+/g;

/** Inline transforms over already-escaped text. */
function renderInline(escaped: string, options: RenderMarkdownOptions): string {
  let out = escaped;
  // Inline code and finished anchors are set aside first, so their contents
  // are exempt from every later transform (a URL inside code stays code; an
  // anchor's href is never linked a second time).
  const held: string[] = [];
  const hold = (html: string): string => {
    held.push(html);
    return `\u0000${held.length - 1}\u0000`;
  };
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => hold(`<code>${code}</code>`));
  out = out.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|\/m\/\?tab=spaces&amp;workspace=[a-z0-9][a-z0-9-]{0,61}[a-z0-9])\)/g,
    (match, label: string, href: string) => {
      if (href.startsWith('/m/')) return options.workspaceLinks === false ? match : hold(`<a href="${href}">${label}</a>`);
      return hold(`<a href="${href}" ${EXTERNAL}>${label}</a>`);
    },
  );
  out = out.replace(BARE_URL, (url: string) => {
    let href = url;
    let trail = '';
    for (let piece = URL_TAIL_PIECE.exec(href); piece; piece = URL_TAIL_PIECE.exec(href)) {
      // A closing bracket the URL itself opened is part of the URL.
      if (piece[0] === ')' && href.split('(').length > href.split(')').length - 1) break;
      href = href.slice(0, href.length - piece[0].length);
      trail = piece[0] + trail;
    }
    if (!/^https?:\/\/[^/\s]+\.[^/\s]/.test(href)) return url;
    return `${hold(`<a href="${href}" ${EXTERNAL}>${href}</a>`)}${trail}`;
  });
  // Bold before italic so ** doesn't get eaten as two singles.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  for (let pass = 0; pass < 2 && out.includes('\u0000'); pass += 1) {
    out = out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => held[Number(i)] ?? '');
  }
  return out;
}

/** `| a | b |` → ['a', 'b']. An escaped `\|` stays inside its cell. A
 *  character walk rather than a lookbehind split: older mobile web views
 *  reject lookbehind at parse time, which would take the whole bundle down. */
function tableCells(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\\' && body[i + 1] === '|') { current += '|'; i += 1; continue; }
    if (ch === '|') { cells.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function isTableStart(line: string, next: string | undefined): boolean {
  return line.includes('|') && next !== undefined && TABLE_RULE.test(next)
    && tableCells(line).length === tableCells(next).length;
}

function renderTable(header: string, rule: string, rows: string[], options: RenderMarkdownOptions): string {
  const heads = tableCells(header);
  const align = tableCells(rule).map((cell) => (
    cell.startsWith(':') && cell.endsWith(':') ? ' class="al-c"' : cell.endsWith(':') ? ' class="al-r"' : ''
  ));
  const cell = (tag: 'th' | 'td', text: string, index: number): string => (
    `<${tag}${align[index] ?? ''}>${renderInline(escapeHtml(text), options)}</${tag}>`
  );
  const head = `<thead><tr>${heads.map((text, i) => cell('th', text, i)).join('')}</tr></thead>`;
  const body = rows.map((row) => {
    const cells = tableCells(row);
    return `<tr>${heads.map((_h, i) => cell('td', cells[i] ?? '', i)).join('')}</tr>`;
  }).join('');
  // The wrapper scrolls sideways on its own so a wide table never widens the page.
  return `<div class="md-table"><table>${head}<tbody>${body}</tbody></table></div>`;
}

export function renderMarkdown(source: string, options: RenderMarkdownOptions = {}): string {
  const text = source.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: { lang: string; lines: string[] } | null = null;
  let quote: string[] = [];
  const inline = (line: string): string => renderInline(escapeHtml(line), options);

  const flushParagraph = (): void => {
    if (paragraph.length) {
      html.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
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
      html.push(`<blockquote>${quote.map(inline).join('<br>')}</blockquote>`);
      quote = [];
    }
  };
  const flushAll = (): void => { flushParagraph(); flushList(); flushQuote(); };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
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
    if (isTableStart(line, lines[i + 1])) {
      flushAll();
      const rows: string[] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && lines[j].includes('|')) {
        rows.push(lines[j]);
        j += 1;
      }
      html.push(renderTable(line, lines[i + 1], rows, options));
      i = j - 1;
      continue;
    }
    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length + 2, 6); // h3–h6: chat bubbles never need h1
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
    const numbered = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      flushQuote();
      const ordered = Boolean(numbered);
      const content = inline(bullet?.[1] ?? numbered?.[2] ?? '');
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
      list.items[list.items.length - 1] += ` ${inline(trimmed)}`;
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
