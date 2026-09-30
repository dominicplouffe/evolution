// The map: terrain biomes, plant food per tile, corpses (meat), plus a
// spatial hash for fast "who is near me?" queries. Supports wrap-around.
(function (Evo) {
  'use strict';

  // Three kinds of plant food, each eaten best by a different body plan:
  // grass (small grazers), tree leaves (big browsers), water plants (swimmers).
  const FOODS = [
    { key: 'grass', label: 'Grass' },
    { key: 'leaves', label: 'Leaves' },
    { key: 'algae', label: 'Water plants' },
  ];

  // `food` = how much of each food type the biome can hold (0..1).
  const BIOMES = [
    { id: 0, name: 'Deep water', color: [30, 60, 110], lush: [30, 80, 105], food: { algae: 1.0 }, speed: 0, passable: false, water: true, cover: 0 },
    { id: 1, name: 'Shallows', color: [58, 110, 160], lush: [45, 130, 130], food: { algae: 1, grass: 0.05 }, speed: 0.4, passable: true, water: true, cover: 0.2 },
    { id: 2, name: 'Beach', color: [205, 190, 140], lush: [170, 180, 110], food: { grass: 0.15, algae: 0.1 }, speed: 0.85, passable: true, cover: 0 },
    { id: 3, name: 'Dry plains', color: [176, 158, 104], lush: [130, 160, 70], food: { grass: 0.45, leaves: 0.08 }, speed: 1, passable: true, cover: 0.2 },
    { id: 4, name: 'Grassland', color: [120, 140, 80], lush: [70, 150, 50], food: { grass: 0.9, leaves: 0.3 }, speed: 1, passable: true, cover: 0.4 },
    { id: 5, name: 'Forest', color: [70, 100, 60], lush: [30, 105, 40], food: { grass: 0.2, leaves: 3.5 }, speed: 0.75, passable: true, cover: 1 },
    { id: 6, name: 'Rock', color: [120, 115, 110], lush: [110, 120, 100], food: { grass: 0.05 }, speed: 0.55, passable: true, cover: 0.3 },
    { id: 7, name: 'Peak', color: [225, 225, 230], lush: [225, 225, 230], food: {}, speed: 0, passable: false, cover: 0 },
  ];

  class SpatialHash {
    constructor(world, cellSize) {
      this.world = world;
      this.cell = cellSize;
      this.cols = Math.ceil(world.width / cellSize);
      this.rows = Math.ceil(world.height / cellSize);
      this.buckets = new Array(this.cols * this.rows);
      for (let i = 0; i < this.buckets.length; i++) this.buckets[i] = [];
    }
    rebuild(items) {
      for (const b of this.buckets) b.length = 0;
      for (const it of items) {
        const cx = Evo.clamp(Math.floor(it.x / this.cell), 0, this.cols - 1);
        const cy = Evo.clamp(Math.floor(it.y / this.cell), 0, this.rows - 1);
        this.buckets[cy * this.cols + cx].push(it);
      }
    }
    // Calls fn(item, dx, dy, d2) for every item within radius r of (x, y).
    query(x, y, r, fn) {
      const w = this.world;
      const c = this.cell;
      const r2 = r * r;
      const wrap = w.wrap, W = w.width, H = w.height, hw = W / 2, hh = H / 2;
      const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
      const y0 = Math.floor((y - r) / c), y1 = Math.floor((y + r) / c);
      const maxX = Math.min(x1, x0 + this.cols - 1), maxY = Math.min(y1, y0 + this.rows - 1);
      for (let cy = y0; cy <= maxY; cy++) {
        let ry = cy;
        if (ry < 0 || ry >= this.rows) {
          if (!w.wrap) continue;
          ry = ((ry % this.rows) + this.rows) % this.rows;
        }
        for (let cx = x0; cx <= maxX; cx++) {
          let rx = cx;
          if (rx < 0 || rx >= this.cols) {
            if (!w.wrap) continue;
            rx = ((rx % this.cols) + this.cols) % this.cols;
          }
          const b = this.buckets[ry * this.cols + rx];
          for (let i = 0; i < b.length; i++) {
            const it = b[i];
            // Wrap-aware delta, inlined: this loop is the hottest in the game.
            let dx = it.x - x, dy = it.y - y;
            if (wrap) {
              if (dx > hw) dx -= W; else if (dx < -hw) dx += W;
              if (dy > hh) dy -= H; else if (dy < -hh) dy += H;
            }
            const d2 = dx * dx + dy * dy;
            if (d2 <= r2) fn(it, dx, dy, d2);
          }
        }
      }
    }
  }

  // Which biome a tile is, from its elevation, moisture and the sea level.
  function biomeFor(e, m, wl) {
    if (e < wl - 0.07) return 0;
    if (e < wl) return 1;
    if (e < wl + 0.035) return 2;
    if (e > 0.9) return 7;
    if (e > 0.8) return 6;
    if (m < 0.35) return 3;
    if (m < 0.66) return 4;
    return 5;
  }

  function heatColor(t) {
    const stops = [[-15, [40, 80, 200]], [5, [150, 190, 235]], [15, [235, 232, 215]], [25, [240, 160, 90]], [35, [200, 50, 40]]];
    if (t <= stops[0][0]) return stops[0][1].slice();
    for (let k = 1; k < stops.length; k++) {
      if (t <= stops[k][0]) {
        const [t0, c0] = stops[k - 1], [t1, c1] = stops[k];
        const f = (t - t0) / (t1 - t0);
        return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
      }
    }
    return stops[stops.length - 1][1].slice();
  }

  // Map colours, one RGBA pixel per tile, into `d`: bare -> lush with the
  // plant food, snow and ice in the cold, or the temperature (heat map).
  // Shared by the renderer and the server's time-lapse.
  function paintTerrain(w, time, heatMap, d) {
    const B = BIOMES;
    const winter = Evo.clamp((1 - w.season(time)) * 0.8, 0, 0.5);
    const F = w.food;
    const shift = w.climateShift() + w.seasonSwing(time) + w.dayTemp(time);
    for (let i = 0; i < w.biome.length; i++) {
      const b = B[w.biome[i]];
      const o = i * 4;
      const temp = w.tempBase[i] + shift;
      if (heatMap) {
        // Blue (cold) -> pale (mild) -> red (hot); water a little darker.
        const c = heatColor(temp);
        if (b.water) { c[0] = c[0] * 0.55 + 18; c[1] = c[1] * 0.55 + 40; c[2] = c[2] * 0.55 + 80; }
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
        continue;
      }
      const max = F.grass.max[i] + F.leaves.max[i] + F.algae.max[i];
      let t = max > 0 ? (F.grass.amt[i] + F.leaves.amt[i] + F.algae.amt[i]) / max : 0;
      t *= 1 - winter * 0.6;
      let r = b.color[0] + (b.lush[0] - b.color[0]) * t;
      let g = b.color[1] + (b.lush[1] - b.color[1]) * t;
      let bl = b.color[2] + (b.lush[2] - b.color[2]) * t;
      // Snow on frozen land, ice on very cold water.
      const snow = b.water ? Evo.clamp((-temp - 4) / 10, 0, 0.7) : Evo.clamp(-temp / 8, 0, 0.85);
      if (snow > 0) {
        const s = b.water ? [205, 225, 240] : [238, 242, 247];
        r += (s[0] - r) * snow; g += (s[1] - g) * snow; bl += (s[2] - bl) * snow;
      }
      d[o] = r; d[o + 1] = g; d[o + 2] = bl; d[o + 3] = 255;
    }
  }

  class World {
    constructor(cfg, rng) {
      const T = Evo.K.TILE;
      this.cfg = cfg;
      this.cols = cfg.worldWidth;
      this.rows = cfg.worldHeight;
      this.width = this.cols * T;
      this.height = this.rows * T;
      this.wrap = cfg.wrap;
      const n = this.cols * this.rows;
      this.biome = new Uint8Array(n);
      this.fertility = new Float32Array(n); // land food capacity, for spawning
      this.tempBase = new Float32Array(n);  // average temperature (°C) before seasons
      // food[key] = { amt, max } per tile.
      this.food = {};
      for (const f of FOODS) this.food[f.key] = { amt: new Float32Array(n), max: new Float32Array(n) };
      this.corpses = [];
      this.generate(rng);
      this.corpseHash = new SpatialHash(this, 64);
    }

    generate(rng) {
      const w = this.cols, h = this.rows;
      const base = Math.max(3, Math.round(w / 40));
      const elev = Evo.tileableFbm(rng, w, h, base, 5);
      const moist = Evo.tileableFbm(rng, w, h, base * 1.5, 4);
      const lushNoise = Evo.tileableFbm(rng, w, h, base * 3, 2);
      const wl = this.cfg.waterLevel;
      // Kept so the coastline can move when the sea level changes (climate cycles).
      this.elev = Float32Array.from(elev);
      this.moist = Float32Array.from(moist);
      this.lush = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const e = elev[i], m = moist[i];
        const b = biomeFor(e, m, wl);
        this.biome[i] = b;
        const lush = (this.lush[i] = 0.7 + 0.6 * lushNoise[i]);
        const start = rng.float(0.5, 0.9);
        for (const f of FOODS) {
          const cap = (BIOMES[b].food[f.key] || 0) * lush;
          this.food[f.key].max[i] = Evo.K.PLANT_MAX * cap;
          this.food[f.key].amt[i] = Evo.K.PLANT_MAX * cap * start;
        }
        this.fertility[i] = BIOMES[b].water ? 0 : ((BIOMES[b].food.grass || 0) + (BIOMES[b].food.leaves || 0)) * lush;
        // Temperature: warm in the middle band, cold toward the top and bottom
        // edges (continuous across wrap-around), and colder with altitude.
        const y = Math.floor(i / w);
        const warmth = 0.5 - 0.5 * Math.cos((2 * Math.PI * (y + 0.5)) / h);
        const altitude = Evo.clamp((e - (wl + 0.035)) / (1 - wl), 0, 1);
        this.tempBase[i] = 2 + 32 * warmth - 24 * altitude;
      }
    }

    // Temperature (°C) of a tile right now: its base, the season, and the
    // Climate setting. Seasons swing it by about ±12 °C at default strength.
    tempAt(i, time) {
      return this.tempBase[i] + this.climateShift() + this.seasonSwing(time) + this.dayTemp(time);
    }

    // Daylight, 0 (night) .. 1 (day), with a short dawn and dusk. A day
    // starts at dawn. Day length 0 turns nights off.
    light(time) {
      const L = this.cfg.dayLength;
      if (!(L > 0)) return 1;
      return Evo.clamp(0.5 + 1.6 * Math.sin((2 * Math.PI * time) / L), 0, 1);
    }

    // Days are a little warmer than nights (±3 °C).
    dayTemp(time) {
      return this.cfg.dayLength > 0 ? (this.light(time) - 0.5) * 6 : 0;
    }

    // The Climate setting plus any temporary shift from events (ice age) and
    // the slow climate cycles.
    climateShift() {
      return this.cfg.climate + (this.extraTemp || 0) + (this.cycleTemp || 0);
    }

    // Move the coastline to sea level `wl`: tiles whose biome changes get the
    // plant capacity of their new biome. Returns the indices that changed.
    setSeaLevel(wl) {
      if (!this.elev) return [];
      const changed = [];
      for (let i = 0; i < this.biome.length; i++) {
        const b = biomeFor(this.elev[i], this.moist[i], wl);
        if (b === this.biome[i]) continue;
        this.biome[i] = b;
        const lush = this.lush[i];
        for (const f of FOODS) {
          const cap = Evo.K.PLANT_MAX * (BIOMES[b].food[f.key] || 0) * lush;
          const food = this.food[f.key];
          food.max[i] = cap;
          if (food.amt[i] > cap) food.amt[i] = cap;
        }
        this.fertility[i] = BIOMES[b].water ? 0 : ((BIOMES[b].food.grass || 0) + (BIOMES[b].food.leaves || 0)) * lush;
        changed.push(i);
      }
      if (changed.length) this.biomeVersion = (this.biomeVersion || 0) + 1;
      return changed;
    }

    seasonSwing(time) {
      return (this.season(time) - 1) * 40;
    }

    tempAtPoint(x, y, time) {
      const i = this.tileIndex(x, y);
      return i < 0 ? 0 : this.tempAt(i, time);
    }

    // Shortest signed delta from a to b, respecting wrap-around.
    dx(a, b) {
      let d = b - a;
      if (this.wrap) {
        if (d > this.width / 2) d -= this.width;
        else if (d < -this.width / 2) d += this.width;
      }
      return d;
    }
    dy(a, b) {
      let d = b - a;
      if (this.wrap) {
        if (d > this.height / 2) d -= this.height;
        else if (d < -this.height / 2) d += this.height;
      }
      return d;
    }

    tileIndex(x, y) {
      const T = Evo.K.TILE;
      let tx = Math.floor(x / T), ty = Math.floor(y / T);
      if (this.wrap) {
        tx = ((tx % this.cols) + this.cols) % this.cols;
        ty = ((ty % this.rows) + this.rows) % this.rows;
      } else if (tx < 0 || ty < 0 || tx >= this.cols || ty >= this.rows) return -1;
      return ty * this.cols + tx;
    }

    biomeAt(x, y) {
      const i = this.tileIndex(x, y);
      return i < 0 ? BIOMES[0] : BIOMES[this.biome[i]];
    }

    passable(x, y) { return this.biomeAt(x, y).passable; }

    // Good swimmers (swim >= 0.5) can cross deep water.
    canEnter(x, y, swim) {
      if (!this.wrap && (x < 0 || y < 0 || x >= this.width || y >= this.height)) return false;
      const b = this.biomeAt(x, y);
      return b.passable || (b.id === 0 && swim >= 0.5);
    }

    // Movement speed multiplier: swimmers are fast in water but clumsy on land.
    speedFactor(biome, swim) {
      if (biome.id === 0) return 0.2 + 0.8 * swim;
      if (biome.id === 1) return 0.35 + 0.75 * swim;
      return biome.speed * (1 - 0.55 * swim * swim);
    }

    // Calories a creature could get from a tile's plants, given how well it
    // digests each kind (`eat`).
    foodValue(i, eat) {
      const f = this.food, cal = Evo.K.CAL;
      return f.grass.amt[i] * cal.grass * eat.grass + f.leaves.amt[i] * cal.leaves * eat.leaves +
        f.algae.amt[i] * cal.algae * eat.algae;
    }

    randomPassablePoint(rng, preferFertile) {
      for (let tries = 0; tries < 500; tries++) {
        const x = rng.float(0, this.width), y = rng.float(0, this.height);
        const i = this.tileIndex(x, y);
        if (!BIOMES[this.biome[i]].passable) continue;
        if (preferFertile && this.fertility[i] < 0.3 && tries < 400) continue;
        return { x, y };
      }
      return { x: this.width / 2, y: this.height / 2 };
    }

    wrapPos(c) {
      if (this.wrap) {
        if (c.x < 0) c.x += this.width; else if (c.x >= this.width) c.x -= this.width;
        if (c.y < 0) c.y += this.height; else if (c.y >= this.height) c.y -= this.height;
      } else {
        c.x = Evo.clamp(c.x, 0, this.width - 0.01);
        c.y = Evo.clamp(c.y, 0, this.height - 0.01);
      }
    }

    // 1 + a sine wave: >1 in "summer", <1 in "winter".
    season(time) {
      return 1 + this.cfg.seasonStrength * Math.sin((2 * Math.PI * time) / this.cfg.seasonLength);
    }

    step(dt, time) {
      // Plants regrow steadily (a bit slower as they fill up), faster in
      // summer. Even a grazed-bare tile recovers, so herds don't wipe out
      // their food for minutes. A tile's max encodes its fertility.
      const g = (Evo.K.PLANT_REGROW * this.cfg.plantGrowth * this.season(time) * dt) / Evo.K.PLANT_MAX;
      // Plants grow slower in the cold and stop in hard frost (below -3 °C).
      const shift = this.climateShift() + this.seasonSwing(time);
      const tb = this.tempBase;
      // Events (drought, fertile ash) and the wet/dry climate bands scale
      // growth per tile; very low growth also makes existing plants wither.
      const gm = this.growthMul, rm = this.rainMul;
      const wither = 1 - 0.01 * dt;
      for (const f of FOODS) {
        const amt = this.food[f.key].amt, max = this.food[f.key].max;
        for (let i = 0; i < amt.length; i++) {
          const m = max[i];
          if (m <= 0) continue;
          const t = tb[i] + shift;
          if (t <= -3) continue;
          const warm = t >= 10 ? 1 : (t + 3) / 13;
          const p = amt[i] / m;
          if (gm || rm) {
            const k = (gm ? gm[i] : 1) * (rm ? rm[i] : 1);
            if (k < 0.5) amt[i] *= wither;
            amt[i] = Math.min(m, amt[i] + g * warm * k * m * (1 - 0.6 * p));
          } else amt[i] = Math.min(m, amt[i] + g * warm * m * (1 - 0.6 * p));
        }
      }
      // Corpses rot away.
      const decay = Evo.K.CORPSE_DECAY * dt;
      for (const c of this.corpses) c.meat -= c.meat * decay + 0.08 * dt;
      this.corpses = this.corpses.filter((c) => c.meat > 0.2);
      this.corpseHash.rebuild(this.corpses);
    }

    addCorpse(x, y, meat, species) {
      if (meat > 0.2) this.corpses.push({ x, y, meat, initial: meat, species });
    }

    totalPlant() {
      let s = 0;
      for (const f of FOODS) {
        const amt = this.food[f.key].amt;
        for (let i = 0; i < amt.length; i++) s += amt[i];
      }
      return s;
    }
  }

  Evo.BIOMES = BIOMES;
  Evo.FOODS = FOODS;
  Evo.SpatialHash = SpatialHash;
  Evo.World = World;
  Evo.paintTerrain = paintTerrain;
  Evo.biomeFor = biomeFor;
})((globalThis.Evo = globalThis.Evo || {}));
