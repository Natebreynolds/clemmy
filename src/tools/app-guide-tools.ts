import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { appAbilitiesFromFacts, appGuideText, readAppAbilityFacts } from '../runtime/app-guide/abilities.js';
import { textResult } from './shared.js';

export const APP_GUIDE_TOOL_DESCRIPTION =
  'What is set up in Clementine now, what each part gives the owner, and every place in the app. Use when they ask '
  + 'how to set something up or where something is, or when a request needs something not set up. Link places as '
  + '[Open <name>](app:<id>), and one Space or workflow as (app:space:<id>) or (app:workflow:<name>). '
  + 'For a contextual interface walkthrough, use [Show me](app:guide:<id>) for a supported place listed in the guide.';

export function registerAppGuideTools(server: McpServer): void {
  server.tool(
    'app_guide',
    APP_GUIDE_TOOL_DESCRIPTION,
    {
      places: z.boolean().optional()
        .describe('Also list every place in the app (default true); false when only what is set up matters.'),
      // The field a caller reaches for first. The whole guide answers it; the
      // call is not refused for naming its purpose (live: every connect-app
      // run sent one and was sent back for it).
      topic: z.string().optional()
        .describe('What the owner is trying to set up or find; the whole guide is returned either way.'),
    },
    async ({ places }) => textResult(appGuideText(appAbilitiesFromFacts(await readAppAbilityFacts()), { places: places !== false })),
  );
}
