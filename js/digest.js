// "While you were away": a summary of what changed in the world since a
// moment in the past (your last visit, or the last hour / day / week): the
// population, species that appeared and died out, niches gained and lost, new
// eras, random events, climate, new records and the chronicle's highlights.
(function (Evo) {
  'use strict';

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Game time at a real (wall-clock) moment, from the history's timestamps.
  function timeAtWall(sim, wall) {
    for (const h of sim.history) if (h.w && h.w >= wall) return h.t;
    const last = sim.history[sim.history.length - 1];
    return last && last.w && last.w < wall ? sim.time : (sim.history[0] ? sim.history[0].t : 0);
  }

  function realSpan(ms) {
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m} min`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
    return `${Math.round(h / 24)} days`;
  }

  function gameSpan(sim, s) {
    const y = s / sim.cfg.seasonLength;
    return y >= 1 ? `${y < 10 ? y.toFixed(1) : Math.round(y)} game-years` : `${Math.max(1, Math.round(s / 60))} game-minutes`;
  }

  // `from`: game time to compare against; `wallMs`: how long ago that was in
  // real time (for the heading, optional); `highlights`: important chronicle
  // entries since then ({t, html}), newest first.
  function build(sim, from, wallMs, highlights) {
    const H = sim.history;
    if (!H.length) return '<p class="muted">Nothing recorded yet.</p>';
    let then = H[0];
    for (const h of H) { if (h.t <= from) then = h; else break; }
    const now = H[H.length - 1];
    const span = Math.max(0, now.t - from);
    const year = (t) => Math.floor(t / sim.cfg.seasonLength) + 1;
    let lo = Infinity, hi = 0;
    for (const h of H) if (h.t >= from) { lo = Math.min(lo, h.n); hi = Math.max(hi, h.n); }
    const parts = [];
    parts.push(`<p class="digest-head">${wallMs ? `<b>${realSpan(wallMs)}</b> of real time · ` : ''}<b>${gameSpan(sim, span)}</b> (year ${year(from)} → ${year(now.t)})</p>`);

    // Population.
    const arrow = (a, b) => `${a} → <b>${b}</b>`;
    parts.push(`<h3>👥 Population</h3><p>${arrow(then.n, now.n)} creatures${Number.isFinite(lo) ? ` (between ${lo} and ${hi} meanwhile)` : ''}.
      Plant-eaters ${arrow(then.herbivore, now.herbivore)}, omnivores ${arrow(then.omnivore, now.omnivore)}, predators ${arrow(then.carnivore, now.carnivore)}.</p>`);

    // Niches gained and lost (share of the population).
    if (then.niches && now.niches) {
      const pct = (h, k) => (h.n ? Math.round((100 * (h.niches[k] || 0)) / h.n) : 0);
      const lines = [];
      for (const k of ['grazer', 'browser', 'swimmer', 'omnivore', 'carnivore']) {
        const a = pct(then, k), b = pct(now, k);
        if (a < 5 && b >= 5) lines.push(`${Evo.Eras.plural(k)} appeared (${b}%)`);
        else if (a >= 5 && b < 5) lines.push(`${Evo.Eras.plural(k)} faded out (${a}% → ${b}%)`);
        else if (Math.abs(a - b) >= 15) lines.push(`${Evo.Eras.plural(k)} ${a}% → ${b}%`);
      }
      if (lines.length) parts.push(`<h3>🧭 Niches</h3><p>${lines.map((l) => l[0].toUpperCase() + l.slice(1)).join('. ')}.</p>`);
    }

    // Species.
    const all = [...sim.species.byId.values()];
    const born = all.filter((sp) => sp.born > from && sp.peak > 0).sort((a, b) => b.peak - a.peak);
    const died = all.filter((sp) => sp.extinctAt !== null && sp.extinctAt > from && sp.peak >= 5).sort((a, b) => b.peak - a.peak);
    const spLine = (sp) => `<span class="swatch" style="background:${sp.color}"></span>${esc(sp.name)} <span class="muted">(${sp.niche}${sp.centroid && sp.centroid.nocturnal > 0.66 ? ', night' : ''}, peak ${sp.peak}${sp.count > 0 ? `, ${sp.count} alive` : ', extinct'})</span>`;
    let sp = `<h3>🧬 Species</h3><p>${then.species} → <b>${now.species}</b> living species. `;
    sp += born.length ? `<b>${born.length}</b> new species appeared` : 'No new species appeared';
    sp += died.length ? `, <b>${died.length}</b> died out.` : ', none of note died out.';
    sp += '</p>';
    if (born.length) sp += `<p class="muted small">Most successful newcomers:</p><ul>${born.slice(0, 5).map((s) => `<li>${spLine(s)}</li>`).join('')}</ul>`;
    if (died.length) sp += `<p class="muted small">Biggest losses:</p><ul>${died.slice(0, 5).map((s) => `<li>${spLine(s)}</li>`).join('')}</ul>`;
    parts.push(sp);

    // Eras.
    const eras = (sim.eras && sim.eras.list) || [];
    const newEras = eras.filter((e) => e.start > from);
    const cur = eras[eras.length - 1];
    if (cur) {
      parts.push(`<h3>📖 Eras</h3><p>${newEras.length ? `${newEras.length} new era${newEras.length > 1 ? 's' : ''}: ${newEras.map((e) => `<b>${esc(e.name)}</b>`).join(' → ')}.` : `Still <b>${esc(cur.name)}</b> (since year ${year(cur.start)}).`}</p>`);
    }

    // Random events and climate.
    const log = (sim.disasters && sim.disasters.log) || [];
    const evs = log.filter((e) => e.start > from);
    const T = Evo.Events.TYPES;
    const climate = Evo.Climate.describe(sim);
    if (evs.length || climate) {
      const counts = {};
      for (const e of evs) counts[e.kind] = (counts[e.kind] || 0) + 1;
      const txt = Object.keys(counts).map((k) => `${T[k].icon} ${counts[k] > 1 ? counts[k] + ' × ' : ''}${T[k].label.toLowerCase()}`).join(', ');
      parts.push(`<h3>🌍 World</h3><p>${evs.length ? `Random events: ${txt}.` : 'No random events.'}${climate ? ` Climate now: ${esc(climate.replace('🌍 ', ''))}.` : ''}</p>`);
    }

    // New records.
    const recs = Evo.Fame.RECORDS.filter((r) => sim.fame[r.key] && sim.fame[r.key].since > from);
    if (recs.length) {
      parts.push(`<h3>🏆 New records</h3><ul>${recs.map((r) => `<li>${r.icon} ${esc(r.label)}: <b>${esc(sim.fame[r.key].name)}</b></li>`).join('')}</ul>`);
    }

    // Highlights from the chronicle.
    if (highlights && highlights.length) {
      parts.push(`<h3>⭐ Highlights</h3><ul class="digest-log">${highlights.slice(0, 12).map((e) => `<li><span class="muted">year ${year(e.t)}</span> ${e.html}</li>`).join('')}</ul>`);
    }
    return parts.join('');
  }

  Evo.Digest = { build, timeAtWall };
})((globalThis.Evo = globalThis.Evo || {}));
