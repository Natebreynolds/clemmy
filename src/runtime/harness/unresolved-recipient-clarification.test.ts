import assert from 'node:assert/strict';
import test from 'node:test';
import {
  directedRecipientLabelFromAcceptedSource,
  unresolvedRecipientClarification,
  type ExactRecipientActionPath,
  type RecipientTurnObservation,
} from './unresolved-recipient-clarification.js';

const SOURCE = 41;
const PROMPT = 'Can you send a calendar invite to Alex Rivera please using my Acme email for today at 5 PM and tell him we need to talk about the new project';
const LIVE_FOR_PROMPT = 'Can you send a calendar invite for Alex Rivera through my Acme mailbox please for today at 6:30 PM tell him we need to talk about the new AI project please';

const selectedAccountPath: ExactRecipientActionPath = {
  kind: 'selected_account_blocker',
  sourceUserSeq: SOURCE,
  operationName: 'OUTLOOK_CALENDAR_CREATE_EVENT',
  accountChoices: [
    'owner@acme.example',
    'owner@personal.example',
  ],
  selectedAccountIdentity: 'owner@acme.example',
};

const citablePath: ExactRecipientActionPath = {
  kind: 'capability_ref',
  sourceUserSeq: SOURCE,
  capabilityRef: 'cap:resolved:calendar_create_event',
  accountIdentity: 'account:work-calendar',
  accountIdentityProvenance: 'same_source_capability_discovered',
};

const citableSetPath: ExactRecipientActionPath = {
  kind: 'capability_refs',
  sourceUserSeq: SOURCE,
  capabilityRefs: [
    'cap:resolved:calendar_create_event',
    'cap:resolved:calendar_cancel_event',
  ],
  accountIdentity: 'account:work-calendar',
  accountIdentityProvenance: 'same_source_capability_discovered',
};

const selectedAccountSetPath: ExactRecipientActionPath = {
  kind: 'selected_account_blockers',
  sourceUserSeq: SOURCE,
  operationNames: [
    'OUTLOOK_CALENDAR_CREATE_EVENT',
    'OUTLOOK_CALENDAR_CANCEL_EVENT',
    'OUTLOOK_CALENDAR_DELETE_EVENT',
  ],
  accountChoices: selectedAccountPath.accountChoices,
  selectedAccountIdentity: selectedAccountPath.selectedAccountIdentity,
};

function lookup(overrides: Partial<RecipientTurnObservation> = {}): RecipientTurnObservation {
  return {
    sourceUserSeq: SOURCE,
    toolName: 'memory_recall_all',
    queryText: 'Alex Rivera email address contact identity',
    result: '[WHO/WHAT] Alex R. Rivera: person - mentioned 44 times',
    settled: true,
    effect: 'read',
    evidenceRole: 'source_read',
    ...overrides,
  };
}

test('extracts only a conservative named recipient from directed request grammar', () => {
  assert.equal(directedRecipientLabelFromAcceptedSource(PROMPT), 'Alex Rivera');
  assert.equal(directedRecipientLabelFromAcceptedSource(LIVE_FOR_PROMPT), 'Alex Rivera');
  assert.equal(directedRecipientLabelFromAcceptedSource('send Alex Rivera an invite at five'), 'Alex Rivera');
  assert.equal(directedRecipientLabelFromAcceptedSource('send an invite to the project team'), null);
  assert.equal(directedRecipientLabelFromAcceptedSource('send a calendar invite for Marketing Team today'), null);
  assert.equal(directedRecipientLabelFromAcceptedSource('send a calendar invite for the Project Team through my Acme mailbox'), null);
  assert.equal(directedRecipientLabelFromAcceptedSource('send a calendar invite for my Acme mailbox today'), null);
  assert.equal(directedRecipientLabelFromAcceptedSource('review the New Project plan'), null);
});

test('live shape: exact account path plus one grounded miss asks once for recipient identity', () => {
  const result = unresolvedRecipientClarification({
    sourceUserSeq: SOURCE,
    acceptedText: PROMPT,
    currentPath: selectedAccountPath,
    observations: [lookup({
      result: [
        '[FACT] Acme sellers include Morgan Lee (morgan.lee@acme.example).',
        '[FACT] User has Outlook accounts owner@acme.example and owner@personal.example.',
        '[WHO/WHAT] Alex R. Rivera: person - mentioned 44 times.',
      ].join('\n'),
    })],
    effectOrApprovalPathEntered: false,
  });
  assert.deepEqual(result, {
    targetLabel: 'Alex Rivera',
    question: "I couldn't ground an exact recipient address for Alex Rivera. What exact email address or recipient ID should I use?",
  });
});

test('a citable exact path also asks after one settled target lookup returns no identity', () => {
  assert.ok(unresolvedRecipientClarification({
    sourceUserSeq: SOURCE,
    acceptedText: PROMPT,
    currentPath: citablePath,
    observations: [lookup({ result: { matches: [] } })],
    effectOrApprovalPathEntered: false,
  }));
});

