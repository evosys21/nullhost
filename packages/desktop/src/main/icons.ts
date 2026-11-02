import { deflateSync } from "node:zlib";

// Tray icons are drawn in code (a shield in the state colour) so there are no
// binary assets to keep in sync with the palette. Encoded as PNG for nativeImage.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(size: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
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
}

// The badge outline, the same path as the sidebar logo (Logo.vue) in unit coordinates:
// M50 5 L88 15 V45 C88 69 71 85 50 95 (mirrored on the left).
const bezier = (t: number, a: number, b: number, c: number, d: number) =>
  (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d;

/** half the shield's width at height y, in unit coordinates */
function shieldHalf(y: number): number {
  if (y < 0.05 || y > 0.95) return -1;
  if (y < 0.15) return (0.38 * (y - 0.05)) / 0.1; // peaked top
  if (y <= 0.45) return 0.38; // straight sides
  // curved base: y(t) rises monotonically, so bisect for t
  let lo = 0, hi = 1;
  for (let i = 0; i < 20; i++) {
    const t = (lo + hi) / 2;
    if (bezier(t, 0.45, 0.69, 0.85, 0.95) < y) lo = t;
    else hi = t;
  }
  return bezier((lo + hi) / 2, 0.88, 0.88, 0.71, 0.5) - 0.5;
}

/** inside the shield outline, in unit coordinates */
function inShield(x: number, y: number): boolean {
  return Math.abs(x - 0.5) <= shieldHalf(y);
}

/** inside the white mark, centred on the shield's visual centre (y 0.47) */
function inMark(x: number, y: number, kind: "check" | "pause" | "dash"): boolean {
  const w = 0.075;
  if (kind === "pause") return y > 0.3 && y < 0.64 && (Math.abs(x - 0.4) < w || Math.abs(x - 0.6) < w);
  if (kind === "dash") return y > 0.41 && y < 0.53 && Math.abs(x - 0.5) < 0.2;
  // check: two segments (0.31,0.47)->(0.45,0.61)->(0.69,0.34)
  const seg = (ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) < w;
  };
  return seg(0.31, 0.47, 0.45, 0.61) || seg(0.45, 0.61, 0.69, 0.34);
}

export type IconState = "enabled" | "disabled" | "paused";

const COLORS: Record<IconState, [number, number, number]> = {
  enabled: [0x15, 0x80, 0x3d],
  paused: [0x1d, 0x4e, 0xd8],
  disabled: [0xb4, 0x53, 0x09],
};

const MARKS: Record<IconState, "check" | "pause" | "dash"> = { enabled: "check", paused: "pause", disabled: "dash" };

/** A size x size PNG of the shield for `state`, 4x4 supersampled. */
export function shieldPng(state: IconState, size = 32): Buffer {
  const [r, g, b] = COLORS[state];
  const px = new Uint8Array(size * size * 4);
  const ss = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0, white = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const ux = (x + (sx + 0.5) / ss) / size;
          const uy = (y + (sy + 0.5) / ss) / size;
          if (inShield(ux, uy)) {
            cover++;
            if (inMark(ux, uy, MARKS[state])) white++;
          }
        }
      }
      const i = (y * size + x) * 4;
      const a = cover / (ss * ss);
      const wf = cover ? white / cover : 0;
      px[i] = Math.round(r + (255 - r) * wf);
      px[i + 1] = Math.round(g + (255 - g) * wf);
      px[i + 2] = Math.round(b + (255 - b) * wf);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, px);
}
