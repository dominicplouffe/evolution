// Main-thread side of the multi-core "deciding" phase (see thinkcore.js).
// Plugs into the simulation as `sim.thinker`: at each step it applies the
// decisions computed from the previous step's snapshot, then writes a new
// snapshot and hands this step's thinkers to the workers, which work while
// the main thread moves, feeds and fights everyone.
//
// `threads: 0` runs the same core on the main thread (identical results; used
// to test that the threaded version is exact).
'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { ThinkCore, S, F, CF, O, D, NA, KIND, stateCodes } = require('./thinkcore');

const WAIT_MS = 5000; // a worker that takes this long is considered stuck

class ThinkPool {
  constructor(Evo, sim, { threads = 2, log = () => {} } = {}) {
    this.Evo = Evo;
    this.sim = sim;
    this.threads = threads;
    this.log = log;
    this.codes = stateCodes(Evo);
    this.known = new Set();      // creature ids whose DNA the workers have
    this.pending = null;         // decisions in flight: { n, rows, corpses }
    this.biomeVersion = sim.world.biomeVersion || 0;
    this.stats = { thinkers: 0 };
    this.alloc(Math.max(4096, sim.creatures.length * 2), 2048);
    const init = this.initData();
    if (threads > 0) {
      this.ctrl = new Int32Array(new SharedArrayBuffer(4));
      this.workerStats = new Float64Array(new SharedArrayBuffer(threads * 2 * 8));
      this.workers = [];
      for (let i = 0; i < threads; i++) {
        const w = new Worker(path.join(__dirname, 'thinkworker.js'), { workerData: { init, ctrl: this.ctrl.buffer, stats: this.workerStats.buffer, index: i } });
        w.on('error', (e) => this.fail(`worker crashed: ${e.message}`));
        w.unref();
        this.workers.push(w);
      }
    } else {
      this.core = new ThinkCore(Evo, init);
    }
  }

  alloc(cap, capC) {
    this.cap = cap;
    this.capC = capC;
    const n = this.sim.world.cols * this.sim.world.rows;
    const b = {
      snap: new SharedArrayBuffer(cap * F * 8),
      corpses: new SharedArrayBuffer(capC * CF * 8),
      thinkers: new SharedArrayBuffer(cap * 4),
      out: new SharedArrayBuffer(cap * D * 8),
      food: {},
    };
    for (const f of this.Evo.FOODS) b.food[f.key] = new SharedArrayBuffer(n * 4);
    this.buffers = b;
    this.snap = new Float64Array(b.snap);
    this.corpseBuf = new Float64Array(b.corpses);
    this.thinkerBuf = new Int32Array(b.thinkers);
    this.out = new Float64Array(b.out);
    this.food = {};
    for (const f of this.Evo.FOODS) this.food[f.key] = new Float32Array(b.food[f.key]);
  }

  terrain() {
    const w = this.sim.world;
    const max = {};
    for (const f of this.Evo.FOODS) max[f.key] = Float32Array.from(w.food[f.key].max);
    return { biome: Uint8Array.from(w.biome), fertility: Float32Array.from(w.fertility), max };
  }

  initData() {
    const sim = this.sim, w = sim.world;
    return Object.assign({
      cfg: sim.cfg, seed: sim.seed, cols: w.cols, rows: w.rows, wrap: w.wrap,
      tempBase: Float32Array.from(w.tempBase), buffers: this.buffers,
    }, this.terrain());
  }

  fail(reason) {
    if (this.broken) return;
    this.broken = reason;
    this.log(`Multi-core deciding switched off (${reason}); continuing on one core`);
    if (this.sim.thinker === this) this.sim.thinker = null;
    this.close();
  }

  close() {
    if (this.workers) for (const w of this.workers) w.terminate();
    this.workers = null;
  }

