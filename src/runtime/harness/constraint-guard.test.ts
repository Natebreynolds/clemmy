import { formatConstraintEscalation, type ConstraintViolation } from './constraint-guard.js';

// Test formatConstraintEscalation
{
  const violation: ConstraintViolation = {
    constraint: {
      id: 1,
      kind: 'constraint',
      content: 'Use corp.example email account for all Outlook sends',
      source: {},
      score: 1.0,
      active: true,
      createdAt: '2026-06-10T00:00:00Z',
      updatedAt: '2026-06-10T00:00:00Z',
      pinned: true,
    },
    reason: 'Email account "legacy@coaching.example" violates constraint requiring "corp.example"',
    toolName: 'composio_execute_tool',
    violatingField: 'from/account',
  };

  const msg = formatConstraintEscalation(violation);
  if (!msg.includes('⚠️  This action would violate a standing constraint')) {
    throw new Error('formatConstraintEscalation should include warning prefix');
  }
  if (!msg.includes('composio_execute_tool')) {
    throw new Error('formatConstraintEscalation should include tool name');
  }
}
