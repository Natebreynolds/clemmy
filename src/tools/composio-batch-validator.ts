/**
 * Pre-execution validation for Composio operations.
 *
 * Two modes, tried in order by validateComposioArgs():
 *
 *   1. SCHEMA-GROUNDED (preferred) — when the action's real
 *      `inputParameters` JSON Schema is cached (composio-schema-cache.ts,
 *      populated by every search/list/dynamic-build), validate against
 *      THAT: required top-level fields + required batch-item fields. No
 *      guessing; new toolkits are automatically right.
 *
 *   2. HEURISTIC (fallback) — when no schema is known, slug-name
 *      heuristics catch only provably-incomplete batches (empty item,
 *      non-object item, no update content, no write target).
 *
 * CONTRACT — capability gates fail OPEN, safety gates fail CLOSED.
 * This is a capability gate: it exists to save a doomed network call and
 * give better guidance than Composio's raw error. It must therefore only
 * block on PROVABLY wrong input. When uncertain (unknown slug, unknown
 * shape, malformed schema, any internal error) it must pass and let
 * Composio's server-side validation be the judge. A false block here is
 * worse than a wasted round-trip: it nudges the model to mutate its args
 * into shapes the target API never asked for (2026-06-11 incident class:
 * Airtable `{id, fields}` and Sheets `{range, values}` were falsely
 * blocked by heuristics that guessed Outlook's `patch` shape was
 * universal). Do not add new key guesses to the heuristics — teach the
 * schema cache instead.
 *
 * Example error prevented:
 *   OUTLOOK_BATCH_UPDATE_MESSAGES: Missing fields: {'updates.0.patch', 'updates.1.patch', ...}
 *   → Detected upfront, returns guidance to ensure all items have required structure
 */

export interface BatchValidationError {
  field: string;
  reason: string;
  examples: string[];
}

export type ValidationMode = 'schema' | 'heuristic';

export interface ComposioArgsValidation {
  error: BatchValidationError | null;
  mode: ValidationMode;
}

export interface NormalizedComposioBatchItemArgs {
  args: Record<string, unknown>;
  connectedAccountId?: string | null;
  repairs: string[];
  errors: string[];
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonObject(value: unknown): { value?: Record<string, unknown>; error?: string } {
  if (isRecordValue(value)) return { value };
  if (typeof value !== 'string') return { error: 'arguments must be a JSON object or JSON object string' };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecordValue(parsed)) return { error: 'arguments must parse to a JSON object' };
    return { value: parsed };
  } catch {
    return { error: 'arguments is not valid JSON' };
  }
}

function schemaRequiredFields(schema?: Record<string, unknown> | null): Set<string> {
  const required = isRecordValue(schema) && Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : [];
  return new Set(required);
}

function schemaPropertyFields(schema?: Record<string, unknown> | null): Set<string> | null {
  const properties = isRecordValue(schema?.properties) ? schema!.properties : null;
  return properties ? new Set(Object.keys(properties)) : null;
}

function isOutlookSendEmailSlug(toolSlug: string): boolean {
  return /^OUTLOOK(?:_|$).*SEND.*EMAIL$/i.test(toolSlug);
}

function applyEmailRecipientAliases(
  toolSlug: string,
  args: Record<string, unknown>,
  schema?: Record<string, unknown> | null,
): { args: Record<string, unknown>; repairs: string[] } {
  const repairs: string[] = [];
  const out = { ...args };
  const required = schemaRequiredFields(schema);
  const properties = schemaPropertyFields(schema);
  const needsToEmail = required.has('to_email') || isOutlookSendEmailSlug(toolSlug);
  if (needsToEmail && !('to_email' in out) && 'to' in out) {
    out.to_email = out.to;
    if (!properties || !properties.has('to')) delete out.to;
    repairs.push('mapped recipient alias "to" to required field "to_email"');
  }
  return { args: out, repairs };
}

