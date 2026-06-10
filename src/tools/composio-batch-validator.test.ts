import { validateComposioBatchOperation, formatBatchValidationError } from './composio-batch-validator.js';

// Test batch validation detects empty items
{
  const error = validateComposioBatchOperation('OUTLOOK_BATCH_UPDATE_MESSAGES', {
    updates: [
      { id: 'msg1', patch: { subject: 'Test' } },
      {}, // Empty item — should fail
      { id: 'msg3', patch: { subject: 'Test 3' } },
    ],
  });
  if (!error || !error.reason.includes('empty')) {
    throw new Error('Should detect empty item in batch');
  }
}

// Test batch validation detects missing patch field
{
  const error = validateComposioBatchOperation('OUTLOOK_BATCH_UPDATE_MESSAGES', {
    updates: [
      { id: 'msg1' }, // Missing patch — should fail
      { id: 'msg2', patch: { subject: 'Test' } },
    ],
  });
  if (!error || !error.reason.includes('patch')) {
    throw new Error('Should detect missing patch field');
  }
}

// Test batch validation passes on valid batch
{
  const error = validateComposioBatchOperation('OUTLOOK_BATCH_UPDATE_MESSAGES', {
    updates: [
      { id: 'msg1', patch: { subject: 'Test 1' } },
      { id: 'msg2', patch: { subject: 'Test 2' } },
    ],
  });
  if (error !== null) {
    throw new Error('Should accept valid batch');
  }
}

// Test batch validation ignores non-batch operations
{
  const error = validateComposioBatchOperation('OUTLOOK_OUTLOOK_SEND_EMAIL', {
    to: 'test@example.com',
    subject: 'Test',
  });
  if (error !== null) {
    throw new Error('Should ignore non-batch operations');
  }
}

// Test error formatting
{
  const error = validateComposioBatchOperation('AIRTABLE_BULK_CREATE_RECORDS', {
    items: [{}],
  });
  if (error) {
    const formatted = formatBatchValidationError(error, 'AIRTABLE_BULK_CREATE_RECORDS');
    if (!formatted.includes('⚠️')) {
      throw new Error('Should include warning symbol');
    }
    if (!formatted.includes('AIRTABLE_BULK_CREATE_RECORDS')) {
      throw new Error('Should include tool slug');
    }
  }
}
