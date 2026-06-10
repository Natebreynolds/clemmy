/**
 * Intelligent retry handler for transient tool failures.
 *
 * When a tool fails, this classifies the error and decides:
 * - Transient (rate limit, 5xx, timeout, network) → retry with exponential backoff
 * - Terminal (401, 403, not found, permission) → escalate immediately
 * - Circuit-breaker: same error N times → give up and escalate
 *
 * Prevents retry loops while recovering from infrastructure blips.
 */

import { isTransientStepError } from '../../execution/transient-error.js';

export interface RetryDecision {
  shouldRetry: boolean;
  isTransient: boolean;
  delayMs: number;
  reason: string;
  attempt: number;
  maxAttempts: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_DELAYS_MS = [1000, 2000, 4000, 8000, 16000]; // exponential backoff

/**
 * Decide whether to retry a failed tool call.
 *
 * @param error The error from the tool
 * @param attempt Current attempt number (1-based)
 * @param recentErrors Recent error history for circuit-breaker detection
 * @returns Decision with retry details
 */
export function shouldRetryToolCall(
  error: unknown,
  attempt: number = 1,
  recentErrors: string[] = [],
): RetryDecision {
  const maxAttempts = DEFAULT_MAX_ATTEMPTS;
  const isTransient = isTransientStepError(error);
  const errorMsg = error instanceof Error ? error.message : String(error ?? '');

  // Terminal errors: never retry
  const isTerminal = isTerminalError(error, errorMsg);
  if (isTerminal) {
    return {
      shouldRetry: false,
      isTransient: false,
      delayMs: 0,
      reason: `Terminal error (${classifyTerminalError(errorMsg)}). Do not retry.`,
      attempt,
      maxAttempts,
    };
  }

  // Transient errors: retry with backoff
  if (isTransient) {
    // Circuit-breaker: if same error appears N times in a row, give up
    const sameErrorCount = countConsecutiveMatches(recentErrors, errorMsg);
    if (sameErrorCount >= 2) {
      return {
        shouldRetry: false,
        isTransient: true,
        delayMs: 0,
        reason: `Transient error repeated ${sameErrorCount} times (${classifyTransientError(errorMsg)}). Escalating instead of retrying.`,
        attempt,
        maxAttempts,
      };
    }

    // Not exceeded max attempts: retry with exponential backoff
    if (attempt <= maxAttempts) {
      const delayIndex = Math.min(attempt - 1, BACKOFF_DELAYS_MS.length - 1);
      const delayMs = BACKOFF_DELAYS_MS[delayIndex];
      return {
        shouldRetry: true,
        isTransient: true,
        delayMs,
        reason: `Transient error (${classifyTransientError(errorMsg)}). Retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts}).`,
        attempt,
        maxAttempts,
      };
    }
  }

  // Unknown error: give up to prevent loops
  return {
    shouldRetry: false,
    isTransient: false,
    delayMs: 0,
    reason: 'Unknown error. Escalating to avoid retry loops.',
    attempt,
    maxAttempts,
  };
}

/**
 * Classify transient error type for user guidance.
 */
function classifyTransientError(errorMsg: string): string {
  if (/rate.?limit|too many requests|429/i.test(errorMsg)) {
    return 'rate limit';
  }
  if (/timeout|timed out|ETIMEDOUT/i.test(errorMsg)) {
    return 'timeout';
  }
  if (/5\d{2}|internal error|service unavailable|bad gateway/i.test(errorMsg)) {
    return 'server error (5xx)';
  }
  if (/connection|ECONNRESET|ECONNREFUSED|socket/i.test(errorMsg)) {
    return 'network error';
  }
  return 'transient infrastructure error';
}

/**
 * Classify terminal error type for user guidance.
 */
function classifyTerminalError(errorMsg: string): string {
  if (/401|unauthorized|not authorized/i.test(errorMsg)) {
    return 'authentication failed (401)';
  }
  if (/403|forbidden|permission/i.test(errorMsg)) {
    return 'permission denied (403)';
  }
  if (/not found|404|doesn.t exist|invalid/i.test(errorMsg)) {
    return 'resource not found (404)';
  }
  if (/invalid|bad request|400|required field/i.test(errorMsg)) {
    return 'invalid request (400)';
  }
  return 'terminal error';
}

/**
 * Detect if an error is terminal (should never retry).
 */
function isTerminalError(error: unknown, errorMsg: string): boolean {
  const code = (error as { code?: string; status?: number } | null);

  // HTTP status codes that are terminal
  if (typeof code?.status === 'number') {
    return code.status >= 400 && code.status < 500; // All 4xx are terminal
  }

  // Error message patterns
  const terminalPatterns = [
    /\b(401|403|404|400)\b/, // HTTP status codes
    /\b(unauthorized|forbidden|not found|not_found|invalid|bad request)\b/i,
    /\b(authentication failed|permission denied)\b/i,
    /\b(schema error|contract error|validation error)\b/i,
  ];

  return terminalPatterns.some((pattern) => pattern.test(errorMsg));
}

/**
 * Count consecutive matches of same error message at the end of history.
 * Used for circuit-breaker: if same error repeats, stop retrying.
 */
function countConsecutiveMatches(history: string[], target: string): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].includes(target.substring(0, 50))) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Async delay utility for exponential backoff.
 */
export async function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format retry decision for user feedback.
 */
export function formatRetryMessage(decision: RetryDecision, toolName: string): string {
  if (decision.shouldRetry) {
    return [
      `⚠️  ${toolName} encountered a ${decision.isTransient ? 'transient' : 'temporary'} error`,
      `Error: ${decision.reason}`,
      `Retrying automatically (${decision.attempt}/${decision.maxAttempts})...`,
    ].join('\n');
  }

  return [
    `❌ ${toolName} failed with a ${decision.isTransient ? 'repeated transient' : 'terminal'} error`,
    `${decision.reason}`,
    'No more retries. Please fix the underlying issue and try again.',
  ].join('\n');
}
