/**
 * produce_document core (2026-07-21) — deterministic document production
 * (capability audit missing-primitive #4, greenfield: no PDF/DOCX generation
 * existed anywhere; PDF was input-only).
 *
 * Pure pieces here: template merge + a small markdown→HTML renderer covering
 * the business-document subset (headings, emphasis, lists, tables, code,
 * links, blockquotes, rules). Deliberately NOT a full CommonMark engine — a
 * letter/report/proposal never needs reference links or HTML passthrough,
 * and a dependency-free renderer keeps the pipeline auditable.
 *
 * The tool wrapper (document-produce-tools.ts) does the impure half: PDF via
 * headless Chrome --print-to-pdf, DOCX via macOS textutil — both already on
 * the machine, zero new dependencies.
 */

export interface TemplateMergeResult {
  content: string;
  /** Placeholders that had NO value — the "letter went out with
   *  {{client_name}} in it" horror, surfaced instead of shipped. */
  missing: string[];
}

/** Merge {{var}} placeholders. Unknown placeholders are LEFT VISIBLE and
 *  reported in `missing` so the caller can hard-stop. */
export function mergeTemplate(template: string, vars: Record<string, unknown>): TemplateMergeResult {
  const missing = new Set<string>();
  const content = template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (raw, name: string) => {
    const value = vars[name];
    if (value === undefined || value === null) {
      missing.add(name);
      return raw;
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
  return { content, missing: Array.from(missing) };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Inline markdown: escape first, then bold/italic/code/links. */
function renderInline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

/** Business-doc markdown subset → HTML body. Deterministic, line-oriented. */
export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let inCode = false;
  let codeLines: string[] = [];
  let tableRows: string[][] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      out.push(`<p>${paragraph.map(renderInline).join('<br/>')}</p>`);
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };
  const flushTable = (): void => {
    if (tableRows.length === 0) return;
    const [header, ...body] = tableRows;
    const cells = (row: string[], tag: 'th' | 'td'): string => row.map((c) => `<${tag}>${renderInline(c)}</${tag}>`).join('');
    out.push('<table>');
    out.push(`<thead><tr>${cells(header, 'th')}</tr></thead>`);
    if (body.length > 0) out.push(`<tbody>${body.map((r) => `<tr>${cells(r, 'td')}</tr>`).join('')}</tbody>`);
    out.push('</table>');
    tableRows = [];
  };
  const flushAll = (): void => { flushParagraph(); flushList(); flushTable(); };

  for (const line of lines) {
    if (inCode) {
      if (line.trim().startsWith('```')) {
        out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else codeLines.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) { flushAll(); inCode = true; continue; }
    if (!trimmed) { flushAll(); continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) { flushAll(); out.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) { flushAll(); out.push('<hr/>'); continue; }
    if (trimmed.startsWith('>')) { flushAll(); out.push(`<blockquote><p>${renderInline(trimmed.replace(/^>\s?/, ''))}</p></blockquote>`); continue; }

    // Table row (require pipes at both ends; separator rows are skipped).
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      flushParagraph(); flushList();
      const cells = trimmed.slice(1, -1).split('|').map((c) => c.trim());
      if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) tableRows.push(cells);
      continue;
    }
    flushTable();

    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      flushParagraph();
      const wanted: 'ul' | 'ol' = bullet ? 'ul' : 'ol';
      if (listType !== wanted) { flushList(); out.push(`<${wanted}>`); listType = wanted; }
      out.push(`<li>${renderInline((bullet ?? numbered)![1])}</li>`);
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }
  if (inCode && codeLines.length > 0) out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  flushAll();
  return out.join('\n');
}

/** Print-ready HTML document with sane business-letter defaults. */
export function htmlDocument(bodyHtml: string, opts: { title?: string; css?: string } = {}): string {
  const defaultCss = [
    'body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; font-size: 12pt; line-height: 1.5; color: #111; max-width: 46em; margin: 2.5em auto; padding: 0 2em; }',
    'h1 { font-size: 20pt; } h2 { font-size: 16pt; } h3 { font-size: 13pt; }',
    'table { border-collapse: collapse; width: 100%; margin: 1em 0; }',
    'th, td { border: 1px solid #999; padding: 6px 10px; text-align: left; font-size: 10.5pt; }',
    'th { background: #f0f0f0; }',
    'pre { background: #f6f6f6; padding: 1em; overflow-x: auto; font-size: 10pt; }',
    'blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 1em; color: #444; }',
    '@media print { body { margin: 0; padding: 0; } }',
  ].join('\n');
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8"/>',
    `<title>${escapeHtml(opts.title ?? 'Document')}</title>`,
    `<style>${opts.css ?? defaultCss}</style>`,
    '</head>',
    `<body>${bodyHtml}</body>`,
    '</html>',
  ].join('\n');
}