test('closed same-account capability and selected-account sets ask without rank selection', () => {
  for (const currentPath of [citableSetPath, selectedAccountSetPath]) {
    assert.ok(unresolvedRecipientClarification({
      sourceUserSeq: SOURCE,
      acceptedText: PROMPT,
      currentPath,
      observations: [lookup({ result: { matches: [] } })],
      effectOrApprovalPathEntered: false,
    }));
  }
});

test('closed candidate sets reject duplicate or malformed identities', () => {
  for (const currentPath of [
    { ...citableSetPath, capabilityRefs: ['cap:resolved:x', 'cap:resolved:x'] },
    { ...citableSetPath, capabilityRefs: [] },
    { ...selectedAccountSetPath, operationNames: ['OUTLOOK_CREATE_EVENT', 'OUTLOOK_CREATE_EVENT'] },
    { ...selectedAccountSetPath, operationNames: [] },
  ] satisfies ExactRecipientActionPath[]) {
    assert.equal(unresolvedRecipientClarification({
      sourceUserSeq: SOURCE,
      acceptedText: PROMPT,
      currentPath,
      observations: [lookup()],
      effectOrApprovalPathEntered: false,
    }), null);
  }
});

test('a source-supplied exact target address prevents a redundant clarification', () => {
  assert.equal(unresolvedRecipientClarification({
    sourceUserSeq: SOURCE,
    acceptedText: 'Send a calendar invite to Alex Rivera (alex.rivera@acme.example) today at 5 PM.',
    currentPath: citablePath,
    observations: [lookup()],
    effectOrApprovalPathEntered: false,
  }), null);
});

test('a source-supplied sender mailbox cannot impersonate the named recipient', () => {
  for (const acceptedText of [
    'Send a calendar invite to Alex Rivera using my owner@acme.example account today at 5 PM.',
    'Send a calendar invite to Alex Rivera from owner@acme.example today at 5 PM.',
    'Send a calendar invite to Alex Rivera via my owner@acme.example mailbox today at 5 PM.',
  ]) {
    assert.ok(unresolvedRecipientClarification({
      sourceUserSeq: SOURCE,
      acceptedText,
      currentPath: citablePath,
      observations: [lookup()],
      effectOrApprovalPathEntered: false,
    }));
  }
});

test('explicit source recipient associations remain sufficient', () => {
  for (const acceptedText of [
    'Send a calendar invite to Alex Rivera <alex.rivera@acme.example>.',
    'Send a calendar invite to Alex Rivera at alex.rivera@acme.example.',
    'Send a calendar invite to <alex.rivera@acme.example> for Alex Rivera.',
  ]) {
    assert.equal(directedRecipientLabelFromAcceptedSource(acceptedText), 'Alex Rivera');
    assert.equal(unresolvedRecipientClarification({
      sourceUserSeq: SOURCE,
      acceptedText,
      currentPath: citablePath,
      observations: [lookup()],
      effectOrApprovalPathEntered: false,
    }), null);
  }
});

test('a structured grounded record that binds the target name and email prevents asking', () => {
  assert.equal(unresolvedRecipientClarification({
    sourceUserSeq: SOURCE,
    acceptedText: PROMPT,
    currentPath: citablePath,
    observations: [lookup({
      toolName: 'contacts_read',
      result: {
        records: [{ full_name: 'Alex R. Rivera', email_address: 'alex.rivera@acme.example' }],
      },
    })],
    effectOrApprovalPathEntered: false,
  }), null);
});

test('a plain grounded middle-initial record binds the exact target email', () => {
  assert.equal(unresolvedRecipientClarification({
    sourceUserSeq: SOURCE,
    acceptedText: PROMPT,
    currentPath: citablePath,
    observations: [lookup({
      result: 'Alex R. Rivera — email: alex.rivera@acme.example',
    })],
    effectOrApprovalPathEntered: false,
  }), null);
});

test('unrelated emails elsewhere in one recall cannot impersonate the named recipient', () => {
  const result = unresolvedRecipientClarification({
    sourceUserSeq: SOURCE,
    acceptedText: PROMPT,
    currentPath: citablePath,
    observations: [lookup({
      result: [
        'Morgan Lee - morgan.lee@acme.example',
        'Alex R. Rivera - person record; no identifiers stored',
      ].join('\n'),
    })],
    effectOrApprovalPathEntered: false,
  });
  assert.equal(result?.targetLabel, 'Alex Rivera');
});

