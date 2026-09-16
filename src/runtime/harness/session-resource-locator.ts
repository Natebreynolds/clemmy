/**
 * Locate a resource before a mutating provider call.
 *
 * Live 2026-09-15: "edit this event" reused the create's Graph id but sent
 * calendar_id: "" which built /me/calendars/events/{id} ("Resource not found
 * for the segment 'AAMk…'"). Same-session create already had the event on
 * the default calendar. Empty identity is not a location.
 *
 * Memory nominates identity; it does not authorize the write.
 */
const IDENTITY_KEY_RE = /(?:^|_)(id|ids)$/i;
const NEVER_IDENTITY = new Set([
  'connected_account_id',
  'user_id',
  'account_id',
  'tenant_id',
  'subscription_id',
  'request_id',
  'client_id',
]);

export function isResourceIdentityKey(key: string): boolean {
  const normalized = key.trim();
  if (!normalized || NEVER_IDENTITY.has(normalized.toLowerCase())) return false;
  return IDENTITY_KEY_RE.test(normalized);
}

function isBlankIdentityValue(value: unknown): boolean {
  return value == null || value === '' || (typeof value === 'string' && value.trim() === '');
}

export function omitBlankIdentityFields(args: Record<string, unknown>): {
  args: Record<string, unknown>;
  omitted: string[];
} {
  const omitted: string[] = [];
  const next: Record<string, unknown> = {};
  // A zero-argument call arrives as null/undefined on the Composio wire; there
  // is nothing to omit and nothing to locate. Full-suite 2026-09-15: every
  // argument-less read died here with "Cannot convert undefined or null to
  // object" before dispatch.
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { args: next, omitted };
  for (const [key, value] of Object.entries(args)) {
    if (isResourceIdentityKey(key) && isBlankIdentityValue(value)) {
      omitted.push(key);
      continue;
    }
    next[key] = value;
  }
  return { args: next, omitted };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Graph-style `data.id` plus explicit *_id fields from a settled write body. */
export function resourceIdsFromProviderResult(result: unknown): Record<string, string> {
  let body: unknown = result;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return {}; }
  }
  const root = asRecord(body);
  const data = asRecord(root?.data) ?? root;
  if (!data) return {};
  const located: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    if (key === 'id' || isResourceIdentityKey(key)) located[key] = value.trim();
  }
  return located;
}

function toolkitOfSlug(slug: string): string {
  return slug.trim().toUpperCase().split('_')[0] ?? '';
}

function slugLooksLikeCreate(slug: string): boolean {
  return /_(CREATE|INSERT|ADD)_|(?:_CREATE|_INSERT|_ADD)$/.test(slug.toUpperCase());
}

function slugLooksLikeUpdate(slug: string): boolean {
  return /_(UPDATE|EDIT|PATCH|MODIFY)_|(?:_UPDATE|_EDIT|_PATCH|_MODIFY)$/.test(slug.toUpperCase());
}

function objectFamily(slug: string): string {
  const upper = slug.trim().toUpperCase();
  const toolkit = toolkitOfSlug(upper);
  const rest = upper.startsWith(`${toolkit}_`) ? upper.slice(toolkit.length + 1) : upper;
  return rest
    .replace(/_(CREATE|INSERT|ADD|UPDATE|EDIT|PATCH|MODIFY|GET|LIST|DELETE|CANCEL)(?:_|$)/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function fillEventIdFromGenericId(args: Record<string, unknown>, located: Record<string, string>): string[] {
  const changes: string[] = [];
  if (isBlankIdentityValue(args.event_id) && (located.event_id || located.id)) {
    args.event_id = located.event_id ?? located.id;
    changes.push('event_id located from this session\'s successful create');
  }
  if (isBlankIdentityValue(args.calendar_id) && located.calendar_id) {
    args.calendar_id = located.calendar_id;
    changes.push('calendar_id located from this session\'s successful create');
  }
  if (Object.prototype.hasOwnProperty.call(args, 'id') && isBlankIdentityValue(args.id) && located.id) {
    args.id = located.id;
    changes.push('id located from this session\'s successful create');
  }
  return changes;
}

export function applyLocatedResourceIds(
  args: Record<string, unknown>,
  located: Record<string, string>,
  toolSlug: string,
): { args: Record<string, unknown>; changes: string[] } {
  const next = { ...args };
  const changes = slugLooksLikeUpdate(toolSlug)
    ? fillEventIdFromGenericId(next, located)
    : [];
  return { args: next, changes };
}

export function requiredIdentityKeysFromSchema(schema: unknown): string[] {
  const root = asRecord(schema);
  if (!root) return [];
  const required = Array.isArray(root.required)
    ? root.required.filter((key): key is string => typeof key === 'string')
    : [];
  return required.filter((key) => isResourceIdentityKey(key));
}

export type SessionWriteReceipt = {
  slug: string;
  result: unknown;
};

export function locateResourceArgs(input: {
  toolSlug: string;
  args: Record<string, unknown>;
  receipts?: readonly SessionWriteReceipt[];
  schema?: unknown;
}): {
  args: Record<string, unknown>;
  changes: string[];
  missingRequired: string[];
  locatedEventId?: string;
} {
  if (!input.args || typeof input.args !== 'object' || Array.isArray(input.args)) {
    // Nothing to locate: pass the call through exactly as it arrived.
    return { args: input.args, changes: [], missingRequired: [] };
  }
  const omitted = omitBlankIdentityFields(input.args);
  let args = omitted.args;
  const changes = omitted.omitted.map((key) => `omitted blank ${key}`);
  const toolkit = toolkitOfSlug(input.toolSlug);
  const family = objectFamily(input.toolSlug);
  const matchingCreates = (input.receipts ?? []).filter((receipt) => (
    toolkitOfSlug(receipt.slug) === toolkit
    && slugLooksLikeCreate(receipt.slug)
    && (!family || objectFamily(receipt.slug) === family || objectFamily(receipt.slug).includes(family) || family.includes(objectFamily(receipt.slug)))
  ));
  if (slugLooksLikeUpdate(input.toolSlug) && matchingCreates.length === 1) {
    const located = resourceIdsFromProviderResult(matchingCreates[0]!.result);
    const filled = applyLocatedResourceIds(args, located, input.toolSlug);
    args = filled.args;
    changes.push(...filled.changes);
  }
  const missingRequired = requiredIdentityKeysFromSchema(input.schema)
    .filter((key) => isBlankIdentityValue(args[key]));
  const locatedEventId = typeof args.event_id === 'string' ? args.event_id : undefined;
  return { args, changes, missingRequired, locatedEventId };
}

export function locateBeforeEditRefusal(input: {
  toolSlug: string;
  missingRequired: readonly string[];
  locatedEventId?: string;
}): string {
  const missing = input.missingRequired.join(', ');
  const located = input.locatedEventId
    ? ` This session already created event ${input.locatedEventId} on the default calendar.`
    : '';
  return (
    `[provider-dispatch:not-started:invalid-args] ${input.toolSlug} is missing required resource identity (${missing}).`
    + `${located} Locate the resource first (reuse the create receipt or read it); do not pass empty identity fields.`
  );
}
