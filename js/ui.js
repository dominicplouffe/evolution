// The app: game loop, mouse/keyboard input, and the side panels.
(function (Evo) {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const STORE_KEY = 'evolution.settings.v1';
  const BRUSH = 56;

  function loadSettings() {
    const cfg = Evo.defaultConfig();
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      for (const f of Evo.CONFIG_SCHEMA) if (saved[f.key] !== undefined) cfg[f.key] = saved[f.key];
    } catch (e) { /* storage unavailable: use defaults */ }
    return cfg;
  }
  function saveSettings(cfg) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (v, d = 0) => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d);

  class App {
    constructor() {
      this.canvas = $('#view');
      this.renderer = new Evo.Renderer(this.canvas);
      this.chart = new Evo.Chart($('#chart'), $('#chartTip'), $('#chartLegend'));
      this.cfg = loadSettings();
      this.speed = 1;
      this.paused = false;
      this.tool = 'inspect';
      this.selected = null;
      this.follow = false;
      this.hover = null;
      this.keys = new Set();
      this.simRate = { t: 0, at: performance.now(), rate: 1 };
      this.buildSettings();
      this.buildChartSelect();
      this.buildAbout();
      this.bindControls();
      this.bindCanvas();
      this.newWorld();
      this.last = performance.now();
      this.lastUi = 0;
      requestAnimationFrame((t) => this.frame(t));
    }

    newWorld() {
      this.sim = new Evo.Simulation(Object.assign({}, this.cfg));
      this.renderer.attach(this.sim);
      this.selected = null;
      this.follow = false;
      this.acc = 0;
      this.simRate = { t: 0, at: performance.now(), rate: this.speed };
      this.updateUI(true);
      this.toast(`New world · seed ${this.sim.seed}`);
    }

    // ------------------------------------------------------------ main loop
    frame(now) {
      const real = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      if (!this.paused) {
        this.acc += real * this.speed;
        const start = performance.now();
        while (this.acc >= Evo.K.DT) {
          this.sim.step();
          this.acc -= Evo.K.DT;
          if (performance.now() - start > 20) { this.acc = 0; break; } // stay responsive
        }
      }
      // Keyboard panning.
      const k = this.keys, p = 600 * real;
      if (k.has('arrowleft') || k.has('a')) this.renderer.pan(p, 0);
      if (k.has('arrowright') || k.has('d')) this.renderer.pan(-p, 0);
      if (k.has('arrowup') || k.has('w')) this.renderer.pan(0, p);
      if (k.has('arrowdown') || k.has('s')) this.renderer.pan(0, -p);

      if (this.follow && this.selected && this.selected.alive) {
        this.renderer.cam.x = this.selected.x;
        this.renderer.cam.y = this.selected.y;
      }
      this.renderer.brushRadius = this.tool === 'food' || this.tool === 'smite' ? BRUSH : 0;
      this.renderer.draw(this.selected, this.hover);

      if (now - this.lastUi > 250) {
        this.lastUi = now;
        const dt = (now - this.simRate.at) / 1000;
        if (dt > 1) { this.simRate = { t: this.sim.time, at: now, rate: (this.sim.time - this.simRate.t) / dt }; }
        this.updateUI();
      }
      requestAnimationFrame((t) => this.frame(t));
    }

    // ------------------------------------------------------------ input
    bindCanvas() {
      const c = this.canvas;
      let down = null;
      const local = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

      c.addEventListener('pointerdown', (e) => {
        c.setPointerCapture(e.pointerId);
        const p = local(e);
        down = { x: p.x, y: p.y, moved: false, button: e.button };
        if (e.button === 0 && (this.tool === 'food' || this.tool === 'smite')) this.applyBrush(this.renderer.screenToWorld(p.x, p.y));
      });
      c.addEventListener('pointermove', (e) => {
        const p = local(e);
        this.hover = this.renderer.screenToWorld(p.x, p.y);
        if (!down) return;
        const dx = p.x - down.x, dy = p.y - down.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) down.moved = true;
        const painting = down.button === 0 && (this.tool === 'food' || this.tool === 'smite');
        if (painting) this.applyBrush(this.hover);
        else if (down.moved) {
          this.renderer.pan(dx, dy);
          this.follow = false;
          c.classList.add('dragging');
          down.x = p.x; down.y = p.y;
        }
      });
      c.addEventListener('pointerup', (e) => {
        c.classList.remove('dragging');
        if (down && !down.moved && down.button === 0) this.click(this.renderer.screenToWorld(local(e).x, local(e).y));
        down = null;
      });
      c.addEventListener('pointerleave', () => { this.hover = null; });
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const p = local(e);
        this.renderer.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
      }, { passive: false });
      c.addEventListener('contextmenu', (e) => e.preventDefault());
      window.addEventListener('resize', () => this.renderer.resize());
    }

    wrapPoint(p) {
      const w = this.sim.world;
      const q = { x: p.x, y: p.y };
      if (w.wrap) w.wrapPos(q);
      return q;
    }

    click(p) {
      const w = this.sim.world;
      const q = this.wrapPoint(p);
      if (this.tool === 'inspect') {
        let best = null, bestD = Math.max(14 / this.renderer.cam.zoom, 10);
        for (const c of this.sim.creatures) {
          const d = Math.hypot(w.dx(q.x, c.x), w.dy(q.y, c.y)) - c.phen.radius;
          if (d < bestD) { bestD = d; best = c; }
        }
        this.select(best);
      } else if (this.tool === 'herbivore' || this.tool === 'carnivore') {
        if (!w.wrap && (q.x < 0 || q.y < 0 || q.x >= w.width || q.y >= w.height)) return;
        const c = this.sim.spawnAt(this.tool, q.x, q.y);
        if (!c) this.toast("Can't place a creature in deep water or on peaks");
      }
    }

    applyBrush(p) {
      const w = this.sim.world;
      const q = this.wrapPoint(p);
      if (this.tool === 'food') {
        const T = Evo.K.TILE, n = Math.ceil(BRUSH / T);
        for (let dy = -n; dy <= n; dy++) {
          for (let dx = -n; dx <= n; dx++) {
            if (Math.hypot(dx, dy) * T > BRUSH) continue;
            const i = w.tileIndex(q.x + dx * T, q.y + dy * T);
            if (i >= 0) w.plant[i] = w.plantMax[i];
          }
        }
        this.renderer.lastTerrain = -1;
      } else if (this.tool === 'smite') {
        this.sim.hash.rebuild(this.sim.creatures);
        this.sim.hash.query(q.x, q.y, BRUSH, (c) => this.sim.kill(c, 'smitten'));
        this.sim.creatures = this.sim.creatures.filter((c) => c.alive);
      }
    }

    select(c) {
      this.selected = c;
      if (!c) this.follow = false;
      this.updateInspector();
    }

    setTool(t) {
      this.tool = t;
      document.querySelectorAll('#tools button').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
      this.canvas.classList.toggle('paint', t !== 'inspect');
    }

    setSpeed(s) {
      this.speed = s;
      document.querySelectorAll('#speeds button').forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === s));
      if (this.paused) this.togglePause();
    }

    togglePause() {
      this.paused = !this.paused;
      $('#playPause').textContent = this.paused ? '▶ Play' : '⏸ Pause';
    }

    bindControls() {
      document.querySelectorAll('#tools button').forEach((b) => b.addEventListener('click', () => this.setTool(b.dataset.tool)));
      document.querySelectorAll('#speeds button').forEach((b) => b.addEventListener('click', () => this.setSpeed(Number(b.dataset.speed))));
      $('#playPause').addEventListener('click', () => this.togglePause());
      $('#colorMode').addEventListener('change', (e) => { this.renderer.colorMode = e.target.value; });
      $('#showSense').addEventListener('change', (e) => { this.renderer.showSense = e.target.checked; });
      $('#chartMetric').addEventListener('change', (e) => this.chart.setMetric(e.target.value));
      $('#newWorld').addEventListener('click', () => { this.readSettings(); this.newWorld(); });
      $('#resetSettings').addEventListener('click', () => {
        this.cfg = Evo.defaultConfig();
        saveSettings(this.cfg);
        this.buildSettings();
      });

      // Don't rebuild panels mid-click, or the click would land on a replaced element.
      $('#side').addEventListener('pointerdown', () => { this.pressing = true; });
      window.addEventListener('pointerup', () => setTimeout(() => { this.pressing = false; }, 0));

      $('#inspector').addEventListener('click', (e) => {
        const act = e.target.dataset && e.target.dataset.act;
        const c = this.selected;
        if (!act || !c) return;
        if (act === 'follow') this.follow = !this.follow;
        if (act === 'clone' && c.alive) { this.sim.cloneNear(c, 5); this.toast('Dropped 5 clones nearby'); }
        if (act === 'kill' && c.alive) this.sim.kill(c, 'smitten');
        if (act === 'parent') {
          const p = this.sim.creatures.find((x) => c.parentIds.includes(x.id));
          if (p) this.select(p); else this.toast('Parents are no longer alive');
        }
        this.updateInspector();
      });

      $('#speciesList').addEventListener('click', (e) => {
        const row = e.target.closest('.sp');
        if (!row) return;
        const id = Number(row.dataset.id);
        const members = this.sim.creatures.filter((c) => c.species === id);
        if (members.length) {
          this.select(members[Math.floor(Math.random() * members.length)]);
          this.follow = true;
          this.renderer.cam.zoom = Math.max(this.renderer.cam.zoom, 1.5);
        }
      });

      window.addEventListener('keydown', (e) => {
        if (e.target.closest && e.target.closest('input, select, textarea')) return;
        const key = e.key.toLowerCase();
        this.keys.add(key);
        if (key === ' ') { e.preventDefault(); this.togglePause(); }
        const speeds = [0.5, 1, 2, 4, 8, 32];
        if (key >= '1' && key <= '6') this.setSpeed(speeds[Number(key) - 1]);
        if (key === 'f' && this.selected) this.follow = !this.follow;
        if (key === 'escape') this.select(null);
        if (key === 'home') this.renderer.fit();
        const tools = { i: 'inspect', h: 'herbivore', c: 'carnivore', g: 'food', x: 'smite' };
        if (tools[key]) this.setTool(tools[key]);
        if (key.startsWith('arrow')) e.preventDefault();
      });
      window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
      window.addEventListener('blur', () => this.keys.clear());
    }

    // ------------------------------------------------------------ settings
    buildSettings() {
      const form = $('#settings');
      form.innerHTML = Evo.CONFIG_SCHEMA.map((f) => {
        const v = this.cfg[f.key];
        const input = f.type === 'bool'
          ? `<input type="checkbox" id="cfg_${f.key}" ${v ? 'checked' : ''}>`
          : `<input type="number" id="cfg_${f.key}" value="${v}" min="${f.min}" max="${f.max}" step="${f.step || 1}">`;
        return `<label for="cfg_${f.key}">${esc(f.label)}</label>${input}`;
      }).join('');
      form.onchange = () => {
        this.readSettings();
        // Some settings can change on the fly.
        for (const k of ['plantGrowth', 'mutationScale', 'seasonStrength', 'seasonLength', 'maxPopulation', 'allowAsexual', 'migration']) {
          this.sim.cfg[k] = this.cfg[k];
        }
      };
      form.onsubmit = (e) => e.preventDefault();
    }

    readSettings() {
      for (const f of Evo.CONFIG_SCHEMA) {
        const el = $('#cfg_' + f.key);
        if (!el) continue;
        if (f.type === 'bool') this.cfg[f.key] = el.checked;
        else {
          let v = Number(el.value);
          if (!Number.isFinite(v)) v = f.def;
          v = Evo.clamp(v, f.min, f.max);
          this.cfg[f.key] = f.type === 'int' ? Math.round(v) : v;
        }
      }
      saveSettings(this.cfg);
    }

    buildChartSelect() {
      $('#chartMetric').innerHTML = this.chart.metrics.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join('');
      this.chart.renderLegend();
    }

    buildAbout() {
      $('#about').innerHTML = `
        <p>Every creature carries <b>DNA</b>: a list of genes. Babies get a mix of both parents' genes plus random
        mutations. Nobody designs the creatures — whatever survives and breeds more simply becomes more common.</p>
        <ul>
          <li><b>Energy</b>: everything costs energy. Resting cost grows with mass<sup>0.75</sup> (Kleiber's law);
          moving costs mass × speed². Expensive genes (muscle, senses, armor) raise upkeep.</li>
          <li><b>Food</b>: plants regrow on fertile tiles (faster in summer). Dead creatures leave meat that rots.</li>
          <li><b>Diet</b> is a sliding scale: good at digesting meat means bad at plants, and vice-versa.</li>
          <li><b>Breeding</b>: adults with enough energy look for a genetically similar mate; if none is found
          for a while they may reproduce alone.</li>
          <li><b>Species</b>: when a lineage drifts far enough from its founder, it becomes a new species
          (with a new name). Colors are a neutral gene, so relatives look alike.</li>
        </ul>
        <p><b>Genes</b></p>
        <ul>${Evo.GENES.map((g) => `<li><b>${esc(g.label)}</b> — ${esc(g.desc)}</li>`).join('')}</ul>`;
    }

    // ------------------------------------------------------------ panels
    updateUI(force) {
      const sim = this.sim;
      const h = sim.history[sim.history.length - 1];
      const n = sim.creatures.length;
      const counts = { herbivore: 0, omnivore: 0, carnivore: 0 };
      for (const c of sim.creatures) counts[c.dietClass]++;
      const stat = (v, k, color) => `<div class="stat"><div class="v">${v}</div><div class="k">${color ? `<span class="swatch" style="background:${color}"></span>` : ''}${k}</div></div>`;
      $('#stats').innerHTML =
        stat(n, 'creatures') + stat(h ? h.species : 0, 'species') + stat(sim.stats.maxGeneration, 'max generation') +
        stat(counts.herbivore, 'herbivores', '#199e70') + stat(counts.omnivore, 'omnivores', '#c98500') + stat(counts.carnivore, 'carnivores', '#d55181') +
        stat(sim.stats.births, 'births') + stat(sim.stats.deaths, 'deaths') + stat(sim.world.corpses.length, 'carcasses');

      const season = sim.seasonName();
      const icon = { Spring: '🌱', Summer: '☀️', Autumn: '🍂', Winter: '❄️' }[season];
      const rate = this.paused ? 'paused' : `${fmt(this.simRate.rate, 1)}× speed`;
      $('#hud').innerHTML = `<b>${Evo.fmtTime(sim.time)}</b> · Year ${Math.floor(sim.time / sim.cfg.seasonLength) + 1} · ${icon} ${season}<br><span class="muted">${rate} · seed ${sim.seed}</span>`;

      this.chart.draw(sim.history);
      if (!this.pressing) {
        this.updateInspector();
        this.updateSpecies();
      }
      $('#events').innerHTML = sim.events.map((e) => `<div><span class="t">${Evo.fmtTime(e.t)}</span>${e.html}</div>`).join('') ||
        '<span class="muted">Nothing yet…</span>';

      if (n === 0 && !this.announcedExtinction) {
        this.announcedExtinction = true;
        this.toast('Everything died out. Start a new world from the settings panel.');
      } else if (n > 0) this.announcedExtinction = false;
    }

    updateSpecies() {
      const living = this.sim.species.living().sort((a, b) => b.count - a.count);
      $('#speciesCount').textContent = `(${living.length} alive)`;
      $('#speciesList').innerHTML = living.slice(0, 12).map((sp) => {
        const diet = sp.avgDiet < 0.33 ? 'herbivore' : sp.avgDiet < 0.66 ? 'omnivore' : 'carnivore';
        const parent = sp.parentId ? this.sim.species.get(sp.parentId) : null;
        return `<div class="sp" data-id="${sp.id}" title="Click to follow a member">
          <span class="dot" style="background:hsl(${Math.round(sp.founder.hue)},80%,56%)"></span>
          <div><div>${esc(sp.name)}</div><div class="meta">${diet} · size ${fmt(sp.avgSize, 2)}${parent ? ' · from ' + esc(parent.name) : ''}</div></div>
          <span class="n">${sp.count}</span></div>`;
      }).join('') + (living.length > 12 ? `<div class="muted small">…and ${living.length - 12} more</div>` : '');
    }

    updateInspector() {
      const c = this.selected;
      const el = $('#inspector');
      if (!c) { el.innerHTML = '<p class="muted">Click a creature on the map to see its DNA.</p>'; return; }
      const sp = this.sim.species.get(c.species);
      const p = c.phen;
      const bar = (label, v, max, color, num) =>
        `<div class="label">${label}</div><div class="bar"><span style="width:${Evo.clamp((v / max) * 100, 0, 100)}%;background:${color}"></span></div><div class="num">${num}</div>`;
      const status = c.alive ? esc(c.state) : `💀 Died (${esc(c.deathCause || 'unknown')})`;
      const genes = Evo.GENES.filter((g) => !g.neutral).map((g) => {
        const v = c.g[g.key];
        return bar(esc(g.label), v - g.min, g.max - g.min, 'var(--accent)', fmt(v, g.max > 10 ? 0 : 2));
      }).join('');
      el.innerHTML = `
        <div class="insp-head">
          <span class="dot" style="background:hsl(${Math.round(c.g.hue)},80%,56%)"></span>
          <div><b>${esc(sp ? sp.name : '?')}</b> #${c.id} <span class="muted">· ${c.dietClass}${c.grow < 1 ? ' · baby' : ''}</span><br>
          <span class="muted">${status}</span></div>
        </div>
        <div class="bars">
          ${bar('Health', c.health, p.maxHealth, '#199e70', fmt(Math.max(0, c.health)))}
          ${bar('Energy', c.energy, p.maxEnergy, '#c98500', fmt(c.energy))}
          ${bar('Stamina', c.stamina, p.maxStamina, '#3987e5', fmt(c.stamina, 1))}
        </div>
        <div class="kv">
          <span class="k">Age</span><span>${fmt(c.age)}s / ${fmt(c.g.lifespan)}s</span>
          <span class="k">Generation</span><span>${c.generation}</span>
          <span class="k">Children · kills</span><span>${c.children} · ${c.kills}</span>
          <span class="k">Mass · top speed</span><span>${fmt(p.mass, 2)} · ${fmt(p.maxSpeed)}</span>
          <span class="k">Strength</span><span>${fmt(p.strength, 1)}/s</span>
          <span class="k">Digests plants · meat</span><span>${fmt(p.plantEff * 100)}% · ${fmt(p.meatEff * 100)}%</span>
          <span class="k">Upkeep</span><span>${fmt(p.basal, 2)} energy/s</span>
        </div>
        <p class="muted small" style="margin:8px 0 0">DNA</p>
        <div class="bars">${genes}</div>
        <div class="row">
          <button data-act="follow" class="${this.follow ? 'active' : ''}">🎥 Follow</button>
          <button data-act="parent">👪 Parent</button>
          <button data-act="clone">🧬 Clone ×5</button>
          <button data-act="kill">⚡ Kill</button>
        </div>`;
    }

    toast(msg) {
      const t = $('#toast');
      t.textContent = msg;
      t.classList.add('show');
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
    }
  }

  Evo.App = App;
})((globalThis.Evo = globalThis.Evo || {}));
