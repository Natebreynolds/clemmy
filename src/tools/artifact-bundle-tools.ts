import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ARTIFACT_BUNDLE_LIMITS } from './artifact-bundle-core.js';
import { textResult } from './shared.js';
import {
  ARTIFACT_BUNDLE_TOOL_PARAMETERS,
  executeArtifactBundleSave,
} from './artifact-bundle-contract.js';

export {
  ARTIFACT_BUNDLE_TOOL_PARAMETERS,
  artifactBundleFileShape,
  executeArtifactBundleSave,
} from './artifact-bundle-contract.js';

export function registerArtifactBundleTools(server: McpServer): void {
  server.tool(
    'artifact_bundle_save',
    [
      'Atomically commit a bounded multi-file local artifact (website, static app, report bundle, or deploy directory) as one immutable content-addressed revision.',
      `Accepts 1-${ARTIFACT_BUNDLE_LIMITS.maxFiles} files, at most ${ARTIFACT_BUNDLE_LIMITS.maxFileBytes} UTF-8 bytes each and ${ARTIFACT_BUNDLE_LIMITS.maxTotalBytes} bytes total.`,
      'Exact replay returns the existing verified directory. A path collision, tampered revision, traversal attempt, or oversize bundle refuses without overwriting anything.',
      'Use the returned directory as the exact input to a later governed upload/deploy call.',
    ].join(' '),
    ARTIFACT_BUNDLE_TOOL_PARAMETERS,
    async (args) => {
      const result = executeArtifactBundleSave(args);
      return textResult(JSON.stringify(result), { maxChars: 20_000 });
    },
  );
}
