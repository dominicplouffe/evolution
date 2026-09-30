// Random events: droughts, ice ages, meteors, plagues and invaders. Each one
// temporarily changes something the simulation already uses (plant growth,
// temperature, creature health) so species must adapt, move or die out.
(function (Evo) {
  'use strict';

  const YEAR = (sim) => sim.cfg.seasonLength;

  const TYPES = {
    drought: { icon: '🏜️', label: 'Drought' },
    iceAge: { icon: '❄️', label: 'Ice age' },
    meteor: { icon: '☄️', label: 'Meteor' },
    plague: { icon: '🦠', label: 'Plague' },
    invaders: { icon: '🐾', label: 'Invaders' },
  };
  const KINDS = Object.keys(TYPES);

  function state(sim) {
    if (!sim.disasters) sim.disasters = { active: [], nextCheck: 300, nextId: 1 };
    if (!sim.disasters.log) sim.disasters.log = []; // every event so far (family tree)
    return sim.disasters;
  }

  // Compass-style description of where something happened.
  function where(sim, x, y) {
    const w = sim.world;
    const v = y / w.height, h = x / w.width;
    const ns = v < 0.33 ? 'north' : v > 0.66 ? 'south' : '';
    const ew = h < 0.33 ? 'west' : h > 0.66 ? 'east' : '';
    return ns || ew ? `the ${ns}${ns && ew ? '-' : ''}${ew}` : 'the middle of the map';
  }

  function landPoint(sim) {
    return sim.world.randomPassablePoint(sim.rng, true);
  }

  // ---------------------------------------------------------------- start
  function start(sim, kind) {
    const st = state(sim);
    if (st.active.some((e) => e.kind === kind)) return null;
    const rng = sim.rng, w = sim.world;
    const size = Math.min(w.width, w.height);
    const e = { id: st.nextId++, kind, start: sim.time };
    if (kind === 'drought') {
      const p = landPoint(sim);
      Object.assign(e, { x: p.x, y: p.y, r: size * rng.float(0.28, 0.4), end: sim.time + YEAR(sim) * rng.float(0.8, 1.2) });
      sim.logEvent(`🏜️ A drought has hit ${where(sim, p.x, p.y)}: plants are withering`, true);
    } else if (kind === 'iceAge') {
      Object.assign(e, { depth: -rng.float(6, 10), end: sim.time + YEAR(sim) * rng.float(2, 3) });
      sim.logEvent(`❄️ An ice age begins: the whole world is cooling by ${Math.round(-e.depth)} °C`, true);
    } else if (kind === 'meteor') {
      const p = landPoint(sim);
      const r = size * rng.float(0.1, 0.15);
      Object.assign(e, { x: p.x, y: p.y, r, fertileR: r * 1.6, end: sim.time + YEAR(sim) });
      let killed = 0;
      sim.hash.rebuild(sim.creatures);
      sim.hash.query(p.x, p.y, r, (c) => { if (c.alive) { sim.kill(c, 'meteor'); killed++; } });
      // Burn the plants in the crater (the ash makes it fertile later).
      const T = Evo.K.TILE, n = Math.ceil(r / T);
      for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) {
        if (Math.hypot(dx, dy) * T > r) continue;
        const i = w.tileIndex(p.x + dx * T, p.y + dy * T);
        if (i >= 0) for (const f of Evo.FOODS) w.food[f.key].amt[i] = 0;
      }
      sim.logEvent(`☄️ A meteor struck ${where(sim, p.x, p.y)}, killing ${killed} creature${killed === 1 ? '' : 's'}. The ash will make the land fertile`, true);
    } else if (kind === 'plague') {
      // Strikes the most numerous species.
      const sp = sim.species.living().sort((a, b) => b.count - a.count)[0];
      if (!sp || sp.count < 20) return null;
      const members = sim.creatures.filter((c) => c.species === sp.id);
      for (let k = 0; k < 4; k++) infect(sim, members[Math.floor(rng.next() * members.length)]);
      Object.assign(e, { species: sp.id, name: sp.name, killed: 0, end: sim.time + YEAR(sim) * 1.5 });
      sim.logEvent(`🦠 A plague breaks out among the <b>${sp.name}</b>`, true);
    } else if (kind === 'invaders') {
      spawnInvaders(sim, e);
      e.end = sim.time + 30;
    }
    st.active.push(e);
    st.log.push(e); // same object, so its end time stays current
    if (st.log.length > 500) st.log.splice(0, st.log.length - 500);
    applyEffects(sim);
    return e;
  }

  // A group of 16 creatures with very different DNA walks in as a new species.
  function spawnInvaders(sim, e) {
    const rng = sim.rng, w = sim.world;
    const hunters = rng.chance(0.4);
    const base = hunters ? sim.carnivoreSpecies.founder : sim.herbivoreSpecies.founder;
    let g = Evo.Genome.mutate(base, rng, 6, 0);
    for (let k = 0; k < 3; k++) g = Evo.Genome.mutate(g, rng, 4, 0);
    g.diet = hunters ? Math.max(0.7, g.diet) : Math.min(0.2, g.diet);
    const p = landPoint(sim);
    // Dressed for the local climate.
    const t = w.tempAtPoint(p.x, p.y, sim.time);
    g.fur = Evo.clamp((26 - t) / 38, 0, 1);
    const sp = sim.species.create(g, null, sim.time);
    for (let k = 0; k < 16; k++) {
      const x = p.x + rng.float(-50, 50), y = p.y + rng.float(-50, 50);
      if (!w.passable(x, y)) continue;
      const c = new Evo.Creature(sim, Evo.Genome.mutate(g, rng, 0.3), x, y, { adult: true, species: sp.id });
      c.age = rng.float(0, g.lifespan * 0.3);
      w.wrapPos(c);
      sim.pending.push(c);
    }
    sim.flush();
    Object.assign(e, { x: p.x, y: p.y, species: sp.id, name: sp.name });
    sim.logEvent(`🐾 Invaders! A group of <b>${sp.name}</b> (${Evo.niche(g)}s) arrived in ${where(sim, p.x, p.y)}`, true);
  }

  function infect(sim, c) {
    if (!c || c.immune || c.infected) return;
    c.infected = sim.time + 25; // sick for 25 s, then immune (if it survives)
  }

  // ---------------------------------------------------------------- per step
  // Recompute the world modifiers from the active events.
  function applyEffects(sim) {
    const st = state(sim), w = sim.world, t = sim.time;
    // Ice age: ramp in over the first quarter, hold, ramp out over the last quarter.
    let extra = 0;
    for (const e of st.active) {
      if (e.kind !== 'iceAge') continue;
      const f = (t - e.start) / (e.end - e.start);
      const k = f < 0.25 ? f / 0.25 : f > 0.75 ? (1 - f) / 0.25 : 1;
      extra += e.depth * Evo.clamp(k, 0, 1);
    }
    w.extraTemp = extra;

    // Plant growth multiplier per tile: droughts (low) and meteor ash (high).
    const zones = st.active.filter((e) => e.kind === 'drought' || e.kind === 'meteor');
    if (!zones.length) { w.growthMul = null; return; }
    const n = w.cols * w.rows;
    if (!w.growthMul || w.growthMul.length !== n) w.growthMul = new Float32Array(n);
    const gm = w.growthMul;
    gm.fill(1);
    const T = Evo.K.TILE;
    for (const e of zones) {
      const R = e.kind === 'drought' ? e.r : e.fertileR;
      const n2 = Math.ceil(R / T);
      const cx = Math.floor(e.x / T), cy = Math.floor(e.y / T);
      for (let dy = -n2; dy <= n2; dy++) for (let dx = -n2; dx <= n2; dx++) {
        const d = Math.hypot(dx, dy) * T;
        if (d > R) continue;
        let tx = cx + dx, ty = cy + dy;
        if (w.wrap) { tx = ((tx % w.cols) + w.cols) % w.cols; ty = ((ty % w.rows) + w.rows) % w.rows; }
        else if (tx < 0 || ty < 0 || tx >= w.cols || ty >= w.rows) continue;
        const i = ty * w.cols + tx;
        const edge = Evo.clamp((R - d) / (R * 0.25), 0, 1); // soft edge
        if (e.kind === 'drought') gm[i] = Math.min(gm[i], 1 - 0.85 * edge);
        else if (t - e.start > 20) gm[i] = Math.max(gm[i], 1 + 1.5 * edge); // ash after the fires
      }
    }
  }

  // Plague: sick creatures lose health and pass it on to close members of
  // their own species (herd animals catch it more). Unusual genotypes resist.
  function plagueStep(sim, e, dt) {
    const sp = sim.species.get(e.species);
    let sick = 0;
    for (const c of sim.creatures) {
      if (!c.infected) continue;
      if (sim.time >= c.infected) { c.infected = 0; c.immune = true; continue; }
      sick++;
      c.health -= c.phen.maxHealth * 0.045 * dt;
      c.energy -= c.phen.basal * 0.3 * dt;
      if (c.health <= 0 && c.deathCause !== 'plague') { c.deathCause = 'plague'; e.killed++; }
      if (sim.rng.next() > dt * 2) continue; // try to spread about twice a second
      sim.hash.query(c.x, c.y, c.phen.radius + 22, (o) => {
        if (o === c || o.species !== c.species || o.infected || o.immune || !o.alive) return;
        const resist = sp ? Evo.clamp(Evo.Genome.distance(o.g, sp.centroid) * 6, 0, 0.8) : 0;
        if (sim.rng.next() < 0.35 * (0.4 + o.g.social) * (1 - resist)) infect(sim, o);
      });
    }
    return sick;
  }

  function step(sim, dt) {
    const st = state(sim);
    // Random start of a new event.
    const rate = sim.cfg.eventRate;
    if (rate > 0 && sim.time >= st.nextCheck) {
      st.nextCheck = sim.time + 30;
      // About one event every 1.5 years at rate 1.
      if (st.active.length < 2 && sim.rng.next() < (30 / (YEAR(sim) * 1.5)) * rate) {
        const options = KINDS.filter((k) => !st.active.some((e) => e.kind === k));
        start(sim, options[Math.floor(sim.rng.next() * options.length)]);
      }
    }
    if (!st.active.length) { sim.world.extraTemp = 0; sim.world.growthMul = null; return; }

    for (const e of st.active) {
      if (e.kind === 'plague') {
        const sick = plagueStep(sim, e, dt);
        if (sick === 0 && sim.time - e.start > 5) e.end = sim.time; // burnt out
      }
    }
    // Finish events.
    const done = st.active.filter((e) => sim.time >= e.end);
    if (done.length) {
      st.active = st.active.filter((e) => sim.time < e.end);
      for (const e of done) {
        if (e.kind === 'drought') sim.logEvent('🌧️ The drought is over');
        if (e.kind === 'iceAge') sim.logEvent('☀️ The ice age has ended');
        if (e.kind === 'meteor') sim.logEvent('🌱 The meteor crater has grown back');
        if (e.kind === 'plague') {
          sim.logEvent(`🦠 The plague among the <b>${e.name}</b> is over (${e.killed} died)`);
          for (const c of sim.creatures) c.infected = 0;
        }
      }
    }
    // Refresh modifiers about once a second (and when events change).
    if (done.length || !st.lastApply || sim.time - st.lastApply > 1) {
      st.lastApply = sim.time;
      applyEffects(sim);
    }
  }

  Evo.Events = { TYPES, KINDS, start, step, state, applyEffects };
})((globalThis.Evo = globalThis.Evo || {}));
