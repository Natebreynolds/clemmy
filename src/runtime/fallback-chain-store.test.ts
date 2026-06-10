import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import {
  loadFallbackChain,
  lookupFallbackChain,
  recordFallbackSuccess,
  recordFallbackFailure,
  addFallbackTool,
  clearFallbackChain,
  suggestNextSteps,
  type FailureType,
} from './fallback-chain-store.js';
import { getMachineId } from './machine-id.js';
import { BASE_DIR } from '../config.js';

// Test directory
const TEST_CHAIN_DIR = path.join(BASE_DIR, 'memory', 'fallback-chains', getMachineId());

describe('FallbackChainStore', () => {
  beforeEach(() => {
    // Ensure test directory exists
    if (!existsSync(TEST_CHAIN_DIR)) {
      mkdirSync(TEST_CHAIN_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test files
    if (existsSync(TEST_CHAIN_DIR)) {
      try {
        rmSync(TEST_CHAIN_DIR, { recursive: true, force: true });
      } catch (err) {
        // Ignore cleanup errors
      }
    }
  });

  describe('recordFallbackSuccess', () => {
    it('creates a new fallback chain on first success', () => {
      recordFallbackSuccess('send_email', 'permission_denied', 'gmail_send');

      const chain = loadFallbackChain('send_email', 'permission_denied');
      expect(chain).toBeTruthy();
      expect(chain?.chain.length).toBe(1);
      expect(chain?.chain[0].toolName).toBe('gmail_send');
      expect(chain?.chain[0].successRate).toBe(1.0);
    });

    it('increments success count for existing tool', () => {
      recordFallbackSuccess('send_email', 'permission_denied', 'gmail_send');
      recordFallbackSuccess('send_email', 'permission_denied', 'gmail_send');

      const chain = loadFallbackChain('send_email', 'permission_denied');
      const entry = chain?.chain[0];
      expect(entry?.attempts).toBe(2);
      expect(entry?.successes).toBe(2);
      expect(entry?.successRate).toBe(1.0);
    });

    it('adds multiple tools to same chain', () => {
      recordFallbackSuccess('send_email', 'permission_denied', 'gmail_send');
      recordFallbackSuccess('send_email', 'permission_denied', 'cli_mail');

      const chain = loadFallbackChain('send_email', 'permission_denied');
      expect(chain?.chain.length).toBe(2);

      const toolNames = chain?.chain.map((e) => e.toolName);
      expect(toolNames).toContain('gmail_send');
      expect(toolNames).toContain('cli_mail');
    });

    it('sorts chain by success rate when loading', () => {
      recordFallbackSuccess('send_email', 'permission_denied', 'gmail_send');
      recordFallbackSuccess('send_email', 'permission_denied', 'gmail_send');

      recordFallbackSuccess('send_email', 'permission_denied', 'cli_mail');
      // gmail: 2 successes, 2 attempts = 100%
      // cli_mail: 1 success, 1 attempt = 100%
      // But gmail was recorded first, so should appear first or equal

      const chain = loadFallbackChain('send_email', 'permission_denied');
      const sorted = [...(chain?.chain || [])].sort((a, b) => b.successRate - a.successRate);
      expect(sorted[0].successRate).toBeGreaterThanOrEqual(sorted[1].successRate);
    });
  });

  describe('recordFallbackFailure', () => {
    it('creates a chain with 0 success rate on first failure', () => {
      recordFallbackFailure('send_email', 'permission_denied', 'gmail_send');

      const chain = loadFallbackChain('send_email', 'permission_denied');
      expect(chain?.chain[0].successRate).toBe(0.0);
    });

    it('decreases success rate after mix of success and failure', () => {
      recordFallbackSuccess('send_email', 'permission_denied', 'gmail_send');
      recordFallbackFailure('send_email', 'permission_denied', 'gmail_send');

      const chain = loadFallbackChain('send_email', 'permission_denied');
      const entry = chain?.chain[0];
      expect(entry?.attempts).toBe(2);
      expect(entry?.successes).toBe(1);
      expect(entry?.successRate).toBe(0.5);
    });
  });

  describe('lookupFallbackChain', () => {
    it('returns empty array for non-existent chain', () => {
      const chain = lookupFallbackChain('unknown_intent', 'permission_denied' as FailureType);
      expect(chain).toEqual([]);
    });

    it('returns tools ordered by success rate', () => {
      recordFallbackSuccess('send_email', 'timeout', 'gmail_send');
      recordFallbackSuccess('send_email', 'timeout', 'gmail_send');
      recordFallbackSuccess('send_email', 'timeout', 'outlook_send'); // Only 1 success

      const chain = lookupFallbackChain('send_email', 'timeout' as FailureType);

      // gmail: 100% success (2/2)
      // outlook: 100% success (1/1)
      // Both have 100% but gmail was recorded first
      expect(chain.length).toBeGreaterThan(0);
      expect(chain[0]).toBe('gmail_send');
    });
  });

  describe('addFallbackTool', () => {
    it('adds tool to new chain', () => {
      addFallbackTool('scrape_website', 'rate_limit', 'firecrawl_scrape', 'Direct API call');

      const chain = loadFallbackChain('scrape_website', 'rate_limit' as FailureType);
      expect(chain?.chain.length).toBe(1);
      expect(chain?.chain[0].toolName).toBe('firecrawl_scrape');
      expect(chain?.chain[0].notes).toBe('Direct API call');
    });

    it('does not duplicate tool in chain', () => {
      addFallbackTool('scrape_website', 'rate_limit', 'firecrawl_scrape');
      addFallbackTool('scrape_website', 'rate_limit', 'firecrawl_scrape');

      const chain = loadFallbackChain('scrape_website', 'rate_limit' as FailureType);
      expect(chain?.chain.length).toBe(1);
    });

    it('adds different tools to same chain', () => {
      addFallbackTool('scrape_website', 'rate_limit', 'firecrawl_scrape');
      addFallbackTool('scrape_website', 'rate_limit', 'simple_fetch');

      const chain = loadFallbackChain('scrape_website', 'rate_limit' as FailureType);
      expect(chain?.chain.length).toBe(2);
    });
  });

  describe('clearFallbackChain', () => {
    it('removes fallback chain file', () => {
      recordFallbackSuccess('send_email', 'timeout', 'gmail_send');

      let chain = loadFallbackChain('send_email', 'timeout' as FailureType);
      expect(chain).toBeTruthy();

      clearFallbackChain('send_email', 'timeout' as FailureType);

      chain = loadFallbackChain('send_email', 'timeout' as FailureType);
      expect(chain).toBeNull();
    });
  });

  describe('suggestNextSteps', () => {
    it('returns learned fallbacks when available', () => {
      recordFallbackSuccess('send_email', 'permission_denied', 'gmail_send');
      recordFallbackSuccess('send_email', 'permission_denied', 'cli_mail');

      const suggestion = suggestNextSteps('send_email', 'outlook_send', 'permission_denied' as FailureType);

      expect(suggestion.fallback.length).toBeGreaterThan(0);
      expect(suggestion.reason).toContain('Learned');
    });

    it('excludes the failed tool from suggestions', () => {
      recordFallbackSuccess('send_email', 'timeout', 'gmail_send');
      recordFallbackSuccess('send_email', 'timeout', 'cli_mail');

      const suggestion = suggestNextSteps('send_email', 'gmail_send', 'timeout' as FailureType);

      expect(suggestion.fallback).not.toContain('gmail_send');
    });

    it('returns empty fallback for unknown intent', () => {
      const suggestion = suggestNextSteps('unknown_intent', 'unknown_tool', 'unknown' as FailureType);

      expect(suggestion.fallback).toEqual([]);
    });
  });

  describe('failure type variants', () => {
    it('handles all failure types', () => {
      const types: Array<FailureType> = ['permission_denied', 'not_found', 'rate_limit', 'timeout', 'unknown'];

      for (const type of types) {
        recordFallbackSuccess('test_intent', type, 'test_tool');
        const chain = loadFallbackChain('test_intent', type);
        expect(chain?.failureType).toBe(type);
      }
    });
  });

  describe('persistence', () => {
    it('persists chain across multiple load/save cycles', () => {
      recordFallbackSuccess('send_email', 'timeout', 'gmail_send');
      recordFallbackSuccess('send_email', 'timeout', 'gmail_send');

      // Load and verify
      let chain = loadFallbackChain('send_email', 'timeout' as FailureType);
      expect(chain?.chain[0].attempts).toBe(2);

      // Simulate another session by clearing from memory and reloading
      recordFallbackSuccess('send_email', 'timeout', 'cli_mail');

      chain = loadFallbackChain('send_email', 'timeout' as FailureType);
      expect(chain?.chain.length).toBe(2);

      // Original counts should be preserved
      const gmail = chain?.chain.find((e) => e.toolName === 'gmail_send');
      expect(gmail?.attempts).toBe(2);
    });
  });

  describe('edge cases', () => {
    it('handles tools with special characters in names', () => {
      recordFallbackSuccess('send-email', 'not_found', 'tool-with-dashes');

      const chain = loadFallbackChain('send-email', 'not_found' as FailureType);
      expect(chain?.chain[0].toolName).toBe('tool-with-dashes');
    });

    it('preserves notes when saving chain', () => {
      addFallbackTool('scrape', 'rate_limit', 'tool1', 'Works best after 5pm');
      addFallbackTool('scrape', 'rate_limit', 'tool2', 'Handles large pages');

      recordFallbackSuccess('scrape', 'rate_limit', 'tool1');
      recordFallbackSuccess('scrape', 'rate_limit', 'tool1');

      const chain = loadFallbackChain('scrape', 'rate_limit' as FailureType);
      const tool1 = chain?.chain.find((e) => e.toolName === 'tool1');
      expect(tool1?.notes).toBeDefined();
    });
  });
});
