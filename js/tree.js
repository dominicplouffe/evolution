// Family tree of species (a phylogenetic "spindle" diagram): every species is
// a band from the time it appeared to the time it died out, as thick as its
// population was, branching off its parent species.
(function (Evo) {
  'use strict';

  const MAX_SAMPLES = 400; // per species; older history gets coarser

  // Called once a second from the census: record each species' population
  // every `sim.treeEvery` seconds, as sp.pop = { i0, v } where v[j] is the
  // count at time (i0 + j) * treeEvery.
  function sample(sim) {
    if (sim.time < (sim.treeNext || 0)) return;
    let every = sim.treeEvery || 5;
    while (sim.time / every > MAX_SAMPLES) {
      every *= 2;
      for (const sp of sim.species.byId.values()) if (sp.pop) halve(sp.pop);
    }
    sim.treeEvery = every;
    const g = Math.round(sim.time / every);
    sim.treeNext = (g + 1) * every;
    for (const sp of sim.species.byId.values()) {
      let p = sp.pop;
      if (!p) {
        if (sp.count === 0) continue;
        p = sp.pop = { i0: g, v: [] };
      }
      const last = p.v.length ? p.v[p.v.length - 1] : 0;
      if (sp.count === 0 && last === 0) continue; // extinct and already recorded
      while (p.i0 + p.v.length < g) p.v.push(last);
      if (p.i0 + p.v.length === g) p.v.push(sp.count);
    }
  }

  // Merge pairs of samples (keeping the bigger count) when the step doubles.
  function halve(p) {
    const i0 = Math.floor(p.i0 / 2);
    const v = [];
    for (let j = 0; j < p.v.length; j++) {
      const k = Math.floor((p.i0 + j) / 2) - i0;
      v[k] = Math.max(v[k] || 0, p.v[j]);
    }
    p.i0 = i0;
    p.v = v;
  }

  // Which species to draw, in which order. Tiny species (peak below
  // `minPeak`) are hidden unless alive or an ancestor of a shown species.
  // Children are listed below their parent, newest first, so branch lines
  // never cross another branch.
  function layout(sim, minPeak) {
    const all = [...sim.species.byId.values()].filter((sp) => sp.peak > 0 || sp.count > 0);
    const byId = new Map(all.map((sp) => [sp.id, sp]));
    const shown = new Set();
    for (const sp of all) {
      if (sp.peak < minPeak && sp.count === 0) continue;
      for (let s = sp; s && !shown.has(s.id); s = byId.get(s.parentId)) shown.add(s.id);
    }
    const kids = new Map();
    const roots = [];
    for (const sp of all) {
      if (!shown.has(sp.id)) continue;
      if (sp.parentId && shown.has(sp.parentId)) {
        if (!kids.has(sp.parentId)) kids.set(sp.parentId, []);
        kids.get(sp.parentId).push(sp);
      } else roots.push(sp);
    }
    roots.sort((a, b) => a.born - b.born);
    const rows = [];
    const visit = (sp, depth) => {
      rows.push(sp);
      const ch = (kids.get(sp.id) || []).sort((a, b) => b.born - a.born);
      for (const c of ch) visit(c, depth + 1);
    };
    for (const r of roots) visit(r, 0);
    return { rows, hidden: all.length - rows.length };
  }

  const ROW = 20, TOP = 6, LEFT = 12, LABEL = 190;
  const EVENT_COLORS = {
    drought: 'rgba(230, 150, 50, 0.13)', iceAge: 'rgba(120, 180, 255, 0.12)', meteor: 'rgba(255, 90, 40, 0.18)',
    plague: 'rgba(190, 90, 255, 0.13)', invaders: 'rgba(255, 255, 255, 0.08)',
  };

  // Only the rows in view are drawn (the canvas is the size of the visible
  // area and the list scrolls underneath it), and live data is refreshed at
  // most once a second, so a long run with hundreds of species stays cheap.
  class TreeView {
    constructor(app) {
      this.app = app;
      this.el = document.getElementById('treeView');
      this.axis = document.getElementById('treeAxis');
      this.canvas = document.getElementById('treeCanvas');
      this.scroll = document.getElementById('treeScroll');
      this.spacer = document.getElementById('treeSpacer');
      this.tip = document.getElementById('treeTip');
      this.info = document.getElementById('treeInfo');
      this.showSmall = false;
      this.hover = null;
      this.related = null;
      this.rows = [];
      this.lastRefresh = -1e9;
      document.getElementById('treeClose').addEventListener('click', () => this.toggle(false));
      document.getElementById('treeSmall').addEventListener('change', (e) => { this.showSmall = e.target.checked; this.refresh(); });
      this.scroll.addEventListener('scroll', () => this.paint(), { passive: true });
      window.addEventListener('resize', () => { if (this.open) this.paint(); });
      this.canvas.addEventListener('mousemove', (e) => this.onMove(e));
      this.canvas.addEventListener('mouseleave', () => this.setHover(null));
      this.canvas.addEventListener('click', (e) => this.onClick(e));
    }

    get open() { return !this.el.hidden; }

    toggle(on = !this.open) {
      this.el.hidden = !on;
      if (on) this.refresh();
      else this.setHover(null);
    }

    // Called with every UI update; only does work about once a second.
    tick() {
      if (!this.open) return;
      const now = performance.now();
      if (now - this.lastRefresh > 1000) this.refresh();
    }

    // Recompute which species to show and the scales, then repaint.
    refresh() {
      if (!this.open) return;
      this.lastRefresh = performance.now();
      const sim = this.app.sim;
      const { rows, hidden } = layout(sim, this.showSmall ? 0 : 5);
      this.rows = rows;
      this.rowOf = new Map(rows.map((sp, i) => [sp.id, i]));
      this.kids = new Map();
      for (const sp of rows) {
        if (!this.rowOf.has(sp.parentId)) continue;
        if (!this.kids.has(sp.parentId)) this.kids.set(sp.parentId, []);
        this.kids.get(sp.parentId).push(sp);
      }
      let maxV = 1;
      for (const sp of rows) if (sp.pop) for (const v of sp.pop.v) if (v > maxV) maxV = v;
      this.maxV = maxV;
      this.tMax = sim.time;
      this.every = sim.treeEvery || 5;
      if (this.hover && !this.rowOf.has(this.hover.id)) this.setHover(null, true);
      else if (this.hover) this.findRelated();
      this.info.textContent = `${rows.length} species${hidden ? ` · ${hidden} tiny ones hidden` : ''} · ${rows.filter((s) => s.count > 0).length} alive`;
      this.spacer.style.height = Math.max(0, TOP * 2 + rows.length * ROW - this.scroll.clientHeight) + 'px';
      this.paint();
    }

    // Plot area in CSS pixels.
    x(t) { return LEFT + (t / Math.max(1, this.tMax)) * (this.W - LEFT - LABEL); }

    paint() {
      if (!this.open) return;
      const sim = this.app.sim;
      const dpr = window.devicePixelRatio || 1;
      const W = (this.W = this.scroll.clientWidth);
      const VH = this.scroll.clientHeight;
      const top = this.scroll.scrollTop;
      this.paintAxis(sim, W, dpr);

      const cv = this.canvas;
      cv.style.height = VH + 'px';
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(VH * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(VH * dpr); }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, -top * dpr); // draw in list coordinates
      ctx.clearRect(0, top, W, VH);

      // Random events as shaded stripes.
      for (const e of (sim.disasters && sim.disasters.log) || []) {
        ctx.fillStyle = EVENT_COLORS[e.kind];
        const x0 = this.x(e.start), x1 = this.x(Math.min(e.end, this.tMax));
        ctx.fillRect(x0, top, Math.max(2, x1 - x0), VH);
      }

      const yOf = (i) => TOP + i * ROW + ROW / 2;
      const first = Math.max(0, Math.floor((top - TOP) / ROW) - 1);
      const last = Math.min(this.rows.length - 1, Math.ceil((top + VH - TOP) / ROW) + 1);
      const rows = this.rows, related = this.related;
      const maxV = this.maxV, every = this.every;
      const half = (v) => (v > 0 ? 1.2 + 7 * Math.sqrt(v / maxV) : 0);

      // Branch lines: any that cross the visible area (cheap checks for all).
      ctx.lineWidth = 1;
      for (let i = 0; i < rows.length; i++) {
        const sp = rows[i];
        const pr = this.rowOf.get(sp.parentId);
        if (pr === undefined || i < first || pr > last) continue;
        ctx.globalAlpha = related && !related.has(sp.id) ? 0.18 : sp.count > 0 ? 1 : 0.6;
        ctx.strokeStyle = sp.color;
        const bx = this.x(sp.born);
        ctx.beginPath();
        ctx.moveTo(bx, yOf(pr));
        ctx.lineTo(bx, yOf(i));
        ctx.stroke();
      }

      // Bands and labels for the rows in view.
      for (let i = first; i <= last; i++) {
        const sp = rows[i];
        const y = yOf(i);
        const alive = sp.count > 0;
        const end = alive ? this.tMax : sp.extinctAt !== null ? sp.extinctAt : this.tMax;
        ctx.globalAlpha = related && !related.has(sp.id) ? 0.18 : alive ? 1 : 0.6;
        ctx.fillStyle = sp.color;
        const p = sp.pop;
        if (p && p.v.length) {
          // Population over time, one point per sample (at most 400).
          const x0 = this.x(sp.born), xs = [x0], hs = [1.2];
          for (let j = 0; j < p.v.length; j++) {
            const t = (p.i0 + j) * every;
            if (t > sp.born && t < end) { xs.push(this.x(t)); hs.push(half(p.v[j])); }
          }
          xs.push(this.x(end)); hs.push(alive ? half(sp.count) : 1.2);
          ctx.beginPath();
          ctx.moveTo(xs[0], y - hs[0]);
          for (let k = 1; k < xs.length; k++) ctx.lineTo(xs[k], y - hs[k]);
          for (let k = xs.length - 1; k >= 0; k--) ctx.lineTo(xs[k], y + hs[k]);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillRect(this.x(sp.born), y - 1.5, Math.max(2, this.x(end) - this.x(sp.born)), 3);
        }
        const ex = this.x(end);
        if (!alive) {
          ctx.strokeStyle = sp.color;
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(ex + 2, y - 4); ctx.lineTo(ex + 2, y + 4); ctx.stroke();
          ctx.lineWidth = 1;
        }
        ctx.font = `${sp === this.hover ? '600 ' : ''}12px system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillStyle = alive ? '#e8edf3' : '#8a96a6';
        ctx.fillText(sp.name, ex + 7, y + 4);
        const lw = ctx.measureText(sp.name).width;
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillStyle = Evo.NICHE_COLORS[sp.niche] || '#7d8a9b';
        ctx.fillText(sp.niche + (sp.centroid.nocturnal > 0.66 ? ' 🌙' : ''), ex + 12 + lw, y + 4);
      }
      ctx.globalAlpha = 1;
    }

    // Time axis in years, with an icon for every random event.
    paintAxis(sim, W, dpr) {
      const ax = this.axis, AH = 26;
      if (ax.width !== Math.round(W * dpr) || ax.height !== Math.round(AH * dpr)) { ax.width = Math.round(W * dpr); ax.height = Math.round(AH * dpr); ax.style.height = AH + 'px'; }
      const ctx = ax.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, AH);
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = '#7d8a9b';
      ctx.strokeStyle = '#283344';
      const year = sim.cfg.seasonLength;
      const years = this.tMax / year;
      const stepY = Math.max(1, Math.ceil(years / 8));
      ctx.textAlign = 'center';
      for (let y = 0; y <= years + 1e-9; y += stepY) {
        const px = this.x(y * year);
        ctx.fillText(y === 0 ? 'start' : `year ${y}`, px, 11);
        ctx.beginPath(); ctx.moveTo(px, 15); ctx.lineTo(px, AH); ctx.stroke();
      }
      ctx.textAlign = 'right';
      ctx.fillText('now', this.x(this.tMax), 24);
      ctx.textAlign = 'center';
      for (const e of (sim.disasters && sim.disasters.log) || []) ctx.fillText(Evo.Events.TYPES[e.kind].icon, this.x(e.start), 24);
    }

    // The hovered species' ancestors and descendants stay bright.
    findRelated() {
      const sim = this.app.sim;
      const rel = new Set();
      for (let s = this.hover; s; s = sim.species.get(s.parentId)) rel.add(s.id);
      const stack = [this.hover];
      while (stack.length) for (const k of this.kids.get(stack.pop().id) || []) { rel.add(k.id); stack.push(k); }
      this.related = rel;
    }

    setHover(sp, quiet) {
      if (sp === this.hover) return;
      this.hover = sp;
      if (sp) this.findRelated();
      else { this.related = null; this.tip.style.display = 'none'; }
      if (!quiet) this.paint();
    }

    rowAt(e) {
      const r = this.canvas.getBoundingClientRect();
      const i = Math.floor((e.clientY - r.top + this.scroll.scrollTop - TOP) / ROW);
      return this.rows[i] || null;
    }

    onMove(e) {
      const sp = this.rowAt(e);
      this.setHover(sp);
      if (!sp) return;
      const sim = this.app.sim;
      const parent = sp.parentId ? sim.species.get(sp.parentId) : null;
      const c = sp.centroid;
      const time = Evo.fmtTime;
      const act = c.nocturnal > 0.66 ? 'active at night' : c.nocturnal < 0.33 ? 'active by day' : 'active at dusk & dawn';
      this.tip.innerHTML =
        `<span class="swatch" style="background:${sp.color}"></span><b>${sp.name}</b> · ${sp.niche}<br>` +
        (parent ? `branched off <b>${parent.name}</b> at ${time(sp.born)}` : sp.born > 0 ? `arrived at ${time(sp.born)}` : 'founder species') + '<br>' +
        (sp.count > 0 ? `alive: <b>${sp.count}</b> now` : `extinct at ${time(sp.extinctAt)} (lasted ${time(sp.extinctAt - sp.born)})`) + ` · peak ${sp.peak}<br>` +
        `<span class="muted">size ${c.size.toFixed(2)} · diet ${c.diet.toFixed(2)} · swim ${c.swim.toFixed(2)} · fur ${c.fur.toFixed(2)} · ${act}</span>` +
        (sp.count > 0 ? '<br><span class="muted">click to follow one</span>' : '');
      this.tip.style.display = 'block';
      const box = this.el.getBoundingClientRect();
      const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
      let lx = e.clientX - box.left + 14, ly = e.clientY - box.top + 14;
      if (lx + tw > box.width - 8) lx = e.clientX - box.left - tw - 14;
      if (ly + th > box.height - 8) ly = e.clientY - box.top - th - 14;
      this.tip.style.left = lx + 'px';
      this.tip.style.top = ly + 'px';
    }

    onClick(e) {
      const sp = this.rowAt(e);
      if (!sp || sp.count === 0) return;
      this.toggle(false);
      this.app.followSpecies(sp.id);
    }
  }

  Evo.Tree = { sample, layout, TreeView };
})((globalThis.Evo = globalThis.Evo || {}));
