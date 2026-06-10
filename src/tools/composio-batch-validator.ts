/**
 * Pre-execution validation for Composio batch operations.
 *
 * Composio batch operations (BATCH_UPDATE_MESSAGES, BULK_CREATE_RECORDS, etc.)
 * frequently fail with "Missing fields" errors when the agent constructs an
 * incomplete item in the batch array.
 *
 * This validator catches incomplete batches BEFORE dispatch and returns clear
 * guidance instead of a Composio error.
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

  // BATCH_UPDATE operations need 'patch' or 'data' field
  if (slug.includes('BATCH_UPDATE') || slug.includes('BULK_UPDATE')) {
    if (!('patch' in item) && !('data' in item) && !('value' in item)) {
      return {
        field: `${fieldName}[${index}].patch`,
        reason: `Item ${index} is missing required field — BATCH_UPDATE needs 'patch', 'data', or 'value' field with update content`,
        examples: [
          'Correct: { id: "msg123", patch: { subject: "New subject" } }',
          'Wrong: { id: "msg123" } (missing patch)',
        ],
      };
    }
  }

  // CREATE/INSERT operations need data but not id (usually generated)
  if (slug.includes('CREATE') || slug.includes('INSERT')) {
    if (isEmptyObject(item)) {
      return {
        field: `${fieldName}[${index}]`,
        reason: `Item ${index} is empty — CREATE needs field values (e.g., name, email, content)`,
        examples: [
          'Correct: { name: "New Record", email: "test@example.com" }',
          'Wrong: {} or { id: "123" } (no fields)',
        ],
      };
    }
  }

  // UPDATE/UPSERT operations need an ID
  if (slug.includes('UPDATE') || slug.includes('UPSERT')) {
    if (!('id' in item) && !('ID' in item) && !('record_id' in item) && !('recordId' in item)) {
      return {
        field: `${fieldName}[${index}].id`,
        reason: `Item ${index} is missing ID — UPDATE needs 'id' or 'record_id' to identify what to update`,
        examples: [
          'Correct: { id: "rec123", name: "Updated" }',
          'Wrong: { name: "Updated" } (missing id)',
        ],
      };
    }
  }

  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEmptyObject(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).length === 0;
}

/**
 * Format a batch validation error for user escalation.
 */
export function formatBatchValidationError(error: BatchValidationError, toolSlug: string): string {
  return [
    `⚠️  Batch operation validation failed before dispatch:`,
    ``,
    `Tool: ${toolSlug}`,
    `Field: ${error.field}`,
    `Issue: ${error.reason}`,
    ``,
    `Examples:`,
    ...error.examples.map((ex) => `  • ${ex}`),
    ``,
    `Fix this and retry.`,
  ].join('\n');
}
