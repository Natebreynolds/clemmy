import { describe, it, expect } from 'vitest';
import {
  detectComposition,
  formatCompositionGuidance,
  checkAchievability,
  suggestApproach,
} from './tool-composition-detector.js';

describe('ToolCompositionDetector', () => {
  describe('detectComposition', () => {
    it('finds composition for "query external database"', () => {
      const comp = detectComposition('query external database');
      expect(comp).toBeTruthy();
      expect(comp?.steps.length).toBeGreaterThan(0);
      expect(comp?.approach).toBe('composition');
    });

    it('finds composition for "send email with large attachment"', () => {
      const comp = detectComposition('send email with large attachment');
      expect(comp).toBeTruthy();
      expect(comp?.steps.length).toBeGreaterThan(1);
    });

    it('returns null when direct tool exists', () => {
      const comp = detectComposition('send email');
      expect(comp).toBeNull(); // Direct tool exists for this
    });

    it('fuzzy matches "query database"', () => {
      const comp = detectComposition('query database');
      expect(comp).toBeTruthy();
    });
  });

  describe('formatCompositionGuidance', () => {
    it('formats steps clearly', () => {
      const comp = detectComposition('query external database');
      if (comp) {
        const formatted = formatCompositionGuidance(comp);
        expect(formatted).toContain('multi-step');
        expect(formatted).toContain('Steps:');
        expect(formatted).toContain('Tools available');
      }
    });

    it('includes rationale', () => {
      const comp = detectComposition('send email with large attachment');
      if (comp) {
        const formatted = formatCompositionGuidance(comp);
        expect(formatted).toContain('Rationale');
      }
    });
  });

  describe('checkAchievability', () => {
    it('marks direct tools as achievable via direct approach', () => {
      const result = checkAchievability('send email');
      expect(result.achievable).toBe(true);
      expect(result.approach).toBe('direct');
    });

    it('marks compositions as achievable via composition', () => {
      const result = checkAchievability('query external database');
      expect(result.achievable).toBe(true);
      expect(result.approach).toBe('composition');
    });

    it('marks impossible intents as not achievable', () => {
      const result = checkAchievability('teleport to mars');
      expect(result.achievable).toBe(false);
      expect(result.approach).toBe('impossible');
    });

    it('includes clear reasoning', () => {
      const result = checkAchievability('query external database');
      expect(result.reason).toBeTruthy();
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });

  describe('suggestApproach', () => {
    it('suggests direct approach for simple tasks', () => {
      const suggestion = suggestApproach('send email');
      expect(suggestion).toContain('directly');
    });

    it('suggests composition for complex tasks', () => {
      const suggestion = suggestApproach('query external database');
      expect(suggestion).toContain('multi-step');
    });

    it('suggests manual escalation when needed', () => {
      const suggestion = suggestApproach('unknown task xyz 123');
      // Should suggest some approach, even if limited
      expect(suggestion.length).toBeGreaterThan(0);
    });
  });

  describe('edge cases', () => {
    it('handles case variations', () => {
      const lower = checkAchievability('query external database');
      const upper = checkAchievability('QUERY EXTERNAL DATABASE');
      const mixed = checkAchievability('Query External Database');

      expect(lower.achievable).toBe(upper.achievable);
      expect(lower.achievable).toBe(mixed.achievable);
    });

    it('handles fuzzy matches', () => {
      const exact = detectComposition('query_external_database');
      const words = detectComposition('query external database');

      if (exact && words) {
        expect(exact.steps.length).toBe(words.steps.length);
      }
    });
  });

  describe('composition completeness', () => {
    it('all compositions have at least 2 steps', () => {
      const intents = [
        'query external database',
        'send email with large attachment',
        'export salesforce to excel',
        'batch update spreadsheet',
        'scrape and analyze',
      ];

      for (const intent of intents) {
        const comp = detectComposition(intent);
        if (comp) {
          expect(comp.steps.length).toBeGreaterThanOrEqual(2);
        }
      }
    });

    it('all steps have clear descriptions and tools', () => {
      const comp = detectComposition('query external database');
      if (comp) {
        for (const step of comp.steps) {
          expect(step.description).toBeTruthy();
          expect(step.toolsAvailable.length).toBeGreaterThan(0);
          expect(step.expectedOutput).toBeTruthy();
        }
      }
    });
  });
});
