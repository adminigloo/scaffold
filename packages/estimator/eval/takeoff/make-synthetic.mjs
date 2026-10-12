#!/usr/bin/env node
/**
 * Draws side-view stair diagrams for the takeoff eval: 2 risers, 3 (two steps
 * and a deck), 4 and 5, as 768 × 576 PNGs in ./photos/synthetic-*.png. No
 * dependencies: node's zlib and a hand-written PNG encoder.
 *
 *   node eval/takeoff/make-synthetic.mjs
 *
 * They test the PIPELINE and the PROMPT (does the reading come back in the
 * schema, does the count hold up on a clean picture), not the model's eye on
 * a real porch: that is what the real photos in fixtures.json are for. Free to
 * run: nothing here calls the model.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const WIDTH = 768;
const HEIGHT = 576;

// --- A tiny PNG encoder (RGB, 8-bit, filter 0 on every row) -----------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(pixels, width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    pixels.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Drawing ----------------------------------------------------------------------

function canvas() {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 3);
  return {
    pixels,
    rect(x0, y0, x1, y1, [r, g, b]) {
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(HEIGHT, Math.ceil(y1)); y += 1) {
        for (let x = Math.max(0, Math.floor(x0)); x < Math.min(WIDTH, Math.ceil(x1)); x += 1) {
          const i = (y * WIDTH + x) * 3;
          pixels[i] = r;
          pixels[i + 1] = g;
          pixels[i + 2] = b;
        }
      }
    },
  };
}

const SKY = [214, 230, 242];
const WALL = [233, 222, 205];
const GROUND = [120, 150, 95];
const CONCRETE = [168, 168, 160];
const EDGE = [90, 90, 86];
const DOOR = [120, 72, 48];

/**
 * A house wall with a door, and `risers` steps rising to it, seen from the
 * side. With `deck`, the last riser is a deck/porch edge (wider than a tread):
 * the "two steps and a deck = three risers" case from the founder's house.
 */
function stairs(risers, { deck = false } = {}) {
  const c = canvas();
  c.rect(0, 0, WIDTH, HEIGHT, SKY);
  const groundY = 470;
  const rise = 46; // px per riser (≈ 7.5 in at this drawing's imagined scale)
  const run = 70; // px per tread
  const wallX = 560;
  c.rect(wallX, 40, WIDTH, groundY, WALL);
  c.rect(0, groundY, WIDTH, HEIGHT, GROUND);
  const topY = groundY - risers * rise;
  c.rect(wallX + 40, topY - 210, wallX + 140, topY, DOOR);
  // The top level is one tread deep — or, with a deck, a deck several treads
  // deep; each level below sticks out one more tread. Drawn bottom-up, each
  // block filled to the ground, so the higher (shorter) ones sit on top.
  const topDepth = deck ? run * 2.4 : run;
  for (let i = 0; i < risers; i += 1) {
    const left = wallX - topDepth - (risers - 1 - i) * run;
    const top = groundY - (i + 1) * rise;
    c.rect(left, top, wallX, groundY, CONCRETE);
    c.rect(left, top, wallX, top + 4, EDGE); // the nosing line a person counts
    c.rect(left, top, left + 4, top + rise, EDGE); // the riser face
  }
  return encodePng(c.pixels, WIDTH, HEIGHT);
}

const out = join(here, "photos");
mkdirSync(out, { recursive: true });
const files = {
  "synthetic-2-risers.png": stairs(2),
  "synthetic-3-risers-deck.png": stairs(3, { deck: true }),
  "synthetic-4-risers.png": stairs(4),
  "synthetic-5-risers.png": stairs(5),
};
for (const [name, bytes] of Object.entries(files)) {
  writeFileSync(join(out, name), bytes);
  console.log(`wrote photos/${name} (${bytes.length} bytes)`);
}
