import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamingPcmResampler, float32ToPcm16, pcm16Seconds, pcm16ToWav } from './pcm.js';

test('48 kHz in becomes 16 kHz out, across chunk boundaries', () => {
  const r = new StreamingPcmResampler(48_000);
  let out = 0;
  for (let i = 0; i < 10; i += 1) out += r.append(new Float32Array(4800).fill(0.1)).length;
  assert.ok(Math.abs(out - 16_000) <= 2, `got ${out} samples for one second`);
});

test('the WAV header says 16 kHz mono 16-bit and the data length is exact', async () => {
  const pcm = float32ToPcm16(new Float32Array(16_000).fill(0.5));
  assert.equal(pcm.byteLength, 32_000);
  const wav = pcm16ToWav([pcm]);
  assert.equal(wav.type, 'audio/wav');
  assert.equal(wav.size, 44 + 32_000);
  const view = new DataView(await wav.arrayBuffer());
  assert.equal(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)), 'RIFF');
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 32_000);
  assert.equal(pcm16Seconds(32_000), 1);
});
