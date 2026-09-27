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
            const dx = w.dx(x, it.x), dy = w.dy(y, it.y);
            const d2 = dx * dx + dy * dy;
            if (d2 <= r2) fn(it, dx, dy, d2);
          }
        }
      }
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
      for (let i = 0; i < w * h; i++) {
        const e = elev[i], m = moist[i];
        let b;
        if (e < wl - 0.07) b = 0;
        else if (e < wl) b = 1;
        else if (e < wl + 0.035) b = 2;
        else if (e > 0.9) b = 7;
        else if (e > 0.8) b = 6;
        else if (m < 0.35) b = 3;
        else if (m < 0.66) b = 4;
        else b = 5;
        this.biome[i] = b;
        const lush = 0.7 + 0.6 * lushNoise[i];
        const start = rng.float(0.5, 0.9);
        for (const f of FOODS) {
          const cap = (BIOMES[b].food[f.key] || 0) * lush;
          this.food[f.key].max[i] = Evo.K.PLANT_MAX * cap;
          this.food[f.key].amt[i] = Evo.K.PLANT_MAX * cap * start;
        }
        this.fertility[i] = BIOMES[b].water ? 0 : ((BIOMES[b].food.grass || 0) + (BIOMES[b].food.leaves || 0)) * lush;
      }
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
      for (const f of FOODS) {
        const amt = this.food[f.key].amt, max = this.food[f.key].max;
        for (let i = 0; i < amt.length; i++) {
          const m = max[i];
          if (m <= 0) continue;
          const p = amt[i] / m;
          amt[i] = Math.min(m, amt[i] + g * m * (1 - 0.6 * p));
        }
      }
      // Corpses rot away.
      const decay = Evo.K.CORPSE_DECAY * dt;
      for (const c of this.corpses) c.meat -= c.meat * decay + 0.08 * dt;
      this.corpses = this.corpses.filter((c) => c.meat > 0.2);
      this.corpseHash.rebuild(this.corpses);
    }

    addCorpse(x, y, meat) {
      if (meat > 0.2) this.corpses.push({ x, y, meat, initial: meat });
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
})((globalThis.Evo = globalThis.Evo || {}));
