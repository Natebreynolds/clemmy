/**
 * Copy-pasteable call examples for the harness reader tools.
 *
 * Every model-facing string that DEMONSTRATES a tool call must render through
 * here. Under schema-on-demand most tool schemas are not in context, and after
 * compaction these hint strings are frequently the ONLY documentation the
 * model has — the hint IS the de facto schema. Hand-written pseudo-signatures
 * (positional-arg pseudo-code, bare comma field
 * lists) taught the model invalid syntax, and it reproduced them verbatim as
 * unparseable tool inputs (4/4 recorded InputValidationErrors, live 2026-08-05
 * calendar run). The OpenAI lane is protected by strict constrained decoding;
 * the Claude SDK lane (streamed tool input) and the BYO lane (strict stripped
 * at the wire) are not — they emit exactly what we teach.
 *
 * Contract, pinned by tool-call-hint.test.ts:
 *   1. The rendered example is `<tool_name> <json>` where <json> parses as
 *      JSON and validates against the tool's registered zod schema.
 *   2. No source file outside this module renders a paren-form call signature
 *      for these tools (the lint tooth of the pin).
 * Placeholder values (e.g. "<call id>") are fine — they are valid strings.
 */

export type ReaderToolName = 'tool_output_query' | 'recall_tool_result';

/** Render `<tool> {"call_id":…,…}` — a literal, valid-JSON call example. */
export function toolCallHint(
  tool: ReaderToolName,
  args: Record<string, unknown>,
): string {
  return `${tool} ${JSON.stringify(args)}`;
}
