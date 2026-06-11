/**
 * Streaming JSON field extractor for token-level streaming.
 *
 * The orchestrator (and the plan-first planner) emit STRUCTURED output, so
 * raw output_text_delta chunks are JSON text — streaming them verbatim shows
 * the user `{"summary":"...,"reply":"...` instead of prose. This stateful
 * char-driven tokenizer extracts ONLY the string values of wanted keys
 * (`reply` for chat decisions; `objective`/`action` for streamed plans) as
 * they form, decoding JSON string escapes, so the bubble streams clean text.
 *
 * Properties:
 *  - depth-agnostic key matching (catches steps[].action inside a plan)
 *  - keys inside VALUE strings can't false-trigger (tokenizer state knows
 *    key-position vs value-position; quotes inside values arrive escaped)
 *  - multiple wanted segments (multi-turn replies, plan objective→actions)
 *    are separated with a blank line so concatenation stays readable
 *  - non-JSON streams emit nothing (the event-driven progress labels still
 *    cover activity; the final reply always lands via conversation_completed)
 */

const ESCAPES: Record<string, string> = {
  n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/',
};

export function createJsonFieldStreamer(
  wantedFields: string[],
  emit: (delta: string) => void,
): (chunk: string) => void {
  const wanted = new Set(wantedFields);
  let inString = false;
  let escaped = false;
  let unicodeLeft = 0;
  let unicodeBuf = '';
  let stringIsValue = false;
  let currentKey = '';
  let lastKey = '';
  let afterColon = false;
  let emitting = false;
  let emittedAnySegment = false;
  let emittedInSegment = false;

  const emitChar = (ch: string): void => {
    if (!emitting) return;
    if (!emittedInSegment) {
      // Separate this segment from any prior emitted segment.
      if (emittedAnySegment) emit('\n\n');
      emittedInSegment = true;
      emittedAnySegment = true;
    }
    emit(ch);
  };

  return (chunk: string) => {
    for (const ch of chunk) {
      if (inString) {
        if (unicodeLeft > 0) {
          unicodeBuf += ch;
          unicodeLeft -= 1;
          if (unicodeLeft === 0) {
            const code = Number.parseInt(unicodeBuf, 16);
            if (Number.isFinite(code)) {
              if (stringIsValue) emitChar(String.fromCharCode(code));
              else currentKey += String.fromCharCode(code);
            }
            unicodeBuf = '';
          }
          continue;
        }
        if (escaped) {
          escaped = false;
          if (ch === 'u') {
            unicodeLeft = 4;
            unicodeBuf = '';
            continue;
          }
          const decoded = ESCAPES[ch] ?? ch;
          if (stringIsValue) emitChar(decoded);
          else currentKey += decoded;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
          if (!stringIsValue) lastKey = currentKey;
          if (emitting) {
            emitting = false;
            emittedInSegment = false;
          }
          stringIsValue = false;
          continue;
        }
        if (stringIsValue) emitChar(ch);
        else currentKey += ch;
        continue;
      }

      if (ch === '"') {
        inString = true;
        if (afterColon) {
          stringIsValue = true;
          emitting = wanted.has(lastKey);
          afterColon = false;
        } else {
          currentKey = '';
          stringIsValue = false;
        }
        continue;
      }
      if (ch === ':') {
        afterColon = true;
        continue;
      }
      if (!/\s/.test(ch)) {
        // Any non-string token after a colon (number/bool/null/{/[) consumes it.
        afterColon = false;
      }
    }
  };
}
