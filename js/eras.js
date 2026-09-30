// Eras: the story of a long run in chapters. An era is a stretch of time with
// the same set of major niches (plant-eater niches with at least 10% of all
// creatures, meat-eaters with 3%; night-active ones counted separately) and
// the same leading species. When the niches change and stay changed for 10
// minutes of game time, a new era begins, named after what appeared or
// disappeared ("The age of the night swimmers", "The age without predators");
// when another species leads for 30 minutes, it's "The Gryras age".
(function (Evo) {
  'use strict';

  const ORDER = ['grazer', 'browser', 'swimmer', 'omnivore', 'carnivore'];
  const PLURAL = { grazer: 'grazers', browser: 'browsers', swimmer: 'swimmers', omnivore: 'omnivores', carnivore: 'predators' };
  const SAMPLE = 60;   // seconds of game time between checks
  const CONFIRM = 10;  // checks in a row before a new era is declared
  const LEAD = 30;     // ...or before a new leading species starts one
  const SHARE = { grazer: 0.1, browser: 0.1, swimmer: 0.1, omnivore: 0.03, carnivore: 0.03 };

  function plural(n) {
    const night = n.startsWith('night ');
    return (night ? 'night ' : '') + PLURAL[night ? n.slice(6) : n];
  }
  function list(names) {
    const p = names.map(plural);
    return p.length > 1 ? p.slice(0, -1).join(', ') + ' and ' + p[p.length - 1] : p[0];
  }

  // The major niches right now, e.g. ['grazer', 'night swimmer', 'carnivore'].
  // Niches already in the current era only drop out below half the share
  // (and night niches below 35% night-active), so a niche hovering around the
  // line doesn't flicker in and out.
  function regime(sim, current = []) {
    const n = sim.creatures.length;
    if (n < 20) return null; // too few to say; keep the current era
    const count = {}, night = {};
    for (const c of sim.creatures) {
      const k = Evo.niche(c.g);
      count[k] = (count[k] || 0) + 1;
      if (c.g.nocturnal > 0.66) night[k] = (night[k] || 0) + 1;
    }
    const out = [];
    for (const k of ORDER) {
      const had = current.includes(k) || current.includes('night ' + k);
      if ((count[k] || 0) < SHARE[k] * n * (had ? 0.5 : 1)) continue;
      const wasNight = current.includes('night ' + k);
      out.push((night[k] || 0) > (wasNight ? 0.35 : 0.5) * count[k] ? 'night ' + k : k);
    }
    return out;
  }

  function name(prev, next) {
    if (!prev) return 'The age of the founders';
    const added = next.filter((k) => !prev.includes(k));
    const removed = prev.filter((k) => !next.includes(k));
    if (added.length) return `The age of the ${list(added)}`;
    if (removed.length) return `The age without ${list(removed)}`;
    return 'A new age';
  }

  function state(sim) {
    if (!sim.eras) sim.eras = { list: [], cand: null, candSince: 0, candCount: 0, next: 0, lastSample: 0 };
    return sim.eras;
  }

  function begin(sim, st, niches, at, leader) {
    const cur = st.list[st.list.length - 1];
    if (cur) finish(sim, cur, at);
    let title = name(cur ? cur.niches : null, niches);
    if (cur && title === 'A new age' && leader) title = `The ${leader.name} age`;
    const era = {
      n: st.list.length + 1, start: at, end: null, niches, name: title, leader: leader ? leader.id : null,
      peak: 0, newSpecies: 0, events: [], dom: {}, dominant: null,
    };
    st.list.push(era);
    if (st.list.length > 2000) st.list.shift();
    if (cur) sim.logEvent(`📖 A new era begins: <b>${era.name}</b> (${list(niches)})`, true);
    return era;
  }

  function finish(sim, era, at) {
    era.end = at;
    era.dominant = dominant(sim, era);
    era.dom = null; // the tallies aren't needed any more
  }

  // The species that led the most checks during the era.
  function dominant(sim, era) {
    if (!era.dom) return era.dominant;
    let best = null, bestN = 0;
    for (const id in era.dom) if (era.dom[id] > bestN) { bestN = era.dom[id]; best = Number(id); }
    if (best === null) return era.dominant;
    const sp = sim.species.get(best);
    return sp ? { id: best, name: sp.name, color: sp.color, niche: sp.niche } : era.dominant;
  }

  // Called with the census; does its work once a minute of game time.
  function update(sim) {
    const st = state(sim);
    if (sim.time < st.next) return;
    st.next = sim.time + SAMPLE;
    let cur = st.list[st.list.length - 1];
    const now = regime(sim, cur ? cur.niches : []);
    if (!cur) {
      if (!now) return;
      cur = begin(sim, st, now, 0, null);
    }
    // Keep the current era's facts up to date.
    cur.peak = Math.max(cur.peak, sim.creatures.length);
    let top = null;
    for (const sp of sim.species.byId.values()) {
      if (sp.count > 0 && (!top || sp.count > top.count)) top = sp;
      if (sp.born > st.lastSample && sp.born <= sim.time && sp.parentId) cur.newSpecies++;
    }
    if (top) cur.dom[top.id] = (cur.dom[top.id] || 0) + 1;
    cur.dominant = dominant(sim, cur);
    for (const e of (sim.disasters && sim.disasters.active) || []) {
      if (!cur.events.some((x) => x.id === e.id)) cur.events.push({ id: e.id, kind: e.kind, t: e.start });
    }
    st.lastSample = sim.time;
    if (!now) return;
    // A different set of niches must hold for a while before it's a new era.
    const key = now.join('|');
    if (key !== cur.niches.join('|')) {
      // Counts checks in a row that differ from the current era; the newest
      // set of niches is the one the new era gets.
      if (st.cand) st.candCount++;
      else { st.candSince = sim.time; st.candCount = 1; }
      st.cand = key;
      if (st.candCount >= CONFIRM) {
        begin(sim, st, now, st.candSince, top);
        st.cand = null;
        st.leadCand = null;
      }
      return;
    }
    st.cand = null;
    // Same niches, but a new species has taken the lead (and kept it).
    if (cur.leader === null || cur.leader === undefined) cur.leader = top ? top.id : null;
    if (!top || top.id === cur.leader) { st.leadCand = null; return; }
    if (st.leadCand === top.id) st.leadCount++;
    else { st.leadCand = top.id; st.leadSince = sim.time; st.leadCount = 1; }
    if (st.leadCount >= LEAD) {
      begin(sim, st, now, st.leadSince, top);
      st.leadCand = null;
    }
  }

  Evo.Eras = { update, state, plural, list, regime };
})((globalThis.Evo = globalThis.Evo || {}));
