import type { ReactNode } from 'react';

/**
 * Turn plain reply text into React nodes with clickable links, WITHOUT pulling
 * in a full markdown renderer. Clem's replies frequently end with a bare URL
 * (e.g. a deployed site) or a markdown link `[label](url)`; rendered as raw
 * text those were not clickable in the chat surface. This is the minimal fix:
 * autolink http(s) URLs + markdown links and leave everything else verbatim so
 * the surrounding `whitespace-pre-wrap` text is unchanged.
 */

// One pass over the text matching EITHER a markdown link `[label](url)` OR a
// bare http(s) URL. Bare-URL match stops at whitespace / `<` so adjacent prose
// is never swallowed.
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+)/g;

// Trailing punctuation that's almost always sentence punctuation, not part of
// the URL ("...site.app." → link "site.app", text ".").
const TAIL_RE = /[.,;:!?'"’”)\]}]+$/;

/** Split sentence punctuation off the end of a bare URL, keeping balanced `)`. */
function splitUrlTail(url: string): [string, string] {
  const m = TAIL_RE.exec(url);
  if (!m) return [url, ''];
  let tail = m[0];
  // Keep a trailing `)` when it closes a `(` inside the URL (e.g. a wiki link).
  if (tail.includes(')')) {
    const opens = (url.match(/\(/g) ?? []).length;
    const closes = (url.match(/\)/g) ?? []).length;
    if (closes <= opens) tail = tail.replace(/\)+$/, '');
  }
  if (!tail) return [url, ''];
  return [url.slice(0, url.length - tail.length), tail];
}

const LINK_CLASS =
  'text-primary underline underline-offset-2 hover:text-primary-hover break-words';

function anchor(href: string, label: string, key: number): ReactNode {
  return (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
      {label}
    </a>
  );
}

/** Render `text` as an array of strings + <a> nodes. Safe for empty/no-link text. */
export function linkify(text: string): ReactNode {
  if (!text || (!text.includes('http') && !text.includes(']('))) return text;
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] && m[2]) {
      // Markdown link [label](url).
      nodes.push(anchor(m[2], m[1], key++));
      last = m.index + m[0].length;
    } else if (m[3]) {
      // Bare URL.
      const [url, tail] = splitUrlTail(m[3]);
      nodes.push(anchor(url, url, key++));
      if (tail) nodes.push(tail);
      last = m.index + m[0].length;
    }
  }
  if (nodes.length === 0) return text;
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
