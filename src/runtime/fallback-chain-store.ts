/**
 * Fallback Chain Store — Learn and recall what works when tools fail.
 *
 * Purpose:
 * When a tool fails, instead of just returning an error, Clementine learns:
 * "When [tool A] fails with [error type X], try [tool B]"
 *
 * Over time, this builds a knowledge base:
 * - intent + failure type → ordered list of alternatives
 * - success rates per alternative
 * - conditions under which each alternative works
 *
 * Design:
 * - Per-machine storage (like tool-choice-store)
 * - Persistent records with success/failure tracking
 * - Fallback chains automatically reordered by success rate
 * - Format: YAML frontmatter + markdown (consistent with vault)
 *
 * Usage:
 * // Record a failure
 * recordFailure({
 *   intent: "send_email",
 *   toolUsed: "composio_outlook_send",
 *   failureType: "permission_denied",
 * })
 *
 * // Recall fallback chain
 * const chain = lookupFallbackChain("send_email", "permission_denied")
 * // Returns: ["composio_gmail_send", "cli_mail", "manual_guidance"]
 *
 * // Record success
 * recordFallbackSuccess("send_email", "permission_denied", "composio_gmail_send")
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { BASE_DIR } from '../config.js';
import { getMachineId } from './machine-id.js';

/**
 * Failure type classification — why a tool failed.
 */
export type FailureType = 'permission_denied' | 'not_found' | 'rate_limit' | 'timeout' | 'unknown';

/**
 * A single fallback entry in the chain.
 */
export interface FallbackEntry {
  /** Tool name or pseudo-tool identifier. */
  toolName: string;
  /** Number of times this fallback was tried. */
  attempts: number;
  /** Number of times it succeeded. */
  successes: number;
  /** Success rate (successes / attempts), or 0 if not tried yet. */
  successRate: number;
  /** When this entry was last tested. */
  lastTestedAt?: string;
  /** Notes (e.g., "works when permission is granted"). */
  notes?: string;
}

/**
 * A fallback chain — multiple alternatives for when a tool fails.
 */
export interface FallbackChain {
  /** User intent (e.g., "send_email"). */
  intent: string;
  /** Failure type (e.g., "permission_denied"). */
  failureType: FailureType;
  /** Ordered list of alternatives, ranked by success rate. */
  chain: FallbackEntry[];
  /** When this chain was last updated. */
  updatedAt: string;
  /** Human-readable notes. */
  notes?: string;
}

/**
 * Failure record — what happened when a tool failed.
 */
export interface FailureRecord {
  intent: string;
  toolUsed: string;
  failureType: FailureType;
  failureMessage?: string;
  timestamp: string;
}

/**
 * Store key: (intent, failureType) pair.
 */
function makeChainKey(intent: string, failureType: FailureType): string {
  return `${intent}__${failureType}`;
}

/**
 * Get the file path for a fallback chain.
 */
function getChainFilePath(intent: string, failureType: FailureType): string {
  const machineId = getMachineId();
  const fileName = `${makeChainKey(intent, failureType)}.md`;
  return path.join(BASE_DIR, 'memory', 'fallback-chains', machineId, fileName);
}

/**
 * Load a fallback chain from disk.
 */
export function loadFallbackChain(intent: string, failureType: FailureType): FallbackChain | null {
  const filePath = getChainFilePath(intent, failureType);

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const { data, content: body } = matter(content);

    return {
      intent: String(data.intent || intent),
      failureType: String(data.failureType || failureType) as FailureType,
      chain: (data.chain || []) as FallbackEntry[],
      updatedAt: String(data.updatedAt || new Date().toISOString()),
      notes: body.trim() || undefined,
    };
  } catch (err) {
    console.warn(`[fallback-chain-store] failed to load chain for ${intent}/${failureType}`, err);
    return null;
  }
}

/**
 * Save a fallback chain to disk.
 */
function saveFallbackChain(chain: FallbackChain): void {
  const filePath = getChainFilePath(chain.intent, chain.failureType);
  const dirPath = path.dirname(filePath);

  // Ensure directory exists
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }

  // Sort chain by success rate (highest first)
  const sortedChain = [...chain.chain].sort((a, b) => b.successRate - a.successRate);

  // Clean up entries to remove undefined values
  const cleanedChain = sortedChain.map((entry) => ({
    toolName: entry.toolName,
    attempts: entry.attempts,
    successes: entry.successes,
    successRate: entry.successRate,
    ...(entry.lastTestedAt && { lastTestedAt: entry.lastTestedAt }),
    ...(entry.notes && { notes: entry.notes }),
  }));

  const frontmatter = {
    intent: chain.intent,
    failureType: chain.failureType,
    chain: cleanedChain,
    updatedAt: new Date().toISOString(),
  };

  const content = matter.stringify(chain.notes || '', frontmatter);

  try {
    writeFileSync(filePath, content, 'utf-8');
  } catch (err) {
    console.error(`[fallback-chain-store] failed to save chain for ${chain.intent}/${chain.failureType}`, err);
  }
}

/**
 * Get fallback chain for a given intent + failure type.
 * Returns ordered list of alternatives, ranked by success rate.
 */
