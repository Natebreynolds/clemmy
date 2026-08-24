/**
 * Per-turn batch-shape steering directive, or '' when not applicable (so the
 * prompt is byte-identical on non-data turns). Fires only when the turn has
 * external data tools in scope (external MCP servers admitted by the JIT
 * scoper, or composio data tools) — exactly the case where serial one-by-one
 * calls waste rounds and dump large JSON into context.
 *
 * HERITAGE: this rule was code-mode-tool's `codeModeMandateDirective`. When
 * the `run_tool_program` surface was subtracted (2026-08-20, 64% live failure
 * rate), its lane — "several read-only fetches in one program" — retargeted
 * to the model's own PARALLEL tool calls: same round-trip win, no second
 * dispatch surface. Pure + exported for test.
 */
export function batchShapeDirective(opts: {
  mcpServersInScope?: number;
  allowAllMcp?: boolean;
  /** Composio data tools (composio_execute_tool) are in scope this turn.
   *  Session-stable, so appending the base rule stays prompt-cache-safe. */
  composioInScope?: boolean;
  fanoutPreferred?: boolean;
  multiItem?: { count: number; kind: string | null; carried?: boolean };
}): string {
  const hasMcpData = !!opts.allowAllMcp || (opts.mcpServersInScope ?? 0) >= 1 || !!opts.composioInScope;
  if (!hasMcpData) return '';
  // ONE standing lane rule, always present on data turns. The old shape was
  // either/or — mandate a lane OR (on multi-item detection) say nothing —
  // so a missed detection ACTIVELY steered batch work away from fan-out
  // (live 2026-07-07: 18 firms ground serially through one context). The
  // model always has all the lanes and the decision rule; detection only
  // sharpens the rule with the concrete count, it never gates it.
  const rule = [
    'BATCH-SHAPE RULE — external data-fetch tools are in scope this turn (MCP tools (`<server>__<tool>`) and `composio_execute_tool`). Pick the lane by the SHAPE of the work:',
    '(a) 3+ same-shape items whose tool arguments you can FULLY MATERIALIZE right now (send N drafted emails, update N records with known values, pull N known lookups) → `run_batch` ONE plan: certified once, then executed deterministically with zero model calls between items — the fastest and most auditable lane. ANY batch of external SENDS/WRITES MUST use run_batch — never loop sends yourself one message at a time.',
    '(b) 3+ independent items that each need their own REASONING/discovery (research each firm, judge each doc) → FAN OUT: call `run_worker` ONCE with the complete stable-id items array and shared output contract; the harness runs isolated Workers with bounded concurrency — do NOT grind the items one-by-one in your own context;',
    '(c) several independent READ-ONLY fetches feeding ONE deliverable → issue them as PARALLEL tool calls in ONE response (every independent read in the same message), then synthesize. Never serialize independent reads across rounds. Large results are parked as handles — use recall_tool_result/tool_output_query to consult them instead of re-fetching;',
    '(d) a SINGLE read → call the tool directly.',
    'GROUNDED-VALUE RULE — when a SEND/WRITE carries high-stakes STRUCTURED values (recipient/attendee lists, record ids, amounts) that came from a prior tool RESULT, do NOT retype them — retyping a list is how a value gets invented, dropped, or transposed. Bind them by reference instead: pass `{"$fromToolOutput":{"callId":"<that read\'s call_id>","path":"result.records[*].Email"}}` as the field value and the harness substitutes the EXACT real values before the call (an unresolvable reference fails closed — the send does not run). Retype only values the USER gave you directly.',
  ].join(' ');
  if (opts.fanoutPreferred && opts.multiItem) {
    const n = opts.multiItem.count >= 3 ? `~${opts.multiItem.count}` : 'several';
    const kind = opts.multiItem.kind ?? 'items';
    const source = opts.multiItem.carried ? 'the conversation (your own prior message names the batch)' : 'the request';
    return `${rule} THIS TURN IS BATCH-SHAPED: ${source} indicates ${n} independent ${kind} — use run_batch if you can bake every item's args now, else run_worker.`;
  }
  return rule;
}
