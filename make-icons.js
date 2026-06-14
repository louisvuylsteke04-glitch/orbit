/* Orbit icon — editorial monochrome mark: an instrument ring with one accent
   body on a near-black tile. AA, dependency-free. */
const zlib = require("zlib"), fs = require("fs"), path = require("path");
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const b = Buffer.concat([Buffer.from(t, "ascii"), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(b), 0); return Buffer.concat([l, b, c]); }
function encodePNG(w, h, rgba) { const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]); const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; const st = w * 4, raw = Buffer.alloc((st + 1) * h); for (let y = 0; y < h; y++) { raw[y * (st + 1)] = 0; rgba.copy(raw, y * (st + 1) + 1, y * st, y * st + st); } const idat = zlib.deflateSync(raw, { level: 9 }); return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]); }
const lerp = (a, b, t) => a + (b - a) * t, cov = (d) => Math.max(0, Math.min(1, 0.5 - d));

function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const ink = [24, 22, 18], paper = [243, 241, 236], accent = [154, 59, 46];
  const cx = size / 2, cy = size / 2;
  const R = size * 0.30, ringHalf = size * 0.012;
  const centerR = size * 0.040;
  const ba = -Math.PI / 4, bx = cx + R * Math.cos(ba), by = cy + R * Math.sin(ba), bodyR = size * 0.066;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let r = ink[0], g = ink[1], b = ink[2];
      const d = Math.hypot(x + .5 - cx, y + .5 - cy);
      const ring = cov(Math.abs(d - R) - ringHalf);
      const center = cov(d - centerR);
      const pa = Math.max(ring, center);
      if (pa > 0) { r = lerp(r, paper[0], pa); g = lerp(g, paper[1], pa); b = lerp(b, paper[2], pa); }
      const bd = Math.hypot(x + .5 - bx, y + .5 - by), body = cov(bd - bodyR);
      if (body > 0) { r = lerp(r, accent[0], body); g = lerp(g, accent[1], body); b = lerp(b, accent[2], body); }
      buf[i] = Math.round(r); buf[i + 1] = Math.round(g); buf[i + 2] = Math.round(b); buf[i + 3] = 255;
    }
  }
  return encodePNG(size, size, buf);
}
const outDir = path.join(__dirname, "icons"); fs.mkdirSync(outDir, { recursive: true });
[32, 180, 192, 512].forEach((s) => { fs.writeFileSync(path.join(outDir, `icon-${s}.png`), drawIcon(s)); console.log("icon-" + s); });
