/**
 * The tray icon, drawn here as PNG bytes. Electron decodes only PNG and JPEG
 * into a native image: an SVG data URL comes back empty (Electron 43, on every
 * platform), which left the menu bar and the Windows notification area with a
 * blank slot. No image asset ships; each state and size is drawn on demand.
 */
import { deflateSync } from 'node:zlib';

export type TrayIconState = 'idle' | 'active' | 'recording';

/** Ring color, then center dot color. */
const COLORS: Record<TrayIconState, [string, string]> = {
  idle: ['#666c7a', '#3a3f4a'],
  active: ['#ff5a35', '#b9ff36'],
  recording: ['#ff3b30', '#ffffff'],
};

/** The design is drawn in a 22-unit box: a faint halo, a ring, a center dot. */
const BOX = 22;
const CENTER = 11;
const HALO_RADIUS = 9;
const HALO_OPACITY = 0.18;
const RING_RADIUS = 6;
const RING_HALF_WIDTH = 0.7;
const DOT_RADIUS = 2.6;
/** Samples per pixel side; 4×4 keeps the 16 px edges smooth. */
const SUPERSAMPLE = 4;

/**
 * The size, in points or logical pixels, and the pixel densities to draw it at.
 * macOS: the 22-point menu bar size this design was made for. Windows: the
 * notification area's 16 px small icon, at the usual display scales so the
 * system never stretches a smaller bitmap.
 */
export function trayIconLayout(platform: NodeJS.Platform): { size: number; scales: number[] } {
  return platform === 'darwin'
    ? { size: 22, scales: [1, 2] }
    : { size: 16, scales: [1, 1.25, 1.5, 2] };
}

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Straight-alpha RGBA, `px` pixels square. */
export function trayIconPixels(state: TrayIconState, px: number): Uint8Array {
  const [ring, dot] = COLORS[state].map(rgb) as [[number, number, number], [number, number, number]];
  const out = new Uint8Array(px * px * 4);
  const unit = BOX / px;
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < px; y += 1) {
    for (let x = 0; x < px; x += 1) {
      // Average premultiplied color over the samples, then un-premultiply.
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const ux = (x + (sx + 0.5) / SUPERSAMPLE) * unit - CENTER;
          const uy = (y + (sy + 0.5) / SUPERSAMPLE) * unit - CENTER;
          const d = Math.hypot(ux, uy);
          // Layers bottom to top, each composited over the last.
          let sr = 0; let sg = 0; let sb = 0; let sa = 0;
          const over = (color: [number, number, number], alpha: number) => {
            sr = color[0] * alpha + sr * (1 - alpha);
            sg = color[1] * alpha + sg * (1 - alpha);
            sb = color[2] * alpha + sb * (1 - alpha);
            sa = alpha + sa * (1 - alpha);
          };
          if (d <= HALO_RADIUS) over(ring, HALO_OPACITY);
          if (Math.abs(d - RING_RADIUS) <= RING_HALF_WIDTH) over(ring, 1);
          if (d <= DOT_RADIUS) over(dot, 1);
          r += sr; g += sg; b += sb; a += sa;
        }
      }
      const i = (y * px + x) * 4;
      const alpha = a / samples;
      out[i + 3] = Math.round(alpha * 255);
      if (alpha > 0) {
        out[i] = Math.round(r / samples / alpha);
        out[i + 1] = Math.round(g / samples / alpha);
        out[i + 2] = Math.round(b / samples / alpha);
      }
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** The icon for `state` as a PNG, `px` pixels square. */
export function trayIconPng(state: TrayIconState, px: number): Buffer {
  const pixels = trayIconPixels(state, px);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(px, 0);
  header.writeUInt32BE(px, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  // Each scanline starts with filter type 0 (none).
  const raw = Buffer.alloc(px * (px * 4 + 1));
  for (let y = 0; y < px; y += 1) {
    raw[y * (px * 4 + 1)] = 0;
    raw.set(pixels.subarray(y * px * 4, (y + 1) * px * 4), y * (px * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