/**
 * Repair the two batch-only Composio shape mistakes that are both common and
 * semantics-preserving:
 *   1. A run_batch item contains the full composio_execute_tool wrapper even
 *      though the batch runner will add that wrapper per item.
 *   2. A provider-specific email send schema wants `to_email`, while the model
 *      used the ordinary email field `to`.
 *
 * This is NOT a broad heuristic validator. Unknown shapes pass through; only a
 * wrapper for the SAME slug is unwrapped, and recipient aliases are applied only
 * when the cached schema requires `to_email` or for the known Outlook send-email
 * slug family that produced the live failure.
 */
export function normalizeComposioBatchItemArgs(
  toolSlug: string,
  args: Record<string, unknown>,
  schema?: Record<string, unknown> | null,
): NormalizedComposioBatchItemArgs {
  const repairs: string[] = [];
  const errors: string[] = [];
  let nextArgs = { ...args };
  let connectedAccountId: string | null | undefined;

  const hasComposioWrapper = 'tool_slug' in nextArgs || 'arguments' in nextArgs || 'connected_account_id' in nextArgs;
  if (hasComposioWrapper && 'arguments' in nextArgs) {
    const wrapperSlug = typeof nextArgs.tool_slug === 'string' ? nextArgs.tool_slug.trim() : '';
    if (wrapperSlug && wrapperSlug !== toolSlug) {
      errors.push(`wrapper tool_slug "${wrapperSlug}" does not match plan composioSlug "${toolSlug}"`);
    }
    const parsed = parseJsonObject(nextArgs.arguments);
    if (parsed.error) {
      errors.push(`wrapper arguments ${parsed.error}`);
    } else if (parsed.value) {
      nextArgs = { ...parsed.value };
      const rawConnection = args.connected_account_id;
      connectedAccountId = typeof rawConnection === 'string' && rawConnection.trim()
        ? rawConnection.trim()
        : rawConnection === null
          ? null
          : undefined;
      repairs.push('unwrapped nested composio_execute_tool args inside run_batch item');
    }
  }

  const recipient = applyEmailRecipientAliases(toolSlug, nextArgs, schema);
  nextArgs = recipient.args;
  repairs.push(...recipient.repairs);

  return { args: nextArgs, connectedAccountId, repairs, errors };
}

/**
 * Unified pre-dispatch entry point. Prefers the real schema when one is
 * supplied; falls back to slug-name heuristics otherwise.
 */
export function validateComposioArgs(
  toolSlug: string,
  args: Record<string, unknown>,
  schema?: Record<string, unknown> | null,
): ComposioArgsValidation {
  if (isRecordValue(schema)) {
    return { error: validateArgsAgainstSchema(toolSlug, args, schema), mode: 'schema' };
  }
  return { error: validateComposioBatchOperation(toolSlug, args), mode: 'heuristic' };
}

/**
 * Schema-grounded validation: block ONLY on fields the action's real
 * JSON Schema declares `required` and that are absent from the args.
 * Presence-only — types, formats, and extra keys are Composio's job.
 * Fail-open on any malformed/unexpected schema shape.
 */
export function validateArgsAgainstSchema(
  toolSlug: string,
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): BatchValidationError | null {
  try {
    // Top-level required fields.
    const required = Array.isArray(schema.required)
      ? schema.required.filter((k): k is string => typeof k === 'string')
      : [];
    const missing = required.filter((key) => !(key in args));
    if (missing.length > 0) {
      return {
        field: missing.join(', '),
        reason: `Missing required field(s) per the action's schema: ${missing.join(', ')}. Required fields for ${toolSlug}: ${required.join(', ')}`,
        examples: [
          `This comes from ${toolSlug}'s real inputParameters schema — supply every required field.`,
        ],
      };
    }

    // Batch-item required fields: any args array whose schema property
    // declares required keys on its items.
    const properties = isRecordValue(schema.properties) ? schema.properties : null;
    if (!properties) return null;
    for (const [key, value] of Object.entries(args)) {
      if (!Array.isArray(value)) continue;
      const propSchema = properties[key];
      if (!isRecordValue(propSchema)) continue;
      const items = isRecordValue(propSchema.items) ? propSchema.items : null;
      if (!items) continue;
      const itemRequired = Array.isArray(items.required)
        ? items.required.filter((k): k is string => typeof k === 'string')
        : [];
      if (itemRequired.length === 0) continue;
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (!isRecordValue(item)) {
          return {
            field: `${key}[${i}]`,
            reason: `Item ${i} in '${key}' is not an object — the schema requires objects with: ${itemRequired.join(', ')}`,
            examples: [`Each '${key}' item needs: ${itemRequired.join(', ')}`],
          };
        }
        const itemMissing = itemRequired.filter((k) => !(k in item));
        if (itemMissing.length > 0) {
          return {
            field: `${key}[${i}].${itemMissing[0]}`,
            reason: `Item ${i} in '${key}' is missing required field(s) per the action's schema: ${itemMissing.join(', ')}`,
            examples: [`Each '${key}' item needs: ${itemRequired.join(', ')}`],
          };
        }
      }
    }
    return null;
  } catch {
    // Fail-open: a malformed schema must never block a dispatch.
    return null;
  }
}

