/**
 * Zero-dependency PNG icon generator for OpsPilot.
 *
 * Draws the app mark analytically with signed distance fields so the result is
 * cleanly antialiased at any size, then encodes it as a PNG using only Node's
 * built-in zlib. Output feeds `tauri icon`, which produces every platform size.
 *
 *   node scripts/gen-icon.mjs
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../src-tauri/icons/source.png");

// --- tiny vector math -------------------------------------------------------

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mix = (a, b, t) => a + (b - a) * t;

/** Smooth 0..1 ramp across `edge0..edge1`; our antialiasing primitive. */
function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Signed distance to an axis-aligned rounded rectangle centred at (cx, cy). */
function sdRoundRect(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Signed distance to a thick line segment (a capsule). */
function sdSegment(px, py, ax, ay, bx, by, thickness) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h) - thickness;
}

/** Signed distance to a 4-pointed sparkle: union of two rotated capsule crosses. */
function sdSparkle(px, py, cx, cy, radius, thickness) {
  const x = px - cx;
  const y = py - cy;
  const vert = sdSegment(x, y, 0, -radius, 0, radius, thickness);
  const horz = sdSegment(x, y, -radius, 0, radius, 0, thickness);
  const d = Math.min(vert, horz);
  // Pinch the arms toward the tips so it reads as a star, not a plus.
  const pinch = 1 - 0.55 * (Math.hypot(x, y) / radius);
  return d + thickness * (1 - clamp(pinch, 0, 1));
}

// --- palette ----------------------------------------------------------------

const BG_TOP = [0x12, 0x1a, 0x26];
const BG_BOTTOM = [0x0a, 0x0f, 0x17];
const RIM = [0x2c, 0x3b, 0x51];
const TEAL = [0x3d, 0xd6, 0xb5];
const CYAN = [0x4f, 0xa8, 0xf5];
const AMBER = [0xf5, 0xa6, 0x23];

/** Alpha-composite `src` (with coverage `a`) over `dst`, both premultiplied-free RGB. */
function over(dst, src, a) {
  if (a <= 0) return dst;
  return [
    mix(dst[0], src[0], a),
    mix(dst[1], src[1], a),
    mix(dst[2], src[2], a),
  ];
}

// --- the mark ---------------------------------------------------------------

const C = SIZE / 2;
const PLATE_HALF = SIZE * 0.44; // 1024 -> 450
const PLATE_RADIUS = SIZE * 0.175;

function shade(px, py) {
  // Everything is expressed in pixel units for readability.
  const plate = sdRoundRect(px, py, C, C, PLATE_HALF, PLATE_HALF, PLATE_RADIUS);
  const plateCoverage = 1 - smoothstep(-1, 1, plate);
  if (plateCoverage <= 0) return [0, 0, 0, 0];

  // Vertical gradient body.
  const t = clamp((py - (C - PLATE_HALF)) / (PLATE_HALF * 2), 0, 1);
  let rgb = [
    mix(BG_TOP[0], BG_BOTTOM[0], t),
    mix(BG_TOP[1], BG_BOTTOM[1], t),
    mix(BG_TOP[2], BG_BOTTOM[2], t),
  ];

  // Inner rim highlight: a 6px band just inside the plate edge.
  const rimBand = 1 - smoothstep(0, SIZE * 0.012, Math.abs(plate + SIZE * 0.012));
  rgb = over(rgb, RIM, rimBand * 0.85);

  // Prompt chevron ">" — two capsules meeting at a point, left of centre.
  const chevX = C - SIZE * 0.115;
  const chevTop = C - SIZE * 0.145;
  const chevMid = C + SIZE * 0.005;
  const chevTip = chevX + SIZE * 0.135;
  const stroke = SIZE * 0.042;
  const upper = sdSegment(px, py, chevX, chevTop, chevTip, chevMid, stroke);
  const lower = sdSegment(px, py, chevX, chevMid + (chevMid - chevTop), chevTip, chevMid, stroke);
  const chevron = Math.min(upper, lower);
  const chevronCoverage = 1 - smoothstep(-1.2, 1.2, chevron);
  // Tint the chevron along its length: teal at the base, cyan at the tip.
  const chevT = clamp((px - chevX) / (chevTip - chevX), 0, 1);
  const chevColor = [
    mix(TEAL[0], CYAN[0], chevT),
    mix(TEAL[1], CYAN[1], chevT),
    mix(TEAL[2], CYAN[2], chevT),
  ];
  rgb = over(rgb, chevColor, chevronCoverage);

  // Cursor bar sitting on the baseline to the right of the chevron.
  const barHalfW = SIZE * 0.105;
  const barHalfH = SIZE * 0.028;
  const barCx = C + SIZE * 0.135;
  const barCy = chevMid + (chevMid - chevTop) + stroke * 0.1;
  const bar = sdRoundRect(px, py, barCx, barCy, barHalfW, barHalfH, barHalfH);
  rgb = over(rgb, AMBER, 1 - smoothstep(-1.2, 1.2, bar));

  // AI sparkle in the upper-right quadrant.
  const sparkle = sdSparkle(px, py, C + SIZE * 0.165, C - SIZE * 0.175, SIZE * 0.085, SIZE * 0.019);
  const sparkleCoverage = 1 - smoothstep(-1.2, 1.2, sparkle);
  rgb = over(rgb, AMBER, sparkleCoverage);
  // Soft glow around the sparkle.
  const glow = 1 - smoothstep(-SIZE * 0.02, SIZE * 0.075, sparkle);
  rgb = over(rgb, AMBER, glow * 0.14);

  return [rgb[0], rgb[1], rgb[2], plateCoverage * 255];
}

// --- rasterise with 2x2 supersampling --------------------------------------

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
const SS = 2;
const offsets = [];
for (let sy = 0; sy < SS; sy++) {
  for (let sx = 0; sx < SS; sx++) {
    offsets.push([(sx + 0.5) / SS, (sy + 0.5) / SS]);
  }
}

for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // PNG filter type: none
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (const [ox, oy] of offsets) {
      const s = shade(x + ox, y + oy);
      r += s[0];
      g += s[1];
      b += s[2];
      a += s[3];
    }
    const n = offsets.length;
    const i = rowStart + 1 + x * 4;
    raw[i] = Math.round(clamp(r / n, 0, 255));
    raw[i + 1] = Math.round(clamp(g / n, 0, 255));
    raw[i + 2] = Math.round(clamp(b / n, 0, 255));
    raw[i + 3] = Math.round(clamp(a / n, 0, 255));
  }
}

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KiB)`);
