/**
 * First run brings the phone along (OpenMausBot parity, 2026-10-30): an
 * optional Phone step between Voice and Ready shows the same pairing panel as
 * Apps & devices, and mints its pairing code only while that step is open.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./Onboarding.tsx', import.meta.url), 'utf8');

test('first run offers the phone as an optional step before Ready', () => {
  assert.match(source, /const steps = \['Connect', 'Work checks', 'Voice', 'Phone', 'Ready'\] as const;/);
  assert.match(source, /import \{ MobilePanel \} from '@\/components\/connect\/MobilePanel';/, 'the same pairing panel as Apps & devices');
  assert.match(source, /<div hidden=\{step !== 3\}>\{step === 3 \? <MobilePanel \/> : null\}<\/div>/, 'the pairing code is minted only on this step');
  assert.match(source, /index > 0 && index < steps\.length - 1 \? <small>Optional<\/small>/, 'every step between Connect and Ready is optional');
});
