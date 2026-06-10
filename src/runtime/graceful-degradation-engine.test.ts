import { describe, it, expect } from 'vitest';
import {
  preFlightCheck,
  selectToolsForIntent,
  getFallbackOptions,
  buildExecutionPlan,
  canExecute,
} from './graceful-degradation-engine.js';

describe('GracefulDegradationEngine', () => {
  describe('preFlightCheck', () => {
    it('approves executable intents', () => {
      const check = preFlightCheck('send email');
      expect(check.achievable).toBe(true);
      expect(['direct', 'composition', 'manual']).toContain(check.approach);
    });

    it('rejects impossible intents', () => {
      const check = preFlightCheck('teleport to mars');
      expect(check.achievable).toBe(false);
      expect(check.approach).toBe('impossible');
    });

    it('provides next steps', () => {
      const check = preFlightCheck('send email');
      expect(check.nextSteps.length).toBeGreaterThan(0);
    });

    it('includes guidance', () => {
      const check = preFlightCheck('query salesforce');
      expect(check.guidance).toBeTruthy();
      expect(check.guidance.length).toBeGreaterThan(0);
    });
  });

  describe('selectToolsForIntent', () => {
    it('returns tools in ranked order', () => {
      const tools = selectToolsForIntent('send email');
      expect(tools.length).toBeGreaterThan(0);

      // Should be sorted (first tool is "best")
      for (let i = 0; i < tools.length - 1; i++) {
        // Higher success rates come first (or equal capability if both unknown)
        const current = tools[i].successRate || tools[i].capabilityScore;
        const next = tools[i + 1].successRate || tools[i + 1].capabilityScore;
        expect(current).toBeGreaterThanOrEqual(next * 0.9); // Allow small variance
      }
    });

    it('includes capability and learned reliability info', () => {
      const tools = selectToolsForIntent('send email');
      if (tools.length > 0) {
        const tool = tools[0];
        expect(tool.toolName).toBeTruthy();
        expect(tool.capabilityScore).toBeGreaterThanOrEqual(0);
        expect(tool.capabilityScore).toBeLessThanOrEqual(1);
        expect(tool.learnedReliability).toBeTruthy();
        expect(tool.successRate).toBeGreaterThanOrEqual(0);
        expect(tool.reason).toBeTruthy();
      }
    });
  });

  describe('getFallbackOptions', () => {
    it('returns alternatives for failed tool', () => {
      const fallbacks = getFallbackOptions('send_email', 'outlook_send', 'permission_denied');
      expect(Array.isArray(fallbacks)).toBe(true);
    });

    it('excludes failed tool from fallbacks', () => {
      const fallbacks = getFallbackOptions('send_email', 'outlook_send', 'timeout');
      const toolNames = fallbacks.map((f) => f.toolName);
      expect(toolNames).not.toContain('outlook_send');
    });

    it('includes reason for each fallback', () => {
      const fallbacks = getFallbackOptions('send_email', 'outlook_send', 'rate_limit');
      for (const fallback of fallbacks) {
        expect(fallback.reason).toBeTruthy();
      }
    });
  });

  describe('buildExecutionPlan', () => {
    it('builds complete execution plan', () => {
      const plan = buildExecutionPlan('send email');

      expect(plan.intent).toBe('send email');
      expect(plan.strategy).toBeTruthy();
      expect(Array.isArray(plan.primaryTools)).toBe(true);
      expect(Array.isArray(plan.fallbacks)).toBe(true);
      expect(plan.estimatedSuccess).toBeTruthy();
      expect(plan.guidance).toBeTruthy();
    });

    it('includes realistic success estimate', () => {
      const plan = buildExecutionPlan('send email');
      const successMatch = plan.estimatedSuccess.match(/(\d+)%/);
      if (successMatch) {
        const percent = parseInt(successMatch[1], 10);
        expect(percent).toBeGreaterThanOrEqual(0);
        expect(percent).toBeLessThanOrEqual(100);
      }
    });

    it('prioritizes primary tools', () => {
      const plan = buildExecutionPlan('query salesforce');
      expect(plan.primaryTools.length).toBeGreaterThan(0);
      // Primary tools should come before fallbacks
      const primary = new Set(plan.primaryTools);
      const fallback = new Set(plan.fallbacks);
      const overlap = [...primary].filter((t) => fallback.has(t));
      expect(overlap.length).toBe(0); // No overlap
    });
  });

  describe('canExecute', () => {
    it('returns true for executable intents', () => {
      const result = canExecute('send email');
      expect(result).toBe(true);
    });

    it('returns false for impossible intents', () => {
      const result = canExecute('teleport to mars');
      expect(result).toBe(false);
    });

    it('returns true for composition intents', () => {
      const result = canExecute('query external database');
      expect(result).toBe(true);
    });
  });

  describe('integration scenarios', () => {
    it('handles full email sending scenario', () => {
      // Check if executable
      const executable = canExecute('send email');
      expect(executable).toBe(true);

      // Get execution plan
      const plan = buildExecutionPlan('send email');
      expect(plan.primaryTools.length).toBeGreaterThan(0);

      // Select tools
      const tools = selectToolsForIntent('send email');
      expect(tools.length).toBeGreaterThan(0);
      expect(tools[0].toolName).toBe(plan.primaryTools[0]);
    });

    it('handles Salesforce query scenario', () => {
      const executable = canExecute('query salesforce records');
      expect(executable).toBe(true);

      const plan = buildExecutionPlan('query salesforce records');
      expect(plan.primaryTools.length).toBeGreaterThan(0);

      const tools = selectToolsForIntent('query salesforce records');
      expect(tools.length).toBeGreaterThan(0);
    });

    it('handles multi-step composition scenario', () => {
      const executable = canExecute('query external database and email results');
      expect(executable).toBe(true);

      const plan = buildExecutionPlan('query external database and email results');
      expect(plan.strategy).toContain('COMPOSITION');
    });
  });
});