export function lookupFallbackChain(intent: string, failureType: FailureType): string[] {
  const chain = loadFallbackChain(intent, failureType);

  if (!chain || chain.chain.length === 0) {
    return [];
  }

  // Return tool names in order of success rate
  return chain.chain.sort((a, b) => b.successRate - a.successRate).map((e) => e.toolName);
}

/**
 * Record a tool failure.
 * When a tool fails with a specific error type, we record it so future runs
 * can learn the fallback chain.
 */
export function recordFailure(record: FailureRecord): void {
  // For now, just log it. In a full implementation, this would:
  // - Accumulate failures over time
  // - Build statistics on which tools fail under which conditions
  // - Inform the fallback chain ordering
  console.debug(`[fallback-chain-store] failure recorded: ${record.intent}/${record.toolUsed}/${record.failureType}`);
}

/**
 * Record that a fallback tool succeeded.
 * When a fallback works, we should boost its success rate for future recalls.
 */
export function recordFallbackSuccess(intent: string, failureType: FailureType, toolName: string): void {
  const chain = loadFallbackChain(intent, failureType);

  if (!chain) {
    // Create a new chain with this tool as the first entry
    const newChain: FallbackChain = {
      intent,
      failureType,
      chain: [
        {
          toolName,
          attempts: 1,
          successes: 1,
          successRate: 1.0,
          lastTestedAt: new Date().toISOString(),
        },
      ],
      updatedAt: new Date().toISOString(),
      notes: `Initially learned: ${toolName} works for ${intent} when ${failureType}`,
    };
    saveFallbackChain(newChain);
    return;
  }

  // Update existing chain entry or add new one
  const entry = chain.chain.find((e) => e.toolName === toolName);

  if (entry) {
    entry.attempts += 1;
    entry.successes += 1;
    entry.successRate = entry.successes / entry.attempts;
    entry.lastTestedAt = new Date().toISOString();
  } else {
    chain.chain.push({
      toolName,
      attempts: 1,
      successes: 1,
      successRate: 1.0,
      lastTestedAt: new Date().toISOString(),
    });
  }

  chain.updatedAt = new Date().toISOString();
  saveFallbackChain(chain);
}

/**
 * Record that a fallback tool was tried but failed.
 */
export function recordFallbackFailure(intent: string, failureType: FailureType, toolName: string): void {
  const chain = loadFallbackChain(intent, failureType);

  if (!chain) {
    // Create a new chain with this tool marked as failed
    const newChain: FallbackChain = {
      intent,
      failureType,
      chain: [
        {
          toolName,
          attempts: 1,
          successes: 0,
          successRate: 0.0,
          lastTestedAt: new Date().toISOString(),
        },
      ],
      updatedAt: new Date().toISOString(),
      notes: `Initially tried and failed: ${toolName} for ${intent} when ${failureType}`,
    };
    saveFallbackChain(newChain);
    return;
  }

  // Update existing chain entry or add new one
  const entry = chain.chain.find((e) => e.toolName === toolName);

  if (entry) {
    entry.attempts += 1;
    entry.successRate = entry.successes / entry.attempts;
    entry.lastTestedAt = new Date().toISOString();
  } else {
    chain.chain.push({
      toolName,
      attempts: 1,
      successes: 0,
      successRate: 0.0,
      lastTestedAt: new Date().toISOString(),
    });
  }

  chain.updatedAt = new Date().toISOString();
  saveFallbackChain(chain);
}

/**
 * Add a tool to a fallback chain (for manual curation).
 */
export function addFallbackTool(
  intent: string,
  failureType: FailureType,
  toolName: string,
  reason?: string,
): void {
  let chain = loadFallbackChain(intent, failureType);

  if (!chain) {
    chain = {
      intent,
      failureType,
      chain: [],
      updatedAt: new Date().toISOString(),
      notes: reason,
    };
  }

  // Check if already in chain
  if (!chain.chain.some((e) => e.toolName === toolName)) {
    chain.chain.push({
      toolName,
      attempts: 0,
      successes: 0,
      successRate: 0.5, // Neutral score for manually added tools
      notes: reason,
    });
  }

  chain.updatedAt = new Date().toISOString();
  saveFallbackChain(chain);
}

/**
 * Clear the fallback chain (reset learning for this intent/failure type).
 */
export function clearFallbackChain(intent: string, failureType: FailureType): void {
  const filePath = getChainFilePath(intent, failureType);
  if (existsSync(filePath)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('fs').unlinkSync(filePath);
    } catch (err) {
      console.warn(`[fallback-chain-store] failed to clear chain ${intent}/${failureType}`, err);
    }
  }
}

/**
 * Suggest next steps when a tool fails (combining capability registry + fallback chains).
 */
export function suggestNextSteps(intent: string, failedTool: string, failureType: FailureType): {
  fallback: string[];
  reason: string;
} {
  // First check learned fallback chains
  const learned = lookupFallbackChain(intent, failureType);

  if (learned.length > 0) {
    return {
      fallback: learned.filter((t) => t !== failedTool), // Exclude the failed tool
      reason: `Learned: When ${intent} fails with ${failureType}, try these in order`,
    };
  }

  // Fall back to capability registry (in Phase 2 integration)
  return {
    fallback: [],
    reason: `No learned fallbacks yet for ${intent}/${failureType}`,
  };
}
