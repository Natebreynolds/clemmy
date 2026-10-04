import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { appAbilitiesFromFacts, appGuideText, readAppAbilityFacts } from '../runtime/app-guide/abilities.js';
import { textResult } from './shared.js';

export const APP_GUIDE_TOOL_DESCRIPTION =
  'What is set up in Clementine right now (models, a second model provider, Jev, meeting recording, connected apps, '
  + 'MCP servers, the phone app, phone notifications, calendar watch), what each part gives the owner, and every place '
  + 'in the app with its id. Use it when the owner asks how to set something up or where something is, or when what '
  + 'they asked needs something that is not set up. Answer from it and link places as [Open <name>](app:<id>).';

export function registerAppGuideTools(server: McpServer): void {
  server.tool(
    'app_guide',
    APP_GUIDE_TOOL_DESCRIPTION,
    {},
    async () => textResult(appGuideText(appAbilitiesFromFacts(await readAppAbilityFacts()))),
  );
}
