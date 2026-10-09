import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { boundedHttpRead } from './bounded-http-read.js';
import { textResult } from './shared.js';

export function registerHttpReadTools(server: McpServer): void {
  server.tool('http_read',
    'Read a public HTTP(S) URL with one bounded GET. Returns status, final URL, content type, exact body bytes digest, and text body. Useful for documentation, pricing and public JSON schemas in Plan or Act mode. An image URL (png, jpeg, gif, webp; for example a thumbnail or export link a connected app returned) comes back as the image itself, so you can look at it. No shell/browser scripts, credentials, cookies or writes. Limit: 1 MiB of text or 3.75 MB of image, 20 seconds, five redirects. Large results are retained; query them with file_query or tool_output_query.',
    { url: z.string().url().describe('Public HTTP(S) URL, without embedded credentials.') },
    async ({ url }) => {
      try {
        const result = await boundedHttpRead(url);
        if (result.image) {
          const { image, ...evidence } = result;
          return { content: [
            { type: 'image' as const, data: image.data, mimeType: image.mimeType },
            { type: 'text' as const, text: JSON.stringify({ ...evidence, shown: 'The image is shown above.' }) },
          ] };
        }
        return textResult(JSON.stringify(result), { isError: !result.ok });
      } catch (error) {
        return textResult(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }), { isError: true });
      }
    });
}
