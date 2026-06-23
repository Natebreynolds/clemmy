/**
 * Convert a brain reply (markdown) into TTS-friendly spoken text.
 *
 * Used by the one-loop voice surface: the realtime model is asked to speak the
 * brain's reply verbatim, so we must strip markdown first (otherwise it reads
 * "asterisk asterisk", bullet characters, raw URLs, etc.) and split into
 * sentences so the first sentence can be spoken the moment it streams.
 *
 * NOTE: the harness already runs scrubInternalNarration() on the reply
 * server-side (loop.ts), so this layer only handles markdown + sentence
 * splitting. Kept pure + side-effect-free for unit testing.
 *
 * IMPORTANT: the renderer (console.ts CONSOLE_JS template) inlines a byte-for-
 * byte mirror of stripMarkdownForSpeech/toSpokenSentences because that code
 * runs in the browser and cannot import. Keep the two in sync; this module is
 * the tested spec.
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
