import { z } from 'zod';

/**
 * Step OUTPUT contract (WorkflowStepOutputContract). Shared by workflow_create
 * + workflow_update so authors can DECLARE what a step produces. Optional, by
 * design: a step with no `output` is unverified — byte-identical to before
 * (the gradual-typing / Dagster-asset-check posture). When declared, the engine
 * verifies the step's output against it before recording completion
 * (verifyStepOutput, runtime-enforced). Named properties (not an open map), so
 * it fills reliably under strict-mode function-calling.
 */
export const WorkflowStepOutputContractSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'object', 'array']).optional()
    .describe('The shape the step must produce.'),
  required_keys: z.array(z.string()).optional()
    .describe('For an object output: top-level keys that must be present and non-null.'),
  non_empty: z.array(z.string()).optional()
    .describe('Dot-paths requiring non-blank strings or non-empty arrays/objects; ""/"." means root. Empty results halt before downstream use.'),
  min_items: z.record(z.string(), z.number().int().nonnegative()).optional()
    .describe('Dot-path → minimum array length, e.g. {"prospects":1}.'),
  verify: z.object({
    path_exists: z.array(z.string()).optional()
      .describe('Existing file targets: absolute filename, output dot-path (artifact.path), or ""/"." for path-valued root.'),
    url_present: z.array(z.string()).optional()
      .describe('Output dot-paths requiring non-empty http(s) URLs.'),
  }).optional()
    .describe('Check file existence and URL shape.'),
  description: z.string().optional().describe('One-line note on what this step produces.'),
});