/**
 * Check if a composio_execute_tool call is a batch operation and validate its structure.
 * Returns error if validation fails, null if OK to proceed.
 */
export function validateComposioBatchOperation(
  toolSlug: string,
  args: Record<string, unknown>,
): BatchValidationError | null {
  // Only validate batch operations
  if (!isBatchOperation(toolSlug)) return null;

  // Find the batch array field (updates, items, records, etc.)
  const arrayFieldName = findBatchArrayField(args);
  if (!arrayFieldName) return null; // No array found, not actually a batch

  const array = args[arrayFieldName];
  if (!Array.isArray(array)) return null;

  // Empty batch is OK (though unusual)
  if (array.length === 0) return null;

  // Check for incomplete items
  const validation = validateBatchItems(array, toolSlug, arrayFieldName);
  return validation;
}

/**
 * Detect if this is a batch-like operation.
 * Pattern: "BATCH_", "BULK_", or toolkit-specific patterns
 */
function isBatchOperation(toolSlug: string): boolean {
  const slug = toolSlug.toUpperCase();
  return /\b(BATCH|BULK|BULK_)/.test(slug) ||
         /BATCH_|BULK_/.test(slug) ||
         /UPDATE_ALL|CREATE_MULTIPLE|UPSERT_MANY/.test(slug);
}

/**
 * Find the array field in batch args.
 * Common patterns: updates, items, records, rows, messages, etc.
 */
function findBatchArrayField(args: Record<string, unknown>): string | null {
  const arrayFieldNames = ['updates', 'items', 'records', 'rows', 'messages', 'entries', 'data'];
  for (const field of arrayFieldNames) {
    if (Array.isArray(args[field])) {
      return field;
    }
  }
  return null;
}

/**
 * Validate that batch items have expected structure.
 * Uses heuristics since we don't have full schema at dispatch time.
 */
function validateBatchItems(
  items: unknown[],
  toolSlug: string,
  fieldName: string,
): BatchValidationError | null {
  // Check for obviously incomplete items
  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    // Item must be an object
    if (!isObject(item)) {
      return {
        field: `${fieldName}[${i}]`,
        reason: `Item ${i} is not an object — batch items must be objects with fields`,
        examples: ['Correct: { id: "123", patch: {...} }', 'Wrong: null, "string", 123'],
      };
    }

    // Item must have fields (not empty)
    const keys = Object.keys(item);
    if (keys.length === 0) {
      return {
        field: `${fieldName}[${i}]`,
        reason: `Item ${i} is empty — batch items must have required fields like id, patch, data, etc.`,
        examples: ['Correct: { id: "rec123", patch: {...} }', 'Wrong: {} (empty object)'],
      };
    }

    // Type-check: validate expected fields for common patterns
    const validation = validateItemFields(item, toolSlug, fieldName, i);
    if (validation) return validation;
  }

  return null;
}

/**
 * Validate individual item fields based on tool type.
 */
