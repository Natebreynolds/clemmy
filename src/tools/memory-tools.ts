import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatSearchHits, searchVault } from '../memory/search.js';
import { WORKING_MEMORY_FILE } from '../memory/vault.js';
import { readText, replaceFile, resolveMemoryTarget, textResult } from './shared.js';

export function registerMemoryTools(server: McpServer): void {
  server.tool(
    'memory_search',
    'Search the local Clementine vault for relevant notes and memories.',
    { query: z.string().min(1) },
    async ({ query }) => {
      const hits = searchVault(query, 8);
      const text = hits.length > 0 ? formatSearchHits(hits, 3000) : 'No relevant memory hits found.';
      return textResult(text);
    },
  );

  server.tool(
    'memory_read',
    'Read a key memory file or a vault-relative markdown path.',
    { target: z.string().min(1) },
    async ({ target }) => {
      const resolved = resolveMemoryTarget(target);
      return textResult(readText(resolved, `Not found: ${target}`));
    },
  );

  server.tool(
    'working_memory',
    'Read, append, replace, or clear the working-memory scratchpad.',
    {
      action: z.enum(['read', 'append', 'replace', 'clear']),
      content: z.string().optional(),
    },
    async ({ action, content }) => {
      if (action === 'read') {
        const text = existsSync(WORKING_MEMORY_FILE)
          ? readFileSync(WORKING_MEMORY_FILE, 'utf-8')
          : 'Working memory is empty.';
        return textResult(text);
      }

      if (action === 'clear') {
        if (existsSync(WORKING_MEMORY_FILE)) {
          unlinkSync(WORKING_MEMORY_FILE);
        }
        return textResult('Working memory cleared.');
      }

      if (!content) {
        return textResult(`Missing content for ${action} action.`);
      }

      if (action === 'append') {
        const existing = existsSync(WORKING_MEMORY_FILE) ? readFileSync(WORKING_MEMORY_FILE, 'utf-8').trimEnd() : '';
        const next = existing ? `${existing}\n${content.trim()}` : content.trim();
        replaceFile(WORKING_MEMORY_FILE, next);
        return textResult('Working memory updated.');
      }

      writeFileSync(WORKING_MEMORY_FILE, `${content.trim()}\n`, 'utf-8');
      return textResult('Working memory replaced.');
    },
  );
}
