// Seeded random numbers + tileable noise used for terrain generation.
(function (Evo) {
  'use strict';

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class RNG {
    constructor(seed) {
      this.seed = seed >>> 0;
      this.next = mulberry32(this.seed);
    }
    float(a = 0, b = 1) { return a + (b - a) * this.next(); }
    int(a, b) { return Math.floor(this.float(a, b + 1)); }
    chance(p) { return this.next() < p; }
    gauss() {
      let u = 0;
      while (u === 0) u = this.next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
    }
    pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  }

  // Fractal value noise that tiles seamlessly on a w x h grid, so a
  // wrap-around (torus) world has no visible seams. Returns values in 0..1.
  function tileableFbm(rng, w, h, baseCells, octaves) {
    const out = new Float32Array(w * h);
    let amp = 1;
    for (let o = 0; o < octaves; o++) {
      const cx = Math.max(2, Math.round(baseCells * Math.pow(2, o)));
      const cy = Math.max(2, Math.round((cx * h) / w));
      const lat = new Float32Array(cx * cy);
      for (let i = 0; i < lat.length; i++) lat[i] = rng.next();
      for (let y = 0; y < h; y++) {
        const fy = (y / h) * cy;
        const y0 = Math.floor(fy);
        const y1 = (y0 + 1) % cy;
        let ty = fy - y0;
        ty = ty * ty * (3 - 2 * ty);
        for (let x = 0; x < w; x++) {
          const fx = (x / w) * cx;
          const x0 = Math.floor(fx);
          const x1 = (x0 + 1) % cx;
          let tx = fx - x0;
          tx = tx * tx * (3 - 2 * tx);
          const a = lat[y0 * cx + x0] + (lat[y0 * cx + x1] - lat[y0 * cx + x0]) * tx;
          const b = lat[y1 * cx + x0] + (lat[y1 * cx + x1] - lat[y1 * cx + x0]) * tx;
          out[y * w + x] += amp * (a + (b - a) * ty);
        }
      }
      amp *= 0.5;
    }
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < out.length; i++) {
      if (out[i] < min) min = out[i];
      if (out[i] > max) max = out[i];
    }
    const span = max - min || 1;
    for (let i = 0; i < out.length; i++) out[i] = (out[i] - min) / span;
    return out;
  }

  Evo.RNG = RNG;
  Evo.tileableFbm = tileableFbm;
})((globalThis.Evo = globalThis.Evo || {}));
