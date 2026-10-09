/**
 * Voice mode's sounds that are not words: a soft two-note chime when Clem has
 * heard the owner, and a quiet tick while she works without speaking, so a
 * spoken conversation never goes dead. Tones are made in the page (no files)
 * and stay well under her voice. They never stand in for anything she says.
 */

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    const Ctor = typeof AudioContext !== 'undefined'
      ? AudioContext
      : (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    context ??= new Ctor();
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    return context;
  } catch {
    return null;
  }
}

function tone(frequency: number, offset: number, duration: number, level: number): void {
  const ctx = audio();
  if (!ctx) return;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  const at = ctx.currentTime + offset;
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(level, at + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(at);
  oscillator.stop(at + duration + 0.02);
}

/** She heard you. */
export function heardCue(): void {
  tone(660, 0, 0.12, 0.06);
  tone(880, 0.09, 0.16, 0.05);
}

/** She is still working. */
export function workingTick(): void {
  tone(523, 0, 0.18, 0.025);
}
