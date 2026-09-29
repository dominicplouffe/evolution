// Hall of fame: all-time records for the current run. Living creatures can
// hold a record (its value keeps updating while they live); records are
// checked once a second and when a creature dies.
(function (Evo) {
  'use strict';

  const CREATURE_RECORDS = [
    { key: 'oldest', label: 'Oldest creature', icon: '⏳', unit: 'time', get: (c) => c.age },
    { key: 'children', label: 'Most children', icon: '👶', get: (c) => c.children },
    { key: 'kills', label: 'Most kills', icon: '🦷', get: (c) => c.kills },
    { key: 'generation', label: 'Deepest generation', icon: '🧬', get: (c) => c.generation },
    { key: 'biggest', label: 'Biggest body', icon: '🐘', digits: 2, get: (c) => (c.grow >= 1 ? c.g.size : 0) },
    { key: 'fastest', label: 'Fastest', icon: '💨', unit: 'speed', get: (c) => (c.grow >= 1 ? c.phen.maxSpeed : 0) },
    { key: 'travelled', label: 'Farthest travelled', icon: '🧭', unit: 'tiles', get: (c) => (c.travelled || 0) / Evo.K.TILE },
  ];
  const SPECIES_RECORDS = [
    { key: 'longestSpecies', label: 'Longest-lasting species', icon: '🏛️', unit: 'time', get: (sp, t) => (sp.extinctAt !== null ? sp.extinctAt : t) - sp.born },
    { key: 'biggestSpecies', label: 'Biggest species', icon: '👑', unit: 'members', get: (sp) => sp.peak },
  ];
  const ALL = CREATURE_RECORDS.concat(SPECIES_RECORDS);

  function holderOf(sim, c, value) {
    const sp = sim.species.get(c.species);
    return { value, id: c.id, species: c.species, name: sp ? sp.name : '?', niche: Evo.niche(c.g), since: sim.time };
  }

  // Check a creature against every creature record.
  function consider(sim, c) {
    const fame = sim.fame;
    for (const r of CREATURE_RECORDS) {
      const v = r.get(c);
      if (!(v > 0)) continue;
      const cur = fame[r.key];
      if (cur && v <= cur.value) continue;
      if (cur && cur.id === c.id) { cur.value = v; continue; }
      fame[r.key] = holderOf(sim, c, v);
      // Announce a new record holder, at most once per record every 3 minutes
      // (and not in the first minute, when every record is broken constantly).
      const log = sim.fameLog || (sim.fameLog = {});
      if (sim.time > 60 && cur && !(sim.time - (log[r.key] || -1e9) < 180)) {
        log[r.key] = sim.time;
        sim.logEvent(`🏆 ${r.label}: a <b>${fame[r.key].name}</b> took the record`);
      }
    }
  }

  function considerSpecies(sim) {
    const fame = sim.fame;
    for (const sp of sim.species.byId.values()) {
      for (const r of SPECIES_RECORDS) {
        const v = r.get(sp, sim.time);
        if (!(v > 0)) continue;
        const cur = fame[r.key];
        if (cur && v <= cur.value) continue;
        if (cur && cur.species === sp.id) { cur.value = v; continue; }
        fame[r.key] = { value: v, species: sp.id, name: sp.name, niche: sp.niche, since: sim.time };
      }
    }
  }

  // Once a second: every living creature, and every species.
  function update(sim) {
    for (const c of sim.creatures) consider(sim, c);
    considerSpecies(sim);
  }

  Evo.Fame = { RECORDS: ALL, CREATURE_RECORDS, SPECIES_RECORDS, consider, update };
})((globalThis.Evo = globalThis.Evo || {}));
