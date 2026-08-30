/** Storage- and transport-neutral contract for the reviewed artifact bundle. */
import { z } from 'zod';

import { ARTIFACT_BUNDLE_LIMITS, saveArtifactBundle } from './artifact-bundle-core.js';

export const artifactBundleFileShape = z.object({
  path: z.string().min(1).max(ARTIFACT_BUNDLE_LIMITS.maxPathBytes)
    .describe('Safe relative POSIX path inside the bundle, for example "public/index.html". Absolute paths, backslashes, dot segments, and duplicates are refused.'),
  content: z.string()
    .describe(`Exact UTF-8 file content (maximum ${ARTIFACT_BUNDLE_LIMITS.maxFileBytes} bytes per file).`),
}).strict();

export const ARTIFACT_BUNDLE_TOOL_PARAMETERS = {
  bundle_id: z.string().min(1).max(80)
    .describe('Stable lowercase artifact id, for example "sales-portal". The revision digest is derived from every file path and byte sequence.'),
  mode: z.literal('content_addressed')
    .describe('Required safety mode. Revisions are immutable and never overwrite a prior revision.'),
  files: z.array(artifactBundleFileShape).min(1).max(ARTIFACT_BUNDLE_LIMITS.maxFiles),
} satisfies z.ZodRawShape;

export function executeArtifactBundleSave(args: {
  bundle_id: string;
  mode: 'content_addressed';
  files: Array<{ path: string; content: string }>;
}) {
  return saveArtifactBundle({
    bundleId: args.bundle_id,
    files: args.files,
  });
}
