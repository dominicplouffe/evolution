// Save / load a whole run: terrain and plants, creatures, carcasses, species,
// history and the random number state, so a loaded world carries on exactly.
// Saves go to browser storage (compressed when the browser supports it) or
// to a downloadable .json file. No DOM here except the file helpers.
(function (Evo) {
  'use strict';

  const FORMAT = 1;
  const STORE_KEY = 'evolution.save.v1';

  // Creature fields worth keeping. References to other objects (targets,
  // attackers...) are dropped; creatures simply re-decide after loading.
  const CREATURE_FIELDS = [
    'id', 'x', 'y', 'heading', 'v', 'age', 'grow', 'health', 'energy', 'stamina', 'stomach', 'stomachCal',
    'hungry', 'exhausted', 'species', 'generation', 'parentIds', 'children', 'kills', 'reproCooldown',
    'mateSearch', 'huntCooldown', 'bornAt', 'herdSize', 'growStart', 'travelled',
  ];
  const KEEP_STATES = new Set(['Wandering', 'Resting', 'Digesting', 'Eating']);

  // ---- typed arrays <-> base64
  function toB64(typed) {
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(b64, Type) {
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return new Type(bytes.buffer);
  }

  // Brains are stored as compact base64 (Brain.from() reads them back).
  function packGenome(g) {
    const o = Object.assign({}, g);
    if (g.brain) o.brain = Evo.Brain.encode(g.brain);
    return o;
  }

  // Saves from before temperature existed: rebuild it from latitude and terrain.
  function fallbackTemps(world) {
    const t = new Float32Array(world.cols * world.rows);
    const altitude = [0, 0, 0, 0.05, 0.1, 0.15, 0.6, 1];
    for (let i = 0; i < t.length; i++) {
      const y = Math.floor(i / world.cols);
      const warmth = 0.5 - 0.5 * Math.cos((2 * Math.PI * (y + 0.5)) / world.rows);
      t[i] = 2 + 32 * warmth - 24 * altitude[world.biome[i]];
    }
    return t;
  }

  function serialize(sim) {
    const w = sim.world;
    const food = {};
    for (const f of Evo.FOODS) food[f.key] = { amt: toB64(w.food[f.key].amt), max: toB64(w.food[f.key].max) };
    return {
      format: FORMAT,
      version: Evo.VERSION ? Evo.VERSION.number : '?',
      savedAt: new Date().toISOString(),
      cfg: sim.cfg,
      seed: sim.seed,
      rng: sim.rng.state,
      time: sim.time,
      nextCreatureId: Evo.Creature.getNextId(),
      world: { biome: toB64(w.biome), fertility: toB64(w.fertility), tempBase: toB64(w.tempBase), food, corpses: w.corpses },
      creatures: sim.creatures.filter((c) => c.alive).map((c) => {
        const o = { g: packGenome(c.g), state: KEEP_STATES.has(c.state) ? c.state : 'Wandering' };
        for (const k of CREATURE_FIELDS) o[k] = c[k];
        return o;
      }),
      species: {
        nextId: sim.species.nextId,
        list: [...sim.species.byId.values()].map((sp) => {
          const o = Object.assign({}, sp);
          delete o._sum;
          o.founder = packGenome(sp.founder);
          o.centroid = packGenome(sp.centroid);
          return o;
        }),
        herbivore: sim.herbivoreSpecies.id,
        carnivore: sim.carnivoreSpecies.id,
      },
      stats: sim.stats,
      history: sim.history,
      historyEvery: sim.historyEvery,
      nextSample: sim.nextSample,
      nextMigrationCheck: sim.nextMigrationCheck,
      missingSince: sim.missingSince,
      events: sim.events,
      fame: sim.fame,
    };
  }

  // Rebuild a Simulation from saved data without running the normal setup.
  function deserialize(d) {
    if (!d || d.format !== FORMAT) throw new Error('Unrecognised save file');
    const cfg = Object.assign(Evo.defaultConfig(), d.cfg);
    const sim = Object.create(Evo.Simulation.prototype);
    sim.cfg = cfg;
    sim.seed = d.seed;
    sim.rng = new Evo.RNG(d.seed);

    // World: same size and settings, then overwrite terrain and plants.
    const world = Object.create(Evo.World.prototype);
    const T = Evo.K.TILE;
    Object.assign(world, {
      cfg, cols: cfg.worldWidth, rows: cfg.worldHeight, width: cfg.worldWidth * T, height: cfg.worldHeight * T, wrap: cfg.wrap,
    });
    world.biome = fromB64(d.world.biome, Uint8Array);
    world.fertility = fromB64(d.world.fertility, Float32Array);
    world.tempBase = d.world.tempBase ? fromB64(d.world.tempBase, Float32Array) : fallbackTemps(world); // before v0.9
    world.food = {};
    for (const f of Evo.FOODS) {
      const saved = d.world.food[f.key];
      const n = world.cols * world.rows;
      world.food[f.key] = saved
        ? { amt: fromB64(saved.amt, Float32Array), max: fromB64(saved.max, Float32Array) }
        : { amt: new Float32Array(n), max: new Float32Array(n) };
    }
    if (world.biome.length !== world.cols * world.rows) throw new Error('Save file is damaged (map size mismatch)');
    world.corpses = (d.world.corpses || []).map((c) => ({ x: c.x, y: c.y, meat: c.meat, initial: c.initial, species: c.species }));
    world.corpseHash = new Evo.SpatialHash(world, 64);
    world.corpseHash.rebuild(world.corpses);
    sim.world = world;
    sim.hash = new Evo.SpatialHash(world, 64);

    // Species.
    sim.species = new Evo.SpeciesRegistry(sim.rng);
    for (const sp of d.species.list) {
      sp.founder = Evo.Genome.make(sp.founder);
      sp.centroid = Evo.Genome.make(sp.centroid || sp.founder);
      sp.niche = sp.niche || Evo.niche(sp.centroid);
      sp.color = sp.color || Evo.speciesColor(sp.id, null); // saves from before v0.7
      sim.species.byId.set(sp.id, sp);
    }
    sim.species.nextId = d.species.nextId;
    sim.herbivoreSpecies = sim.species.get(d.species.herbivore);
    sim.carnivoreSpecies = sim.species.get(d.species.carnivore);

    // Plain state.
    sim.time = d.time;
    sim.pending = [];
    sim.stats = d.stats;
    sim.history = d.history || [];
    sim.historyEvery = d.historyEvery || 1;
    sim.nextSample = d.nextSample || d.time;
    sim.nextMigrationCheck = d.nextMigrationCheck || d.time;
    sim.missingSince = d.missingSince || { herbivore: null, carnivore: null };
    sim.events = d.events || [];
    sim.fame = d.fame || {};

    // Creatures: construct normally (fills in every field), then restore.
    // Missing genes (from an older version) get their default value.
    sim.creatures = d.creatures.map((o) => {
      const c = new Evo.Creature(sim, Evo.Genome.make(o.g), o.x, o.y, { species: o.species, adult: true });
      for (const k of CREATURE_FIELDS) if (o[k] !== undefined) c[k] = o[k];
      if (o.growStart === undefined) c.growStart = o.grow >= 1 ? 1 : 0; // saves from before v0.6
      c.phen = Evo.Genome.phenotype(c.g, c.grow);
      c.state = o.state || 'Wandering';
      c.thinkTimer = 0;
      if (!sim.species.get(c.species)) c.species = sim.herbivoreSpecies.id;
      return c;
    });
    Evo.Creature.setNextId(Math.max(d.nextCreatureId || 1, ...sim.creatures.map((c) => c.id + 1)));
    sim.rng.state = d.rng; // restore last, after the constructors above drew numbers
    return sim;
  }

  // ---- gzip helpers (native CompressionStream, where available)
  async function gzip(text) {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }

  // ---- browser storage
  async function saveToStorage(sim) {
    const json = JSON.stringify(serialize(sim));
    let payload = json;
    if (typeof CompressionStream !== 'undefined') payload = 'gz:' + toB64(await gzip(json));
    localStorage.setItem(STORE_KEY, payload); // may throw (quota / blocked storage)
    return { bytes: payload.length, savedAt: new Date() };
  }

  async function loadFromStorage() {
    const payload = localStorage.getItem(STORE_KEY);
    if (!payload) return null;
    const json = payload.startsWith('gz:') ? await gunzip(fromB64(payload.slice(3), Uint8Array)) : payload;
    return deserialize(JSON.parse(json));
  }

  function storageInfo() {
    try {
      const payload = localStorage.getItem(STORE_KEY);
      if (!payload) return null;
      return { bytes: payload.length };
    } catch (e) {
      return null;
    }
  }

  function clearStorage() {
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
  }

  // ---- files
  function exportFile(sim) {
    const blob = new Blob([JSON.stringify(serialize(sim))], { type: 'application/json' });
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    a.href = URL.createObjectURL(blob);
    a.download = `evolution-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function importFile(file) {
    let text;
    if (file.name.endsWith('.gz')) text = await gunzip(new Uint8Array(await file.arrayBuffer()));
    else text = await file.text();
    return deserialize(JSON.parse(text));
  }

  Evo.Save = { serialize, deserialize, saveToStorage, loadFromStorage, storageInfo, clearStorage, exportFile, importFile };
})((globalThis.Evo = globalThis.Evo || {}));
