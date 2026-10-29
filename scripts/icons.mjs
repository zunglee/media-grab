/**
 * Generates the toolbar icons as PNGs, with no image dependency.
 *
 * Chrome does not accept SVG for an MV3 action icon, and adding `sharp` to draw
 * four flat rectangles would be a native dependency for nothing. Node's zlib is
 * already there, and a PNG is a zlib stream with a header, so we write the
 * encoder (about 40 lines) instead of taking the dependency.
 *
 * The mark: three ascending signal bars over a baseline, in MediaGrab's amber on
 * the dark ground. It reads at 16px, which is the only size that really matters.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';

const GROUND = [23, 26, 29, 255]; // #171a1d
const AMBER = [224, 122, 45, 255]; // #e07a2d
const PALE = [232, 226, 216, 255]; // #e8e2d8

/** @param {number} size */
function drawIcon(size) {
  const pixels = new Uint8Array(size * size * 4);
  const set = (x, y, rgba) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const offset = (y * size + x) * 4;
    pixels[offset] = rgba[0];
    pixels[offset + 1] = rgba[1];
    pixels[offset + 2] = rgba[2];
    pixels[offset + 3] = rgba[3];
  };

  const radius = Math.max(2, Math.round(size * 0.18));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (insideRoundedRect(x, y, size, radius)) set(x, y, GROUND);
    }
  }

  // Three bars of increasing height, then a baseline: a level meter.
  const pad = Math.max(2, Math.round(size * 0.22));
  const barWidth = Math.max(1, Math.round(size * 0.11));
  const gap = Math.max(1, Math.round(size * 0.08));
  const baseY = size - pad;
  const heights = [0.28, 0.46, 0.62];

  let x = pad;
  for (let i = 0; i < heights.length; i += 1) {
    const barHeight = Math.round(size * heights[i]);
    const color = i === heights.length - 1 ? AMBER : PALE;
    for (let by = baseY - barHeight; by < baseY; by += 1) {
      for (let bx = x; bx < x + barWidth; bx += 1) set(bx, by, color);
    }
    x += barWidth + gap;
  }

  const baselineThickness = Math.max(1, Math.round(size * 0.06));
  for (let by = baseY; by < baseY + baselineThickness; by += 1) {
    for (let bx = pad; bx < size - pad; bx += 1) set(bx, by, AMBER);
  }

  return pixels;
}

function insideRoundedRect(x, y, size, radius) {
  const nearLeft = x < radius;
  const nearRight = x >= size - radius;
  const nearTop = y < radius;
  const nearBottom = y >= size - radius;
  if (!((nearLeft || nearRight) && (nearTop || nearBottom))) return true;
  const cx = nearLeft ? radius : size - radius - 1;
  const cy = nearTop ? radius : size - radius - 1;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** @param {Uint8Array} pixels @param {number} size */
function encodePng(pixels, size) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type; 0 = None.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** @param {string} outDir */
export function writeIcons(outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const png = encodePng(drawIcon(size), size);
    const file = join(outDir, `icon-${size}.png`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, png);
  }
}

if (process.argv[1]?.endsWith('icons.mjs')) {
  const target = process.argv[2] ?? 'dist/chrome/assets';
  writeIcons(target);
  console.log(`icons written to ${target}`);
}
