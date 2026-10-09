import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { trayIconLayout, trayIconPixels, trayIconPng, type TrayIconState } from './tray-icon.js';

const STATES: TrayIconState[] = ['idle', 'active', 'recording'];

function decode(png: Buffer): { width: number; height: number; rgba: Buffer } {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8;
  let width = 0;
  let height = 0;
  const data: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      assert.deepEqual([body[8], body[9]], [8, 6], '8-bit RGBA');
    }
    if (type === 'IDAT') data.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  assert.equal(raw.length, height * (width * 4 + 1));
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (width * 4 + 1)], 0, 'unfiltered scanline');
    raw.copy(rgba, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
  }
  return { width, height, rgba };
}

test('every state is a decodable PNG at every size the tray uses on macOS and Windows', () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const { size, scales } = trayIconLayout(platform);
    for (const scale of scales) {
      const px = Math.round(size * scale);
      for (const state of STATES) {
        const image = decode(trayIconPng(state, px));
        assert.equal(image.width, px);
        assert.equal(image.height, px);
        assert.ok(image.rgba.some((byte, i) => i % 4 === 3 && byte > 0), `${platform} ${state} ${px}px is not blank`);
      }
    }
  }
  assert.deepEqual(trayIconLayout('win32'), { size: 16, scales: [1, 1.25, 1.5, 2] });
});

test('the drawing keeps its design: transparent corners, the state color ring, the center dot', () => {
  const px = 44;
  const at = (pixels: Uint8Array, x: number, y: number) => [...pixels.subarray((y * px + x) * 4, (y * px + x) * 4 + 4)];
  const active = trayIconPixels('active', px);
  assert.deepEqual(at(active, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(at(active, 22, 22), [0xb9, 0xff, 0x36, 255]);
  // The ring sits 6 units (12 px at 2×) from the center.
  assert.deepEqual(at(active, 22 + 12, 22), [0xff, 0x5a, 0x35, 255]);
  // The halo is the ring color, faint.
  const halo = at(active, 22 + 16, 22);
  assert.deepEqual(halo.slice(0, 3), [0xff, 0x5a, 0x35]);
  assert.ok(halo[3]! > 30 && halo[3]! < 60);
  assert.deepEqual(at(trayIconPixels('recording', px), 22, 22), [255, 255, 255, 255]);
  assert.notDeepEqual(trayIconPng('idle', 16), trayIconPng('active', 16));
});

// Electron decodes only PNG and JPEG into a native image; an SVG data URL
// comes back empty, which is how the tray slot went blank on every platform.
test('the tray icon is built from these PNGs, never from an SVG data URL', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const builder = /function buildTrayIcon[\s\S]*?\n}\n/.exec(main)?.[0] ?? '';
  assert.match(builder, /trayIconPng\(/);
  assert.match(builder, /addRepresentation\(/);
  assert.doesNotMatch(main, /image\/svg\+xml/);
});
