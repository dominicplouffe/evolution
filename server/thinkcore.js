// The "deciding" half of the simulation, run on worker threads.
//
// Each step the main thread writes a compact snapshot of the world into shared
// memory (every creature's position and status, the carcasses, plant levels)
// and lists the creatures whose turn it is to think. Workers keep a light copy
// ("mirror") of every creature, refresh it from the snapshot, and run the very
// same Creature.think() code on it; its decisions are written back as small
// records that the main thread applies at the start of the next step. So
// decisions are made on the world as it was one step (1/30 s) earlier, while
// the main thread carries on moving, eating and fighting.
'use strict';

// Snapshot: one row of F numbers per creature.
const S = {
  id: 0, x: 1, y: 2, heading: 3, state: 4, species: 5, grow: 6, health: 7, energy: 8, stomach: 9, stomachCal: 10,
  stamina: 11, hungry: 12, huntCooldown: 13, age: 14, reproCooldown: 15, herdSize: 16, stealth: 17, sight: 18,
  sleepy: 19, temp: 20, chaseTime: 21, targetKind: 22, targetRef: 23, targetX: 24, targetY: 25, chasedBy: 26,
  lastAttacker: 27, lastAttackedAt: 28,
};
const F = 29;
const CF = 4; // carcass row: x, y, meat, species
// Decision: one row of D numbers per thinker.
const O = {
  row: 0, decided: 1, herdSize: 2, state: 3, targetKind: 4, targetRef: 5, tx: 6, ty: 7, fleeX: 8, fleeY: 9,
  home: 10, homeX: 11, homeY: 12, wanderTurn: 13, choice: 14, hunt: 15, mate: 16, util: 17,
};
const NA = 10;
const D = O.util + 2 * NA;
const KIND = { none: 0, creature: 1, corpse: 2, tile: 3 };

function stateCodes(Evo) {
  const list = Object.values(Evo.Creature.STATE);
  return { list, code: new Map(list.map((s, i) => [s, i])) };
}

