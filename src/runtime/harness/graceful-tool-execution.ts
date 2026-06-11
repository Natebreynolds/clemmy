/**
 * Graceful tool execution — capture per-tool errors without halting workflow.
 *
 * Wraps tool calls in try-catch, returning success/error tuples instead of
 * throwing. Allows workflows to continue even if one tool fails, with the
 * model deciding what to do with partial data.
 */

export interface ToolExecutionResult {
  toolName: string;
  success: boolean;
  data?: unknown;
  error?: {
    name: string;
    message: string;
    code?: string;
  };
  durationMs?: number;
  attempt?: number;
}

export interface GracefulToolOptions {
  maxRetries?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
  fallbackValue?: unknown;
}

/**
 * Execute a tool call with graceful error handling.
 *
 * Instead of throwing, returns a result object with success/error status.
 * Transient errors (timeout, rate limit, 5xx) are retried; terminal errors
 * (4xx, invalid args) fail immediately.
 */
export async function executeToolGracefully(
  toolName: string,
  executeToolFn: () => Promise<unknown>,
  options: GracefulToolOptions = {},
): Promise<ToolExecutionResult> {
  const maxRetries = options.maxRetries ?? 2;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  const startTime = Date.now();

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Wrap in timeout promise
      const resultPromise = executeToolFn();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Tool timeout after ${timeoutMs}ms`)),
          timeoutMs
        )
      );

      const data = await Promise.race([resultPromise, timeoutPromise]);

      return {
        toolName,
        success: true,
        data,
        durationMs: Date.now() - startTime,
        attempt,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const errorCode = classifyError(lastError);

      // Terminal errors (4xx, invalid args, auth) — don't retry
      if (isTerminalError(errorCode)) {
        return {
          toolName,
          success: false,
          error: {
            name: lastError.name || 'Error',
            message: lastError.message,
            code: errorCode,
          },
          durationMs: Date.now() - startTime,
          attempt,
        };
      }

      // Transient errors (timeout, 5xx, rate limit) — retry with backoff
      if (attempt < maxRetries) {
        const delay = retryDelayMs * Math.pow(2, attempt); // exponential backoff
        await new Promise(resolve => setTimeout(resolve, delay));
        continue; // retry
      }

      // Out of retries
      return {
        toolName,
        success: false,
        error: {
          name: lastError.name || 'Error',
          message: lastError.message,
          code: errorCode,
        },
        durationMs: Date.now() - startTime,
        attempt,
      };
    }
  }

  // Should not reach here, but just in case
  return {
    toolName,
    success: false,
    error: {
      name: 'UnknownError',
      message: lastError?.message || 'Unknown error',
      code: 'UNKNOWN',
    },
    durationMs: Date.now() - startTime,
    attempt: maxRetries,
  };
}

/**
 * Execute multiple tool calls in parallel with graceful error handling.
 *
 * Returns an array of results where each tool's result includes its success/error status.
 * A failure in one tool does not affect others.
 */
export async function executeToolsInParallelGracefully(
  toolCalls: Array<{ toolName: string; execute: () => Promise<unknown> }>,
  options: GracefulToolOptions = {},
): Promise<ToolExecutionResult[]> {
  const promises = toolCalls.map(tc =>
    executeToolGracefully(tc.toolName, tc.execute, options)
  );

  return Promise.all(promises);
}

/**
 * Classify an error as transient (retry) or terminal (fail).
 */
function classifyError(err: Error): string {
  const message = err.message.toLowerCase();

  // Timeout
  if (message.includes('timeout') || message.includes('econnreset')) {
    return 'TIMEOUT';
  }

  // Rate limit (429)
  if (message.includes('rate limit') || message.includes('429') || message.includes('too many requests')) {
    return 'RATE_LIMIT';
  }

  // Server error (5xx)
  if (message.includes('5xx') || message.includes('500') || message.includes('502') || message.includes('503')) {
    return 'SERVER_ERROR';
  }

  // Network/connectivity
  if (message.includes('econnrefused') || message.includes('enotfound') || message.includes('network')) {
    return 'NETWORK_ERROR';
  }

  // Client errors (4xx) — terminal
  if (message.includes('401') || message.includes('403') || message.includes('unauthorized') || message.includes('forbidden')) {
    return 'AUTH_ERROR';
  }

  if (message.includes('400') || message.includes('404') || message.includes('bad request') || message.includes('not found')) {
    return 'CLIENT_ERROR';
  }

  // Default: assume transient
  return 'TRANSIENT';
}

/**
 * Check if an error should not be retried.
 */
function isTerminalError(code: string): boolean {
  return code === 'AUTH_ERROR' || code === 'CLIENT_ERROR';
}

/**
 * Format tool results for the model in a human-readable way.
 *
 * Shows success, error, and data in a format the model can reason about.
 */
export function formatResultsForModel(results: ToolExecutionResult[]): string {
  const lines: string[] = [];

  lines.push('Tool Execution Results:');
  lines.push('');

  for (const result of results) {
    if (result.success) {
      lines.push(`✓ ${result.toolName} (${result.durationMs}ms)`);
      if (result.data) {
        const dataStr = typeof result.data === 'string'
          ? result.data.slice(0, 200)
          : JSON.stringify(result.data).slice(0, 200);
        lines.push(`  Data: ${dataStr}${typeof result.data === 'string' && result.data.length > 200 ? '...' : ''}`);
      }
    } else {
      lines.push(`✗ ${result.toolName} (${result.durationMs}ms)`);
      if (result.error) {
        lines.push(`  Error: ${result.error.message}`);
        if (result.error.code) {
          lines.push(`  Code: ${result.error.code}`);
        }
      }
    }
    lines.push('');
  }

  lines.push(`Summary: ${results.filter(r => r.success).length}/${results.length} tools succeeded`);

  return lines.join('\n');
}

/**
 * Check if all tools succeeded.
 */
export function allSucceeded(results: ToolExecutionResult[]): boolean {
  return results.every(r => r.success);
}

/**
 * Check if at least one tool succeeded.
 */
export function anySucceeded(results: ToolExecutionResult[]): boolean {
  return results.some(r => r.success);
}

/**
 * Get successful results only.
 */
export function getSuccessfulResults(results: ToolExecutionResult[]): ToolExecutionResult[] {
  return results.filter(r => r.success);
}

/**
 * Get failed results only.
 */
export function getFailedResults(results: ToolExecutionResult[]): ToolExecutionResult[] {
  return results.filter(r => !r.success);
}
