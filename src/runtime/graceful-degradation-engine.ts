/**
 * Graceful Degradation Engine — Wire Phases 1-4 into actual task execution.
 *
 * This is Phase 5: the integration layer that makes Clementine actually RUN
 * any task with no fail. It:
 *
 * 1. Pre-flight: Check achievability before attempting (Phase 3 + Phase 1)
 * 2. Execute: Try tools in capability order (Phase 1 + Phase 4)
 * 3. Fallback: Suggest alternatives on failure (Phase 2)
 * 4. Learn: Record outcomes for future improvement (Phase 4)
 *
 * Purpose: Transform isolated utilities (Phases 1-4) into an active,
 * end-to-end task execution system that adapts and learns.
 */

import { checkAchievability, suggestApproach } from './tool-composition-detector.js';
import { getCapabilitiesForIntent } from './capability-registry.js';
import { lookupFallbackChain, suggestNextSteps } from './fallback-chain-store.js';
import { recordToolOutcome, getToolSuccessRate, classifyToolReliability } from './adaptive-tool-selection.js';
import type { ToolOutcome } from './adaptive-tool-selection.js';

/**
 * Pre-flight check before attempting a task.
 * Returns guidance on whether task is achievable and how.
 */
export function preFlightCheck(intent: string): {
  achievable: boolean;
  approach: 'direct' | 'composition' | 'manual' | 'impossible';
  guidance: string;
  nextSteps: string[];
} {
  const achievability = checkAchievability(intent);

  if (achievability.approach === 'direct') {
    const caps = getCapabilitiesForIntent(intent);
    const topTools = caps.slice(0, 3);

    return {
      achievable: true,
      approach: 'direct',
      guidance: suggestApproach(intent),
      nextSteps: topTools.map((c) => c.toolName),
    };
  }

  if (achievability.approach === 'composition') {
    return {
      achievable: true,
      approach: 'composition',
      guidance: suggestApproach(intent),
      nextSteps: ['compose_multi_step_solution'],
    };
  }

  if (achievability.approach === 'manual') {
    return {
      achievable: true,
      approach: 'manual',
      guidance: suggestApproach(intent),
      nextSteps: ['provide_guidance_to_user'],
    };
  }

  return {
    achievable: false,
    approach: 'impossible',
    guidance: achievability.reason,
    nextSteps: [],
  };
}

/**
 * Intelligent tool selection for an intent.
 * Returns tools in order of likelihood to succeed, based on:
 * 1. Capability score (Phase 1)
 * 2. Learned success rate (Phase 4)
 * 3. Recent trends (Phase 4)
 */
export function selectToolsForIntent(intent: string): Array<{
  toolName: string;
  capabilityScore: number;
  learnedReliability: string;
  successRate: number;
  reason: string;
}> {
  const caps = getCapabilitiesForIntent(intent);

  return caps
    .map((cap) => {
      const successRate = getToolSuccessRate(cap.toolName);
      const reliability = classifyToolReliability(cap.toolName);

      return {
        toolName: cap.toolName,
        capabilityScore: cap.score,
        learnedReliability: reliability,
        successRate,
        reason: `${cap.reason} (learned: ${reliability}, ${(successRate * 100).toFixed(0)}% success)`,
      };
    })
    .sort((a, b) => {
      // Sort by learned success rate first (what actually works),
      // then by capability score (what should work)
      if (a.successRate !== b.successRate) {
        return b.successRate - a.successRate;
      }
      return b.capabilityScore - a.capabilityScore;
    });
}

/**
 * Record a tool execution outcome and learn from it.
 * Call this after every tool executes (success or failure).
 */
export function recordExecution(outcome: ToolOutcome): void {
  recordToolOutcome(outcome);

  // Could also update memory, trigger re-ranking, etc.
  // For now, just the core recording to Phase 4
}

/**
 * Get fallback options when a tool fails.
 * Returns ranked alternatives based on learned chains + capabilities.
 */
export function getFallbackOptions(intent: string, failedTool: string, failureType: string): Array<{
  toolName: string;
  reason: string;
  tryBefore: string[] | null;
}> {
  const suggestion = suggestNextSteps(
    intent,
    failedTool,
    failureType as
      | 'permission_denied'
      | 'not_found'
      | 'rate_limit'
      | 'timeout'
      | 'unknown',
  );

  return (suggestion.fallback || []).slice(0, 5).map((tool) => ({
    toolName: tool,
    reason: `${suggestion.reason}`,
    tryBefore: null,
  }));
}

/**
 * Comprehensive task execution plan.
 * Shows agent the full strategy before executing.
 */
export function buildExecutionPlan(intent: string): {
  intent: string;
  strategy: string;
  primaryTools: string[];
  fallbacks: string[];
  estimatedSuccess: string;
  guidance: string;
} {
  const preflight = preFlightCheck(intent);
  const tools = selectToolsForIntent(intent);
  const primaryTools = tools.slice(0, 3).map((t) => t.toolName);
  const fallbacks = tools.slice(3, 6).map((t) => t.toolName);

  const avgSuccess =
    tools.length > 0 ? (tools.reduce((sum, t) => sum + t.successRate, 0) / tools.length) * 100 : 50;

  return {
    intent,
    strategy: `${preflight.approach.toUpperCase()}: ${preflight.guidance}`,
    primaryTools,
    fallbacks,
    estimatedSuccess: `${avgSuccess.toFixed(0)}% (based on learned outcomes)`,
    guidance: preflight.guidance,
  };
}

/**
 * One-stop function to check if a task can be executed.
 * Returns true if ANY viable path exists (direct, composition, or manual).
 */
export function canExecute(intent: string): boolean {
  const check = preFlightCheck(intent);
  return check.achievable;
}

/**
 * Get a human-readable summary of task execution capabilities.
 */
export function getSummary(): {
  cachedIntents: number;
  learnedTools: number;
  averageSuccessRate: number;
  summary: string;
} {
  // In production, would aggregate across all recorded intents
  // For now, return a placeholder

  return {
    cachedIntents: 0,
    learnedTools: 0,
    averageSuccessRate: 0,
    summary: 'Graceful degradation engine ready. Use preFlightCheck() and selectToolsForIntent() to execute tasks.',
  };
}
