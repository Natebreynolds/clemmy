/**
 * Run: npx tsx --test src/memory/capability-effect-scope.test.ts
 *
 * A remembered provider family can contain opposite operations that share the
 * same nouns. Effect scope must separate them before workflow binding,
 * capability advertising, or discovery short-circuiting sees the candidates.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-effect-scope-'));

const {
  capabilityEffectIsCompatible,
  rememberedCapabilityEffect,
  requestedCapabilityEffectScope,
} = await import('./capability-effect-scope.js');
const {
  matchToolChoicesForStep,
  recallComposioForSearch,
  rememberToolChoice,
  renderToolChoicesForContext,
} = await import('./tool-choice-store.js');
type ToolChoiceRecord = import('./tool-choice-store.js').ToolChoiceRecord;

function record(
  intent: string,
  kind: 'cli' | 'composio' | 'mcp',
  identifier: string,
  invocationTemplate?: string,
): ToolChoiceRecord {
  return {
    intent,
    choice: {
      kind,
      identifier,
      ...(invocationTemplate ? { invocationTemplate } : {}),
      testedAt: '2026-08-08T00:00:00.000Z',
      successCount: 3,
    },
    fallbacks: [],
    body: '',
    filePath: `/test/${intent}.md`,
  };
}

const mcpRead = record('gmail.email.list', 'mcp', 'gmail__list_email');
const mcpSend = record('gmail.email.send', 'mcp', 'gmail__send_email');
const composioRead = record('gmail email messages list', 'composio', 'GMAIL_LIST_EMAILS');
const composioSend = record('gmail email messages send', 'composio', 'GMAIL_SEND_EMAIL');
const calendarRead = record('outlook.calendar.view', 'composio', 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW');
const calendarWrite = record('outlook.calendar.create', 'composio', 'OUTLOOK_CREATE_CALENDAR_EVENT');

test('request scope distinguishes reads, writes, compounds, and ambiguous asks', () => {
  assert.equal(requestedCapabilityEffectScope('Read the Gmail email messages.'), 'read');
  assert.equal(requestedCapabilityEffectScope('Find the Gmail email from Alice.'), 'read');
  assert.equal(requestedCapabilityEffectScope('Run the Gmail email lookup workflow.'), 'read',
    'email/message resource nouns alone are not writes');
  assert.equal(requestedCapabilityEffectScope("What's on my Outlook calendar?"), 'read');
  assert.equal(requestedCapabilityEffectScope('whats on my Outlook calendar tomorrow'), 'read');
  assert.equal(requestedCapabilityEffectScope('Send the Gmail email now.'), 'write');
  assert.equal(requestedCapabilityEffectScope('Read the Gmail email, then send a reply.'), 'mixed');
  assert.equal(requestedCapabilityEffectScope('Create a summary report of my Gmail emails.'), 'mixed',
    'an artifact write keeps the obvious provider-read dependency');
  assert.equal(requestedCapabilityEffectScope('Draft a reply to the latest Gmail email.'), 'mixed',
    'latest-resource writes keep the lookup needed to identify their target');
  assert.equal(requestedCapabilityEffectScope("Schedule a meeting when I'm free."), 'mixed',
    'availability is a read dependency of calendar creation');
  assert.equal(requestedCapabilityEffectScope('Book it based on my calendar availability.'), 'mixed');
  assert.equal(requestedCapabilityEffectScope('Archive old Gmail emails.'), 'mixed',
    'a set-selection write keeps the read needed to identify the set');
  assert.equal(requestedCapabilityEffectScope('Explain how to send a Gmail email.'), 'read',
    'advice about a write is still an information request');
  assert.equal(requestedCapabilityEffectScope('Handle the Gmail email.'), 'unknown');
});

test('remembered effect evidence is conservative and unknown fails open', () => {
  assert.equal(rememberedCapabilityEffect(composioRead.choice!), 'read');
  assert.equal(rememberedCapabilityEffect(composioSend.choice!), 'write');
  assert.equal(rememberedCapabilityEffect({ kind: 'mcp', identifier: 'slack__conversations_history' }), 'unknown');
  assert.equal(rememberedCapabilityEffect({
    kind: 'cli', identifier: 'sf',
    invocationTemplate: 'sf data query --query "SELECT Id FROM Message WHERE Subject = send_update"',
  }), 'read', 'CLI argument values cannot relabel the command head as a write');
  assert.equal(rememberedCapabilityEffect({
    kind: 'cli', identifier: 'netlify', invocationTemplate: 'netlify deploy --site {{site_id}}',
  }), 'write');
  assert.equal(capabilityEffectIsCompatible('read', 'unknown'), true);
  assert.equal(capabilityEffectIsCompatible('write', 'unknown'), true);
});

test('workflow matcher never auto-binds the opposite MCP effect', () => {
  const readMatches = matchToolChoicesForStep('Read the Gmail email messages.', {
    choices: [mcpSend, mcpRead],
  });
  assert.deepEqual(readMatches.map((match) => match.identifier), ['gmail__list_email']);
  assert.equal(readMatches[0]?.autoBindable, true);
  assert.equal(readMatches[0]?.effectClass, 'read');

  const writeMatches = matchToolChoicesForStep('Send the Gmail email now.', {
    choices: [mcpRead, mcpSend],
  });
  assert.deepEqual(writeMatches.map((match) => match.identifier), ['gmail__send_email']);
  assert.equal(writeMatches[0]?.effectClass, 'write');
});

test('advertising preserves both effects only for genuinely compound or ambiguous work', () => {
  const conversationalCalendarRead = matchToolChoicesForStep('whats on my Outlook calendar tomorrow', {
    choices: [calendarWrite, calendarRead], purpose: 'advertise', limit: 5,
  });
  assert.deepEqual(conversationalCalendarRead.map((match) => match.identifier),
    ['OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW']);

  const read = matchToolChoicesForStep('Read the Gmail email messages.', {
    choices: [composioSend, composioRead], purpose: 'advertise', limit: 5,
  });
  assert.deepEqual(read.map((match) => match.identifier), ['GMAIL_LIST_EMAILS']);

  const write = matchToolChoicesForStep('Send the Gmail email now.', {
    choices: [composioRead, composioSend], purpose: 'advertise', limit: 5,
  });
  assert.deepEqual(write.map((match) => match.identifier), ['GMAIL_SEND_EMAIL']);

  const compound = matchToolChoicesForStep('Read the Gmail email, then send a reply.', {
    choices: [composioRead, composioSend], purpose: 'advertise', limit: 5,
  });
  assert.deepEqual(new Set(compound.map((match) => match.identifier)),
    new Set(['GMAIL_LIST_EMAILS', 'GMAIL_SEND_EMAIL']));

  for (const dependencyAsk of [
    'Create a summary report of my Gmail emails.',
    'Draft a reply to the latest Gmail email.',
    'Archive old Gmail emails.',
  ]) {
    const dependency = matchToolChoicesForStep(dependencyAsk, {
      choices: [composioRead, composioSend], purpose: 'advertise', limit: 5,
    });
    assert.deepEqual(new Set(dependency.map((match) => match.identifier)),
      new Set(['GMAIL_LIST_EMAILS', 'GMAIL_SEND_EMAIL']), dependencyAsk);
  }

  const calendarDependency = matchToolChoicesForStep('Book it based on my calendar availability.', {
    choices: [calendarRead, calendarWrite], purpose: 'advertise', limit: 5,
  });
  assert.deepEqual(new Set(calendarDependency.map((match) => match.identifier)),
    new Set(['OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW', 'OUTLOOK_CREATE_CALENDAR_EVENT']),
    'availability-based scheduling keeps LIST + CREATE memory');

  const ambiguous = matchToolChoicesForStep('Handle the Gmail email.', {
    choices: [composioRead, composioSend], purpose: 'advertise', limit: 5,
  });
  assert.deepEqual(new Set(ambiguous.map((match) => match.identifier)),
    new Set(['GMAIL_LIST_EMAILS', 'GMAIL_SEND_EMAIL']), 'uncertain intent must fail open');
});

test('Composio discovery recall cannot short-circuit onto the opposite effect', () => {
  const choices = [composioSend, composioRead];
  assert.deepEqual(
    recallComposioForSearch('read Gmail email messages', { choices, limit: 5 }).map((hit) => hit.slug),
    ['GMAIL_LIST_EMAILS'],
  );
  assert.deepEqual(
    recallComposioForSearch('send Gmail email messages', { choices, limit: 5 }).map((hit) => hit.slug),
    ['GMAIL_SEND_EMAIL'],
  );
  assert.deepEqual(
    new Set(recallComposioForSearch(
      'draft a reply to the latest Gmail email messages', { choices, limit: 5 },
    ).map((hit) => hit.slug)),
    new Set(['GMAIL_LIST_EMAILS', 'GMAIL_SEND_EMAIL']),
    'a write with an obvious lookup dependency keeps both operation families',
  );
});

test('the workflow-step remembered-context block excludes the opposite effect', () => {
  rememberToolChoice({
    intent: 'effectproof.email.list',
    choice: { kind: 'composio', identifier: 'EFFECTPROOF_LIST_EMAILS' },
  });
  rememberToolChoice({
    intent: 'effectproof.email.send',
    choice: { kind: 'composio', identifier: 'EFFECTPROOF_SEND_EMAIL' },
  });

  const readBlock = renderToolChoicesForContext(8, undefined, 'Read Effectproof email messages.');
  assert.match(readBlock, /EFFECTPROOF_LIST_EMAILS/);
  assert.doesNotMatch(readBlock, /EFFECTPROOF_SEND_EMAIL/);

  const writeBlock = renderToolChoicesForContext(8, undefined, 'Send the Effectproof email now.');
  assert.match(writeBlock, /EFFECTPROOF_SEND_EMAIL/);
  assert.doesNotMatch(writeBlock, /EFFECTPROOF_LIST_EMAILS/);
});
