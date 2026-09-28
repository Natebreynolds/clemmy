import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readImageForViewing } from '../runtime/attachments.js';

/** One image capability for MCP and the in-process host, sharing the same
 * attachment-only path guard and structured pixels (never base64 prose). */
export function registerAttachmentTools(server: McpServer): void {
  server.tool('view_image',
    'Look at an attached image directly (the actual pixels, not a description). Pass the stored path given in the attachment block.',
    { path: z.string().min(1).describe('The stored image path from the attachment block (state/attachments-files/…).') },
    async (input: { path: string }) => {
      const image = readImageForViewing(input.path);
      if (!image.ok) return { isError: true, content: [{ type: 'text' as const, text: `Could not view image: ${image.error}` }] };
      return { content: [
        { type: 'image' as const, data: image.base64, mimeType: image.mimeType },
        { type: 'text' as const, text: `Image ${image.name} (${image.mimeType}, ${(image.bytes / 1024).toFixed(0)}KB) shown above.` },
      ] };
    });
}
