/** Storage-free contract for one saved source script, never arbitrary argv. */
import { z } from 'zod';

export const WORKSPACE_SCRIPT_OPERATION = 'workspace_source_script';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const WORKSPACE_SCRIPT_PARAMETERS = {
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/),
  source_id: z.string().min(1).max(256),
  source_digest: digest,
  script_sha256: digest,
  occurrence_id: z.string().min(1).max(128),
  cause: z.enum(['manual', 'scheduled']),
};
export const workspaceScriptArguments = z.strictObject(WORKSPACE_SCRIPT_PARAMETERS);
export type WorkspaceScriptArguments = z.infer<typeof workspaceScriptArguments>;
