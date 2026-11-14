#!/usr/bin/env node
/**
 * Writes the placeholder toolbar icons (extension/icons/icon{16,48,128}.png):
 * an indigo rounded square with three white "sound wave" bars. Original
 * artwork drawn in code, no brand logos, no dependencies (PNG encoded
 * with node:zlib).
 *
 *   node extension/scripts/make-icons.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "..", "icons");

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const encodePng = (size, pixel) => {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

/** Inside a rounded rectangle (coordinates in 0..1 units). */
const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return x >= x0 && x <= x1 && y >= y0 && y <= y1 && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

const BG = [79, 70, 229, 255];
const FG = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];
const BARS = [
  { x: 0.3, h: 0.3 },
  { x: 0.5, h: 0.52 },
  { x: 0.7, h: 0.3 },
];

const drawIcon = (size) =>
  encodePng(size, (px, py) => {
    const x = px / size;
    const y = py / size;
    if (!inRoundRect(x, y, 0, 0, 1, 1, 0.22)) return CLEAR;
    const w = 0.12;
    const onBar = BARS.some((bar) =>
      inRoundRect(x, y, bar.x - w / 2, 0.5 - bar.h / 2, bar.x + w / 2, 0.5 + bar.h / 2, w / 2)
    );
    return onBar ? FG : BG;
  });

for (const size of [16, 48, 128]) {
  writeFileSync(join(outDir, `icon${size}.png`), drawIcon(size));
}

console.log(`Wrote icons to ${outDir}`);
