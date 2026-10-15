import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isSensitivePath } from '../runtime/security.js';
import { absentReadTargetText, resolveAllowedPath } from './computer-tools.js';

const PAGE_EXTENSIONS = new Set(['.html', '.htm']);

function refusal(text: string) {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

/** Look at a local page the way read_file reads one: the same allowed roots,
 * the same refusal of credential files, and nothing on disk is changed. */
export function registerPagePreviewTools(server: McpServer): void {
  server.tool(
    'page_preview',
    [
      'SEE a local HTML page: render the file as a browser opening it shows it and return the image. Look at a page after writing or changing it, at a desktop width and at a phone width, and fix what you see (broken layout, overlapping or clipped text, unstyled blocks, empty sections, content running off the side) before telling the user it is done.',
      'Read-only: the file is not changed and nothing is submitted. width and height set the browser window in CSS pixels (default 1440 × 1100; 390 shows a phone-width layout). A long page is checked in parts: offset_y starts the screenshot that many pixels down the page.',
    ].join('\n'),
    {
      path: z.string().min(1).describe('The HTML file to look at, inside an allowed workspace path.'),
      width: z.number().int().min(360).max(4000).nullish().describe('Window width in CSS pixels (default 1440; 390 shows a phone-width layout; larger than 2000 is rendered at 2000).'),
      height: z.number().int().min(480).max(4000).nullish().describe('Window height in CSS pixels (default 1100; larger than 2000 is rendered at 2000).'),
      offset_y: z.number().int().min(0).max(20000).nullish().describe('Start the screenshot this many CSS pixels down the page, to check a lower part of a long page (default 0).'),
    },
    async ({ path: requested, width, height, offset_y }) => {
      // A web address is not a path: resolving it as one looked for a file
      // named after the URL and reported that nothing was there.
      let local = requested;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(requested.trim())) {
        if (!/^file:\/\//i.test(requested.trim())) {
          return refusal(`Not a local file: ${requested.trim()} is a web address. page_preview renders HTML files on this computer; read a web page with a web read or the browser. Nothing was read.`);
        }
        try { local = fileURLToPath(requested.trim()); }
        catch { return refusal(`Not a readable file address: ${requested.trim()}. Nothing was read.`); }
      }
      let file: string;
      try { file = resolveAllowedPath(local); }
      catch (error) { return refusal(error instanceof Error ? error.message : String(error)); }
      if (isSensitivePath(file)) return refusal('Refused: that file holds credential material. Nothing was read.');
      // No page at the path is what the look found, not a failed look: the
      // same completed-read rule as read_file, with nothing to render.
      if (!existsSync(file) || !statSync(file).isFile()) {
        return { content: [{ type: 'text' as const, text: absentReadTargetText(file, 'file') }] };
      }
      if (!PAGE_EXTENSIONS.has(path.extname(file).toLowerCase())) {
        return refusal(`Not an HTML page: ${file}. page_preview renders .html and .htm files; read_file reads any other file.`);
      }
      const { renderLocalPagePreview } = await import('../spaces/space-preview.js');
      const rendered = await renderLocalPagePreview({
        file,
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        ...(offset_y ? { offsetY: offset_y } : {}),
      });
      if (!rendered.ok) return refusal(`Preview unavailable: ${rendered.reason}. Read the page source with read_file instead.`);
      return {
        content: [
          { type: 'image' as const, data: rendered.png.toString('base64'), mimeType: 'image/png' },
          { type: 'text' as const, text: `Preview of ${file}, ${rendered.width}×${rendered.height}${rendered.offsetY ? `, starting ${rendered.offsetY}px down the page` : ''}. This is what a browser opening the file shows.` },
        ],
      };
    },
  );
}
