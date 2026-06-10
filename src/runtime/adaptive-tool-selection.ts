/**
 * Adaptive Tool Selection — Learn and improve tool choices over time.
 *
 * This module makes Clementine smarter with every task:
 * - Tracks which tools work under which conditions
 * - Reorders fallback chains by real success rates
 * - Learns user/instance-specific tool reliability
 * - Improves tool ranking dynamically
 *
 * Example:
 * Day 1: User tries Outlook (fails), Gmail (succeeds) → learns "use Gmail first"
 * Day 2: Next email task automatically uses Gmail first
 * Day 30: After 30 email tasks, Clementine knows Gmail reliability in this user's env
 */

import { recordFallbackSuccess, recordFallbackFailure } from './fallback-chain-store.js';
import { updateToolChoiceOutcomeForIdentifier } from '../memory/tool-choice-store.js';

/**
 * Tool outcome tracking — what happened when we used a tool.
 */
export interface ToolOutcome {
  toolName: string;
  intent: string;
  succeeded: boolean;
  errorType?: 'permission_denied' | 'not_found' | 'rate_limit' | 'timeout' | 'unknown';
  conditionContext?: {
    timeOfDay?: string;
    dayOfWeek?: string;
    userDomain?: string;
    retryCount?: number;
  };
  timestamp: string;
  duration?: number;
}

/**
 * Learned tool profile — success rate and reliability metrics.
 */
export interface ToolProfile {
  toolName: string;
  totalAttempts: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  lastUsed?: string;
  averageExecutionTime?: number;
  failureTypes: Record<string, number>;
  recentOutcomes: boolean[]; // Last 10 outcomes: true=success, false=fail
}

/**
 * In-memory profiles for current session.
 * In production, these would persist to the fallback chain store.
 */
const toolProfiles = new Map<string, ToolProfile>();

/**
 * Record a tool execution outcome.
 * Call this whenever a tool finishes (success or failure).
 */
export function recordToolOutcome(outcome: ToolOutcome): void {
  // Update local profile
  let profile = toolProfiles.get(outcome.toolName);
  if (!profile) {
    profile = {
      toolName: outcome.toolName,
      totalAttempts: 0,
      successCount: 0,
      failureCount: 0,
      successRate: 0,
      failureTypes: {},
      recentOutcomes: [],
    };
    toolProfiles.set(outcome.toolName, profile);
  }

  // Update counts
  profile.totalAttempts += 1;
  if (outcome.succeeded) {
    profile.successCount += 1;
  } else {
    profile.failureCount += 1;
    if (outcome.errorType) {
      profile.failureTypes[outcome.errorType] = (profile.failureTypes[outcome.errorType] ?? 0) + 1;
    }
  }

  // Update success rate
  profile.successRate = profile.successCount / profile.totalAttempts;

  // Track recent outcomes (last 10)
  profile.recentOutcomes.push(outcome.succeeded);
  if (profile.recentOutcomes.length > 10) {
    profile.recentOutcomes.shift();
  }

  // Update timestamp
  profile.lastUsed = outcome.timestamp;

  // Track execution time
  if (outcome.duration && profile.averageExecutionTime) {
    profile.averageExecutionTime = (profile.averageExecutionTime + outcome.duration) / 2;
  } else if (outcome.duration) {
    profile.averageExecutionTime = outcome.duration;
  }

  // Persist to fallback chains for long-term learning
  if (!outcome.succeeded && outcome.errorType) {
    recordFallbackFailure(outcome.intent, outcome.errorType, outcome.toolName);
  } else if (outcome.succeeded) {
    recordFallbackSuccess(outcome.intent, 'unknown', outcome.toolName);
  }

  // Persist to tool-choice-store for per-tool learning
  try {
    updateToolChoiceOutcomeForIdentifier(outcome.toolName, outcome.succeeded);
  } catch (err) {
    // Silently ignore if tool-choice-store not available
  }
}

/**
 * Get the current success rate for a tool.
 */
export function getToolSuccessRate(toolName: string): number {
  const profile = toolProfiles.get(toolName);
  return profile?.successRate ?? 0.5; // Default to neutral if unknown
}

/**
 * Get recent trend for a tool (is it improving or degrading?).
 */
