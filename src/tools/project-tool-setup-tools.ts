import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { readSourceSessionContext } from '../runtime/harness/source-session-context.js';
import { currentSourceSessionContext } from '../runtime/harness/source-session-context-scope.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { getPendingAction, verifyPendingActionResumeExecutionCapability } from '../runtime/harness/pending-actions.js';
import { canonicalRuntimeEffectiveToolName, unwrapRuntimeEffectiveToolIdentity } from '../runtime/harness/tool-effect.js';
import { connectProjectTool, inspectProjectTools } from '../projects/project-tool-setup.js';
import { textResult } from './shared.js';

/** Setup belongs to the owner's selected project conversation. Project files
 * neither grant authority nor turn an unattended worker into an administrator. */
type ConnectInput = { resource_id: string; server_name: string; preview_token: string };
function selectedProject(connectInput?: ConnectInput) {
  const context = getToolOutputContext();
  if (!context?.sessionId || !Number.isSafeInteger(context.sourceUserSeq) || Number(context.sourceUserSeq) <= 0) return null;
  try {
    const identity = { sessionId: context.sessionId, sourceUserSeq: Number(context.sourceUserSeq) };
    const run = harnessRunContextStorage.getStore();
    const capability = run?.pendingActionExecution;
    let approvedOriginal = false;
    if (capability) {
      // A normal approval executes the frozen call under its decision source.
      // Only the winning, exact stored action may recover its original project;
      // a bare control event or today's chat selection supplies no authority.
      if (!connectInput || run?.sessionId !== identity.sessionId || run.sourceUserSeq !== identity.sourceUserSeq
        || capability.sourceUserSeq !== identity.sourceUserSeq) return null;
      const action = getPendingAction(capability.pendingActionId);
      if (!action || !verifyPendingActionResumeExecutionCapability({ capability, sessionId: identity.sessionId,
        toolName: action.toolName, payload: action.payload })) return null;
      const effective = unwrapRuntimeEffectiveToolIdentity(action.toolName, action.payload);
      const args = effective.args;
      if (canonicalRuntimeEffectiveToolName(effective.toolName) !== 'project_tools_connect'
        || !args || typeof args !== 'object' || Array.isArray(args)
        || Object.keys(args).length !== 3
        || !Object.entries(connectInput).every(([key, value]) => (args as Record<string, unknown>)[key] === value)
        || !Number.isSafeInteger(action.sourceUserSeq) || Number(action.sourceUserSeq) <= 0) return null;
      identity.sourceUserSeq = Number(action.sourceUserSeq);
      approvedOriginal = true;
    }
    const accepted = approvedOriginal ? readSourceSessionContext(identity)
      : currentSourceSessionContext(identity.sessionId) ?? readSourceSessionContext(identity);
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
      const selected = selectedProject({ resource_id, server_name, preview_token });
      return selected ? result(await connectProjectTool(selected.owner, selected.projectId, resource_id, server_name, preview_token)) : missing();
    });
}
