import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-auto-capture-clause-'));
process.env.CLEMENTINE_HOME = TEST_HOME;

const { loadUserProfile } = await import('../runtime/user-profile.js');
const {
  autoCaptureProvenanceFromDirectUserInput,
  captureInteractionSignals,
  extractAutoMemoryCandidates,
  extractProfilePatchFromMessage,
} = await import('./auto-capture.js');

test.after(() => rmSync(TEST_HOME, { recursive: true, force: true }));

const rememberedProjectOwner = [{
  kind: 'project' as const,
  content: 'the Falcon project owner is Mira Vale.',
  reason: 'explicit remember request',
}];

test('current-task scope does not erase a separate explicit remember clause', () => {
  for (const message of [
    'For this task, scrape 100 accounts and put them in a sheet. Also remember that the Falcon project owner is Mira Vale.',
    'Scrape 100 accounts and put them in a sheet during this task. Then remember that the Falcon project owner is Mira Vale.',
  ]) {
    assert.deepEqual(
      extractAutoMemoryCandidates(message),
      rememberedProjectOwner,
      message,
    );
  }
});

test('a task-scoped no-save clause does not cancel a separate explicit remember clause', () => {
  for (const message of [
    'Do not save this task as memory. Also remember that the Falcon project owner is Mira Vale.',
    'Do not save the scraping task as memory; remember that the Falcon project owner is Mira Vale.',
  ]) {
    assert.deepEqual(
      extractAutoMemoryCandidates(message),
      rememberedProjectOwner,
      message,
    );
  }
});

test('a same-content or turn-wide opt-out still wins over explicit remember wording', () => {
  for (const message of [
    'Remember that the Falcon project owner is Mira Vale. Do not save this as memory.',
    'Do not save anything from this turn to memory. Also remember that the Falcon project owner is Mira Vale.',
  ]) {
    assert.deepEqual(extractAutoMemoryCandidates(message), [], message);
  }
});

test('a no-save clause cannot leak a preferred name through the profile side channel', () => {
  const message = 'My name is Alex. Do not save this as memory.';
  const before = loadUserProfile();

  assert.equal(extractProfilePatchFromMessage(message), undefined);
  const result = captureInteractionSignals({
    message,
    sourceProvenance: autoCaptureProvenanceFromDirectUserInput('chat'),
  });

  assert.deepEqual(result.candidates, []);
  assert.equal(result.profilePatch, undefined);
  assert.equal(result.profile, undefined);
  assert.deepEqual(loadUserProfile(), before, 'profile storage remains byte-semantically unchanged');
});
