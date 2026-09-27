// The simulation: owns the world, all creatures, species and statistics.
// Has no DOM dependencies, so it can also run headless (see tools/headless.js).
(function (Evo) {
  'use strict';

  const HERBIVORE = {
    size: 1, speed: 1, stamina: 1, sense: 1, diet: 0.05, aggression: 0.15, fear: 0.7,
    armor: 0.05, camo: 0.1, social: 0.5, litter: 2, maturity: 25, lifespan: 150, mutation: 0.1, hue: 50,
  };
  const CARNIVORE = {
    size: 1.15, speed: 1.4, stamina: 1.2, sense: 1.6, diet: 0.9, aggression: 0.75, fear: 0.2,
    armor: 0.05, camo: 0.2, social: 0.15, litter: 1.6, maturity: 20, lifespan: 200, mutation: 0.1, hue: 0,
  };

  class Simulation {
    constructor(cfg) {
      this.cfg = Object.assign(Evo.defaultConfig(), cfg);
      const seed = this.cfg.seed || Math.floor(Math.random() * 1e9);
      this.seed = seed;
      this.rng = new Evo.RNG(seed);
      this.world = new Evo.World(this.cfg, this.rng);
      this.hash = new Evo.SpatialHash(this.world, 64);
      this.species = new Evo.SpeciesRegistry(this.rng);
      this.creatures = [];
      this.pending = [];
      this.time = 0;
      this.stats = { births: 0, deaths: 0, causes: {}, maxGeneration: 0, peakPopulation: 0 };
      this.history = [];
      this.historyEvery = 1;
      this.nextSample = 0;
      this.nextMigrationCheck = 0;
      this.missingSince = { herbivore: null, carnivore: null };
      this.events = [];

      this.herbivoreSpecies = this.species.create(Evo.Genome.make(HERBIVORE), null, 0);
      this.carnivoreSpecies = this.species.create(Evo.Genome.make(CARNIVORE), null, 0);
      for (let i = 0; i < this.cfg.initialHerbivores; i++) this.spawnFounder('herbivore');
      for (let i = 0; i < this.cfg.initialCarnivores; i++) this.spawnFounder('carnivore');
      this.flush();
      this.census();
    }

    spawnFounder(kind, x, y) {
      const carn = kind === 'carnivore';
      const sp = carn ? this.carnivoreSpecies : this.herbivoreSpecies;
      // Founders are small variations on a template.
      const g = Evo.Genome.mutate(sp.founder, this.rng, 0.5);
      if (x === undefined) ({ x, y } = this.world.randomPassablePoint(this.rng, !carn));
      const c = new Evo.Creature(this, g, x, y, { adult: true, species: sp.id });
      c.age = this.rng.float(0, g.lifespan * 0.4);
      c.reproCooldown = this.rng.float(0, 10);
      this.pending.push(c);
      return c;
    }

    // Spawn a copy of an existing species (used by the "spawn" tool when a
    // creature is selected), otherwise a founder template.
    spawnAt(kind, x, y) {
      if (!this.world.passable(x, y)) return null;
      const c = this.spawnFounder(kind, x, y);
      c.age = 0;
      this.flush();
      return c;
    }

    // Drop copies of an existing creature's DNA nearby (inspector "Clone").
    cloneNear(src, n) {
      const out = [];
      for (let i = 0; i < n; i++) {
        const x = src.x + this.rng.float(-40, 40), y = src.y + this.rng.float(-40, 40);
        if (!this.world.passable(x, y)) continue;
        const c = new Evo.Creature(this, Evo.Genome.clone(src.g), x, y, { adult: true, species: src.species, generation: src.generation });
        this.world.wrapPos(c);
        out.push(c);
        this.pending.push(c);
      }
      this.flush();
      return out;
    }

    reproduce(mother, father) {
      if (this.creatures.length + this.pending.length >= this.cfg.maxPopulation) {
        mother.reproCooldown = 5;
        return;
      }
      const g = mother.g;
      const litter = Math.max(1, Math.floor(g.litter) + (this.rng.chance(g.litter % 1) ? 1 : 0));
      const invest = mother.phen.maxEnergy * (father ? 0.45 : 0.55);
      mother.energy -= invest;
      if (father) {
        father.energy -= father.phen.maxEnergy * 0.1;
        father.reproCooldown = father.g.maturity * 0.3 + 3;
        father.children += litter;
      }
      mother.reproCooldown = g.maturity * 0.6 + 3 + litter * 1.5;
      mother.children += litter;
      mother.mateSearch = 0;

      for (let i = 0; i < litter; i++) {
        let genome = father ? Evo.Genome.crossover(mother.g, father.g, this.rng) : Evo.Genome.clone(mother.g);
        genome = Evo.Genome.mutate(genome, this.rng, this.cfg.mutationScale);
        const sp = this.species.assign(genome, mother.species, this.time);
        if (sp.id !== mother.species && sp.count === 0 && sp.born === this.time) {
          this.logEvent(`New species <b>${sp.name}</b> branched off from ${this.species.get(mother.species).name}`);
        }
        const a = this.rng.float(0, Math.PI * 2);
        const x = mother.x + Math.cos(a) * mother.phen.radius;
        const y = mother.y + Math.sin(a) * mother.phen.radius;
        const gen = Math.max(mother.generation, father ? father.generation : 0) + 1;
        const baby = new Evo.Creature(this, genome, mother.x, mother.y, {
          species: sp.id,
          generation: gen,
          energy: invest / litter,
          parentIds: father ? [mother.id, father.id] : [mother.id],
        });
        if (this.world.passable(x, y)) { baby.x = x; baby.y = y; this.world.wrapPos(baby); }
        sp.count++; // counted immediately so siblings join the same new species
        this.pending.push(baby);
        this.stats.births++;
        if (gen > this.stats.maxGeneration) this.stats.maxGeneration = gen;
      }
    }

    kill(c, cause) {
      if (!c.alive) return;
      c.alive = false;
      c.deathCause = cause;
      this.stats.deaths++;
      this.stats.causes[cause] = (this.stats.causes[cause] || 0) + 1;
      this.world.addCorpse(c.x, c.y, c.phen.mass * Evo.K.MEAT_PER_MASS + Math.max(0, c.energy) * 0.5);
    }

    flush() {
      if (this.pending.length) {
        for (const c of this.pending) this.creatures.push(c);
        this.pending.length = 0;
      }
    }

    step() {
      const dt = Evo.K.DT;
      this.time += dt;
      this.world.step(dt, this.time);
      this.hash.rebuild(this.creatures);
      for (let i = 0; i < this.creatures.length; i++) {
        const c = this.creatures[i];
        if (c.alive) c.update(dt, this);
      }
      let alive = 0;
      for (let i = 0; i < this.creatures.length; i++) {
        const c = this.creatures[i];
        if (c.alive) this.creatures[alive++] = c;
      }
      this.creatures.length = alive;
      this.flush();
      if (this.time >= this.nextMigrationCheck) {
        this.nextMigrationCheck = this.time + 5;
        this.checkMigration();
      }
      if (this.time >= this.nextSample) {
        this.nextSample = this.time + this.historyEvery;
        this.census();
      }
    }

    // If all plant-eaters or all meat-eaters die out, a small group wanders in
    // from "off the map" after a while, so the ecosystem can restart.
    checkMigration() {
      if (!this.cfg.migration) return;
      const has = { herbivore: false, carnivore: false };
      for (const c of this.creatures) {
        if (c.g.diet < 0.5) has.herbivore = true;
        else has.carnivore = true;
        if (has.herbivore && has.carnivore) break;
      }
      for (const kind of ['herbivore', 'carnivore']) {
        if (has[kind]) { this.missingSince[kind] = null; continue; }
        if (kind === 'carnivore' && !has.herbivore) continue; // wait for prey first
        if (this.missingSince[kind] === null) { this.missingSince[kind] = this.time; continue; }
        if (this.time - this.missingSince[kind] < 30) continue;
        this.missingSince[kind] = null;
        const n = kind === 'herbivore' ? 20 : 6;
        const at = this.world.randomPassablePoint(this.rng, true);
        for (let i = 0; i < n; i++) {
          const c = this.spawnFounder(kind, at.x + this.rng.float(-60, 60), at.y + this.rng.float(-60, 60));
          if (!this.world.passable(c.x, c.y)) { c.x = at.x; c.y = at.y; }
          this.world.wrapPos(c);
        }
        this.logEvent(`A group of ${n} ${kind === 'herbivore' ? 'grazers' : 'predators'} migrated in`);
      }
    }

    census() {
      const counts = { herbivore: 0, omnivore: 0, carnivore: 0 };
      const sums = {};
      for (const gene of Evo.GENES) sums[gene.key] = 0;
      for (const sp of this.species.byId.values()) { sp.count = 0; sp._diet = 0; sp._size = 0; }
      for (const c of this.creatures) {
        counts[c.dietClass]++;
        for (const gene of Evo.GENES) sums[gene.key] += c.g[gene.key];
        const sp = this.species.get(c.species);
        sp.count++;
        sp._diet += c.g.diet;
        sp._size += c.g.size;
      }
      for (const sp of this.species.byId.values()) {
        if (sp.count > 0) {
          sp.avgDiet = sp._diet / sp.count;
          sp.avgSize = sp._size / sp.count;
          sp.peak = Math.max(sp.peak, sp.count);
          sp.extinctAt = null;
        } else if (sp.extinctAt === null && sp.peak > 0) {
          sp.extinctAt = this.time;
          if (sp.peak >= 10) this.logEvent(`<b>${sp.name}</b> went extinct (peak ${sp.peak})`);
        }
      }
      const n = this.creatures.length;
      const avg = {};
      for (const gene of Evo.GENES) avg[gene.key] = n ? sums[gene.key] / n : 0;
      this.stats.peakPopulation = Math.max(this.stats.peakPopulation, n);
      this.history.push({
        t: this.time, n, ...counts,
        plants: this.world.totalPlant() / (this.world.cols * this.world.rows),
        species: this.species.living().length,
        avg,
      });
      // Keep the whole run but thin it out as it gets long.
      if (this.history.length > 1200) {
        this.history = this.history.filter((_, i) => i % 2 === 0);
        this.historyEvery *= 2;
      }
    }

    logEvent(html) {
      this.events.unshift({ t: this.time, html });
      if (this.events.length > 60) this.events.length = 60;
    }

    seasonName() {
      const phase = ((this.time / this.cfg.seasonLength + 0.125) % 1 + 1) % 1;
      return ['Spring', 'Summer', 'Autumn', 'Winter'][Math.floor(phase * 4)];
    }
  }

  Evo.Simulation = Simulation;
})((globalThis.Evo = globalThis.Evo || {}));