// A deterministic random stream per creature and step, so results don't depend
// on which thread did the work.
function reseed(rng, seed, id, tick) {
  let h = (seed ^ Math.imul(id | 0, 0x9e3779b1) ^ Math.imul(tick | 0, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  rng.seed = h;
  rng.state = h;
}

class ThinkCore {
  // init: { cfg, seed, cols, rows, wrap, biome, tempBase, fertility, max: {grass,...}, buffers }
  constructor(Evo, init) {
    this.Evo = Evo;
    this.codes = stateCodes(Evo);
    const T = Evo.K.TILE;
    const w = Object.create(Evo.World.prototype);
    Object.assign(w, {
      cfg: Object.assign({}, init.cfg), cols: init.cols, rows: init.rows, width: init.cols * T, height: init.rows * T, wrap: init.wrap,
      tempBase: init.tempBase, corpses: [],
    });
    this.world = w;
    this.setTerrain(init);
    w.corpseHash = new Evo.SpatialHash(w, 64);
    this.hash = new Evo.SpatialHash(w, 64);
    this.seed = init.seed >>> 0;
    this.rng = new Evo.RNG(1);
    this.mirrors = new Map();
    this.list = [];
    this.fakeSim = { world: w, hash: this.hash, rng: this.rng, time: 0, cfg: w.cfg };
    this.setBuffers(init.buffers);
  }

  setTerrain(t) {
    const w = this.world;
    w.biome = t.biome;
    w.fertility = t.fertility;
    w.food = {};
    for (const f of this.Evo.FOODS) w.food[f.key] = { amt: w.food[f.key] ? w.food[f.key].amt : null, max: t.max[f.key] };
    if (this.buffers) this.setBuffers(this.buffers);
  }

  setBuffers(b) {
    this.buffers = b;
    this.snap = new Float64Array(b.snap);
    this.corpses = new Float64Array(b.corpses);
    this.thinkers = new Int32Array(b.thinkers);
    this.out = new Float64Array(b.out);
    for (const f of this.Evo.FOODS) this.world.food[f.key].amt = new Float32Array(b.food[f.key]);
  }

  // New creatures: their DNA arrives once, then only the snapshot rows.
  addBirths(births) {
    const Evo = this.Evo;
    // Mirrors must not use up real creature ids (matters when run in-process).
    const nextId = Evo.Creature.getNextId();
    for (const b of births) {
      const g = Object.assign({}, b.g, { brain: Array.from(b.g.brain) });
      const m = new Evo.Creature(this.fakeSim, Evo.Genome.make(g), 0, 0, { species: b.species, adult: true });
      m.id = b.id;
      m.grow = -1; // forces the body to be computed on the first refresh
      this.mirrors.set(b.id, m);
    }
    Evo.Creature.setNextId(nextId);
  }

  // Refresh every mirror from the snapshot and rebuild the neighbour grids.
  refresh(msg) {
    const Evo = this.Evo, w = this.world, snap = this.snap, st = this.codes.list;
    if (msg.cfg) Object.assign(w.cfg, msg.cfg);
    w.extraTemp = msg.extraTemp;
    w.cycleTemp = msg.cycleTemp;
    w.lastTime = msg.time;
    this.fakeSim.time = msg.time;
    // Carcasses (objects reused from step to step).
    const pool = this.corpsePool || (this.corpsePool = []);
    const cs = w.corpses;
    cs.length = msg.nc;
    for (let k = 0; k < msg.nc; k++) {
      const o = k * CF;
      const c = pool[k] || (pool[k] = { x: 0, y: 0, meat: 0, species: 0, idx: k });
      c.x = this.corpses[o]; c.y = this.corpses[o + 1]; c.meat = this.corpses[o + 2]; c.species = this.corpses[o + 3];
      cs[k] = c;
    }
    w.corpseHash.rebuild(cs);
    // Creatures, in the main thread's order.
    const list = this.list;
    list.length = msg.n;
    for (let i = 0; i < msg.n; i++) {
      const o = i * F;
      const m = this.mirrors.get(snap[o + S.id]);
      m.row = i;
      m.alive = true;
      m.x = snap[o + S.x]; m.y = snap[o + S.y]; m.heading = snap[o + S.heading];
      m.state = st[snap[o + S.state]];
      m.species = snap[o + S.species];
      const grow = snap[o + S.grow];
      if (grow !== m.grow) { m.grow = grow; m.phen = Evo.Genome.phenotype(m.g, grow); }
      m.health = snap[o + S.health]; m.energy = snap[o + S.energy];
      m.stomach = snap[o + S.stomach]; m.stomachCal = snap[o + S.stomachCal]; m.stamina = snap[o + S.stamina];
      m.hungry = snap[o + S.hungry] === 1; m.huntCooldown = snap[o + S.huntCooldown];
      m.age = snap[o + S.age]; m.reproCooldown = snap[o + S.reproCooldown]; m.herdSize = snap[o + S.herdSize];
      m.stealth = snap[o + S.stealth]; m.sight = snap[o + S.sight]; m.sleepy = snap[o + S.sleepy];
      m.temp = snap[o + S.temp]; m.chaseTime = snap[o + S.chaseTime]; m.lastAttackedAt = snap[o + S.lastAttackedAt];
      list[i] = m;
    }
    // References to other creatures (after all rows are known).
    for (let i = 0; i < msg.n; i++) {
      const o = i * F, m = list[i];
      const kind = snap[o + S.targetKind], ref = snap[o + S.targetRef];
      m.target = kind === KIND.creature ? (ref >= 0 ? list[ref] : null)
        : kind === KIND.corpse ? (ref >= 0 ? cs[ref] : null)
          : kind === KIND.tile ? { x: snap[o + S.targetX], y: snap[o + S.targetY] } : null;
      const cb = snap[o + S.chasedBy], la = snap[o + S.lastAttacker];
      m.chasedBy = cb >= 0 ? list[cb] : null;
      m.lastAttacker = la >= 0 ? list[la] : null;
    }
    this.hash.rebuild(list);
    // Forget creatures that are gone.
    if (this.mirrors.size > msg.n * 1.5 + 100) {
      const live = new Set(list);
      for (const [id, m] of this.mirrors) if (!live.has(m)) this.mirrors.delete(id);
    }
  }

  // Decide for thinkers[from..to), writing one output row each.
  think(msg, from, to) {
    const out = this.out, code = this.codes.code;
    for (let k = from; k < to; k++) {
      const row = this.thinkers[k];
      const m = this.list[row];
      reseed(this.rng, this.seed, m.id, msg.tick);
      m.choice = -1;
      const prevState = m.state, prevTarget = m.target;
      m.think(this.fakeSim);
      // think() marks its prey as chased; undo that on the mirror so other
      // thinkers this step see the same snapshot whichever thread they're on
      // (the main thread applies it with the decision).
      const HUNT = this.Evo.Creature.STATE.HUNT;
      if (m.state === HUNT && m.target && m.target.row !== undefined) {
        const cb = this.snap[m.target.row * F + S.chasedBy];
        m.target.chasedBy = cb >= 0 ? this.list[cb] : null;
      }
      const o = k * D;
      out[o + O.row] = row;
      out[o + O.herdSize] = m.herdSize;
      if (m.choice === -1) { out[o + O.decided] = 0; m.state = prevState; m.target = prevTarget; continue; } // kept its current plan
      out[o + O.decided] = 1;
      out[o + O.state] = code.get(m.state);
      const t = m.target;
      let kind = KIND.none, ref = -1, tx = 0, ty = 0;
      if (t) {
        if (t.row !== undefined && this.list[t.row] === t) { kind = KIND.creature; ref = t.row; }
        else if (t.idx !== undefined) { kind = KIND.corpse; ref = t.idx; }
        else { kind = KIND.tile; tx = t.x; ty = t.y; }
      }
      out[o + O.targetKind] = kind; out[o + O.targetRef] = ref; out[o + O.tx] = tx; out[o + O.ty] = ty;
      out[o + O.fleeX] = m.fleeX; out[o + O.fleeY] = m.fleeY;
      out[o + O.home] = m.home ? 1 : 0;
      out[o + O.homeX] = m.home ? m.home.x : 0; out[o + O.homeY] = m.home ? m.home.y : 0;
      out[o + O.wanderTurn] = m.wanderTurn;
      out[o + O.choice] = m.choice;
      out[o + O.hunt] = m.state === HUNT ? 1 : 0;
      out[o + O.mate] = m.state === this.Evo.Creature.STATE.MATE ? 1 : 0;
      for (let a = 0; a < NA; a++) { out[o + O.util + a] = m.util[a]; out[o + O.util + NA + a] = m.avail[a]; }
      // Others thinking later this step must see this creature as it was in
      // the snapshot, not its new plan (or results would depend on threads).
      m.state = prevState;
      m.target = prevTarget;
    }
  }
}

module.exports = { ThinkCore, S, F, CF, O, D, NA, KIND, stateCodes };
