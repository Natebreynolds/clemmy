function record(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function properties(value: unknown): Record<string, unknown> | null {
  const schema = record(value);
  return schema?.type === 'object' ? record(schema.properties) : null;
}

function required(value: unknown): string[] | null {
  const schema = record(value);
  return Array.isArray(schema?.required)
    && schema.required.every((entry) => typeof entry === 'string')
    ? schema.required as string[]
    : null;
}

function typed(value: unknown, type: string): boolean {
  return record(value)?.type === type;
}

function arrayItems(value: unknown): Record<string, unknown> | null {
  const schema = record(value);
  return schema?.type === 'array' ? record(schema.items) : null;
}

/** Positive semantic wall for the exact current Firecrawl start/get pair.
 * Full schema digests remain the byte identity; this predicate prevents an
 * unrelated same-version definition from inheriting the hard-coded pointers. */
export function firecrawlBatchScrapeSchemasMatchV20260826(input: {
  startInput: unknown;
  startOutput: unknown;
  getterInput: unknown;
  getterOutput: unknown;
}): boolean {
  const startInput = properties(input.startInput);
  const startRequired = required(input.startInput);
  const startOutput = properties(input.startOutput);
  const getterInput = properties(input.getterInput);
  const getterRequired = required(input.getterInput);
  const getterOutput = properties(input.getterOutput);
  if (!startInput || !startRequired || !startOutput || !getterInput || !getterRequired || !getterOutput) {
    return false;
  }
  const urlItems = arrayItems(startInput.urls);
  const formatItems = arrayItems(startInput.formats);
  const formats = Array.isArray(formatItems?.enum) ? formatItems.enum : [];
  const dataItems = arrayItems(getterOutput.data);
  const dataProperties = properties(dataItems);
  const metadata = dataProperties ? record(dataProperties.metadata) : null;
  return startRequired.includes('urls')
    && typed(urlItems, 'string')
    && Number(record(startInput.urls)?.minItems ?? 0) >= 1
    && Boolean(formatItems)
    && formats.includes('rawHtml')
    && typed(startOutput.success, 'boolean')
    && typed(startOutput.id, 'string')
    && typed(startOutput.url, 'string')
    && getterRequired.length === 1
    && getterRequired[0] === 'id'
    && typed(getterInput.id, 'string')
    && typed(getterOutput.status, 'string')
    && (typed(getterOutput.total, 'number') || typed(getterOutput.total, 'integer'))
    && (typed(getterOutput.completed, 'number') || typed(getterOutput.completed, 'integer'))
    && (typed(getterOutput.creditsUsed, 'number') || typed(getterOutput.creditsUsed, 'integer'))
    && typed(getterOutput.expiresAt, 'string')
    && Boolean(dataItems)
    && Boolean(dataProperties)
    && typed(dataProperties!.rawHtml, 'string')
    && metadata?.type === 'object';
}
