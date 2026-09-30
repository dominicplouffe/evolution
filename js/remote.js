// Viewer mode: when the page is served by the Evolution server, it doesn't run
// its own world. It keeps a local "mirror" of the server's world (loaded from a
// snapshot, then kept up to date by a live stream) so the map, panels, chart
// and family tree work exactly as in the standalone game, and god tools become
// commands sent to the server.
(function (Evo) {
  'use strict';

  const FRAME_MS = 200; // the server sends positions 5 times a second

  function token() {
    let t = null;
    try {
      t = new URLSearchParams(location.search).get('token');
      if (t) localStorage.setItem('evolution.token', t);
      else t = localStorage.getItem('evolution.token');
    } catch (e) { /* no storage */ }
    return t || '';
  }

  function api(path) {
    const t = token();
    return path + (t ? (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t) : '');
  }

  function b64bytes(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  class Remote {
    // Is this page being served by the Evolution server?
    static async detect() {
      if (location.protocol === 'file:') return false;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 2000);
        const r = await fetch(api('api/status'), { signal: ctl.signal, cache: 'no-store' });
        clearTimeout(timer);
        if (r.status === 403) return 'token';
        const j = await r.json();
        return !!(j && j.server);
      } catch (e) {
        return false;
      }
    }

    constructor(app) {
      this.app = app;
      this.sim = null;
      this.status = null;
      this.byId = new Map();
      this.pending = new Set();   // creature ids we still need the DNA of
      this.fetching = false;
      this.frameAt = 0;
      this.connected = false;
    }

    // Open the stream first (buffering what arrives), then load the snapshot,
    // then apply the buffer, so nothing that happens in between is missed.
    async connect() {
      this.buffer = [];
      this.ready = false;
      if (!this.es) {
        this.es = new EventSource(api('api/stream'));
        for (const kind of ['frame', 'meta', 'food', 'reset']) {
          this.es.addEventListener(kind, (e) => this.receive(kind, e.data));
        }
        // After a server restart (maybe rolled back to a snapshot), reload it all.
        this.es.onopen = () => {
          if (this.lostConnection && this.ready) this.reload();
          this.connected = true;
          this.lostConnection = false;
        };
        this.es.onerror = () => { this.connected = false; this.lostConnection = true; };
      }
      const r = await fetch(api('api/snapshot'), { cache: 'no-store' });
      const sim = Evo.Save.deserialize(await r.json());
      sim.remote = true;
      this.sim = sim;
      this.byId = new Map(sim.creatures.map((c) => [c.id, c]));
      for (const c of sim.creatures) this.initMotion(c);
      this.ready = true;
      for (const [kind, data] of this.buffer) this.receive(kind, data);
      this.buffer = null;
      return sim;
    }

    receive(kind, data) {
      if (!this.ready) { if (this.buffer) this.buffer.push([kind, data]); return; }
      if (kind === 'reset') { this.reload(); return; }
      const m = JSON.parse(data);
      if (kind === 'frame') this.onFrame(m);
      else if (kind === 'meta') this.onMeta(m);
      else if (kind === 'food') this.onFood(m);
    }

    // The server replaced the whole world (new world, import, rollback).
    async reload() {
      if (this.reloading) return;
      this.reloading = true;
      this.ready = false;
      this.buffer = [];
      try {
        const sim = await this.connect();
        this.app.useSim(sim, true);
        this.app.toast('Reloaded the world from the server');
      } catch (e) {
        this.ready = true; // keep showing the old copy; the next reconnect tries again
        this.lostConnection = true;
      }
      this.reloading = false;
    }

    initMotion(c) {
      c.x0 = c.x1 = c.x;
      c.y0 = c.y1 = c.y;
    }

    // ---------------------------------------------------------- stream
    onFrame(m) {
      const sim = this.sim, w = sim.world, S = Evo.Creature.STATE;
      const bytes = b64bytes(m.b);
      const dv = new DataView(bytes.buffer);
      const n = bytes.length / 20;
      const seen = new Set();
      // Where each creature is drawn right now becomes the start of the next glide.
      for (const c of sim.creatures) { c.x0 = c.x; c.y0 = c.y; }
      for (let i = 0; i < n; i++) {
        const o = i * 20;
        const id = dv.getUint32(o, true);
        seen.add(id);
        const c = this.byId.get(id);
        if (!c) { this.pending.add(id); continue; }
        c.species = dv.getUint32(o + 4, true);
        c.x1 = dv.getFloat32(o + 8, true);
        c.y1 = dv.getFloat32(o + 12, true);
        // Big jumps (wrapping around, teleports) snap instead of gliding.
        if (Math.abs(w.dx(c.x0, c.x1)) + Math.abs(w.dy(c.y0, c.y1)) > 200) { c.x0 = c.x1; c.y0 = c.y1; }
        c.heading = (dv.getUint8(o + 16) / 255) * Math.PI * 2;
        const grow = dv.getUint8(o + 17) / 255;
        if (Math.abs(grow - c.grow) > 0.02 || (grow >= 1 && c.grow < 1)) { c.grow = grow >= 0.999 ? 1 : grow; c.phen = Evo.Genome.phenotype(c.g, c.grow); }
        const f = dv.getUint8(o + 18);
        c.infected = f & 2 ? 1 : 0;
        const st = f & 1 ? S.FLEE : f & 4 ? S.SLEEP : null;
        if (st) c.state = st;
        else if (c.state === S.FLEE || c.state === S.SLEEP) c.state = S.WANDER;
      }
      // Gone from the frame: died.
      let k = 0;
      for (const c of sim.creatures) {
        if (seen.has(c.id)) sim.creatures[k++] = c;
        else { c.alive = false; this.byId.delete(c.id); }
      }
      sim.creatures.length = k;
      sim.time = m.t;
      this.frameAt = performance.now();
      if (this.pending.size) this.fetchNew();
    }

    // DNA and details of creatures born since we last looked.
    async fetchNew() {
      if (this.fetching) return;
      this.fetching = true;
      const ids = [...this.pending].slice(0, 2000);
      try {
        const r = await fetch(api('api/creatures'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
        const list = await r.json();
        const sim = this.sim;
        for (const d of list) {
          if (this.byId.has(d.id)) continue;
          const c = new Evo.Creature(sim, Evo.Genome.make(d.g), 0, 0, { species: d.species, adult: true });
          this.applyDetail(c, d); // sets its position too
          this.initMotion(c);
          this.byId.set(c.id, c);
          sim.creatures.push(c);
        }
        for (const id of ids) this.pending.delete(id);
      } catch (e) { /* retried on the next frame */ }
      this.fetching = false;
    }

    applyDetail(c, d) {
      for (const k of ['id', 'species', 'generation', 'parentIds', 'bornAt', 'energy', 'health', 'stamina', 'stomach', 'stomachCal',
        'hungry', 'state', 'age', 'children', 'kills', 'temp', 'sight', 'choice', 'deathCause', 'travelled']) {
        if (d[k] !== undefined && d[k] !== null) c[k] = d[k];
      }
      if (d.grow !== undefined) { c.grow = d.grow; c.phen = Evo.Genome.phenotype(c.g, c.grow); }
      if (d.util) c.util = Float32Array.from(d.util);
      if (d.avail) c.avail = Uint8Array.from(d.avail);
      if (d.brain) c.g.brain = Evo.Brain.from(d.brain);
      if (d.x !== undefined) { c.x = d.x; c.y = d.y; }
    }

    // Glide creatures from their last position to the newest one.
    animate(now) {
      if (!this.sim) return;
      const f = Math.min(1, (now - this.frameAt) / FRAME_MS);
      const w = this.sim.world;
      for (const c of this.sim.creatures) {
        if (c.x1 === undefined) continue;
        // A missing start point (never expected) snaps to the target instead of
        // hiding the creature for good.
        if (!Number.isFinite(c.x0) || !Number.isFinite(c.y0)) { c.x0 = c.x1; c.y0 = c.y1; }
        c.x = c.x0 + w.dx(c.x0, c.x1) * f;
        c.y = c.y0 + w.dy(c.y0, c.y1) * f;
        if (w.wrap) w.wrapPos(c);
      }
    }

    onMeta(m) {
      const sim = this.sim;
      sim.tick = m.tick;
      sim.seed = m.seed;
      Object.assign(sim.cfg, m.cfg);
      sim.stats = m.stats;
      const lastT = sim.history.length ? sim.history[sim.history.length - 1].t : -1;
      for (const h of m.history) if (h.t > lastT) sim.history.push(h);
      if (sim.history.length > 1500) sim.thinHistory();
      for (const s of m.species) {
        s.centroid = Evo.Genome.make(s.centroid);
        const cur = sim.species.get(s.id);
        if (cur) Object.assign(cur, s);
        else sim.species.byId.set(s.id, s);
      }
      sim.species.nextId = m.speciesNextId;
      if (m.fame) sim.fame = m.fame;
      if (m.events) sim.events = m.events;
      if (m.eras) sim.eras = m.eras;
      Evo.Climate.apply(sim); // follows from the time: warm/cold, wet/dry, coastline
      if (m.disasters) {
        if (!sim.disasters) sim.disasters = { active: [], log: [], nextCheck: 0, nextId: 1 };
        const log = sim.disasters.log || (sim.disasters.log = []);
        sim.disasters.active = m.disasters.active.map((e) => {
          const known = log.find((x) => x.id === e.id);
          if (known) return Object.assign(known, e);
          log.push(e);
          return e;
        });
      }
      sim.world.extraTemp = m.extraTemp;
      const cs = m.corpses, list = [];
      for (let i = 0; i < cs.length; i += 4) list.push({ x: cs[i], y: cs[i + 1], meat: cs[i + 2], initial: cs[i + 2], species: cs[i + 3] });
      sim.world.corpses = list;
      sim.treeEvery = m.treeEvery;
      sim.historyOldEvery = m.historyOldEvery;
      this.status = m.runner;
      // A viewer can stay open for months: keep its copy bounded like the server's.
      if (sim.time >= (this.nextPrune || 0)) {
        this.nextPrune = sim.time + 600;
        sim.pruneSpecies();
        const log = sim.disasters && sim.disasters.log;
        if (log && log.length > 500) log.splice(0, log.length - 500);
      }
    }

    onFood(m) {
      const w = this.sim.world;
      for (const f of Evo.FOODS) {
        if (!m[f.key]) continue;
        const q = b64bytes(m[f.key]);
        const { amt, max } = w.food[f.key];
        for (let i = 0; i < q.length && i < amt.length; i++) amt[i] = (q[i] / 255) * max[i];
      }
    }

    // ---------------------------------------------------------- commands
    async cmd(body) {
      try {
        const r = await fetch(api('api/cmd'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json();
        if (j.message) this.app.toast(j.message);
        return j;
      } catch (e) {
        this.app.toast('Could not reach the server');
        return { ok: false };
      }
    }

    // Keep the selected creature's full details fresh (energy, brain...).
    async refreshDetail(c) {
      if (!c || this.detailBusy) return;
      this.detailBusy = true;
      try {
        const r = await fetch(api('api/creature?id=' + c.id), { cache: 'no-store' });
        const d = await r.json();
        if (d.alive === false) { c.alive = false; if (d.deathCause) c.deathCause = d.deathCause; }
        else { const x = c.x, y = c.y; this.applyDetail(c, d); c.x = x; c.y = y; }
      } catch (e) { /* try again later */ }
      this.detailBusy = false;
    }

    api(path) { return api(path); }
    exportUrl() { return api('api/export'); }
    chronicleUrl() { return api('chronicle'); }

    async importFile(file) {
      const r = await fetch(api('api/import'), { method: 'POST', body: file });
      return r.json();
    }
  }

  Evo.Remote = Remote;
})((globalThis.Evo = globalThis.Evo || {}));
