// Runs one world forever: paces the simulation to a target speed within a CPU
// budget, saves crash-proof snapshots with rotating backups, checks the world
// for corruption (and rolls back if needed), and keeps a permanent chronicle.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { performance } = require('perf_hooks');

// Load the same simulation code the browser uses.
const JS = path.join(__dirname, '..', 'js');
for (const f of ['version', 'rng', 'config', 'brain', 'genome', 'world', 'creature', 'fame', 'events', 'tree', 'climate', 'eras', 'sim', 'save']) {
  vm.runInThisContext(fs.readFileSync(path.join(JS, f + '.js'), 'utf8'), { filename: f + '.js' });
}
const Evo = globalThis.Evo;
const DT = Evo.K.DT;
const { Timelapse } = require('./timelapse');
const { ThinkPool } = require('./thinkpool');
const os = require('os');

const LIVE_SETTINGS = ['plantGrowth', 'mutationScale', 'seasonStrength', 'seasonLength', 'maxPopulation', 'allowAsexual',
  'migration', 'neuralBrains', 'brainMutation', 'eventRate', 'climate', 'dayLength', 'climateSwing', 'climateCycle'];
const KEEP = { hourly: 48, daily: 60, weekly: 104 };

function log(...args) { console.log(new Date().toISOString(), ...args); }

class Runner {
  constructor(opts) {
    this.dataDir = path.resolve(opts.dataDir);
    this.backupDir = path.join(this.dataDir, 'backups');
    fs.mkdirSync(this.backupDir, { recursive: true });
    this.worldFile = path.join(this.dataDir, 'world.json.gz');
    this.prevFile = path.join(this.dataDir, 'world.prev.json.gz'); // the snapshot before
    this.settingsFile = path.join(this.dataDir, 'server.json');
    this.chronicleFile = path.join(this.dataDir, 'chronicle.jsonl');
    this.snapshotEvery = (opts.snapshotMinutes || 5) * 60000;
    // Worker threads that do the creatures' deciding (0 = everything on one core).
    this.threads = opts.threads !== undefined && Number.isFinite(opts.threads) ? Math.max(0, Math.min(32, opts.threads))
      : Math.max(0, Math.min(4, os.cpus().length - 1));
    // Time-lapse: a map image every N minutes (0 = off).
    this.lapseEvery = (opts.timelapseMinutes === undefined ? 5 : opts.timelapseMinutes) * 60000;
    this.lapse = this.lapseEvery > 0 ? new Timelapse(path.join(this.dataDir, 'timelapse'), Evo) : null;
    // Speed and CPU budget are remembered between restarts.
    const saved = this.readJson(this.settingsFile) || {};
    this.speed = opts.speed !== undefined ? opts.speed : saved.speed !== undefined ? saved.speed : 1; // Infinity = max
    if (this.speed === 'max' || this.speed === null) this.speed = Infinity;
    this.budget = opts.budget !== undefined ? opts.budget : saved.budget !== undefined ? saved.budget : 0.5;
    this.paused = !!saved.paused;
    this.onReset = () => {};  // set by the HTTP server: world replaced
    this.failures = [];       // times of recent crashes / rollbacks
    this.error = null;        // shown in the viewer when the runner gave up
    this.lastSave = null;
    this.stats = { speed: 0, cpu: 0, stepMs: 0 };
    this.acc = 0;
    this.busy = [];           // [wallMs, busyMs] samples for the CPU estimate
  }

  readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
  }

  saveSettings() {
    const s = { speed: this.speed === Infinity ? 'max' : this.speed, budget: this.budget, paused: this.paused };
    fs.writeFileSync(this.settingsFile, JSON.stringify(s, null, 2));
  }

  // ------------------------------------------------------------ world
  start() {
    const sim = this.loadLatest();
    if (sim) {
      this.use(sim);
      log(`Resumed world (seed ${sim.seed}) at ${Evo.fmtTime ? Evo.fmtTime(sim.time) : Math.round(sim.time) + 's'} with ${sim.creatures.length} creatures`);
    } else {
      this.use(new Evo.Simulation(Evo.defaultConfig()));
      log(`Started a new world (seed ${this.sim.seed})`);
      this.snapshot();
    }
    this.last = performance.now();
    this.nextSave = Date.now() + this.snapshotEvery;
    this.nextCheck = Date.now() + 10000;
    this.nextFrame = Date.now() + 30000;
    this.rate = { t: this.sim.time, at: this.last };
    this.loop();
  }

  use(sim) {
    if (this.pool) this.pool.close();
    this.pool = null;
    if (this.threads > 0) {
      try {
        this.pool = sim.thinker = new ThinkPool(Evo, sim, { threads: this.threads, log });
      } catch (e) {
        log('Could not start worker threads, running on one core:', e.message);
      }
    }
    this.sim = sim;
    this.acc = 0;
    sim.onLog = (e) => this.chronicle(e);
    this.onReset();
  }

  // The newest snapshot that loads and passes the checks: the current world
  // file, the one before it, else the backups from newest to oldest.
  loadLatest() {
    const files = [this.worldFile, this.prevFile];
    try {
      const backups = fs.readdirSync(this.backupDir).filter((f) => f.endsWith('.json.gz'))
        .map((f) => path.join(this.backupDir, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      files.push(...backups);
    } catch (e) { /* no backups yet */ }
    for (const f of files) {
      if (!fs.existsSync(f)) continue;
      try {
        const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'));
        const sim = Evo.Save.deserialize(d);
        const bad = this.validate(sim);
        if (bad) throw new Error(bad);
        if (f !== this.worldFile) log(`Loaded backup ${path.basename(f)}`);
        return sim;
      } catch (e) {
        log(`Could not load ${path.basename(f)}: ${e.message}`);
      }
    }
    return null;
  }

  // Returns a description of the first problem found, or null if all is well.
  validate(sim) {
    if (!Number.isFinite(sim.time)) return 'time is not a number';
    const w = sim.world;
    for (const c of sim.creatures) {
      for (const k of ['x', 'y', 'energy', 'health', 'age', 'heading', 'v']) {
        if (!Number.isFinite(c[k])) return `creature #${c.id} has ${k} = ${c[k]}`;
      }
      if (w.wrap && (c.x < -1 || c.y < -1 || c.x > w.width + 1 || c.y > w.height + 1)) return `creature #${c.id} is off the map`;
    }
    for (const f of Evo.FOODS) {
      const a = w.food[f.key].amt;
      for (let i = 0; i < a.length; i += 97) if (!Number.isFinite(a[i])) return `plant food (${f.key}) is not a number`;
    }
    return null;
  }

  // Something went wrong: go back to the last good snapshot. After too many
  // failures in an hour, pause and report instead of looping forever.
  recover(reason) {
    log(`PROBLEM: ${reason}`);
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < 3600000);
    this.failures.push(now);
    this.chronicle({ t: this.sim ? this.sim.time : 0, html: `⚠️ Server problem: ${reason}. Rolled back to the last snapshot.`, important: true });
    if (this.failures.length > 5) {
      this.paused = true;
      this.error = `Paused after ${this.failures.length} problems in an hour. Last: ${reason}`;
      log(this.error);
      return;
    }
    const sim = this.loadLatest();
    if (sim) this.use(sim);
    else { this.paused = true; this.error = 'No snapshot could be loaded: ' + reason; }
  }

  // ------------------------------------------------------------ main loop
  loop() {
    const now = performance.now();
    const real = Math.min(1, (now - this.last) / 1000);
    this.last = now;
    let busy = 0;
    if (!this.paused && !this.error) {
      const max = this.speed === Infinity;
      this.acc = max ? 0 : Math.min(this.acc + real * this.speed, Math.max(1, this.speed * 0.5)); // limited backlog
      const start = performance.now();
      let steps = 0;
      try {
        while ((max || this.acc >= DT) && performance.now() - start < 40) {
          this.sim.step();
          this.acc -= DT;
          steps++;
        }
      } catch (e) {
        this.recover('the simulation crashed: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | '));
      }
      if (max) this.acc = 0;
      busy = performance.now() - start;
      if (steps) this.stats.stepMs = this.stats.stepMs * 0.9 + (busy / steps) * 0.1;
    }
    this.busy.push([now, busy]);
    while (this.busy.length && now - this.busy[0][0] > 5000) this.busy.shift();

    this.periodic(now);

    // Rest so the simulation uses at most `budget` of one CPU core, and don't
    // spin when we're ahead of the target speed.
    let delay = busy > 0 ? (busy * (1 - this.budget)) / this.budget : 50;
    if (!this.paused && this.speed !== Infinity && this.acc < DT) delay = Math.max(delay, ((DT - this.acc) / this.speed) * 1000);
    setTimeout(() => this.loop(), Math.max(1, Math.min(250, delay)));
  }

  periodic(now) {
    // Measured speed and CPU use, over the last few seconds.
    if (now - this.rate.at > 2000) {
      this.stats.speed = (this.sim.time - this.rate.t) / ((now - this.rate.at) / 1000);
      // CPU of the whole process (all threads), as a share of one core.
      const cpu = process.cpuUsage();
      if (this.rate.cpu) this.stats.cpuTotal = ((cpu.user + cpu.system - this.rate.cpu) / 1000) / (now - this.rate.at);
      this.rate = { t: this.sim.time, at: now, cpu: cpu.user + cpu.system };
      const span = this.busy.length ? now - this.busy[0][0] : 1;
      this.stats.cpu = this.busy.reduce((s, b) => s + b[1], 0) / Math.max(1, span);
    }
    const wall = Date.now();
    if (wall >= this.nextCheck) {
      this.nextCheck = wall + 10000;
      this.watchdog();
    }
    if (this.lapse && wall >= this.nextFrame) {
      this.nextFrame = wall + this.lapseEvery;
      try { this.lapse.capture(this.sim); } catch (e) { log('Time-lapse frame failed:', e.message); }
    }
    if (wall >= this.nextSave) {
      this.nextSave = wall + this.snapshotEvery;
      this.snapshot();
    }
  }

  watchdog() {
    if (this.error) return;
    const bad = this.validate(this.sim);
    if (bad) { this.recover(bad); return; }
    // Never let the world end: if everything died, bring in fresh founders.
    if (this.sim.creatures.length === 0) {
      const sim = this.sim;
      for (let i = 0; i < Math.max(20, sim.cfg.initialHerbivores / 2); i++) sim.spawnFounder('herbivore');
      for (let i = 0; i < Math.max(4, sim.cfg.initialCarnivores / 2); i++) sim.spawnFounder('carnivore');
      sim.flush();
      sim.logEvent('🌱 Everything had died out. New founders arrived to restart life', true);
      log('World was empty: respawned founders');
    }
  }

  // ------------------------------------------------------------ saving
  // Written to a temporary file, flushed to disk, then renamed over the old
  // one: a crash mid-save can never leave a broken world file.
  snapshot() {
    const bad = this.validate(this.sim);
    if (bad) { this.recover(bad); return; } // never save a broken world
    try {
      const t0 = performance.now();
      const json = JSON.stringify(Evo.Save.serialize(this.sim));
      const gz = zlib.gzipSync(json, { level: 6 });
      const tmp = this.worldFile + '.tmp';
      const fd = fs.openSync(tmp, 'w');
      fs.writeSync(fd, gz);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      if (fs.existsSync(this.worldFile)) fs.renameSync(this.worldFile, this.prevFile);
      fs.renameSync(tmp, this.worldFile);
      this.lastSave = { at: Date.now(), bytes: gz.length, simTime: this.sim.time, ms: Math.round(performance.now() - t0) };
      this.backup();
    } catch (e) {
      log('Snapshot failed:', e.message);
    }
  }

  // Keep copies: hourly (48), daily (60) and weekly (104).
  backup() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const week = `${d.getFullYear()}-w${pad(Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7))}`;
    const names = { hourly: `hourly-${day}-${pad(d.getHours())}`, daily: `daily-${day}`, weekly: `weekly-${week}` };
    for (const kind of Object.keys(names)) {
      const file = path.join(this.backupDir, names[kind] + '.json.gz');
      if (fs.existsSync(file)) continue;
      fs.copyFileSync(this.worldFile, file);
      const old = fs.readdirSync(this.backupDir).filter((f) => f.startsWith(kind + '-')).sort();
      for (const f of old.slice(0, Math.max(0, old.length - KEEP[kind]))) fs.unlinkSync(path.join(this.backupDir, f));
    }
  }

  // Every logged event, forever (the in-game log only keeps the last 60).
  chronicle(e) {
    const line = JSON.stringify({ wall: new Date().toISOString(), t: Math.round(e.t), seed: this.sim ? this.sim.seed : null, html: e.html, important: e.important }) + '\n';
    fs.appendFile(this.chronicleFile, line, () => {});
  }

  // The newest `limit` entries (newest first); optionally only those of world
  // `seed` after game time `since`, or only the important ones.
  readChronicle(limit, filter = {}) {
    try {
      const size = fs.statSync(this.chronicleFile).size;
      const want = Math.min(size, limit * 400 * (filter.important ? 6 : 1));
      const fd = fs.openSync(this.chronicleFile, 'r');
      const buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, size - want);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      if (want < size) lines.shift(); // probably cut in half
      let out = lines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
      if (filter.seed !== undefined) out = out.filter((e) => e.seed === filter.seed);
      if (filter.since !== undefined) out = out.filter((e) => e.t > filter.since);
      if (filter.important) out = out.filter((e) => e.important);
      return out.slice(-limit).reverse();
    } catch (e) {
      return [];
    }
  }

  // ------------------------------------------------------------ commands
  command(c) {
    const sim = this.sim;
    switch (c.cmd) {
      case 'speed':
        this.speed = c.speed === 'max' ? Infinity : Evo.clamp(Number(c.speed) || 1, 0.1, 1000);
        this.paused = false;
        this.saveSettings();
        return { ok: true };
      case 'budget':
        this.budget = Evo.clamp(Number(c.value) || 0.5, 0.05, 1);
        this.saveSettings();
        return { ok: true };
      case 'pause':
        this.paused = !!c.paused;
        if (!this.paused) this.error = null; // resuming clears a reported problem
        this.saveSettings();
        return { ok: true };
      case 'spawn': {
        const q = this.wrapped(c);
        const cr = sim.spawnAt(c.kind === 'carnivore' ? 'carnivore' : 'herbivore', q.x, q.y);
        return cr ? { ok: true } : { ok: false, message: "Can't place a creature in deep water or on peaks" };
      }
      case 'brush': {
        const q = this.wrapped(c);
        if (c.tool === 'food') sim.growFood(q.x, q.y, 56);
        else if (c.tool === 'smite') sim.smite(q.x, q.y, 56);
        return { ok: true };
      }
      case 'creature': {
        const cr = sim.creatures.find((x) => x.id === c.id);
        if (!cr) return { ok: false, message: 'That creature has died' };
        if (c.act === 'clone') sim.cloneNear(cr, 5);
        if (c.act === 'kill') sim.kill(cr, 'smitten');
        return { ok: true };
      }
      case 'event': {
        if (!Evo.Events.TYPES[c.kind]) return { ok: false, message: 'Unknown event' };
        const ev = Evo.Events.start(sim, c.kind);
        return ev ? { ok: true } : { ok: false, message: c.kind === 'plague' ? 'No species is big enough for a plague (20+ members)' : `A ${Evo.Events.TYPES[c.kind].label.toLowerCase()} is already happening` };
      }
      case 'settings':
        for (const k of LIVE_SETTINGS) if (c.cfg && c.cfg[k] !== undefined) sim.cfg[k] = this.cleanSetting(k, c.cfg[k]);
        return { ok: true };
      case 'newWorld': {
        this.snapshot(); // the old world stays in the backups
        const cfg = Evo.defaultConfig();
        for (const f of Evo.CONFIG_SCHEMA) if (c.cfg && c.cfg[f.key] !== undefined) cfg[f.key] = this.cleanSetting(f.key, c.cfg[f.key]);
        this.use(new Evo.Simulation(cfg));
        this.error = null;
        this.snapshot();
        log(`New world started from the viewer (seed ${this.sim.seed})`);
        return { ok: true };
      }
      case 'save':
        this.snapshot();
        return { ok: true, message: 'Saved' };
      default:
        return { ok: false, message: 'Unknown command' };
    }
  }

  cleanSetting(key, v) {
    const f = Evo.CONFIG_SCHEMA.find((x) => x.key === key);
    if (!f) return v;
    if (f.type === 'bool') return !!v;
    let n = Number(v);
    if (!Number.isFinite(n)) n = f.def;
    n = Evo.clamp(n, f.min, f.max);
    return f.type === 'int' ? Math.round(n) : n;
  }

  wrapped(c) {
    const q = { x: Number(c.x) || 0, y: Number(c.y) || 0 };
    if (this.sim.world.wrap) this.sim.world.wrapPos(q);
    return q;
  }

  importWorld(d) {
    const sim = Evo.Save.deserialize(d);
    const bad = this.validate(sim);
    if (bad) throw new Error(bad);
    this.snapshot();
    this.use(sim);
    this.snapshot();
    log('World replaced by an imported file');
  }

  status() {
    return {
      version: Evo.VERSION.number,
      speed: this.speed === Infinity ? 'max' : this.speed,
      budget: this.budget,
      paused: this.paused,
      error: this.error,
      actualSpeed: this.stats.speed,
      cpu: this.stats.cpu,
      cpuTotal: this.stats.cpuTotal || 0,
      threads: this.pool && this.sim.thinker === this.pool ? this.threads : 0,
      stepMs: this.stats.stepMs,
      lastSave: this.lastSave,
      uptime: process.uptime(),
      memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    };
  }
}

module.exports = { Runner, Evo, log };
