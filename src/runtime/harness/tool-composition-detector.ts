/**
 * Tool composition detector — identifies independent tool calls that can run in parallel.
 *
 * Detects when N consecutive tool calls have no data dependencies, allowing
 * them to execute in parallel instead of sequentially. Used to auto-parallelize
 * workflows like /build-brief that call many independent tools (DataForSEO,
 * Apify, etc.) in a single step.
 */

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface ToolResult {
  toolName: string;
  success: boolean;
  data?: unknown;
  error?: string;
  args?: Record<string, unknown>;
}

/**
 * Analyze a sequence of tool calls to detect independent batches.
 *
 * Returns a list of batch groups where each group can be executed in parallel.
 * Within a batch, all tools are independent (no tool's output is used as input
 * by another tool in the same batch).
 *
 * Example:
 *   Input: [
 *     { name: "domain_rank", args: { domain } },
 *     { name: "competitors", args: { domain } },    // no dependency on domain_rank output
 *     { name: "history", args: { domain } },         // no dependency
 *     { name: "send_email", args: { text } }         // depends on combined results
 *   ]
 *   Output: [
 *     [0, 1, 2],  // batch 1: first 3 tools (independent)
 *     [3]         // batch 2: email tool (depends on previous results)
 *   ]
 */
export function detectParallelBatches(toolCalls: ToolCall[]): number[][] {
  if (toolCalls.length === 0) return [];
  if (toolCalls.length === 1) return [[0]];

  const batches: number[][] = [];
  let currentBatch: number[] = [0];
  const usedVarsInBatch = extractUsedVars(toolCalls[0].args);

  for (let i = 1; i < toolCalls.length; i++) {
    const tool = toolCalls[i];
    const inputVars = extractUsedVars(tool.args);

    // Check if this tool depends on outputs from tools in the current batch
    // (Conservative: if a tool references a variable that could be an output,
    // we start a new batch. In a real system, track actual outputs.)
    const dependsOnBatch = Array.from(inputVars).some(v => usedVarsInBatch.has(v));

    if (dependsOnBatch) {
      // Start a new batch
      batches.push(currentBatch);
      currentBatch = [i];
      usedVarsInBatch.clear();
      usedVarsInBatch.addAll(inputVars);
    } else {
      // Add to current batch
      currentBatch.push(i);
      usedVarsInBatch.addAll(inputVars);
    }
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

/**
 * Extract variable names referenced in an object's values.
 * Simple heuristic: looks for patterns like {{variable}}, $var, or just var names.
 */
function extractUsedVars(obj: Record<string, unknown>): Set<string> {
  const vars = new Set<string>();

  const walk = (val: unknown): void => {
    if (typeof val === 'string') {
      // Match {{variable}} patterns
      const templateMatches = val.matchAll(/\{\{([^}]+)\}\}/g);
      for (const m of templateMatches) {
        vars.add(m[1]);
      }
      // Match simple variable names (cautiously)
      const wordMatches = val.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g);
      for (const m of wordMatches) {
        vars.add(m[1]);
      }
    } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      for (const v of Object.values(val)) {
        walk(v);
      }
    } else if (Array.isArray(val)) {
      for (const item of val) {
        walk(item);
      }
    }
  };

  for (const v of Object.values(obj)) {
    walk(v);
  }

  return vars;
}

// Helper: Set.prototype.addAll polyfill
declare global {
  interface Set<T> {
    addAll(iterable: Iterable<T>): Set<T>;
  }
}

if (!Set.prototype.addAll) {
  Set.prototype.addAll = function<T>(iterable: Iterable<T>): Set<T> {
    for (const item of iterable) {
      this.add(item);
    }
    return this;
  };
}

/**
 * Check if a set of tool calls should be parallelized based on name heuristics.
 *
 * Conservative approach: if all tools are from disjoint categories (DataForSEO,
 * Apify, Bright Data, etc.), they can safely run in parallel because they
 * have no data dependencies and serve different purposes.
 */
export function shouldParallelize(toolCalls: ToolCall[]): boolean {
  if (toolCalls.length <= 1) return false;

  // Tools that are "safe to parallelize" (don't depend on each other)
  const independentToolPatterns = [
    /dataforseo/i,
    /apify/i,
    /brightdata|bright_data/i,
    /serp/i,
    /backlinks/i,
    /google.*maps|maps.*api/i,
    /lighthouse|web.*vital/i,
  ];

  // If ALL tools match patterns that suggest independence, parallelize
  const allFromIndependent = toolCalls.every(tc =>
    independentToolPatterns.some(p => p.test(tc.name))
  );

  // If tools are from different vendors, parallelize
  const toolVendors = new Set(
    toolCalls.map(tc => {
      if (/dataforseo/i.test(tc.name)) return 'dataforseo';
      if (/apify/i.test(tc.name)) return 'apify';
      if (/brightdata/i.test(tc.name)) return 'brightdata';
      if (/lighthouse|web.*vital/i.test(tc.name)) return 'lighthouse';
      return 'other';
    })
  );

  // If we have 2+ different vendors, tools are independent
  return toolVendors.size >= 2 || allFromIndependent;
}

/**
 * Combine multiple tool results into a single consolidated result object.
 * Used after parallel execution to merge results for the model.
 */
export function consolidateResults(results: ToolResult[]): Record<string, unknown> {
  const consolidated: Record<string, unknown> = {
    results: [],
    successful: 0,
    failed: 0,
    errors: [],
  };

  for (const result of results) {
    if (result.success) {
      (consolidated.results as unknown[]).push({
        tool: result.toolName,
        data: result.data,
      });
      (consolidated.successful as number)++;
    } else {
      (consolidated.results as unknown[]).push({
        tool: result.toolName,
        error: result.error,
      });
      (consolidated.failed as number)++;
      if (result.error) {
        (consolidated.errors as string[]).push(`${result.toolName}: ${result.error}`);
      }
    }
  }

  return consolidated;
}
