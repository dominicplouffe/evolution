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
      let max = 0, min = Infinity;
      for (const p of h) for (const s of series) { const v = s.get(p); if (v > max) max = v; if (v < min) min = v; }
      if (this.metric.id.startsWith('gene:')) { min = Math.max(0, min - (max - min) * 0.2); } else min = 0;
      if (max - min < 1e-6) max = min + 1;
      const t0 = h[0].t, t1 = h[h.length - 1].t;
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

      for (const s of series) {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        h.forEach((p, i) => { const x = X(p.t), y = Y(s.get(p)); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.stroke();
      }

      // Hover crosshair + tooltip.
      if (this.hoverX !== null && this.hoverX >= pad.l) {
        const tt = t0 + ((this.hoverX - pad.l) / (W - pad.l - pad.r)) * (t1 - t0);
        let best = h[0];
        for (const p of h) if (Math.abs(p.t - tt) < Math.abs(best.t - tt)) best = p;
        const x = X(best.t);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke();
        for (const s of series) {
          ctx.beginPath();
          ctx.arc(x, Y(s.get(best)), 4, 0, Math.PI * 2);
          ctx.fillStyle = s.color; ctx.fill();
          ctx.strokeStyle = '#141b26'; ctx.lineWidth = 2; ctx.stroke();
        }
        this.tip.innerHTML = `<div class="muted">${fmtTime(best.t)}</div>` + series.map((s) =>
          `<div><span class="swatch" style="background:${s.color}"></span>${s.name}: <b>${s.get(best).toFixed(s.digits || 0)}</b></div>`).join('');
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
