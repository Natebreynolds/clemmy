import { EXPLICIT_MEMORY_INSTRUCTION_RE } from '../assistant/message-intent.js';

/** Negative-only recognition of a storage directive whose object is still a
 * reference. Never resolve its antecedent, infer a fact from preceding prose,
 * or change the owner's memory intent. The ordinary brain/tool path keeps the
 * complete accepted input. This is not a general semantic completeness test. */
export function isUnresolvedMemoryReferencePayload(value: string): boolean {
  let text = value.trim();
  // These wrappers make the following bytes the payload; a colon by itself
  // does not supply one. Inspect before auto-capture removes this/that/quotes.
  text = text.replace(/^for\s+(?:later|future\s+reference)\s*:?\s*/i, '').trim();
  text = text.replace(/^(?:(?:this|that|exactly)\s*)?:\s*/i, '').trim();
  text = text.replace(/^exactly\s+/i, '').trim();
  if (!text) return true;
  // Explicit quoted short literals and codewords are self-contained requests,
  // even when the literal happens to be "that" or "the correction".
  if (/^(["'`])[\s\S]+?\1(?:[.!?]|\s|$)/.test(text)) return false;
  if (/^to\b/i.test(text)) return false;
  const reference = /^(?:(?:the|this|that|these|those|both|all)\s+(?:(?:current|new|updated|previous)\s+)?(?:corrections?|changes?|updates?|information|details?|facts?|conventions?|preferences?|rules?|decisions?|answers?)|(?:the\s+)?(?:above|previous|preceding)(?:\s+(?:correction|change|update|information|details|facts))?|it|this|that|these|those)\b/i.exec(text);
  if (!reference) return false;
  text = text.slice(reference[0].length).trim();
  // Match only storage/acknowledgement framing. In particular, complementizer
  // "that" followed by a factual subject, or "the correction is ...", is not
  // rejected merely for containing a reference-shaped first word.
  const qualifier = /^(?:only|just|exactly|verbatim|permanently|here|everywhere|locally|for\s+(?:later|future\s+reference|(?:future|later|subsequent|new)\s+(?:chats|conversations|sessions|requests))|as\s+(?:a\s+)?(?:memory|fact)|(?:in|for|within)\s+(?:this|the|our|my|current)\s+(?:project|conversation|chat|agent|workspace)|from\s+now\s+on)\b\s*/i;
  while (qualifier.test(text)) text = text.replace(qualifier, '').trim();
  return /^[.!?]*$/.test(text)
    || /^(?:[,;.!]\s*(?:and\s+)?|and\s+)(?:please\s+)?(?:just\s+)?(?:confirm|acknowledge)\b/i.test(text);
}

export function hasUnresolvedExplicitMemoryReference(message: string): boolean {
  const match = EXPLICIT_MEMORY_INSTRUCTION_RE.exec(message);
  if (!match?.[1] || match.index === undefined) return false;
  const start = match.index + match[0].lastIndexOf(match[1]);
  return isUnresolvedMemoryReferencePayload(message.slice(start + match[1].length));
}
