import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { appAbilitiesFromFacts, appGuideText, readAppAbilityFacts } from '../runtime/app-guide/abilities.js';
import { textResult } from './shared.js';

export const APP_GUIDE_TOOL_DESCRIPTION =
  'What is set up in Clementine now, what each part gives the owner, and every place in the app. Use when they ask '
  + 'how to set something up or where something is, or when a request needs something not set up. Link places as '
  + '[Open <name>](app:<id>).';

export function registerAppGuideTools(server: McpServer): void {
  server.tool(
    'app_guide',
    APP_GUIDE_TOOL_DESCRIPTION,
    {
      places: z.boolean().optional()
        .describe('Also list every place in the app (default true); false when only what is set up matters.'),
    },
    async ({ places }) => textResult(appGuideText(appAbilitiesFromFacts(await readAppAbilityFacts()), { places: places !== false })),
  );
}