export function getToolTrend(toolName: string): 'improving' | 'degrading' | 'stable' | 'unknown' {
  const profile = toolProfiles.get(toolName);
  if (!profile || profile.recentOutcomes.length < 3) {
    return 'unknown';
  }

  const recent = profile.recentOutcomes.slice(-5); // Last 5 outcomes
  const successCount = recent.filter((o) => o).length;
  const successRate = successCount / recent.length;

  // Compare to overall success rate
  if (successRate > profile.successRate + 0.1) {
    return 'improving';
  }
  if (successRate < profile.successRate - 0.1) {
    return 'degrading';
  }
  return 'stable';
}

/**
 * Get tool reliability classification.
 */
export function classifyToolReliability(toolName: string): 'highly_reliable' | 'reliable' | 'unreliable' | 'unknown' {
  const profile = toolProfiles.get(toolName);

  // If we have no history, it's unknown
  if (!profile || profile.totalAttempts === 0) {
    return 'unknown';
  }

  const rate = profile.successRate;

  if (rate >= 0.9) return 'highly_reliable';
  if (rate >= 0.7) return 'reliable';
  if (rate >= 0.0) return 'unreliable'; // Any data below 70% is unreliable
  return 'unknown';
}

/**
 * Recommend tool order based on learned success rates.
 * Used when multiple tools can achieve the same intent.
 */
export function rankToolsByReliability(toolNames: string[]): Array<{ toolName: string; score: number }> {
  return toolNames
    .map((tool) => ({
      toolName: tool,
      score: getToolSuccessRate(tool),
    }))
    .sort((a, b) => b.score - a.score); // Highest success rate first
}

/**
 * Get diagnostic info about a tool's health.
 */
export function getToolHealthDiagnostics(toolName: string): {
  toolName: string;
  reliability: string;
  trend: string;
  successRate: string;
  failureTypes: string[];
  recommendation: string;
} {
  const profile = toolProfiles.get(toolName);
  const reliability = classifyToolReliability(toolName);
  const trend = getToolTrend(toolName);

  if (!profile) {
    return {
      toolName,
      reliability: 'unknown',
      trend: 'unknown',
      successRate: 'No data',
      failureTypes: [],
      recommendation: `${toolName} has not been used yet`,
    };
  }

  const failureTypes = Object.entries(profile.failureTypes)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([type, count]) => `${type} (${count}x)`)
    .join(', ');

  let recommendation = '';
  if (reliability === 'highly_reliable') {
    recommendation = `Prefer ${toolName} — it has proven reliability`;
  } else if (reliability === 'reliable') {
    recommendation = `${toolName} works well but has occasional issues`;
  } else if (reliability === 'unreliable') {
    recommendation = `Avoid ${toolName} — consider alternatives`;
  }

  if (trend === 'degrading') {
    recommendation += '. Warning: recent performance has degraded.';
  }

  return {
    toolName,
    reliability,
    trend,
    successRate: `${(profile.successRate * 100).toFixed(1)}% (${profile.successCount}/${profile.totalAttempts})`,
    failureTypes: failureTypes ? failureTypes.split(', ') : [],
    recommendation,
  };
}

/**
 * Reset learning for a tool (for debugging or recovery).
 */
export function resetToolProfile(toolName: string): void {
  toolProfiles.delete(toolName);
}

/**
 * Clear all learning data (for testing).
 */
export function clearAllProfiles(): void {
  toolProfiles.clear();
}

/**
 * Get summary of all learned tool profiles.
 */
export function getSummary(): {
  totalTools: number;
  totalOutcomes: number;
  averageSuccessRate: number;
  toolSummaries: Array<{
    toolName: string;
    attempts: number;
    successRate: string;
    reliability: string;
  }>;
} {
  const summaries = Array.from(toolProfiles.values()).map((profile) => ({
    toolName: profile.toolName,
    attempts: profile.totalAttempts,
    successRate: `${(profile.successRate * 100).toFixed(1)}%`,
    reliability: classifyToolReliability(profile.toolName),
  }));

  const totalOutcomes = Array.from(toolProfiles.values()).reduce((sum, p) => sum + p.totalAttempts, 0);
  const avgRate = Array.from(toolProfiles.values()).reduce((sum, p) => sum + p.successRate, 0) / toolProfiles.size || 0;

  return {
    totalTools: toolProfiles.size,
    totalOutcomes,
    averageSuccessRate: avgRate,
    toolSummaries: summaries.sort((a, b) => parseFloat(b.successRate) - parseFloat(a.successRate)),
  };
}
