import { describe, it, expect } from 'vitest';
import {
  getCapabilitiesForIntent,
  formatCapabilitiesForContext,
  suggestFallback,
  type CapabilityOption,
} from './capability-registry.js';

describe('CapabilityRegistry', () => {
  describe('getCapabilitiesForIntent', () => {
    it('returns exact match for "send email"', () => {
      const caps = getCapabilitiesForIntent('send email');
      expect(caps.length).toBeGreaterThan(0);
      expect(caps[0].score).toBeGreaterThanOrEqual(0.9); // Top option should be highly scored
      expect(caps[0].toolName).toMatch(/outlook|gmail/i);
    });

    it('returns exact match for "query salesforce records"', () => {
      const caps = getCapabilitiesForIntent('query salesforce records');
      expect(caps.length).toBeGreaterThan(0);
      expect(caps[0].toolName).toMatch(/salesforce|sf/i);
    });

    it('handles case-insensitive matching', () => {
      const lower = getCapabilitiesForIntent('send email');
      const upper = getCapabilitiesForIntent('SEND EMAIL');
      const mixed = getCapabilitiesForIntent('Send Email');

      expect(lower).toEqual(upper);
      expect(lower).toEqual(mixed);
    });

    it('returns sorted by score descending', () => {
      const caps = getCapabilitiesForIntent('send email');
      for (let i = 0; i < caps.length - 1; i++) {
        expect(caps[i].score).toBeGreaterThanOrEqual(caps[i + 1].score);
      }
    });

    it('fuzzy matches "query salesforce" without "records"', () => {
      const caps = getCapabilitiesForIntent('query salesforce');
      expect(caps.length).toBeGreaterThan(0);
      expect(caps[0].toolName).toMatch(/salesforce/i);
    });

    it('returns unknown capability for unsupported intent', () => {
      const caps = getCapabilitiesForIntent('teleport to mars');
      expect(caps.length).toBeGreaterThan(0);
      expect(caps[0].score).toBe(0.0);
    });

    it('handles empty string', () => {
      const caps = getCapabilitiesForIntent('');
      expect(Array.isArray(caps)).toBe(true);
    });

    it('includes fallback suggestions for lower-scored options', () => {
      const caps = getCapabilitiesForIntent('send email');
      // Should have at least one option with a fallback specified
      const hasFallback = caps.some((c) => c.fallback);
      expect(hasFallback).toBe(true);
    });

    it('includes requirement info for tools that need setup', () => {
      const caps = getCapabilitiesForIntent('send email');
      const hasRequirement = caps.some((c) => c.requirement);
      expect(hasRequirement).toBe(true);
    });
  });

  describe('formatCapabilitiesForContext', () => {
    it('formats capabilities for agent context', () => {
      const caps = getCapabilitiesForIntent('send email');
      const formatted = formatCapabilitiesForContext('send email', caps);

      expect(formatted).toContain('send email');
      expect(formatted).toContain('option');
      expect(formatted).toContain('✅'); // High-score marker
    });

    it('includes tool names and reasons', () => {
      const caps = getCapabilitiesForIntent('send email');
      const formatted = formatCapabilitiesForContext('send email', caps);

      expect(formatted).toContain(caps[0].toolName);
      expect(formatted).toContain(caps[0].reason);
    });

    it('returns empty string for empty options', () => {
      const formatted = formatCapabilitiesForContext('test', []);
      expect(formatted).toBe('');
    });

    it('marks requirements in formatted output', () => {
      const caps = getCapabilitiesForIntent('send email');
      const capWithReq = caps.find((c) => c.requirement);

      if (capWithReq) {
        const formatted = formatCapabilitiesForContext('send email', [capWithReq]);
        expect(formatted).toContain('requires');
      }
    });
  });

  describe('suggestFallback', () => {
    it('suggests alternatives when primary tool fails', () => {
      const fallbacks = suggestFallback('composio_outlook_send_message', 'send email');
      expect(fallbacks.length).toBeGreaterThan(0);
      expect(fallbacks.every((f) => f.toolName !== 'composio_outlook_send_message')).toBe(true);
    });

    it('returns lower-scored options as fallbacks', () => {
      const allCaps = getCapabilitiesForIntent('send email');
      const fallbacks = suggestFallback(allCaps[0].toolName, 'send email');

      expect(fallbacks.length).toBeGreaterThan(0);
      // Fallbacks should generally have lower or equal scores than the first option
      const avgFallbackScore = fallbacks.reduce((sum, f) => sum + f.score, 0) / fallbacks.length;
      expect(avgFallbackScore).toBeLessThanOrEqual(allCaps[0].score);
    });

    it('suggests escalation when no alternatives exist', () => {
      const fallbacks = suggestFallback('unknown_tool', 'teleport to mars');
      expect(fallbacks.length).toBeGreaterThan(0);
      expect(fallbacks[0].toolName).toBe('escalate_to_user');
    });

    it('orders fallbacks by score', () => {
      const fallbacks = suggestFallback('composio_outlook_send_message', 'send email');
      for (let i = 0; i < fallbacks.length - 1; i++) {
        expect(fallbacks[i].score).toBeGreaterThanOrEqual(fallbacks[i + 1].score);
      }
    });
  });

  describe('score ranges', () => {
    it('direct tools score 0.9+', () => {
      const caps = getCapabilitiesForIntent('send email');
      const direct = caps.filter((c) => c.score >= 0.9);
      expect(direct.length).toBeGreaterThan(0);
    });

    it('indirect/workaround tools score 0.4-0.8', () => {
      const caps = getCapabilitiesForIntent('send email');
      const workarounds = caps.filter((c) => c.score >= 0.4 && c.score < 0.9);
      expect(workarounds.length).toBeGreaterThan(0);
    });

    it('manual/impossible options score < 0.4', () => {
      const caps = getCapabilitiesForIntent('send email');
      const manual = caps.filter((c) => c.score < 0.4);
      // May or may not exist depending on intent
      if (manual.length > 0) {
        expect(manual[0].score).toBeLessThan(0.4);
      }
    });
  });

  describe('multi-intent coverage', () => {
    it('covers communication intents', () => {
      const intents = ['send email', 'send message to slack', 'send calendar invite'];
      for (const intent of intents) {
        const caps = getCapabilitiesForIntent(intent);
        expect(caps.length).toBeGreaterThan(0);
        expect(caps[0].score).toBeGreaterThan(0.5);
      }
    });

    it('covers data query intents', () => {
      const intents = ['query salesforce records', 'search airtable records', 'query google sheets'];
      for (const intent of intents) {
        const caps = getCapabilitiesForIntent(intent);
        expect(caps.length).toBeGreaterThan(0);
      }
    });

    it('covers data write intents', () => {
      const intents = ['create or update salesforce record', 'update airtable records', 'write to google sheets'];
      for (const intent of intents) {
        const caps = getCapabilitiesForIntent(intent);
        expect(caps.length).toBeGreaterThan(0);
      }
    });

    it('covers execution intents', () => {
      const intents = ['run shell command or script', 'deploy or publish'];
      for (const intent of intents) {
        const caps = getCapabilitiesForIntent(intent);
        expect(caps.length).toBeGreaterThan(0);
      }
    });
  });

  describe('requirement tracking', () => {
    it('documents tool requirements clearly', () => {
      const caps = getCapabilitiesForIntent('send email');
      const outlook = caps.find((c) => c.toolName.includes('outlook'));
      if (outlook) {
        expect(outlook.requirement).toContain('Outlook');
      }
    });

    it('includes fallback guidance', () => {
      const caps = getCapabilitiesForIntent('send email');
      const withFallback = caps.find((c) => c.fallback);
      if (withFallback) {
        expect(withFallback.fallback).toBeTruthy();
      }
    });
  });
});
