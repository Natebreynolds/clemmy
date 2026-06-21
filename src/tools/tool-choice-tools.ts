import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  invalidateToolChoice,
  recallToolChoice,
  rememberToolChoice,
  deleteToolChoice,
  forgetMatching,
  type ToolChoiceKind,
} from '../memory/tool-choice-store.js';
import { noteRecalledIntent } from '../memory/procedural-recall-link.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { textResult } from './shared.js';

/**
 * Tool-choice memory tools — the agent's interface to the per-machine
 * "what worked last time for intent X" memory layer.
 *
 * Phase A of the intent-based tool dispatch plan
 * (/Users/nathan.reynolds/.claude/plans/intent-based-tool-dispatch.md).
 *
 * The tools intentionally have terse, prescriptive descriptions: they
 * teach the discipline. Specifically:
 *   - Always call `tool_choice_recall` BEFORE reaching for
 *     `composio_search_tools` or `local_cli_list`.
 *   - When discovery finishes successfully, write the result back via
 *     `tool_choice_remember` so the next run skips discovery.
 *   - When an executed tool fails at runtime, call
 *     `tool_choice_invalidate` so the next request triggers re-discovery
 *     instead of re-trying the broken path.
 *
 * In Phase A these tools are additive — registering them does not
 * change any existing behavior. The Orchestrator prompt change that
 * teaches the discipline ships in Phase B.
 */

const KIND_VALUES = ['cli', 'composio', 'mcp'] as const;

function formatChoiceRecall(intent: string): string {
  const rec = recallToolChoice(intent);
  if (!rec) {
    return `No tool choice recorded yet for intent "${intent}".\nRun discovery (composio_search_tools / local_cli_list / MCP), pick the working tool, then call tool_choice_remember to save it.`;
  }
  const lines: string[] = [
    `Intent: ${rec.intent}`,
    rec.description ? `Description: ${rec.description}` : '',
  ].filter(Boolean);
  if (rec.choice) {
    // Note this CLI/MCP recall so the next matching tool result credits THIS
    // intent's outcome (the per-recalled-intent loop — closes the measured 0%
    // CLI/MCP outcome-coverage gap). composio recalls are skipped (their slug
    // path already credits them). Best-effort; sessionId from the run context.
    try {
      noteRecalledIntent(harnessRunContextStorage.getStore()?.sessionId, rec.intent, rec.choice.identifier, rec.choice.kind);
    } catch { /* never break a recall */ }
    lines.push(
      `Active choice: kind=${rec.choice.kind}, identifier=${rec.choice.identifier}`,
      rec.choice.invocationTemplate ? `  invocationTemplate: ${rec.choice.invocationTemplate}` : '',
      rec.choice.testEvidence ? `  testEvidence: ${rec.choice.testEvidence}` : '',
      `  testedAt: ${rec.choice.testedAt}`,
    );
  } else {
    lines.push('Active choice: (none — last choice was invalidated; run fresh discovery before executing).');
  }
  if (rec.fallbacks.length > 0) {
    lines.push('Known-failed fallbacks (do NOT re-try these blindly):');
    for (const f of rec.fallbacks) {
      lines.push(`  - ${f.kind}:${f.identifier} — ${f.reason} (failed ${f.failedAt})`);
    }
  }
  return lines.filter(Boolean).join('\n');
}

