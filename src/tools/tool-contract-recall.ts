/**
 * Learned-contract recall (A1) — the READ side of "a successful call teaches
 * how to call it".
 *
 * The contract store already persists the provider schema plus a redacted
 * argument payload that ACTUALLY WORKED (`exampleArgs`) — written before every
 * gate, so the data for the observed body-vs-body_content failure class has
 * been on disk the whole time. Until this module, `exampleArgs` had zero
 * readers: the only contract render sat on the invalid-args REFUSAL, i.e. the
 * model learned how to call a tool only after burning a wrong call.
 *
 * Recall is deliberately dumb and deterministic: rank contract FILENAMES by
 * word-token overlap with the turn's text (no model, no embeddings, no
 * network), open only the top winners, render ≤ RENDER_BUDGET_CHARS_PER_ENTRY
 * per entry as DATA. The render must ride the VOLATILE turn tail (the same
 * seam capability resolution renders through) — never the cached prefix; a
 * learned artifact that lives in the prefix churns the prompt cache, which is
 * the exact incident (08-07) that produced the cache doctrine.
 */

import {
  listToolContractFiles,
  readToolContractFile,
  type ToolContract,
} from './tool-contract-store.js';
import { singularFold, wordTokens } from '../memory/tool-choice-store.js';

export interface LearnedContractHint {
  identifier: string;
  /** Required argument names from the stored schema, when declared. */
  requiredFields: string[];
  /** The redacted payload shape that succeeded, when one was banked. */
  exampleArgs?: Record<string, unknown>;
  lastUsedAt?: string;
  savedAt: string;
  matchedTokens: string[];
}

export const MAX_RECALLED_CONTRACTS = 2;
export const RENDER_BUDGET_CHARS_PER_ENTRY = 400;

/** Generic tokens that appear in half the store and carry no selectivity —
 *  shape words, not provider names (which would be the anti-goal). */
const NOISE_TOKENS: ReadonlySet<string> = new Set([
  'get', 'list', 'create', 'update', 'delete', 'new', 'all', 'the', 'and',
  'for', 'with', 'tool', 'tools', 'record', 'records', 'item', 'items',
]);

function identifierTokens(identifierHint: string): Set<string> {
  const out = new Set<string>();
  for (const raw of identifierHint
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    out.add(raw);
    const folded = singularFold(raw);
    if (folded !== raw) out.add(folded);
  }
  return out;
}

function requiredFieldsOf(contract: ToolContract): string[] {
  const required = (contract.schema as { required?: unknown }).required;
  if (!Array.isArray(required)) return [];
  return required.filter((field): field is string => typeof field === 'string').slice(0, 12);
}

/**
 * Rank the store's contracts against free text and open only the winners.
 * Scoring: count of shared non-noise tokens; ≥2 distinct matches required (one
 * shared word is coincidence at store scale); ties break to most recently
 * used/observed. Pure read — never touches the network or the provider SDK.
 */
export function recallLearnedContracts(
  text: string,
  opts?: { limit?: number },
): LearnedContractHint[] {
  const limit = Math.max(0, opts?.limit ?? MAX_RECALLED_CONTRACTS);
  if (limit === 0) return [];
  const turnTokens = wordTokens(text);
  if (turnTokens.size === 0) return [];

  const ranked = listToolContractFiles()
    .map((file) => {
      const matched: string[] = [];
      for (const token of identifierTokens(file.identifierHint)) {
        if (NOISE_TOKENS.has(token)) continue;
        if (turnTokens.has(token)) matched.push(token);
      }
      return { file, matched };
    })
    .filter((entry) => entry.matched.length >= 2)
    .sort((a, b) => (
      b.matched.length - a.matched.length
      || b.file.modifiedMs - a.file.modifiedMs
      || a.file.fileName.localeCompare(b.file.fileName)
    ));

  const hints: LearnedContractHint[] = [];
  const seenIdentifiers = new Set<string>();
  for (const entry of ranked) {
    if (hints.length >= limit) break;
    const contract = readToolContractFile(entry.file.fileName);
    if (!contract) continue;
    // The case-collision class: COMPOSIO_SEARCH_TOOLS and composio_search_tools
    // are separate files today; render one.
    const identityKey = contract.identifier.toUpperCase();
    if (seenIdentifiers.has(identityKey)) continue;
    seenIdentifiers.add(identityKey);
    hints.push({
      identifier: contract.identifier,
      requiredFields: requiredFieldsOf(contract),
      exampleArgs: contract.exampleArgs,
      lastUsedAt: contract.lastUsedAt,
      savedAt: contract.savedAt,
      matchedTokens: entry.matched.sort(),
    });
  }
  return hints;
}

/**
 * Render hints as a DATA block for the volatile turn tail. Facts only — what
 * is required and what worked — never instructions about what the model
 * should do with them (model voice, not templates).
 */
export function renderLearnedContracts(hints: readonly LearnedContractHint[]): string | null {
  if (hints.length === 0) return null;
  const lines: string[] = ['LEARNED TOOL CONTRACTS (calls that already worked on this machine):'];
  for (const hint of hints) {
    let line = `- ${hint.identifier}`;
    if (hint.requiredFields.length > 0) {
      line += ` — required: ${hint.requiredFields.join(', ')}`;
    }
    if (hint.exampleArgs && Object.keys(hint.exampleArgs).length > 0) {
      line += ` — worked: ${JSON.stringify(hint.exampleArgs)}`;
    }
    if (line.length > RENDER_BUDGET_CHARS_PER_ENTRY) {
      line = `${line.slice(0, RENDER_BUDGET_CHARS_PER_ENTRY - 1)}…`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}
