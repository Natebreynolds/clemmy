/**
 * Convert a brain reply (markdown) into speakable text.
 *
 * Voice mode reads Clem's reply aloud (voice-speech.ts), so markdown must not
 * be read as punctuation ("asterisk asterisk", bullets, raw URLs) and code is
 * never read. The harness already scrubs internal narration from the reply
 * server-side; this layer only handles markdown and sentence splitting. Pure.
 */

import { splitSentences } from '../runtime/harness/scrub-internal-narration.js';

/** Strip common markdown so it isn't read aloud as literal punctuation. */
export function stripMarkdownForSpeech(md: string): string {
  if (!md) return '';
  let s = md;
  // Fenced code blocks → drop entirely (never speak code).
  s = s.replace(/```[\s\S]*?```/g, ' ');
  // Inline code → keep the text, drop the backticks.
  s = s.replace(/`([^`]+)`/g, '$1');
  // Images ![alt](url) → alt; links [text](url) → text.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Bold/italic markers (**, __, *, _) → keep the inner text.
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
  s = s.replace(/(\*|_)(.*?)\1/g, '$2');
  // Headings, blockquotes, list bullets at line starts.
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/^\s{0,3}>\s?/gm, '');
  s = s.replace(/^\s{0,3}[-*+]\s+/gm, '');
  s = s.replace(/^\s{0,3}\d+\.\s+/gm, '');
  // Horizontal rules.
  s = s.replace(/^\s{0,3}([-*_])\1{2,}\s*$/gm, ' ');
  // Bare URLs read terribly aloud → say "the link".
  s = s.replace(/https?:\/\/\S+/g, 'the link');
  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Strip markdown then split into spoken sentences (non-empty). */
export function toSpokenSentences(md: string): string[] {
  const plain = stripMarkdownForSpeech(md);
  if (!plain) return [];
  return splitSentences(plain).map((x) => x.trim()).filter((x) => x.length > 0);
}
