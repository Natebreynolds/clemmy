import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { boundedHttpRead } from './bounded-http-read.js';
import { textResult } from './shared.js';

export function registerHttpReadTools(server: McpServer): void {
  server.tool('http_read',
    'Read a public HTTP(S) URL with one bounded GET. Returns status, final URL, content type, exact body bytes digest, and text body. Useful for documentation, pricing and public JSON schemas in Plan or Act mode. No shell/browser scripts, credentials, cookies or writes. Limit: 1 MiB, 20 seconds, five redirects. Large results are retained; query them with file_query or tool_output_query.',
    { url: z.string().url().describe('Public HTTP(S) URL, without embedded credentials.') },
    async ({ url }) => {
      try {
        const result = await boundedHttpRead(url);
        return textResult(JSON.stringify(result), { isError: !result.ok });
      } catch (error) {
        return textResult(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }), { isError: true });
      }
    });
}
