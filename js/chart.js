// Small line chart of the simulation history with a hover crosshair/tooltip.
(function (Evo) {
  'use strict';

  const C = { herb: '#199e70', omni: '#c98500', carn: '#d55181', main: '#3987e5' };

  function metrics() {
    const list = [
      {
        id: 'population', label: 'Population by diet',
        series: [
          { name: 'Herbivores', color: C.herb, get: (h) => h.herbivore },
          { name: 'Omnivores', color: C.omni, get: (h) => h.omnivore },
          { name: 'Carnivores', color: C.carn, get: (h) => h.carnivore },
        ],
      },
      {
        id: 'niches', label: 'Herbivores by niche',
        series: [
          { name: 'Grazers', color: C.herb, get: (h) => (h.niches ? h.niches.grazer : 0) },
          { name: 'Browsers', color: C.omni, get: (h) => (h.niches ? h.niches.browser : 0) },
          { name: 'Swimmers', color: C.main, get: (h) => (h.niches ? h.niches.swimmer : 0) },
        ],
      },
      { id: 'brains', label: 'Brain drift from founders', series: [{ name: 'Avg brain drift', color: C.main, get: (h) => h.brainDrift || 0, digits: 2 }] },
      { id: 'total', label: 'Total population', series: [{ name: 'Creatures', color: C.main, get: (h) => h.n }] },
      { id: 'species', label: 'Living species', series: [{ name: 'Species', color: C.main, get: (h) => h.species }] },
      { id: 'plants', label: 'Plant food per tile', series: [{ name: 'Plants', color: C.herb, get: (h) => h.plants, digits: 2 }] },
    ];
    for (const g of Evo.GENES) {
      if (g.neutral) continue;
      list.push({ id: 'gene:' + g.key, label: 'Avg ' + g.label.toLowerCase(), series: [{ name: 'Avg ' + g.label, color: C.main, get: (h) => h.avg[g.key], digits: 2 }] });
    }
    return list;
  }

  class Chart {
    constructor(canvas, tip, legend) {
      this.canvas = canvas;
      this.tip = tip;
      this.legend = legend;
      this.ctx = canvas.getContext('2d');
      this.metrics = metrics();
      this.metric = this.metrics[0];
      this.hoverX = null;
      this.range = 0;
      this.note = null;
      canvas.addEventListener('mousemove', (e) => {
        const r = canvas.getBoundingClientRect();
        this.hoverX = e.clientX - r.left;
        this.draw();
      });
      canvas.addEventListener('mouseleave', () => { this.hoverX = null; this.tip.style.display = 'none'; this.draw(); });
    }

    setMetric(id) {
      this.metric = this.metrics.find((m) => m.id === id) || this.metrics[0];
      this.renderLegend();
      this.draw();
    }

    renderLegend() {
      const s = this.metric.series;
      this.legend.innerHTML = s.length < 2 ? '' :
        s.map((x) => `<span><span class="swatch" style="background:${x.color}"></span>${x.name}</span>`).join('');
    }

    // `range`: seconds to show back from now (0 = the whole run).
    setRange(range) {
      this.range = range;
      this.draw();
    }

    // Pick what to plot: the raw points if they fit, otherwise buckets of a
    // "nice" game length (a day, a year, several years) holding the average and
    // the low-high range of each series.
    prepare(h, plotW) {
      const tEnd = h[h.length - 1].t;
      const tStart = this.range ? Math.max(h[0].t, tEnd - this.range) : h[0].t;
      let lo = 0;
      while (lo < h.length - 1 && h[lo].t < tStart) lo++;
      const pts = h.slice(lo);
      const series = this.metric.series;
      const target = Math.max(20, Math.floor(plotW / 5));
      if (pts.length <= target) {
        return { tStart, tEnd, size: 0, rows: pts.map((p) => ({ t: p.t, t0: p.t, t1: p.t, v: series.map((s) => s.get(p)) })) };
      }
      const day = this.dayLength || 60, year = this.yearLength || 240;
      const sizes = [5, 10, 30, day, 2 * day, year, 2 * year, 5 * year, 10 * year, 20 * year, 50 * year, 100 * year]
        .filter((v, i, a) => v > 0 && a.indexOf(v) === i).sort((a, b) => a - b);
      const span = tEnd - tStart;
      const size = sizes.find((v) => span / v <= target) || sizes[sizes.length - 1];
      const rows = [];
      let cur = null;
      for (const p of pts) {
        const b = Math.floor(p.t / size);
        if (!cur || cur.b !== b) {
          cur = { b, t0: b * size, t1: (b + 1) * size, n: 0, sum: series.map(() => 0), min: series.map(() => Infinity), max: series.map(() => -Infinity) };
          rows.push(cur);
        }
        cur.n++;
        series.forEach((s, k) => {
          const v = s.get(p);
          cur.sum[k] += v;
          if (v < cur.min[k]) cur.min[k] = v;
          if (v > cur.max[k]) cur.max[k] = v;
        });
      }
      for (const r of rows) {
        r.v = r.sum.map((v) => v / r.n);
        r.t = Math.min(tEnd, Math.max(tStart, (r.t0 + r.t1) / 2));
      }
      return { tStart, tEnd, size, rows };
    }

    bucketLabel(size) {
      const day = this.dayLength || 60, year = this.yearLength || 240;
      if (size % year === 0) return size === year ? 'year' : `${size / year} years`;
      if (day && size % day === 0) return size === day ? 'day' : `${size / day} days`;
      if (size % 60 === 0) return `${size / 60} min`;
      return `${size} s`;
    }

    draw(history) {
      if (history) this.history = history;
      const h = this.history;
      if (!h) return;
      const dpr = window.devicePixelRatio || 1;
      const r = this.canvas.getBoundingClientRect();
      const W = r.width, H = r.height;
      if (this.canvas.width !== Math.round(W * dpr)) { this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr); }
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (h.length < 2) return;

      const pad = { l: 34, r: 6, t: 6, b: 16 };
      const series = this.metric.series;
      const data = this.prepare(h, W - pad.l - pad.r);
      const rows = data.rows;
      const banded = data.size > 0;
      if (this.note) this.note.textContent = banded ? `Averaged per ${this.bucketLabel(data.size)} · shaded: low–high` : '';
      let max = 0, min = Infinity;
      for (const row of rows) for (let k = 0; k < series.length; k++) {
        const hi = banded ? row.max[k] : row.v[k], lo = banded ? row.min[k] : row.v[k];
        if (hi > max) max = hi;
        if (lo < min) min = lo;
      }
      if (this.metric.id.startsWith('gene:')) { min = Math.max(0, min - (max - min) * 0.2); } else min = 0;
      if (max - min < 1e-6) max = min + 1;
      const t0 = data.tStart, t1 = data.tEnd;
      const X = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (W - pad.l - pad.r);
      const Y = (v) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);

      // Recessive grid + axis labels.
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillStyle = '#7d8a9b';
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      const digits = series[0].digits || 0;
      for (let i = 0; i <= 2; i++) {
        const v = min + ((max - min) * i) / 2;
        const y = Y(v);
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
        ctx.textAlign = 'right';
        ctx.fillText(v.toFixed(digits), pad.l - 4, y + 3);
      }
      ctx.textAlign = 'left';
      ctx.fillText(fmtTime(t0), pad.l, H - 3);
      ctx.textAlign = 'right';
      ctx.fillText(fmtTime(t1), W - pad.r, H - 3);

      // Low-high bands first, then the average lines on top.
      if (banded) {
        series.forEach((s, k) => {
          ctx.fillStyle = s.color;
          ctx.globalAlpha = 0.16;
          ctx.beginPath();
          rows.forEach((row, i) => { const x = X(row.t), y = Y(row.max[k]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
          for (let i = rows.length - 1; i >= 0; i--) ctx.lineTo(X(rows[i].t), Y(rows[i].min[k]));
          ctx.closePath();
          ctx.fill();
        });
        ctx.globalAlpha = 1;
      }
      series.forEach((s, k) => {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        rows.forEach((row, i) => { const x = X(row.t), y = Y(row.v[k]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.stroke();
      });

      // Hover crosshair + tooltip.
      if (this.hoverX !== null && this.hoverX >= pad.l) {
        const tt = t0 + ((this.hoverX - pad.l) / (W - pad.l - pad.r)) * (t1 - t0);
        let best = rows[0];
        for (const row of rows) if (Math.abs(row.t - tt) < Math.abs(best.t - tt)) best = row;
        const x = X(best.t);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke();
        series.forEach((s, k) => {
          ctx.beginPath();
          ctx.arc(x, Y(best.v[k]), 4, 0, Math.PI * 2);
          ctx.fillStyle = s.color; ctx.fill();
          ctx.strokeStyle = '#141b26'; ctx.lineWidth = 2; ctx.stroke();
        });
        const when = banded ? `${fmtTime(Math.max(t0, best.t0))} – ${fmtTime(Math.min(t1, best.t1))} (average)` : fmtTime(best.t);
        this.tip.innerHTML = `<div class="muted">${when}</div>` + series.map((s, k) => {
          const d = s.digits || 0;
          const range = banded ? ` <span class="muted">(${best.min[k].toFixed(d)}–${best.max[k].toFixed(d)})</span>` : '';
          return `<div><span class="swatch" style="background:${s.color}"></span>${s.name}: <b>${best.v[k].toFixed(d)}</b>${range}</div>`;
        }).join('');
        this.tip.style.display = 'block';
        const tw = this.tip.offsetWidth;
        this.tip.style.left = Math.min(W - tw, Math.max(0, x + 10 + tw > W ? x - tw - 10 : x + 10)) + 'px';
        this.tip.style.top = '4px';
      }
    }
  }

  function fmtTime(t) {
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}:${String(s).padStart(2, '0')}`;
  }

  Evo.Chart = Chart;
  Evo.fmtTime = fmtTime;
})((globalThis.Evo = globalThis.Evo || {}));
