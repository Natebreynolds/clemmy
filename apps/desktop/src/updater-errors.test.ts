/**
 * Run: npx tsx --test apps/desktop/src/updater-errors.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isMissingReleaseMetadataError, updaterErrorMessage } from './updater-errors.js';

test('isMissingReleaseMetadataError detects electron-updater latest-mac.yml 404', () => {
  const err = new Error('Cannot find latest-mac.yml in the latest release artifacts (https://github.com/Natebreynolds/clemmy/releases/download/v1.3.2/latest-mac.yml): HttpError: 404');
  assert.equal(isMissingReleaseMetadataError(err), true);
});

test('isMissingReleaseMetadataError detects generic missing updater yml metadata', () => {
  assert.equal(isMissingReleaseMetadataError('latest.yml not found: 404'), true);
  assert.equal(isMissingReleaseMetadataError('Cannot find latest-linux.yml in the latest release artifacts'), true);
});

test('isMissingReleaseMetadataError does not hide unrelated updater failures', () => {
  assert.equal(isMissingReleaseMetadataError(new Error('download failed: sha512 mismatch')), false);
  assert.equal(isMissingReleaseMetadataError(new Error('GitHub API rate limit exceeded')), false);
  assert.equal(isMissingReleaseMetadataError(new Error('latest-mac.yml signature verification failed')), false);
});

test('updaterErrorMessage normalizes non-Error values', () => {
  assert.equal(updaterErrorMessage('plain'), 'plain');
  assert.equal(updaterErrorMessage(new Error('boom')), 'boom');
});
