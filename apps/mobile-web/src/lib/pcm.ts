/**
 * Microphone samples to the WAV the Mac's transcriber reads: 16 kHz, mono,
 * 16-bit PCM. Pure functions, so the encoder is tested without a microphone.
 * Mirrors the desktop's local-meeting-recorder; the phone carries its own
 * copy because the two apps do not share a lib yet.
 */
export const OUTPUT_SAMPLE_RATE = 16_000;

/** Stateful linear resampler: carries the boundary sample and cursor between
 *  Web Audio callbacks so there is no click at every chunk. */
export class StreamingPcmResampler {
  private carry = new Float32Array(0);
  private position = 0;
  private readonly ratio: number;

  constructor(inputSampleRate: number, outputSampleRate = OUTPUT_SAMPLE_RATE) {
    if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0) throw new Error('invalid input sample rate');
    this.ratio = inputSampleRate / outputSampleRate;
  }

  append(input: Float32Array): Float32Array {
    if (input.length === 0) return new Float32Array(0);
    const samples = new Float32Array(this.carry.length + input.length);
    samples.set(this.carry);
    samples.set(input, this.carry.length);
    const output: number[] = [];
    while (this.position < samples.length - 1) {
      const left = Math.floor(this.position);
      const fraction = this.position - left;
      output.push(samples[left] + ((samples[left + 1] - samples[left]) * fraction));
      this.position += this.ratio;
    }
    const consumed = Math.min(Math.floor(this.position), samples.length - 1);
    this.carry = samples.slice(consumed);
    this.position -= consumed;
    return Float32Array.from(output);
  }
}

export function float32ToPcm16(samples: Float32Array): ArrayBuffer {
  const pcm = new ArrayBuffer(samples.length * 2);
  const view = new DataView(pcm);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, sample < 0 ? Math.round(sample * 32_768) : Math.round(sample * 32_767), true);
  }
  return pcm;
}

export function pcm16ToWav(chunks: ArrayBuffer[], sampleRate = OUTPUT_SAMPLE_RATE): Blob {
  let dataLength = 0;
  for (const c of chunks) dataLength += c.byteLength;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataLength, true);
  let offset = 44;
  for (const c of chunks) { new Uint8Array(buffer, offset, c.byteLength).set(new Uint8Array(c)); offset += c.byteLength; }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Seconds of speech in the captured bytes; the composer refuses a tap that recorded nothing. */
export function pcm16Seconds(bytes: number, sampleRate = OUTPUT_SAMPLE_RATE): number {
  return bytes / 2 / sampleRate;
}
