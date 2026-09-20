import { z } from 'zod';

/** Shared registered schema for foreground and structured workflow reads. */
export const READ_FILE_PARAMS = {
  path: z.string().min(1),
  max_chars: z.number().int().min(1).nullable(),
};
