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
    .describe('Dot-paths whose value must be NON-EMPTY (a non-blank string, an array with ≥1 item, or an object with ≥1 key); "" / "." means the whole output. Declare on a data-producing step so a zero-row / blocked-but-shaped result ({prospects: []}) HALTS and reports back instead of feeding empty data downstream.'),
  min_items: z.record(z.string(), z.number().int().nonnegative()).optional()
    .describe('Map of dot-path → minimum array length (e.g. {"prospects": 1}). Stricter form of non_empty for "this source must yield at least N rows".'),
  verify: z.object({
    path_exists: z.array(z.string()).optional()
      .describe('File existence checks: use an absolute filename when known, an output dot-path such as artifact.path, or an empty string / dot for a path-valued root output. Every target must exist on disk.'),
    url_present: z.array(z.string()).optional()
      .describe('Dot-paths in the output whose value must be a non-empty http(s) URL.'),
  }).optional()
    .describe('Concrete-handle checks — confirm the named output values are REAL (a file that exists, a non-empty URL), so "produced a brief" cannot pass when the file/URL does not actually exist.'),
  description: z.string().optional().describe('One-line note on what this step produces.'),
});

