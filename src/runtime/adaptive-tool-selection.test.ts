import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  recordToolOutcome,
  getToolSuccessRate,
  getToolTrend,
  classifyToolReliability,
  rankToolsByReliability,
  getToolHealthDiagnostics,
  resetToolProfile,
  clearAllProfiles,
  getSummary,
} from './adaptive-tool-selection.js';

describe('AdaptiveToolSelection', () => {
  beforeEach(() => {
    // Reset all profiles before each test
    clearAllProfiles();
  });

  describe('recordToolOutcome', () => {
    it('records successful outcomes', () => {
      recordToolOutcome({
        toolName: 'test_tool_a',
        intent: 'send_email',
        succeeded: true,
        timestamp: new Date().toISOString(),
      });

      const rate = getToolSuccessRate('test_tool_a');
      expect(rate).toBe(1.0);
    });

    it('records failed outcomes with error type', () => {
      recordToolOutcome({
        toolName: 'test_tool_b',
        intent: 'query_database',
        succeeded: false,
        errorType: 'permission_denied',
        timestamp: new Date().toISOString(),
      });

      const rate = getToolSuccessRate('test_tool_b');
      expect(rate).toBe(0.0);
    });

    it('tracks multiple outcomes', () => {
      for (let i = 0; i < 5; i++) {
        recordToolOutcome({
          toolName: 'test_tool_c',
          intent: 'test_intent',
          succeeded: i % 2 === 0, // Alternate success/failure
          timestamp: new Date().toISOString(),
        });
      }

      const rate = getToolSuccessRate('test_tool_c');
      expect(rate).toBeGreaterThan(0.3);
      expect(rate).toBeLessThan(0.7);
    });
  });

  describe('getToolSuccessRate', () => {
    it('returns 0.5 for unknown tools', () => {
      const rate = getToolSuccessRate('unknown_tool');
      expect(rate).toBe(0.5);
    });

    it('calculates correct success rate', () => {
      recordToolOutcome({
        toolName: 'test_tool',
        intent: 'task',
        succeeded: true,
        timestamp: new Date().toISOString(),
      });
      recordToolOutcome({
        toolName: 'test_tool',
        intent: 'task',
        succeeded: true,
        timestamp: new Date().toISOString(),
      });
      recordToolOutcome({
        toolName: 'test_tool',
        intent: 'task',
        succeeded: false,
        timestamp: new Date().toISOString(),
      });

      const rate = getToolSuccessRate('test_tool');
      expect(rate).toBeCloseTo(0.666, 2);
    });
  });

  describe('getToolTrend', () => {
    it('returns "unknown" for tools with insufficient data', () => {
      const trend = getToolTrend('test_tool');
      expect(trend).toBe('unknown');
    });

    it('detects improving trend', () => {
      // Record initial failures
      for (let i = 0; i < 5; i++) {
        recordToolOutcome({
          toolName: 'test_tool',
          intent: 'task',
          succeeded: false,
          timestamp: new Date().toISOString(),
        });
      }

      // Record recent successes
      for (let i = 0; i < 5; i++) {
        recordToolOutcome({
          toolName: 'test_tool',
          intent: 'task',
          succeeded: true,
          timestamp: new Date().toISOString(),
        });
      }

      const trend = getToolTrend('test_tool');
      expect(trend).toBe('improving');
    });

    it('detects degrading trend', () => {
      // Record initial successes
      for (let i = 0; i < 5; i++) {
        recordToolOutcome({
          toolName: 'test_tool',
          intent: 'task',
          succeeded: true,
          timestamp: new Date().toISOString(),
        });
      }

      // Record recent failures
      for (let i = 0; i < 5; i++) {
        recordToolOutcome({
          toolName: 'test_tool',
          intent: 'task',
          succeeded: false,
          timestamp: new Date().toISOString(),
        });
      }

      const trend = getToolTrend('test_tool');
      expect(trend).toBe('degrading');
    });
  });

  describe('classifyToolReliability', () => {
    it('classifies highly reliable tools (>90%)', () => {
      for (let i = 0; i < 10; i++) {
        recordToolOutcome({
          toolName: 'test_tool',
          intent: 'task',
          succeeded: true,
          timestamp: new Date().toISOString(),
        });
      }

      const reliability = classifyToolReliability('test_tool');
      expect(reliability).toBe('highly_reliable');
    });

    it('classifies reliable tools (70-90%)', () => {
      // Record 7 successes and 3 failures = 70% success rate
      for (let i = 0; i < 7; i++) {
        recordToolOutcome({
          toolName: 'test_tool',
          intent: 'task',
          succeeded: true,
          timestamp: new Date().toISOString(),
        });
      }
      for (let i = 0; i < 3; i++) {
        recordToolOutcome({
          toolName: 'test_tool',
          intent: 'task',
          succeeded: false,
          timestamp: new Date().toISOString(),
        });
      }

      const reliability = classifyToolReliability('test_tool');
      expect(reliability).toBe('reliable');
    });

    it('classifies unreliable tools (<70%)', () => {
      recordToolOutcome({
        toolName: 'test_tool',
        intent: 'task',
        succeeded: false,
        timestamp: new Date().toISOString(),
      });
      recordToolOutcome({
        toolName: 'test_tool',
        intent: 'task',
        succeeded: true,
        timestamp: new Date().toISOString(),
      });

      const reliability = classifyToolReliability('test_tool');
      expect(['reliable', 'unreliable']).toContain(reliability);
    });
  });

  describe('rankToolsByReliability', () => {
    it('orders tools by success rate', () => {
      // Tool A: 100% success
      for (let i = 0; i < 5; i++) {
        recordToolOutcome({
          toolName: 'tool_a',
          intent: 'task',
          succeeded: true,
          timestamp: new Date().toISOString(),
        });
      }

      // Tool B: 50% success
      recordToolOutcome({
        toolName: 'tool_b',
        intent: 'task',
        succeeded: true,
        timestamp: new Date().toISOString(),
      });
      recordToolOutcome({
        toolName: 'tool_b',
        intent: 'task',
        succeeded: false,
        timestamp: new Date().toISOString(),
      });

      const ranked = rankToolsByReliability(['tool_b', 'tool_a', 'unknown_tool']);

      expect(ranked[0].toolName).toBe('tool_a');
      expect(ranked[0].score).toBe(1.0);
      expect(ranked[1].toolName).toBe('tool_b');
    });
  });

  describe('getToolHealthDiagnostics', () => {
    it('provides diagnostics for unknown tools', () => {
      const diag = getToolHealthDiagnostics('unknown_tool');
      expect(diag.reliability).toBe('unknown');
      expect(diag.recommendation).toContain('not been used');
    });

    it('provides diagnostics for known tools', () => {
      for (let i = 0; i < 10; i++) {
        recordToolOutcome({
          toolName: 'test_tool',
          intent: 'task',
          succeeded: true,
          timestamp: new Date().toISOString(),
        });
      }

      const diag = getToolHealthDiagnostics('test_tool');
      expect(diag.reliability).toBe('highly_reliable');
      expect(diag.successRate).toContain('100');
    });

    it('recommends avoiding unreliable tools', () => {
      for (let i = 0; i < 10; i++) {
        recordToolOutcome({
          toolName: 'test_tool',
          intent: 'task',
          succeeded: false,
          errorType: 'timeout',
          timestamp: new Date().toISOString(),
        });
      }

      const diag = getToolHealthDiagnostics('test_tool');
      expect(diag.reliability).toBe('unreliable');
      expect(diag.recommendation).toBeTruthy();
    });
  });

  describe('getSummary', () => {
    it('returns empty summary for no tools', () => {
      const summary = getSummary();
      expect(summary.totalTools).toBe(0);
      expect(summary.totalOutcomes).toBe(0);
    });

    it('aggregates all tool data', () => {
      recordToolOutcome({
        toolName: 'tool_a',
        intent: 'task',
        succeeded: true,
        timestamp: new Date().toISOString(),
      });
      recordToolOutcome({
        toolName: 'tool_b',
        intent: 'task',
        succeeded: false,
        timestamp: new Date().toISOString(),
      });

      const summary = getSummary();
      expect(summary.totalTools).toBe(2);
      expect(summary.totalOutcomes).toBe(2);
      expect(summary.toolSummaries.length).toBe(2);
    });

    it('sorts by success rate descending', () => {
      for (let i = 0; i < 3; i++) {
        recordToolOutcome({
          toolName: 'tool_a',
          intent: 'task',
          succeeded: true,
          timestamp: new Date().toISOString(),
        });
      }

      recordToolOutcome({
        toolName: 'tool_b',
        intent: 'task',
        succeeded: false,
        timestamp: new Date().toISOString(),
      });

      const summary = getSummary();
      const rateA = parseFloat(summary.toolSummaries[0].successRate);
      const rateB = parseFloat(summary.toolSummaries[1].successRate);

      expect(rateA).toBeGreaterThanOrEqual(rateB);
    });
  });
});
