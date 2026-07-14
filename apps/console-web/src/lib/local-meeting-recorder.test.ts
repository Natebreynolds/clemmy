import { test } from 'node:test';
import assert from 'node:assert/strict';
import { float32ToPcm16, StreamingPcmResampler } from './local-meeting-recorder';

test('streaming resampler preserves its interpolation cursor across chunks', () => {
  const resampler = new StreamingPcmResampler(48_000, 16_000);
  const a = resampler.append(Float32Array.from([0, 0.1, 0.2, 0.3, 0.4]));
  const b = resampler.append(Float32Array.from([0.5, 0.6, 0.7, 0.8, 0.9]));
  const end = resampler.flush();
  const values = [...a, ...b, ...end].map((value) => Number(value.toFixed(4)));
  assert.deepEqual(values, [0, 0.3, 0.6, 0.9]);
});

test('float32ToPcm16 clamps and encodes little-endian signed samples', () => {
  const pcm = float32ToPcm16(Float32Array.from([-2, -1, -0.5, 0, 0.5, 1, 2]));
  const view = new DataView(pcm);
  assert.deepEqual(
    Array.from({ length: 7 }, (_, index) => view.getInt16(index * 2, true)),
    [-32_768, -32_768, -16_384, 0, 16_384, 32_767, 32_767],
  );
});
