import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { resolveInSpace, type SpaceRecord } from './store.js';

export const SPACE_ACTION_PRESS_FIELD = '__workspaceButtonPressV1';
export const SPACE_ACTION_PRESS_TTL_MS = 15_000;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const spaceActionPressInputSchema = z.object({
  documentId: z.string().min(1).max(180),
  expectedViewRevision: digestSchema,
  actionId: z.string().min(1).max(200),
  args: z.record(z.string(), z.unknown()),
}).strict();
const bindingSchema = z.object({
  version: z.literal(1),
  documentId: z.string().min(1).max(180),
  viewRevision: digestSchema,
  tokenDigest: digestSchema,
  intentDigest: digestSchema,
}).strict();
export type SpaceActionPressBinding = z.infer<typeof bindingSchema>;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
export const spaceActionPressDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

/** The trusted wrapper and daemon use the saved document, never authored
 * claims about which page/action definition the owner was looking at. */
export function workspacePressViewRevision(rec: SpaceRecord, exactServedHtml?: string): string {
  return spaceActionPressDigest({ version: 1, workspaceId: rec.id, workspaceVersion: rec.version,
    status: rec.status, viewEntry: rec.viewEntry, actions: rec.actions,
    view: exactServedHtml ?? readFileSync(resolveInSpace(rec.id, rec.viewEntry), 'utf8') });
}

export function newSpaceActionPressBinding(documentId: string, viewRevision: string, intentDigest: string) {
  const secret = randomBytes(32).toString('hex');
  return { secret, binding: bindingSchema.parse({ version: 1, documentId, viewRevision, intentDigest,
    tokenDigest: createHash('sha256').update(secret).digest('hex') }) };
}
export function readSpaceActionPressBinding(args: Record<string, unknown> | null | undefined): SpaceActionPressBinding | null {
  const parsed = bindingSchema.safeParse(args?.[SPACE_ACTION_PRESS_FIELD]);
  return parsed.success ? parsed.data : null;
}
export function parseSpaceActionPressToken(token: unknown): { approvalId: string; secret: string } | null {
  if (typeof token !== 'string') return null;
  const match = /^(apr-[A-Za-z0-9-]{1,80})\.([a-f0-9]{64})$/.exec(token);
  return match ? { approvalId: match[1]!, secret: match[2]! } : null;
}
export function spaceActionPressSecretMatches(binding: SpaceActionPressBinding, secret: string): boolean {
  const observed = createHash('sha256').update(secret).digest();
  return timingSafeEqual(Buffer.from(binding.tokenDigest, 'hex'), observed);
}
