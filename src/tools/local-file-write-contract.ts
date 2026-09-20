/** Shared file-write schema; no runtime storage or tool registration imports. */
import { z } from 'zod';

export const WRITE_FILE_PARAMS = {
  path: z.string().min(1),
  content: z.string(),
  mode: z.enum(['create', 'append', 'overwrite']).nullable(),
  // Chunked-by-construction: append:true appends (creating if absent) — the
  // continuation call for a large file. append:false starts the file fresh
  // (overwrite). Omitted/null → fall back to `mode` (backward compatible — a
  // caller that never sends `append` behaves exactly as before, so it is OPTIONAL,
  // unlike the always-present `mode`).
  append: z.boolean().nullable().optional(),
} satisfies z.ZodRawShape;