test('an unrelated address on the target line cannot impersonate the named recipient', () => {
  const result = unresolvedRecipientClarification({
    sourceUserSeq: SOURCE,
    acceptedText: PROMPT,
    currentPath: citablePath,
    observations: [lookup({
      result: 'Alex Rivera reports to Morgan Lee at morgan.lee@acme.example',
    })],
    effectOrApprovalPathEntered: false,
  });
  assert.equal(result?.targetLabel, 'Alex Rivera');
});

test('the words contact identity are not an explicit contact ID', () => {
  const result = unresolvedRecipientClarification({
    sourceUserSeq: SOURCE,
    acceptedText: PROMPT,
    currentPath: citablePath,
    observations: [lookup({ result: 'Alex Rivera email address contact identity' })],
    effectOrApprovalPathEntered: false,
  });
  assert.equal(result?.targetLabel, 'Alex Rivera');
});

test('metadata discovery is not the one grounded recipient lookup', () => {
  assert.equal(unresolvedRecipientClarification({
    sourceUserSeq: SOURCE,
    acceptedText: PROMPT,
    currentPath: citablePath,
    observations: [lookup({
      toolName: 'tool_search',
      queryText: 'Alex Rivera calendar capability',
      result: { results: [{ name: 'CALENDAR_CREATE_EVENT' }] },
    })],
    effectOrApprovalPathEntered: false,
  }), null);
});

test('the predicate abstains without exact current capability and account identity', () => {
  assert.equal(unresolvedRecipientClarification({
    sourceUserSeq: SOURCE,
    acceptedText: PROMPT,
    currentPath: null,
    observations: [lookup()],
    effectOrApprovalPathEntered: false,
  }), null);
  assert.equal(unresolvedRecipientClarification({
    sourceUserSeq: SOURCE,
    acceptedText: PROMPT,
    currentPath: { ...citablePath, accountIdentity: '' },
    observations: [lookup()],
    effectOrApprovalPathEntered: false,
  }), null);
  assert.equal(unresolvedRecipientClarification({
    sourceUserSeq: SOURCE,
    acceptedText: PROMPT,
    currentPath: {
      ...citablePath,
      accountIdentityProvenance: 'tool_search_only' as never,
    },
    observations: [lookup()],
    effectOrApprovalPathEntered: false,
  }), null);
  assert.equal(unresolvedRecipientClarification({
    sourceUserSeq: SOURCE,
    acceptedText: PROMPT,
    currentPath: { ...selectedAccountPath, selectedAccountIdentity: 'unknown@example.test' },
    observations: [lookup()],
    effectOrApprovalPathEntered: false,
  }), null);
});

test('lookup authority must be same-source, settled, read, source-grounded, and target-bound', () => {
  const invalidLookups = [
    lookup({ sourceUserSeq: SOURCE + 1 }),
    lookup({ settled: false }),
    lookup({ effect: 'compute' }),
    lookup({ evidenceRole: 'derivation' }),
    lookup({ queryText: 'someone else' }),
  ];
  for (const invalid of invalidLookups) {
    assert.equal(unresolvedRecipientClarification({
      sourceUserSeq: SOURCE,
      acceptedText: PROMPT,
      currentPath: citablePath,
      observations: [invalid],
      effectOrApprovalPathEntered: false,
    }), null);
  }
});

test('exactly one grounded lookup owns the stop edge', () => {
  assert.equal(unresolvedRecipientClarification({
    sourceUserSeq: SOURCE,
    acceptedText: PROMPT,
    currentPath: citablePath,
    observations: [],
    effectOrApprovalPathEntered: false,
  }), null);
  assert.equal(unresolvedRecipientClarification({
    sourceUserSeq: SOURCE,
    acceptedText: PROMPT,
    currentPath: citablePath,
    observations: [lookup(), lookup({ toolName: 'contacts_read' })],
    effectOrApprovalPathEntered: false,
  }), null);
});

test('an effect or approval path suppresses clarification manufacture', () => {
  assert.equal(unresolvedRecipientClarification({
    sourceUserSeq: SOURCE,
    acceptedText: PROMPT,
    currentPath: citablePath,
    observations: [lookup()],
    effectOrApprovalPathEntered: true,
  }), null);
  assert.equal(unresolvedRecipientClarification({
    sourceUserSeq: SOURCE,
    acceptedText: PROMPT,
    currentPath: citablePath,
    observations: [lookup(), lookup({
      toolName: 'OUTLOOK_CALENDAR_CREATE_EVENT',
      queryText: '',
      result: { event_id: 'evt-1' },
      effect: 'external_write',
      evidenceRole: 'committed_effect',
    })],
    effectOrApprovalPathEntered: false,
  }), null);
});

test('non-directed and non-external work never manufactures a recipient question', () => {
  assert.equal(unresolvedRecipientClarification({
    sourceUserSeq: SOURCE,
    acceptedText: 'Summarize the meeting notes about Alex Rivera.',
    currentPath: citablePath,
    observations: [lookup()],
    effectOrApprovalPathEntered: false,
  }), null);
});
