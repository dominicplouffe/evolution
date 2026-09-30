// Time-lapse: every few minutes, paint a small image of the whole map (same
// colours as the viewer, one dot per creature in its species colour) and keep
// it, so months of evolution can be played back as a movie. Older frames are
// thinned out: all from the last 7 days, one an hour up to 30 days, then one
// every 6 hours.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- minimal PNG encoder (RGB, 8 bit)
const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // no filter
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 'hsl(210, 70%, 55%)' or '#rrggbb' -> [r, g, b]
function cssRgb(s) {
  let m = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/.exec(s || '');
  if (m) {
    const h = Number(m[1]) / 360, sat = Number(m[2]) / 100, l = Number(m[3]) / 100;
    const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat, p = 2 * l - q;
    const f = (t) => {
      t = ((t % 1) + 1) % 1;
      const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
      return Math.round(v * 255);
    };
    return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
  }
  m = /^#([0-9a-f]{6})$/i.exec(s || '');
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4), 16)];
  return [220, 220, 220];
}

class Timelapse {
  constructor(dir, Evo) {
    this.dir = dir;
    this.Evo = Evo;
    this.index = path.join(dir, 'index.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    this.lastThin = 0;
  }

  // Paint the world into a PNG: 2 pixels per tile for normal maps, 1 for huge ones.
  render(sim) {
    const Evo = this.Evo, w = sim.world;
    const s = w.cols <= 320 ? 2 : 1;
    const W = w.cols * s, H = w.rows * s;
    const tiles = new Uint8ClampedArray(w.cols * w.rows * 4);
    Evo.paintTerrain(w, sim.time, false, tiles);
    const rgb = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const t = (Math.floor(y / s) * w.cols + Math.floor(x / s)) * 4, o = (y * W + x) * 3;
        rgb[o] = tiles[t]; rgb[o + 1] = tiles[t + 1]; rgb[o + 2] = tiles[t + 2];
      }
    }
    const colors = new Map();
    const T = Evo.K.TILE;
    for (const c of sim.creatures) {
      let col = colors.get(c.species);
      if (!col) {
        const sp = sim.species.get(c.species);
        col = cssRgb(sp && sp.color);
        colors.set(c.species, col);
      }
      const px = Math.floor((c.x / T) * s), py = Math.floor((c.y / T) * s);
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const x = (px + dx) % W, y = (py + dy) % H;
          const o = (y * W + x) * 3;
          rgb[o] = col[0]; rgb[o + 1] = col[1]; rgb[o + 2] = col[2];
        }
      }
    }
    return png(W, H, rgb);
  }

  capture(sim) {
    const now = new Date();
    const f = now.toISOString().replace(/[:.]/g, '-') + '.png';
    fs.writeFileSync(path.join(this.dir, f), this.render(sim));
    const year = Math.floor(sim.time / sim.cfg.seasonLength) + 1;
    const line = { f, wall: now.getTime(), t: Math.round(sim.time), year, n: sim.creatures.length, seed: sim.seed };
    fs.appendFileSync(this.index, JSON.stringify(line) + '\n');
    if (Date.now() - this.lastThin > 6 * 3600000) this.thin();
    return line;
  }

  list() {
    try {
      return fs.readFileSync(this.index, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  // All frames from the last 7 days, then one per hour up to 30 days, then one
  // per 6 hours; delete the rest.
  thin() {
    this.lastThin = Date.now();
    const now = Date.now(), H = 3600000, D = 24 * H;
    const keep = [], seen = new Set();
    for (const e of this.list()) {
      const age = now - e.wall;
      const slot = age < 7 * D ? e.f : age < 30 * D ? 'h' + Math.floor(e.wall / H) : 's' + Math.floor(e.wall / (6 * H));
      if (seen.has(slot)) { try { fs.unlinkSync(path.join(this.dir, e.f)); } catch (err) { /* already gone */ } continue; }
      seen.add(slot);
      keep.push(e);
    }
    const tmp = this.index + '.tmp';
    fs.writeFileSync(tmp, keep.map((e) => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : ''));
    fs.renameSync(tmp, this.index);
  }

  file(name) {
    if (!/^[\w.-]+\.png$/.test(name)) return null;
    try { return fs.readFileSync(path.join(this.dir, name)); } catch (e) { return null; }
  }
}

module.exports = { Timelapse, png, cssRgb };
