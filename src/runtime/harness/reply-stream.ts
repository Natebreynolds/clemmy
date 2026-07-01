/**
 * The Claude SDK brain emits its answer wrapped in a `{"reply":"…"}` JSON envelope (the
 * harness parses it off for the FINAL reply). Raw token streaming therefore leaks the JSON
 * structure into the dock (`{"reply":"Local SEO…`) — which is why streaming was default-off.
 *
 * This stateful extractor sits in the onDelta path: fed the raw SDK deltas, it returns the
 * CLEAN reply text incrementally — only the characters INSIDE the reply string value,
 * JSON-unescaped — so the user watches clean prose appear token-by-token. If the output is
 * NOT a reply envelope (plain prose), it streams it through verbatim.
 */
export function createReplyStreamExtractor(): (rawDelta: string) => string {
  let raw = '';
  let emittedLen = 0; // length of clean text already returned (envelope: reply chars; raw: raw chars)
  let mode: 'unknown' | 'envelope' | 'raw' = 'unknown';
  let finished = false;
  const ENVELOPE_START = /^\{\s*"reply"\s*:\s*"/;

  return (rawDelta: string): string => {
    if (finished) return '';
    raw += rawDelta;

    if (mode === 'unknown') {
      const t = raw.replace(/^\s+/, '');
      if (t === '') return '';
      if (ENVELOPE_START.test(t)) {
        mode = 'envelope';
      } else if (couldStillBeReplyEnvelope(t)) {
        return ''; // ambiguous prefix (e.g. `{"re`) — wait for more before deciding
      } else {
        mode = 'raw';
      }
    }

    if (mode === 'raw') {
      const delta = raw.slice(emittedLen);
      emittedLen = raw.length;
      return delta;
    }

    // envelope: extract the reply string value so far
    const { text, done } = extractReplyValueSoFar(raw);
    const delta = text.slice(emittedLen);
    emittedLen = text.length;
    if (done) finished = true;
    return delta;
  };
}

/** True while `t` (leading-ws-stripped) is still a possible prefix of a `{"reply":"` opener,
 *  tolerating whitespace between tokens — so we buffer instead of prematurely deciding 'raw'. */
function couldStillBeReplyEnvelope(t: string): boolean {
  const compact = t.replace(/\s+/g, '');
  const target = '{"reply":"';
  return target.startsWith(compact) && compact.length < target.length;
}

/** Parse the reply string VALUE out of a (possibly incomplete) `{"reply":"…` payload,
 *  JSON-unescaping as it goes. `done:true` once the closing unescaped quote is seen. Stops
 *  early (waiting for more input) on a dangling escape / incomplete \\uXXXX. */
export function extractReplyValueSoFar(raw: string): { text: string; done: boolean } {
  const open = raw.match(/^\s*\{\s*"reply"\s*:\s*"/);
  if (!open) return { text: '', done: false };
  let i = open[0].length;
  let out = '';
  while (i < raw.length) {
    const c = raw[i];
    if (c === '\\') {
      const next = raw[i + 1];
      if (next === undefined) break; // dangling escape → wait for the next delta
      if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === 'r') out += '\r';
      else if (next === 'b') out += '\b';
      else if (next === 'f') out += '\f';
      else if (next === '"') out += '"';
      else if (next === '\\') out += '\\';
      else if (next === '/') out += '/';
      else if (next === 'u') {
        const hex = raw.slice(i + 2, i + 6);
        if (hex.length < 4) break; // incomplete unicode escape → wait
        out += String.fromCharCode(parseInt(hex, 16) || 0);
        i += 6;
        continue;
      } else out += next; // unknown escape → keep the char
      i += 2;
      continue;
    }
    if (c === '"') return { text: out, done: true }; // closing quote of the reply value
    out += c;
    i += 1;
  }
  return { text: out, done: false };
}
