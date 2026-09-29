/**
 * Run: npx tsx --test src/lib/project-words.test.ts   (from apps/mobile-web)
 *
 * Pins for what the phone says and sends about projects and delegated tasks:
 * a refusal is said in plain words and never as its code, a saved form sends
 * only what changed, and a refused account binding asks the right next thing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountBindStep,
  goalsFromText,
  goalsToText,
  inWords,
  projectDraftChanges,
  projectDraftFrom,
  refusalIsStale,
  refusalWords,
} from './project-words';

const refused = (error: string, extra: Record<string, unknown> = {}) => ({ status: 409, message: error, body: { error, ...extra } });

test('goals are one per line, without bullets, blanks or repeats', () => {
  assert.deepEqual(goalsFromText('- Close Q4\n\n2. Renew Acme\n• Close Q4\n  Hire an SDR  '), ['Close Q4', 'Renew Acme', 'Hire an SDR']);
  assert.deepEqual(goalsFromText(''), []);
  assert.equal(goalsToText(['Close Q4', ' ', 'Renew Acme']), 'Close Q4\nRenew Acme');
  assert.deepEqual(goalsFromText(goalsToText(['A', 'B'])), ['A', 'B']);
});

test('saving sends only the fields the owner changed', () => {
  const project = { name: 'Weekly Sales', purpose: 'Run the weekly numbers', goals: ['Close Q4'], context: 'Use the pipeline sheet' };
  const draft = projectDraftFrom(project);
  assert.equal(projectDraftChanges(project, draft), null, 'an untouched form saves nothing');
  assert.deepEqual(projectDraftChanges(project, { ...draft, purpose: 'Run the weekly numbers ' }), null, 'a trailing space is not a change');
  assert.deepEqual(projectDraftChanges(project, { ...draft, purpose: 'Own the forecast' }), { purpose: 'Own the forecast' });
  assert.deepEqual(projectDraftChanges(project, { ...draft, goals: 'Close Q4\nRenew Acme' }), { goals: ['Close Q4', 'Renew Acme'] });
  assert.deepEqual(projectDraftChanges(project, { ...draft, goals: '' }), { goals: [] }, 'clearing the goals is a change');
  assert.deepEqual(projectDraftChanges(project, { ...draft, context: '' }), { context: '' });
  assert.deepEqual(projectDraftChanges(project, { ...draft, name: '   ' }), null, 'a project is never renamed to nothing');
  assert.deepEqual(projectDraftChanges(project, { ...draft, name: 'Sales', context: 'New' }), { name: 'Sales', context: 'New' });
});

test('a refusal is said in words; its code never reaches the screen', () => {
  assert.equal(refusalWords(refused('NAME_TAKEN')), 'You already have a project with that name.');
  assert.equal(refusalWords(refused('TASK_NOT_OPEN')), 'This task has already ended, so it cannot take a correction.');
  assert.equal(refusalWords(refused('STOPPING')), 'This task is stopping. Correct it once it has stopped.');
  assert.equal(refusalWords(refused('ALREADY_KEPT_THERE')), 'It is already kept there.');
  assert.equal(refusalWords({ offline: true, status: 0, message: 'x' }), "Can't reach your Mac right now. Try again when you're back on.");
  assert.equal(refusalWords(refused('SOMETHING_NEW_FROM_THE_MAC')), 'That did not go through. Try again.');
  assert.equal(refusalWords(new Error('HTTP 500'), 'Could not save.'), 'Could not save.');
  assert.equal(refusalWords(null), 'That did not go through. Try again.');
  for (const code of ['NAME_TAKEN', 'PROJECT_ARCHIVED', 'ALREADY_ANSWERED', 'MYSTERY_CODE']) {
    assert.doesNotMatch(refusalWords(refused(code)), /[A-Z]{3,}_[A-Z]/, code);
  }
});

test('a task that moved on is a refresh, not a failure', () => {
  for (const code of ['TASK_NOT_OPEN', 'TASK_NOT_RESUMABLE', 'TASK_NOT_WAITING', 'ALREADY_ANSWERED']) {
    assert.equal(refusalIsStale(refused(code)), true, code);
  }
  assert.equal(refusalIsStale(refused('INSTRUCTION_REQUIRED')), false);
  assert.equal(refusalIsStale(new Error('HTTP 500')), false);
});

test('a refused account binding asks the owner the right next thing', () => {
  assert.deepEqual(
    accountBindStep(refused('ACCOUNT_CHOICE_REQUIRED', { accounts: [
      { accountId: 'ca_1', label: 'nathan@work.example' },
      { accountId: 'ca_1', label: 'duplicate' },
      { accountId: 'ca_2', label: '' },
      { label: 'no id' },
    ] })),
    { step: 'choose', accounts: [{ accountId: 'ca_1', label: 'nathan@work.example' }, { accountId: 'ca_2', label: 'Connected account' }] },
  );
  assert.deepEqual(accountBindStep(refused('ACCOUNT_CHOICE_REQUIRED', { accounts: [] })), { step: 'not_connected' },
    'a choice with nothing to choose from is nothing connected');
  assert.deepEqual(accountBindStep(refused('ACCOUNT_NOT_CONNECTED')), { step: 'not_connected' });
  assert.deepEqual(
    accountBindStep(refused('CONFLICTING_ACCOUNT', { bound: { accountId: 'ca_9', label: 'old@work.example' } })),
    { step: 'conflict', bound: { accountId: 'ca_9', label: 'old@work.example' } },
  );
  assert.deepEqual(accountBindStep(refused('CONFLICTING_ACCOUNT')), { step: 'conflict', bound: { accountId: '', label: 'another account' } });
  assert.deepEqual(accountBindStep(refused('TOO_MANY_RESOURCES')), {
    step: 'failed',
    message: 'This project already lists as much as it can hold. Remove something first.',
  });
  assert.deepEqual(accountBindStep(new Error('HTTP 500')), { step: 'failed', message: 'That account could not be added. Try again.' });
});

test('a failure handed to a screen keeps what it was and loses its code', () => {
  const gone = inWords(refused('PROJECT_NOT_FOUND'), 'Could not load this project.') as Error & { status?: number; offline?: boolean };
  assert.equal(gone.message, 'That project is no longer on your Mac.');
  assert.equal(gone.status, 409);
  const away = inWords({ offline: true, status: 0 }, 'Could not load this project.') as Error & { offline?: boolean };
  assert.equal(away.offline, true, 'a screen still says the Mac is out of reach');
  assert.equal(inWords(new Error('PROJECT_REQUEST_FAILED'), 'Could not load this project.').message, 'Could not load this project.');
});
