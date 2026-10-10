import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readImageForViewing } from '../runtime/attachments.js';

/** One image capability for MCP and the in-process host, sharing the same
 * attachment-only path guard and structured pixels (never base64 prose). */
export function registerAttachmentTools(server: McpServer): void {
  server.tool('view_image',
    'Look at an image directly (the actual pixels, not a description): a chat attachment by the stored path its attachment block gives, or, when the owner turned on Full computer access, an image file anywhere in their folders (png, jpg, gif, webp).',
    { path: z.string().min(1).describe('The stored attachment path (state/attachments-files/…), or the full path of an image file on this computer.') },
    async (input: { path: string }) => {
      const image = readImageForViewing(input.path);
      if (!image.ok) return { isError: true, content: [{ type: 'text' as const, text: `Could not view image: ${image.error}` }] };
      return { content: [
        { type: 'image' as const, data: image.base64, mimeType: image.mimeType },
        { type: 'text' as const, text: `Image ${image.name} (${image.mimeType}, ${(image.bytes / 1024).toFixed(0)}KB) shown above.` },
      ] };
    });
}
