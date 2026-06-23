/**
 * Run: npx tsx --test src/dashboard/realtime-session-config.test.ts
 *
 * Characterizes the per-session Realtime VAD resolution used by
 * /api/console/realtime/session: the voice settings UI may override
 * turn-taking params via the request body, and every value MUST be clamped
 * to a safe range or fall back to the env-resolved default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clampRealtimeNumber,
  resolveRealtimeVad,
  REALTIME_VAD_RANGES,
  buildRealtimeSessionConfig,
} from './realtime-session-config.js';

const DEFAULTS = { vadThreshold: 0.55, prefixPaddingMs: 350, silenceMs: 430 };

test('absent body falls back to the env-resolved defaults', () => {
  assert.deepEqual(resolveRealtimeVad(undefined, DEFAULTS), DEFAULTS);
  assert.deepEqual(resolveRealtimeVad(null, DEFAULTS), DEFAULTS);
  assert.deepEqual(resolveRealtimeVad({}, DEFAULTS), DEFAULTS);
});

test('valid in-range overrides are honored', () => {
  const out = resolveRealtimeVad({ vadThreshold: 0.5, silenceMs: 300, prefixPaddingMs: 200 }, DEFAULTS);
  assert.deepEqual(out, { vadThreshold: 0.5, silenceMs: 300, prefixPaddingMs: 200 });
});

test('out-of-range overrides are clamped, never passed through', () => {
  const tooHigh = resolveRealtimeVad({ vadThreshold: 9, silenceMs: 99999, prefixPaddingMs: 99999 }, DEFAULTS);
  assert.equal(tooHigh.vadThreshold, REALTIME_VAD_RANGES.vadThreshold.max);
  assert.equal(tooHigh.silenceMs, REALTIME_VAD_RANGES.silenceMs.max);
  assert.equal(tooHigh.prefixPaddingMs, REALTIME_VAD_RANGES.prefixPaddingMs.max);

  const tooLow = resolveRealtimeVad({ vadThreshold: -1, silenceMs: 0, prefixPaddingMs: -50 }, DEFAULTS);
  assert.equal(tooLow.vadThreshold, REALTIME_VAD_RANGES.vadThreshold.min);
  assert.equal(tooLow.silenceMs, REALTIME_VAD_RANGES.silenceMs.min);
  assert.equal(tooLow.prefixPaddingMs, REALTIME_VAD_RANGES.prefixPaddingMs.min);
});

test('garbage / non-numeric overrides fall back to defaults', () => {
  const out = resolveRealtimeVad({ vadThreshold: 'fast', silenceMs: NaN, prefixPaddingMs: null }, DEFAULTS);
  assert.deepEqual(out, DEFAULTS);
});

test('"Snappy" preset values survive resolution unchanged (UI contract)', () => {
  // The renderer maps Snappy -> { silenceMs: 300, vadThreshold: 0.5 }.
  const out = resolveRealtimeVad({ vadThreshold: 0.5, silenceMs: 300 }, DEFAULTS);
  assert.equal(out.vadThreshold, 0.5);
  assert.equal(out.silenceMs, 300);
  assert.equal(out.prefixPaddingMs, DEFAULTS.prefixPaddingMs);
});

test('clampRealtimeNumber: standalone behavior', () => {
  assert.equal(clampRealtimeNumber(5, 1, 0, 10), 5);
  assert.equal(clampRealtimeNumber(50, 1, 0, 10), 10);
  assert.equal(clampRealtimeNumber(-5, 1, 0, 10), 0);
  assert.equal(clampRealtimeNumber('x', 7, 0, 10), 7);
  assert.equal(clampRealtimeNumber(undefined, 7, 0, 10), 7);
});

const BASE_CFG = {
  model: 'gpt-realtime',
  voice: 'marin',
  transcriptionModel: 'gpt-4o-mini-transcribe',
  instructions: 'hi',
  vad: { vadThreshold: 0.55, prefixPaddingMs: 350, silenceMs: 430 },
  idleTimeoutMs: 6500,
};

test('persona mode: model auto-responds and has the relay tool', () => {
  const cfg = buildRealtimeSessionConfig({ ...BASE_CFG, oneLoop: false }) as any;
  assert.equal(cfg.session.audio.input.turn_detection.create_response, true);
  assert.equal(cfg.session.tool_choice, 'auto');
  assert.equal(cfg.session.tools.length, 1);
  assert.equal(cfg.session.tools[0].name, 'send_to_clementine');
});

test('one-loop mode: ears+mouth only — no auto-response, no tools', () => {
  const cfg = buildRealtimeSessionConfig({ ...BASE_CFG, oneLoop: true }) as any;
  assert.equal(cfg.session.audio.input.turn_detection.create_response, false, 'must NOT auto-generate replies');
  assert.deepEqual(cfg.session.tools, [], 'no tools — the model decides nothing');
  assert.equal(cfg.session.tool_choice, 'none');
  // VAD + transcription still configured so STT keeps firing.
  assert.equal(cfg.session.audio.input.turn_detection.type, 'server_vad');
  assert.equal(cfg.session.audio.input.transcription.model, 'gpt-4o-mini-transcribe');
  assert.equal(cfg.session.audio.input.turn_detection.interrupt_response, true);
});
