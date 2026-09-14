import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HOME_LAYOUT_CHANGE_PARAMETERS, HomeLayoutError, loadHomeLayout, updateHomeLayout } from '../runtime/home-layout.js';
import { spaceStore } from '../spaces/store.js';
import { invalidArgumentsTextResult, textResult } from './shared.js';

export function registerHomeTools(server: McpServer): void {
  server.tool('home_get',
    'Read the owner’s current Home tile layout and revision. Tiles reference Spaces; use space_get to inspect their data and freshness. Home reads never refresh sources or run workflows.',
    {}, async () => textResult(JSON.stringify(loadHomeLayout())));
  server.tool('home_update',
    'Add a Space to Home, resize/move its tile, or remove the tile. This changes only Home placement; it never deletes the Space or runs its actions. Read home_get first. For a new custom tile, create a responsive Space through space_save, then pin its exact slug here. Reuse the same Space for subsequent content/data edits. A user-authorized Home edit is a normal reversible local write; Plan mode can inspect and prepare it. Return to home_get to verify. Defaults: width=medium, zone=watching, position=keep. On a layout conflict, use the returned current revision and preserve unrelated owner changes.',
    HOME_LAYOUT_CHANGE_PARAMETERS, async input => {
      try {
        return textResult(updateHomeLayout(input, { spaceExists: id => Boolean(spaceStore.get(id)) }).receipt);
      } catch (error) {
        if (error instanceof HomeLayoutError) return invalidArgumentsTextResult(JSON.stringify({ ok: false, code: error.code, message: error.message, current: error.current }));
        throw error;
      }
    });
}