  // ---- called by Simulation.step (after the stealth/temperature refresh)
  step(sim, dt) {
    if (this.pending) this.apply(sim);
    if (this.broken) return; // switched off: creatures think for themselves again
    // Whose turn is it to think? (Their timers run here instead of in update.)
    const thinkers = [];
    const cs = sim.creatures;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      c.thinkTimer -= dt;
      if (c.thinkTimer <= 0) {
        c.thinkTimer = 0.25 + sim.rng.float(0, 0.15);
        thinkers.push(i);
      }
    }
    this.dispatch(sim, thinkers);
  }

  dispatch(sim, thinkers) {
    const cs = sim.creatures, w = sim.world;
    const corpses = w.corpses;
    if (cs.length > this.cap || corpses.length > this.capC) this.grow(Math.max(this.cap, cs.length * 2), Math.max(this.capC, corpses.length * 2));
    const tick = sim.tick;
    // Row numbers, stamped with this tick so stale ones are never used.
    for (let i = 0; i < cs.length; i++) { cs[i]._row = i; cs[i]._rowTick = tick; }
    const corpseRow = new Map();
    for (let k = 0; k < corpses.length; k++) corpseRow.set(corpses[k], k);
    const ref = (o) => (o && o._rowTick === tick ? o._row : -1);
    const snap = this.snap, code = this.codes.code;
    const births = [];
    // Forget ids of creatures long gone.
    if (this.known.size > cs.length * 2 + 1000) this.known = new Set(cs.map((c) => c.id).filter((id) => this.known.has(id)));
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i], o = i * F;
      if (!this.known.has(c.id)) {
        this.known.add(c.id);
        // Brains as typed arrays: much cheaper to send to the workers.
        births.push({ id: c.id, species: c.species, g: Object.assign({}, c.g, { brain: Float64Array.from(c.g.brain) }) });
      }
      snap[o + S.id] = c.id; snap[o + S.x] = c.x; snap[o + S.y] = c.y; snap[o + S.heading] = c.heading;
      snap[o + S.state] = code.get(c.state); snap[o + S.species] = c.species; snap[o + S.grow] = c.grow;
      snap[o + S.health] = c.health; snap[o + S.energy] = c.energy; snap[o + S.stomach] = c.stomach;
      snap[o + S.stomachCal] = c.stomachCal; snap[o + S.stamina] = c.stamina; snap[o + S.hungry] = c.hungry ? 1 : 0;
      snap[o + S.huntCooldown] = c.huntCooldown; snap[o + S.age] = c.age; snap[o + S.reproCooldown] = c.reproCooldown;
      snap[o + S.herdSize] = c.herdSize; snap[o + S.stealth] = c.stealth; snap[o + S.sight] = c.sight;
      snap[o + S.sleepy] = c.sleepy; snap[o + S.temp] = c.temp; snap[o + S.chaseTime] = c.chaseTime;
      snap[o + S.lastAttackedAt] = c.lastAttackedAt;
      const t = c.target;
      let kind = KIND.none, r = -1, tx = 0, ty = 0;
      if (t) {
        if (c.targetKind === 'creature') { kind = KIND.creature; r = ref(t); }
        else if (c.targetKind === 'corpse') { kind = KIND.corpse; r = corpseRow.has(t) ? corpseRow.get(t) : -1; }
        else { kind = KIND.tile; tx = t.x; ty = t.y; }
      }
      snap[o + S.targetKind] = kind; snap[o + S.targetRef] = r; snap[o + S.targetX] = tx; snap[o + S.targetY] = ty;
      snap[o + S.chasedBy] = ref(c.chasedBy); snap[o + S.lastAttacker] = ref(c.lastAttacker);
    }
    for (let k = 0; k < corpses.length; k++) {
      const c = corpses[k], o = k * CF;
      this.corpseBuf[o] = c.x; this.corpseBuf[o + 1] = c.y; this.corpseBuf[o + 2] = c.meat; this.corpseBuf[o + 3] = c.species || 0;
    }
    for (const f of this.Evo.FOODS) this.food[f.key].set(w.food[f.key].amt);
    for (let k = 0; k < thinkers.length; k++) this.thinkerBuf[k] = thinkers[k];
    const msg = {
      type: 'step', tick, time: sim.time, n: cs.length, nc: corpses.length, nt: thinkers.length,
      extraTemp: w.extraTemp || 0, cycleTemp: w.cycleTemp || 0,
    };
    // Settings only when they changed.
    const cfgJson = JSON.stringify(sim.cfg);
    if (cfgJson !== this.cfgJson) { this.cfgJson = cfgJson; msg.cfg = sim.cfg; }
    // The coastline moved (sea level): send the new terrain.
    if ((w.biomeVersion || 0) !== this.biomeVersion) {
      this.biomeVersion = w.biomeVersion || 0;
      msg.terrain = this.terrain();
    }
    this.pending = { n: thinkers.length, rows: cs.slice(), corpses: corpses.slice() };
    this.stats.thinkers = thinkers.length;
    if (this.core) {
      if (msg.terrain) this.core.setTerrain(msg.terrain);
      this.core.addBirths(births);
      this.core.refresh(msg);
      this.core.think(msg, 0, thinkers.length);
      return;
    }
    Atomics.store(this.ctrl, 0, 0);
    const per = Math.ceil(thinkers.length / this.workers.length);
    this.workers.forEach((wk, i) => {
      wk.postMessage(Object.assign({}, msg, { births, from: Math.min(thinkers.length, i * per), to: Math.min(thinkers.length, (i + 1) * per) }));
    });
  }

  grow(cap, capC) {
    this.alloc(cap, capC);
    if (this.core) this.core.setBuffers(this.buffers);
    else for (const w of this.workers) w.postMessage({ type: 'buffers', buffers: this.buffers });
  }

  // Wait for the workers, then apply every decision to the real creatures.
  apply(sim) {
    const p = this.pending;
    this.pending = null;
    if (this.workers) {
      const n = this.workers.length;
      const start = Date.now();
      for (;;) {
        const done = Atomics.load(this.ctrl, 0);
        if (done >= n) break;
        if (Date.now() - start > WAIT_MS) { this.fail('a worker stopped answering'); return; }
        Atomics.wait(this.ctrl, 0, done, 100);
      }
    }
    const STATE = this.Evo.Creature.STATE, list = this.codes.list, out = this.out;
    for (let k = 0; k < p.n; k++) {
      const o = k * D;
      const c = p.rows[out[o + O.row]];
      if (!c || !c.alive) continue;
      c.herdSize = out[o + O.herdSize];
      if (!out[o + O.decided]) continue;
      const state = list[out[o + O.state]];
      c.choice = out[o + O.choice];
      const util = c.util || (c.util = new Float32Array(NA));
      const avail = c.avail || (c.avail = new Uint8Array(NA));
      for (let a = 0; a < NA; a++) { util[a] = out[o + O.util + a]; avail[a] = out[o + O.util + NA + a]; }
      c.home = out[o + O.home] ? { x: out[o + O.homeX], y: out[o + O.homeY] } : null;
      const kind = out[o + O.targetKind], ref = out[o + O.targetRef];
      const target = kind === KIND.creature ? (ref >= 0 ? p.rows[ref] : null)
        : kind === KIND.corpse ? (ref >= 0 ? p.corpses[ref] : null)
          : kind === KIND.tile ? { x: out[o + O.tx], y: out[o + O.ty] } : null;
      if (out[o + O.hunt]) {
        if (c.state !== STATE.HUNT) c.chaseTime = 0;
        if (target) target.chasedBy = c;
      }
      if (out[o + O.mate]) c.mateSearch = 0;
      if (state === STATE.FLEE) { c.fleeX = out[o + O.fleeX]; c.fleeY = out[o + O.fleeY]; }
      if (state === STATE.WANDER && !c.home) c.wanderTurn = out[o + O.wanderTurn];
      c.state = state;
      c.target = target;
      if (kind !== KIND.none) c.targetKind = kind === KIND.creature ? 'creature' : kind === KIND.corpse ? 'corpse' : 'tile';
    }
  }
}

module.exports = { ThinkPool };
