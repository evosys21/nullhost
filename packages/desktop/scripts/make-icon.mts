// Writes build/icon.ico (16-256 px) from the same shield the tray draws, so the
// installer, the exe and the tray never drift apart. Run: node scripts/make-icon.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shieldPng } from "../src/main/icons.ts";

const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const images = sizes.map((s) => shieldPng("enabled", s));

// ICO: 6-byte header, 16-byte directory entry per image, then the PNG data
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
const dir = Buffer.alloc(16 * images.length);
let offset = header.length + dir.length;
images.forEach((png, i) => {
  const s = sizes[i]!;
  const e = i * 16;
  dir[e] = s >= 256 ? 0 : s;
  dir[e + 1] = s >= 256 ? 0 : s;
  dir[e + 2] = 0;
  dir[e + 3] = 0;
  dir.writeUInt16LE(1, e + 4);
  dir.writeUInt16LE(32, e + 6);
  dir.writeUInt32LE(png.length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += png.length;
});
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "build", "icon.ico");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, dir, ...images]));
console.log(`wrote ${out} (${sizes.join(", ")} px)`);
