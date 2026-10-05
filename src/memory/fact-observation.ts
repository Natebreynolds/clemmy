/** Pure, complete fact observations. A digest is a state revision, never authority. */
import { createHash } from 'node:crypto';
import { z } from 'zod';

const nullableText = z.string().nullable();
const positive = z.number().int().positive().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const factObservationBodySchema = z.object({
  version: z.literal(1),
  id: positive,
  kind: z.enum(['user', 'project', 'feedback', 'reference', 'constraint']),
  content: z.string().min(1),
  scope: z.object({ projectId: z.string().min(1).nullable(), agentKey: z.string().min(1).nullable() }).strict(),
  active: z.boolean(), pinned: z.boolean(), createdAt: z.string().min(1),
  validFrom: nullableText, validTo: nullableText, supersededByFactId: positive.nullable(),
  provenance: z.object({
    sourceSessionId: nullableText, sourcePath: nullableText, sourceApp: nullableText,
    derivedFromSessionId: nullableText, derivedFromCallId: nullableText, derivedFromTool: nullableText,
    derivedFromFactIds: z.array(positive).nullable(), derivationDepth: z.number().int().nonnegative(),
    trustLevel: z.number().min(0).max(1).nullable(), confidence: z.number().min(0).max(1).nullable(),
    extractedAt: nullableText,
  }).strict(),
}).strict();
export const factObservationSchema = factObservationBodySchema.extend({ digest }).strict();
export type FactObservationBody = z.infer<typeof factObservationBodySchema>;
export type FactObservationV1 = z.infer<typeof factObservationSchema>;

export function factObservationDigest(value: FactObservationBody): string {
  // Parsing establishes deterministic field ordering and rejects partial/extra fields.
  return createHash('sha256').update(JSON.stringify(factObservationBodySchema.parse(value))).digest('hex');
}
export function createFactObservation(value: FactObservationBody): FactObservationV1 {
  const body = factObservationBodySchema.parse(value);
  return { ...body, digest: factObservationDigest(body) };
}
export function parseFactObservation(value: unknown): FactObservationV1 {
  const parsed = factObservationSchema.parse(value);
  const { digest: expected, ...body } = parsed;
  if (factObservationDigest(body) !== expected) throw new Error('Fact observation digest mismatch.');
  return parsed;
}

export const factCorrectionPatchesSchema = z.array(z.object({ before: z.string().min(1), after: z.string() }).strict()).min(1).max(8);
export type FactCorrectionPatch = z.infer<typeof factCorrectionPatchesSchema>[number];
export interface AppliedFactCorrection {
  content: string;
  ranges: Array<FactCorrectionPatch & { start: number; end: number }>;
}
function splitSurrogate(text: string, at: number): boolean {
  if (at <= 0 || at >= text.length) return false;
  return /[\uD800-\uDBFF]/.test(text[at - 1]!) && /[\uDC00-\uDFFF]/.test(text[at]!);
}
/** Every match is located in the original, complete observation, never sequentially. */
export function applyExactFactPatches(content: string, edits: readonly FactCorrectionPatch[]): AppliedFactCorrection {
  const patches = factCorrectionPatchesSchema.parse(edits);
  const ranges = patches.map(patch => {
    const start = content.indexOf(patch.before);
    if (start < 0 || content.indexOf(patch.before, start + 1) >= 0) throw new Error('Correction text must match exactly once.');
    const end = start + patch.before.length;
    if (splitSurrogate(content, start) || splitSurrogate(content, end)) throw new Error('Correction splits a Unicode character.');
    // Reject isolated surrogates in the new content instead of silently replacing bytes.
    if (/[\uD800-\uDFFF]/u.test(patch.after)) throw new Error('Correction replacement is not valid Unicode.');
    return { ...patch, start, end };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i += 1) {
    if (ranges[i]!.start < ranges[i - 1]!.end) throw new Error('Correction ranges overlap.');
  }
  let next = content;
  for (const range of [...ranges].reverse()) next = next.slice(0, range.start) + range.after + next.slice(range.end);
  if (!next.trim()) throw new Error('Correction cannot erase the complete fact.');
  return { content: next, ranges };
}
