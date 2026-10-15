import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { readSourceSessionContext } from '../runtime/harness/source-session-context.js';
import { currentSourceSessionContext } from '../runtime/harness/source-session-context-scope.js';
import { connectProjectTool, inspectProjectTools } from '../projects/project-tool-setup.js';
import { textResult } from './shared.js';

/** Setup belongs to the owner's selected project conversation. Project files
 * neither grant authority nor turn an unattended worker into an administrator. */
function selectedProject() {
  const context = getToolOutputContext();
  if (!context?.sessionId || !Number.isSafeInteger(context.sourceUserSeq) || Number(context.sourceUserSeq) <= 0) return null;
  try {
    const identity = { sessionId: context.sessionId, sourceUserSeq: Number(context.sourceUserSeq) };
    const accepted = currentSourceSessionContext(identity.sessionId) ?? readSourceSessionContext(identity);
    if (!accepted || accepted.sourceUserSeq !== identity.sourceUserSeq || accepted.mount.kind !== 'chat'
      || !accepted.mount.project) return null;
    return { owner: { ...identity, digest: accepted.digest }, projectId: accepted.mount.project.project.id };
  } catch { return null; }
}
const result = (value: unknown) => textResult(JSON.stringify(value), { maxChars: 18_000 });
const missing = () => result({ ok: false, code: 'select_project',
  detail: 'Open a conversation in the project whose tools you want to prepare. No setup was changed.' });

export function registerProjectToolSetupTools(server: McpServer): void {
  server.tool('project_tools_inspect',
    'Inspect the selected project’s linked .mcp.json tool requirements on this computer. Returns redacted setup previews, exact folder resource IDs and opaque preview tokens; never raw configuration or private values. Starts no server, installation or login. Use before project_tools_connect. A declaration or same-name connection is not proof of the right account.',
    { resource_id: z.string().optional().describe('The linked folder resource ID from project_get. Omit only when the selected project has one linked folder.') },
    async ({ resource_id }) => {
      const selected = selectedProject();
      return selected ? result(inspectProjectTools(selected.owner, selected.projectId, resource_id)) : missing();
    });
  server.tool('project_tools_connect',
    'Set up one exact server from the selected project’s inspected .mcp.json. ADMIN approval required. Use its resource_id, server_name and fresh preview_token from project_tools_inspect. Rechecks the exact linked file, resolves this computer’s paths and creates a new configuration without overwriting existing connections. Private env/header values are not copied; the user enters needed values in Connect. Verifies the named handshake and inventory when possible. Runs no business tool. A repeated identical receipt does not write again.',
    { resource_id: z.string(), server_name: z.string(), preview_token: z.string() },
    async ({ resource_id, server_name, preview_token }) => {
      const selected = selectedProject();
      return selected ? result(await connectProjectTool(selected.owner, selected.projectId, resource_id, server_name, preview_token)) : missing();
    });
}
