/**
 * SINGLE source of truth for "this text is SHAPED like a printed tool call" — the model
 * narrating a tool instead of invoking it (native tool_use). Used in three places so the
 * shapes live in ONE place, not N reactive regexes scattered across output paths:
 *
 *   1. DETECT narration on a fresh turn → fire the retry corrective (looksLikeToolNarration).
 *   2. SANITIZE the final reply at the WRITE boundary → never show the user raw `{"tool_call":…}`
 *      and never PERSIST it as the durable reply.
 *   3. SANITIZE prior assistant turns at the transcript READ boundary → the format can never be
 *      replayed as a `YOU:` exemplar the model then mimics (the self-reinforcing loop that turned
 *      a rare slip into a reproducible pattern — 2026-07-01 Acme-calendar root cause).
 *
 * Line-anchored where a header could appear mid-prose so normal replies ("the [tool] I
 * recommend", "the arguments we set") never false-flag.
 */
export function looksLikeToolCallShape(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  return (
    // "Tool: x" / "Tool call: x" / "**Tool call: x**" headers, incl. behind a hallucinated
    // wrapper tag ("<system>Tool call: …</system>").
    /(^|\n)\s*(?:<\/?[a-z][a-z0-9_-]*>\s*)?\*{0,2}\s*tool(?:[\s_-]*call)?\s*:\s*\*{0,2}\s*[a-z_"]/i.test(t)
    // Bracketed tool reference printed as the answer: "[Tool: OUTLOOK_GET_…]", "[Calling X]".
    || /(^|\n)\s*\[\s*(?:tool|calling|using|invoking|call)\b[^\]]*\]/i.test(t)
    // Tagged markers: "<tool_call>", "[tool_call]".
    || /(^|\n)\s*[<\[]\s*tool[\s_-]*call\b/i.test(t)
    || /(^|\n)\s*function\s*\n?\s*\{/.test(t)
    || /System:\s*tool result/i.test(t)
    // Bare tool-call-shaped JSON: {"command"/"tool_slug"/"tool_name"/"arguments": …}.
    || /(^|\n)\s*\{\s*"(command|tool_slug|tool_name|arguments)"\s*:/i.test(t)
    // OpenAI/function-calling JSON printed as text: {"tool_call":{…}}, {"name":"x","arguments":…},
    // "function":{"name":…}.
    || /"tool_call"\s*:\s*\{/i.test(t)
    || /"name"\s*:\s*"[a-z0-9_.-]+"\s*,\s*"arguments"\s*:/i.test(t)
    || /"function"\s*:\s*\{\s*"name"\s*:/i.test(t)
    // Native Anthropic tool XML emitted as text.
    || /<\/?(?:antml:)?(?:function_calls\b|invoke\s+name\s*=|parameter\s+name\s*=)/i.test(t)
  );
}

/** Streaming variant: catches the shapes that can appear MID-stream (no trailing `]`/`}` yet)
 *  so the raw protocol never reaches the bubble as it streams. Superset-safe with the above. */
export function looksLikeToolCallShapeStreaming(text: string): boolean {
  const t = text || '';
  if (!t) return false;
  return (
    /<\/?(?:antml:)?(?:function_calls\b|invoke\s+name\s*=|parameter\s+name\s*=)/i.test(t)
    || /(^|\n)\s*(?:<\/?[a-z][a-z0-9_-]*>\s*)?\*{0,2}\s*tool(?:[\s_-]*call)?\s*:\s*\*{0,2}\s*[a-z_"]/i.test(t)
    || /(^|\n)\s*[<\[]\s*tool[\s_-]*call\b/i.test(t)
    || /"tool_call"\s*:\s*\{/i.test(t)
    || /"function"\s*:\s*\{\s*"name"\s*:/i.test(t)
  );
}