export function registerToolChoiceTools(server: McpServer): void {
  server.tool(
    'tool_choice_recall',
    [
      'Look up the previously-recorded tool choice for an intent (per-machine memory).',
      'CALL THIS FIRST before reaching for composio_search_tools, local_cli_list, or any other discovery surface. If a choice is recorded, use it directly — that skips a 3-5 tool-call discovery loop.',
      'Returns the active choice (kind + identifier + invocationTemplate) AND any known-failed fallbacks so you can avoid re-trying broken paths.',
      'Lookup is fuzzy by token-overlap when no exact slug match is found, so different phrasings of the same intent (e.g. "salesforce.accounts.list" vs "salesforce accounts list stale") collapse to the same memory entry.',
    ].join('\n'),
    {
      intent: z
        .string()
        .min(1)
        .max(160)
        .describe(
          'Free-form intent slug describing what the user wants done. Dotted-lowercase recommended (e.g. "salesforce.accounts.list_stale", "gmail.draft_email", "github.repo.search"). The store will fuzzy-match across paraphrases.',
        ),
    },
    async ({ intent }) => textResult(formatChoiceRecall(intent)),
  );

  server.tool(
    'tool_choice_remember',
    [
      'Save the tool that worked for an intent so future runs skip discovery.',
      'Call this AFTER discovery + probing has picked a winning tool. Pass the verified invocation template so the next caller can fill in args and run immediately.',
      'Also accepts a `fallbacks` list — record what was tried and failed (e.g. "composio Salesforce toolkit not connected") so future runs know not to re-try the broken paths.',
      'On update, fallbacks are merged with any existing list (deduped by kind+identifier+reason); the choice is replaced wholesale.',
    ].join('\n'),
    {
      intent: z.string().min(1).max(160),
      description: z.string().max(400).optional(),
      kind: z.enum(KIND_VALUES).describe('cli = a binary on $PATH; composio = a Composio action slug; mcp = a tool exposed by a connected MCP server.'),
      identifier: z
        .string()
        .min(1)
        .max(200)
        .describe('CLI command name (e.g. "sf"), Composio slug (e.g. "SALESFORCE_QUERY_RECORDS"), or MCP tool name (e.g. "dataforseo__rank_overview").'),
      invocationTemplate: z
        .string()
        .max(1000)
        .optional()
        .describe('Literal invocation with `{{var}}` placeholders the Executor will fill in. Optional but strongly recommended for CLIs.'),
      testEvidence: z
        .string()
        .max(400)
        .optional()
        .describe('Short string describing how you verified this tool works (e.g. "sf --version exit 0, output @salesforce/cli/2.130.9").'),
      fallbacks: z
        .array(
          z.object({
            kind: z.enum(KIND_VALUES),
            identifier: z.string().min(1).max(200),
            reason: z.string().min(1).max(400),
          }),
        )
        .optional(),
    },
    async (input) => {
      const fallbacks = (input.fallbacks ?? []).map((f) => ({
        kind: f.kind as ToolChoiceKind,
        identifier: f.identifier,
        reason: f.reason,
        failedAt: new Date().toISOString(),
      }));
      const rec = rememberToolChoice({
        intent: input.intent,
        description: input.description,
        choice: {
          kind: input.kind as ToolChoiceKind,
          identifier: input.identifier,
          invocationTemplate: input.invocationTemplate,
          testEvidence: input.testEvidence,
        },
        fallbacks,
      });
      return textResult(
        `Saved tool choice for "${rec.intent}":\n  kind=${rec.choice?.kind}, identifier=${rec.choice?.identifier}\n  fallbacks recorded: ${rec.fallbacks.length}`,
      );
    },
  );

  server.tool(
    'tool_choice_invalidate',
    [
      'Mark the currently-recorded tool choice for an intent as broken.',
      'Call this when a tool that was previously recorded as working fails at runtime (e.g. CLI now throws EPERM, Composio toolkit was disconnected, MCP server is down). The current choice is moved into fallbacks with the supplied reason, and the active choice is cleared so the next request for this intent triggers fresh discovery.',
      'Do NOT call this for transient errors that retry would fix — only for state changes that mean the tool genuinely no longer works on this machine.',
    ].join('\n'),
    {
      intent: z.string().min(1).max(160),
      reason: z
        .string()
        .min(1)
        .max(400)
        .describe('Verbatim failure summary — quote the actual error message rather than diagnosing. Future runs will see this in the fallbacks list.'),
    },
    async ({ intent, reason }) => {
      const rec = invalidateToolChoice(intent, reason);
      if (!rec) {
        return textResult(`No recorded choice for intent "${intent}" — nothing to invalidate.`);
      }
      return textResult(
        `Invalidated choice for "${intent}". The next request for this intent will trigger fresh discovery. Total fallbacks recorded: ${rec.fallbacks.length}.`,
      );
    },
  );

  server.tool(
    'tool_choice_forget',
    [
      'HARD-clear a remembered tool choice so the next request fully re-discovers it.',
      'Use this when the user says a remembered tool is WRONG ("that is wrong", "clear the cache", "forget what you learned for X", "search for new tools / re-search"), or when you notice a cached choice maps to the wrong action for the intent (e.g. a "send" intent that actually points at a create-draft slug).',
      'Unlike `tool_choice_invalidate` (which keeps the record with an empty choice — still fuzzy-matchable and re-fillable), this DELETES the record entirely. Pass `intent` to forget one, or `pattern` to forget a whole poisoned cluster at once (e.g. pattern "outlook send" or "mark read"). After forgetting, re-discover with `composio_search_tools`/`tool_choice_recall`.',
    ].join('\n'),
    {
      intent: z.string().min(1).max(160).optional().describe('Exact intent to forget (one record).'),
      pattern: z.string().min(1).max(160).optional().describe('Case-insensitive substring; forgets EVERY matching intent (clears a cluster).'),
    },
    async ({ intent, pattern }) => {
      if (pattern) {
        const forgotten = forgetMatching(pattern);
        if (forgotten.length === 0) return textResult(`No tool choices matched "${pattern}" — nothing to forget.`);
        return textResult(`Forgot ${forgotten.length} tool choice(s) matching "${pattern}": ${forgotten.join(', ')}. The next request for these intents will re-discover from scratch.`);
      }
      if (intent) {
        const removed = deleteToolChoice(intent);
        return textResult(removed
          ? `Forgot the tool choice for "${intent}" (record deleted). The next request will re-discover it.`
          : `No recorded choice for intent "${intent}" — nothing to forget.`);
      }
      return textResult('Provide either `intent` (one record) or `pattern` (a cluster) to forget.');
    },
  );
}