function validateItemFields(
  item: Record<string, unknown>,
  toolSlug: string,
  fieldName: string,
  index: number,
): BatchValidationError | null {
  const slug = toolSlug.toUpperCase();

  // STRUCTURAL rules only — never enumerate toolkit vocabulary. Every
  // key-name list this validator ever carried produced false positives
  // on real production shapes (Outlook `message_id`+`patch`, Outlook
  // `message_id`+`is_read`, Airtable `id`+`fields`, Sheets
  // `range`+`values`), and a false block nudges the model to rename its
  // args into shapes the target API never asked for. The structural
  // invariant that holds across all of them:
  //   identity = any key ending in id/ids (id, message_id, record_id,
  //              row_ids, …) or 'range' (Sheets' write target)
  //   content  = any key that is not an identity key
  const keys = Object.keys(item);
  const isIdentityKey = (k: string): boolean => /(?:^|_)ids?$/i.test(k) || k.toLowerCase() === 'range';
  const hasIdentity = keys.some(isIdentityKey);
  const hasContent = keys.some((k) => !isIdentityKey(k));

  // CREATE/INSERT operations need data but not id (usually generated)
  if (slug.includes('CREATE') || slug.includes('INSERT')) {
    if (!hasContent) {
      return {
        field: `${fieldName}[${index}]`,
        reason: `Item ${index} has no field values — CREATE needs content (e.g., name, email, fields)`,
        examples: [
          'Correct: { name: "New Record", email: "test@example.com" }',
          'Wrong: {} or { id: "123" } (no fields)',
        ],
      };
    }
    return null;
  }

  // UPDATE/UPSERT operations need a write-target identity AND some
  // update content. An item with identity but nothing else (the
  // original incident shape: { id: "msg123" }) is provably incomplete.
  if (slug.includes('UPDATE') || slug.includes('UPSERT')) {
    if (!hasIdentity) {
      return {
        field: `${fieldName}[${index}].id`,
        reason: `Item ${index} is missing ID — UPDATE needs an identity key ('id', 'message_id', 'record_id', a '…_id' field, or 'range') to identify what to update`,
        examples: [
          'Correct: { id: "rec123", fields: { Name: "Updated" } }',
          'Correct (Sheets): { range: "Sheet1!A1:B2", values: [["a","b"]] }',
          'Wrong: { name: "Updated" } (missing id)',
        ],
      };
    }
    if (!hasContent) {
      return {
        field: `${fieldName}[${index}].patch`,
        reason: `Item ${index} has an identity but no update content — UPDATE needs at least one content field (e.g., 'patch', 'fields', 'values', or the property to change)`,
        examples: [
          'Correct: { message_id: "msg123", patch: { isRead: true } }',
          'Correct: { message_id: "msg123", is_read: true }',
          'Wrong: { id: "msg123" } (identity only, no update content)',
        ],
      };
    }
  }

  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Format a validation error for the model. The recovery instructions are
 * the self-healing half of the design: fetching the real schema (via
 * composio_search_tools / composio_list_tools) both gives the model the
 * correct shape AND populates the schema cache, so the next validation
 * of this slug is schema-grounded instead of guessed — a heuristic false
 * positive cannot block the same action twice in a session.
 */
export function formatBatchValidationError(
  error: BatchValidationError,
  toolSlug: string,
  mode: ValidationMode = 'heuristic',
): string {
  const recovery = mode === 'schema'
    ? [
        `Recovery: the missing field(s) come from ${toolSlug}'s real schema — add them and retry.`,
        `Do NOT rename or drop other keys; they were not the problem.`,
      ]
    : [
        `Recovery: do NOT guess or rename keys. Call composio_search_tools (or composio_list_tools) for this toolkit to fetch ${toolSlug}'s real inputParameters schema, rebuild the arguments to match it exactly, and retry.`,
        `Fetching the schema also upgrades this pre-dispatch check from heuristic to schema-grounded for the rest of the session.`,
        `If you believe the arguments were already correct, the schema fetch will prove it and the retry will pass.`,
      ];
  return [
    `⚠️  Operation validation failed before dispatch (${mode} check):`,
    ``,
    `Tool: ${toolSlug}`,
    `Field: ${error.field}`,
    `Issue: ${error.reason}`,
    ``,
    `Examples:`,
    ...error.examples.map((ex) => `  • ${ex}`),
    ``,
    ...recovery,
  ].join('\n');
}
