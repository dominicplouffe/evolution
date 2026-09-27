// A creature: body built from its genome, plus a small priority-based brain.
// Priorities: flee > fight back > mate > eat (plants / carrion / hunt) > wander.
(function (Evo) {
  'use strict';

  const STATE = {
    WANDER: 'Wandering',
    GRAZE: 'Looking for plants',
    EAT: 'Eating',
    SCAVENGE: 'Going for carrion',
    HUNT: 'Hunting',
    FIGHT: 'Fighting back',
    FLEE: 'Fleeing',
    MATE: 'Courting',
    REST: 'Resting',
    DIGEST: 'Digesting',
  };

  let nextId = 1;

  function angleDiff(a, b) {
    let d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  class Creature {
    constructor(sim, genome, x, y, opts = {}) {
      this.id = nextId++;
      this.g = genome;
      this.x = x;
      this.y = y;
      this.heading = sim.rng.float(0, Math.PI * 2);
      this.v = 0;
      this.age = 0;
      this.grow = opts.adult ? 1 : 0;
      this.phen = Evo.Genome.phenotype(genome, this.grow);
      this.health = this.phen.maxHealth;
      this.energy = opts.energy !== undefined ? Math.min(opts.energy, this.phen.maxEnergy) : this.phen.maxEnergy * 0.7;
      this.stamina = this.phen.maxStamina;
      this.stomach = 0;      // food volume waiting to be digested
      this.stomachCal = 0;   // usable calories in that food
      this.hungry = false;
      this.exhausted = false;
      this.alive = true;
      this.species = opts.species;
      this.generation = opts.generation || 0;
      this.parentIds = opts.parentIds || [];
      this.children = 0;
      this.kills = 0;
      this.reproCooldown = genome.maturity * 0.3;
      this.mateSearch = 0;
      this.state = STATE.WANDER;
      this.target = null;       // creature, corpse or {x, y}
      this.targetKind = null;   // 'creature' | 'corpse' | 'tile'
      this.fleeX = 0;
      this.fleeY = 0;
      this.chaseTime = 0;
      this.huntCooldown = 0;
      this.lastAttacker = null;
      this.lastAttackedAt = -99;
      this.thinkTimer = sim.rng.float(0, 0.3);
      this.wanderTurn = 0;
      this.herdSize = 0;
      this.home = null;
      this.chasedBy = null;
      this.sprinting = false;
      this.deathCause = null;
      this.bornAt = sim.time;
    }

    get dietClass() {
      const d = this.g.diet;
      return d < 0.33 ? 'herbivore' : d < 0.66 ? 'omnivore' : 'carnivore';
    }

    isReadyToMate() {
      return this.grow >= 1 && this.reproCooldown <= 0 && this.energy >= 0.75 * this.phen.maxEnergy && this.age < this.g.lifespan;
    }

    // Mates must be genetically close AND look alike (similar color). Once two
    // groups drift apart they stop interbreeding, so new species stay separate.
    canMateWith(o) {
      if (o === this || !o.alive || !o.isReadyToMate()) return false;
      let hue = Math.abs(this.g.hue - o.g.hue);
      if (hue > 180) hue = 360 - hue;
      return hue < Evo.K.MATE_HUE && Evo.Genome.distance(this.g, o.g) < Evo.K.MATE_THRESHOLD;
    }

    // Does `o` look like a danger to me?
    isThreat(o) {
      return o.g.diet >= Evo.K.PREDATOR_DIET && o.species !== this.species && o.grow > 0.6 &&
        o.phen.strength * 6 > this.phen.maxHealth * 0.25 && o.phen.mass > this.phen.mass * 0.35;
    }

    // How far away can I spot `o`? Camouflage works best under cover.
    detectRange(o, world) {
      const cover = world.biomeAt(o.x, o.y).cover;
      return this.phen.senseRadius * (1 - o.g.camo * (0.3 + 0.5 * cover));
    }

    think(sim) {
      const world = sim.world;
      const p = this.phen, g = this.g;
      const sense = p.senseRadius;

      // ---- scan surroundings
      let fx = 0, fy = 0, threats = 0;
      let mate = null, mateD = Infinity;
      let prey = null, preyScore = 0;
      let herdX = 0, herdY = 0, herdHX = 0, herdHY = 0, herdN = 0;
      // "Many eyes": a creature in a herd spots danger earlier.
      const fleeDist = sense * (0.2 + 0.8 * g.fear) * (1 + 0.1 * Math.min(this.herdSize, 6) * g.social);
      // Only look for food when hungry and there's room in the stomach.
      const hungry = this.hungry && this.stomach < 0.9 * p.stomachCap;
      const canHunt = g.diet >= Evo.K.PREDATOR_DIET && this.grow > 0.7 && this.huntCooldown <= 0 && hungry;
      const ready = this.isReadyToMate();

      sim.hash.query(this.x, this.y, sense, (o, dx, dy, d2) => {
        if (o === this || !o.alive) return;
        const d = Math.sqrt(d2) || 0.01;
        if (d > this.detectRange(o, world)) return;
        // Only a hunting predator is scary from afar; an idle one only up close.
        if (this.isThreat(o) && d < (o.state === STATE.HUNT ? fleeDist : fleeDist * 0.3)) {
          // Weight by closeness and by how outmatched I am.
          const w = (1 / d) * Math.min(3, o.phen.strength / (p.strength + 0.5) + 0.5);
          fx -= (dx / d) * w;
          fy -= (dy / d) * w;
          threats++;
        }
        if (o.species === this.species) {
          herdX += dx; herdY += dy;
          herdHX += Math.cos(o.heading); herdHY += Math.sin(o.heading);
          herdN++;
        }
        if (ready && d < mateD && this.canMateWith(o)) { mate = o; mateD = d; }
        // Don't chase prey another predator is already chasing.
        const rival = o.chasedBy;
        const taken = rival && rival !== this && rival.alive && rival.target === o && rival.state === STATE.HUNT;
        if (canHunt && o.species !== this.species && !taken) {
          const bravery = 0.8 + 1.5 * g.aggression;
          if (o.phen.mass < p.mass * bravery && o.health < p.strength * 12 * (0.5 + g.aggression)) {
            const s = (o.phen.mass * Evo.K.MEAT_PER_MASS * Evo.K.CAL.meat * p.meatEff) / (d + 30);
            if (s > preyScore) { preyScore = s; prey = o; }
          }
        }
      });

      this.herdSize = herdN;

      // ---- 1. flee
      if (threats > 0 && (fx !== 0 || fy !== 0)) {
        this.state = STATE.FLEE;
        this.fleeX = fx; this.fleeY = fy;
        // Swimmers bolt for the water, where land predators are slow.
        if (g.swim >= 0.5) {
          const home = this.findHome(world, sim.rng);
          if (home) {
            const hx = world.dx(this.x, home.x), hy = world.dy(this.y, home.y);
            const hd = Math.hypot(hx, hy) || 1, fd = Math.hypot(fx, fy) || 1;
            this.fleeX = fx / fd + (1.5 * hx) / hd;
            this.fleeY = fy / fd + (1.5 * hy) / hd;
          }
        }
        this.target = null;
        return;
      }

      // ---- 2. fight back (or run from) whoever is biting me
      const att = this.lastAttacker;
      if (att && att.alive && sim.time - this.lastAttackedAt < 2) {
        if (g.aggression > 0.5 && p.strength > att.phen.strength * 0.6) {
          this.setTarget(STATE.FIGHT, att, 'creature');
        } else {
          this.state = STATE.FLEE;
          this.fleeX = -world.dx(this.x, att.x);
          this.fleeY = -world.dy(this.y, att.y);
        }
        return;
      }

      // Keep chasing a current prey rather than re-deciding every think.
      if (this.state === STATE.HUNT && this.target && this.target.alive && this.chaseTime < 10) return;

      // ---- 3. mate
      if (mate) {
        this.setTarget(STATE.MATE, mate, 'creature');
        this.mateSearch = 0;
        return;
      }

      // ---- 4. food
      // Keep walking to the chosen patch instead of re-deciding every think.
      if (hungry && this.state === STATE.GRAZE && this.target) {
        const ti = world.tileIndex(this.target.x, this.target.y);
        if (ti >= 0 && world.foodValue(ti, p.eat) > 1) return;
      }
      if (hungry) {
        let best = null, bestScore = 0, bestKind = null, bestState = null;
        if (prey) { best = prey; bestScore = preyScore * 0.8; bestKind = 'creature'; bestState = STATE.HUNT; }

        if (p.meatEff > 0.15) {
          world.corpseHash.query(this.x, this.y, sense, (c, dx, dy, d2) => {
            const s = (Math.min(c.meat * Evo.K.CAL.meat, p.maxEnergy) * p.meatEff) / (Math.sqrt(d2) + 30);
            if (s > bestScore) { bestScore = s; best = c; bestKind = 'corpse'; bestState = STATE.SCAVENGE; }
          });
        }

        if (p.plantEff > 0.1) {
          const here = world.tileIndex(this.x, this.y);
          const hereValue = here >= 0 ? this.patchValue(world) : 0;
          if (hereValue > 1.5) {
            const s = hereValue / 20;
            if (s > bestScore) { bestScore = s; best = null; bestKind = 'here'; bestState = STATE.EAT; }
          }
          // Check the 8 neighbouring tiles, then sample a handful of tiles in
          // view (scanning all of them would be too slow).
          const T = Evo.K.TILE;
          for (let i = 0; i < 18; i++) {
            let tx, ty, r;
            if (i < 8) {
              const a = (i / 8) * Math.PI * 2;
              r = T;
              tx = this.x + Math.cos(a) * T;
              ty = this.y + Math.sin(a) * T;
            } else {
              const a = sim.rng.float(0, Math.PI * 2);
              r = sense * Math.sqrt(sim.rng.next());
              tx = this.x + Math.cos(a) * r;
              ty = this.y + Math.sin(a) * r;
            }
            const ti = world.tileIndex(tx, ty);
            if (ti < 0 || !world.canEnter(tx, ty, g.swim)) continue;
            let s = world.foodValue(ti, p.eat) / (r + 15);
            // Prefer feeding in my own habitat.
            const wet = !!Evo.BIOMES[world.biome[ti]].water;
            if (g.swim >= 0.5 && !wet) s *= 0.35;
            else if (g.swim < 0.3 && wet) s *= 0.5;
            if (s > bestScore) {
              bestScore = s;
              best = { x: tx, y: ty };
              bestKind = 'tile';
              bestState = STATE.GRAZE;
            }
          }
        }

        if (bestKind === 'here') {
          this.state = STATE.EAT;
          this.target = null;
          return;
        }
        if (best) {
          if (bestState === STATE.HUNT) {
            if (this.state !== STATE.HUNT) this.chaseTime = 0;
            best.chasedBy = this;
          }
          this.setTarget(bestState, best, bestKind);
          return;
        }
      }

      // ---- 5. go home: swimmers return to water, land animals leave it
      this.home = this.findHome(world, sim.rng);
      if (this.home) {
        this.state = STATE.WANDER;
        this.target = null;
        return;
      }

      // ---- 6. rest when full (saves energy), otherwise wander (with herding)
      if (!hungry && !ready && sim.rng.chance(0.85)) {
        this.state = this.stomach > 0.25 * p.stomachCap ? STATE.DIGEST : STATE.REST;
        this.target = null;
        return;
      }
      this.state = STATE.WANDER;
      this.target = null;
      this.wanderTurn = sim.rng.float(-1.2, 1.2);
      if (herdN > 0 && g.social > 0.05) {
        const cohesion = Math.atan2(herdY, herdX);
        const align = Math.atan2(herdHY, herdHX);
        const want = Math.hypot(herdX / herdN, herdY / herdN) > 40 ? cohesion : align;
        this.wanderTurn += angleDiff(this.heading, want) * g.social * 2;
      }
    }

    // Swimmers feel at home in water, everyone else on land. If I'm in the
    // wrong place, pick the nearest point of my habitat I can see.
    findHome(world, rng) {
      const swim = this.g.swim;
      const inWater = !!world.biomeAt(this.x, this.y).water;
      const wantWater = swim >= 0.5;
      if (inWater === wantWater || (swim > 0.3 && swim < 0.5)) return null;
      let best = null, bestD = Infinity;
      const r0 = this.phen.senseRadius;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2 + rng.float(0, 0.4);
        for (const f of [0.25, 0.6, 1]) {
          const x = this.x + Math.cos(a) * r0 * f, y = this.y + Math.sin(a) * r0 * f;
          const b = world.biomeAt(x, y);
          if (!!b.water !== wantWater || !world.canEnter(x, y, swim)) continue;
          if (r0 * f < bestD) { bestD = r0 * f; best = { x, y }; }
          break;
        }
      }
      return best;
    }

    // Put food in the stomach (limited by room). Returns the volume swallowed.
    swallow(volume, calPerUnit) {
      const v = Math.max(0, Math.min(volume, this.phen.stomachCap - this.stomach));
      this.stomach += v;
      this.stomachCal += v * calPerUnit;
      return v;
    }

    // Stomach full, or I've eaten enough to top up my reserves.
    isFull() {
      const p = this.phen;
      return this.stomach >= 0.98 * p.stomachCap || this.energy + this.stomachCal >= 0.98 * p.maxEnergy;
    }

    // Digest a steady share of the stomach into energy, and update hunger:
    // hungry below my Appetite level, satisfied once reserves + meal are full.
    digest(dt) {
      const p = this.phen;
      if (this.stomach > 0) {
        const v = Math.min(this.stomach, p.stomachCap * p.digestRate * dt);
        const cal = (this.stomachCal * v) / this.stomach;
        this.stomach -= v;
        this.stomachCal -= cal;
        this.energy = Math.min(p.maxEnergy, this.energy + cal);
        if (this.stomach < 1e-6) { this.stomach = 0; this.stomachCal = 0; }
      }
      const total = this.energy + this.stomachCal;
      if (total < this.g.appetite * p.maxEnergy) this.hungry = true;
      else if (total >= 0.98 * p.maxEnergy) this.hungry = false;
    }

    // The tiles I can feed from without moving: my own tile, plus (for big
    // bodies) the neighbouring ones. Returns [tileIndex, weight] pairs.
    patchTiles(world) {
      const here = world.tileIndex(this.x, this.y);
      const out = here >= 0 ? [[here, 1]] : [];
      const w = this.phen.footprint;
      if (w > 0) {
        const T = Evo.K.TILE;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const ti = world.tileIndex(this.x + dx * T, this.y + dy * T);
            if (ti >= 0 && ti !== here) out.push([ti, w * (dx && dy ? 0.7 : 1)]);
          }
        }
      }
      return out;
    }

    patchValue(world) {
      let v = 0;
      for (const [ti, w] of this.patchTiles(world)) v += w * world.foodValue(ti, this.phen.eat);
      return v;
    }

    setTarget(state, target, kind) {
      this.state = state;
      this.target = target;
      this.targetKind = kind;
    }

    update(dt, sim) {
      const world = sim.world;
      this.age += dt;
      if (this.reproCooldown > 0) this.reproCooldown -= dt;
      if (this.huntCooldown > 0) this.huntCooldown -= dt;

      // Growing up changes the body.
      if (this.grow < 1) {
        const ng = Math.min(1, this.age / this.g.maturity);
        if (ng - this.grow > 0.04 || ng === 1) {
          const hr = this.health / this.phen.maxHealth;
          this.grow = ng;
          this.phen = Evo.Genome.phenotype(this.g, this.grow);
          this.health = hr * this.phen.maxHealth;
        }
      }

      // Nobody to mate with for a while? Reproduce alone (budding).
      if (this.isReadyToMate() && this.state !== STATE.MATE) {
        this.mateSearch += dt;
        if (sim.cfg.allowAsexual && this.mateSearch > 15) sim.reproduce(this, null);
      }

      this.thinkTimer -= dt;
      if (this.thinkTimer <= 0) {
        this.thinkTimer = 0.25 + sim.rng.float(0, 0.15);
        this.think(sim);
      }

      this.act(dt, sim);
      this.move(dt, world);

      const p = this.phen;
      this.digest(dt);

      // Swimmers dry out on land, which costs extra energy.
      if (this.g.swim > 0.3 && !world.biomeAt(this.x, this.y).water) this.energy -= p.basal * 0.8 * (this.g.swim - 0.3) * dt;

      // Metabolism: resting cost (Kleiber-ish) + movement cost ~ v².
      const vr = this.v / 50;
      this.energy -= (p.basal + p.moveCost * vr * vr) * dt;

      if (this.energy <= 0) {
        this.energy = 0;
        this.health -= p.maxHealth * 0.12 * dt;
        this.deathCause = 'starvation';
      } else if (this.health < p.maxHealth) {
        const heal = p.maxHealth * 0.03 * dt;
        this.health = Math.min(p.maxHealth, this.health + heal);
        this.energy -= heal * 0.3;
      }
      if (this.age > this.g.lifespan) {
        this.health -= p.maxHealth * 0.06 * dt;
        if (this.energy > 0) this.deathCause = 'old age';
      }

      // Stamina.
      if (this.sprinting) {
        this.stamina -= dt;
        if (this.stamina <= 0) { this.stamina = 0; this.exhausted = true; }
      } else {
        this.stamina = Math.min(p.maxStamina, this.stamina + p.staminaRegen * dt);
        if (this.exhausted && this.stamina > p.maxStamina * 0.5) this.exhausted = false;
      }

      if (this.health <= 0) sim.kill(this, this.deathCause || 'wounds');
    }

    // Turn intentions into a desired heading/speed and perform interactions.
    act(dt, sim) {
      const world = sim.world;
      const p = this.phen;
      const cruise = p.maxSpeed * 0.45;
      let wantHeading = this.heading;
      let wantSpeed = cruise;
      let sprint = false;
      const t = this.target;
      const distTo = (o) => Math.hypot(world.dx(this.x, o.x), world.dy(this.y, o.y));
      const headTo = (o) => Math.atan2(world.dy(this.y, o.y), world.dx(this.x, o.x));

      switch (this.state) {
        case STATE.FLEE:
          wantHeading = Math.atan2(this.fleeY, this.fleeX);
          sprint = true;
          break;

        case STATE.HUNT:
        case STATE.FIGHT: {
          if (!t || !t.alive || distTo(t) > p.senseRadius * 1.4 || (this.state === STATE.HUNT && this.chaseTime > 10)) {
            if (this.state === STATE.HUNT) this.huntCooldown = 4;
            this.state = STATE.WANDER;
            this.target = null;
            break;
          }
          this.chaseTime += dt;
          const d = distTo(t);
          // Lead the target a little.
          const lead = Math.min(1, d / (p.maxSpeed + 1));
          const px = t.x + Math.cos(t.heading) * t.v * lead;
          const py = t.y + Math.sin(t.heading) * t.v * lead;
          wantHeading = headTo({ x: px, y: py });
          sprint = d < p.senseRadius * 0.8;
          const reach = p.radius + t.phen.radius + 3;
          if (d < reach) {
            wantSpeed = t.v;
            sprint = false;
            this.attack(t, dt, sim);
          }
          break;
        }

        case STATE.SCAVENGE: {
          if (!t || t.meat <= 0.2) { this.state = STATE.WANDER; this.target = null; break; }
          const d = distTo(t);
          wantHeading = headTo(t);
          if (d < p.radius + 5) {
            wantSpeed = 0;
            const bite = Math.min(p.biteRate * 1.5 * dt, t.meat);
            t.meat -= this.swallow(bite, Evo.K.CAL.meat * p.meatEff);
            if (this.isFull()) this.state = STATE.DIGEST;
          }
          break;
        }

        case STATE.EAT: {
          wantSpeed = 0;
          const patch = this.patchTiles(world);
          let value = 0;
          for (const [ti, w] of patch) value += w * world.foodValue(ti, p.eat);
          if (value < 0.4 || this.isFull()) {
            this.state = this.isFull() ? STATE.DIGEST : STATE.WANDER;
            this.thinkTimer = 0;
            break;
          }
          // Holling type II: sparse food is slower to eat. Mouthfuls are split
          // across food types in proportion to the calories each is worth to me.
          const dens = value / Evo.K.PLANT_MAX;
          const mouthful = p.biteRate * dt * (dens / (dens + 0.25)) * 1.25;
          for (const [ti, w] of patch) {
            for (const f of Evo.FOODS) {
              const eff = p.eat[f.key];
              const layer = world.food[f.key];
              if (eff <= 0.01 || layer.amt[ti] <= 0) continue;
              const cal = Evo.K.CAL[f.key] * eff;
              const want = Math.min(layer.amt[ti], (mouthful * w * layer.amt[ti] * cal) / value);
              layer.amt[ti] -= this.swallow(want, cal);
            }
          }
          break;
        }

        case STATE.GRAZE: {
          if (!t) { this.state = STATE.WANDER; break; }
          wantHeading = headTo(t);
          const i = world.tileIndex(this.x, this.y);
          if (distTo(t) < Evo.K.TILE * 0.6 || (i >= 0 && world.foodValue(i, p.eat) > Evo.K.PLANT_MAX * 0.7)) {
            this.state = STATE.EAT;
            this.target = null;
          }
          break;
        }

        case STATE.MATE: {
          if (!t || !t.alive || !this.isReadyToMate() || !t.isReadyToMate()) { this.state = STATE.WANDER; this.target = null; break; }
          wantHeading = headTo(t);
          if (distTo(t) < p.radius + t.phen.radius + 4) {
            sim.reproduce(this, t);
            this.state = STATE.WANDER;
            this.target = null;
          }
          break;
        }

        case STATE.REST:
        case STATE.DIGEST:
          wantSpeed = 0;
          break;

        default: // WANDER
          if (this.home) {
            wantHeading = headTo(this.home);
            if (distTo(this.home) < Evo.K.TILE) this.home = null;
          } else wantHeading = this.heading + this.wanderTurn * dt * 2;
          wantSpeed = cruise * 0.7;
      }

      this.sprinting = sprint && !this.exhausted && this.stamina > 0;
      if (this.sprinting) wantSpeed = p.maxSpeed;
      this.wantHeading = wantHeading;
      this.wantSpeed = wantSpeed;
    }

    attack(t, dt, sim) {
      const dmg = this.phen.strength * dt * (1 - 0.6 * t.g.armor);
      t.health -= dmg;
      t.lastAttacker = this;
      t.lastAttackedAt = sim.time;
      if (t.health <= 0 && t.alive) {
        t.deathCause = this.state === STATE.HUNT ? 'eaten' : 'fight';
        this.kills++;
        sim.kill(t, t.deathCause);
        this.state = STATE.WANDER;
        this.target = null;
        this.thinkTimer = 0; // go eat the corpse right away
      }
    }

    move(dt, world) {
      const p = this.phen;
      const turn = Evo.clamp(angleDiff(this.heading, this.wantHeading), -p.turnRate * dt, p.turnRate * dt);
      this.heading += turn;
      const accel = p.maxSpeed * 2 * dt;
      this.v += Evo.clamp(this.wantSpeed - this.v, -accel * 2, accel);
      if (this.v < 0.01) { this.v = 0; return; }
      const biome = world.biomeAt(this.x, this.y);
      const step = this.v * Math.max(0.15, world.speedFactor(biome, this.g.swim)) * dt;
      const nx = this.x + Math.cos(this.heading) * step;
      const ny = this.y + Math.sin(this.heading) * step;
      if (!world.canEnter(nx, ny, this.g.swim)) {
        // Bump into water/wall: turn away.
        this.heading += Math.PI * (0.5 + Math.random() * 0.5) * (Math.random() < 0.5 ? -1 : 1);
        this.v *= 0.3;
        if (this.state === STATE.GRAZE) this.state = STATE.WANDER;
        return;
      }
      this.x = nx;
      this.y = ny;
      world.wrapPos(this);
    }
  }

  Creature.STATE = STATE;
  // Creature ids keep counting up across save/load.
  Creature.getNextId = () => nextId;
  Creature.setNextId = (n) => { nextId = n; };
  Evo.Creature = Creature;
})((globalThis.Evo = globalThis.Evo || {}));
