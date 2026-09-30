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
      this.chart.note = $('#chartNote');
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
      this.bindSave();
      this.bindDisasters();
      this.bindPanels();
      this.lastUi = 0;
      this.start();
    }

    // Continue the saved world if there is one, otherwise start fresh.
    async start() {
      // Served by the Evolution server? Then watch and control its world.
      const remote = Evo.Remote ? await Evo.Remote.detect() : false;
      if (remote === 'token') {
        this.toast('This server needs a token: open the page with ?token=…');
        return;
      }
      if (remote) {
        try {
          this.remote = new Evo.Remote(this);
          const sim = await this.remote.connect();
          this.useSim(sim, true);
          this.enterRemoteMode();
          this.toast('Connected to the world on the server');
          this.last = performance.now();
          requestAnimationFrame((t) => this.frame(t));
          return;
        } catch (e) {
          console.warn('Could not connect to the server', e);
          this.remote = null;
          this.toast('Could not connect to the server, running a local world');
        }
      }
      let resumed = false;
      if (Evo.Save.storageInfo()) {
        try {
          const sim = await Evo.Save.loadFromStorage();
          if (sim) {
            this.useSim(sim, true);
            resumed = true;
            this.toast(`Continuing your saved world (${Evo.fmtTime(sim.time)} in)`);
          }
        } catch (e) {
          console.warn('Could not load save', e);
          this.toast('Could not load your saved world, starting a new one');
        }
      }
      if (!resumed) this.newWorld();
      this.last = performance.now();
      requestAnimationFrame((t) => this.frame(t));
    }

    // Viewer for the Evolution server: the panels show server controls.
    enterRemoteMode() {
      $('#serverBox').hidden = false;
      $('#loadBtn').hidden = true;
      $('.save-auto').hidden = true;
      $('#saveBtn').textContent = '💾 Save now';
      $('#saveBtn').title = 'Snapshot the world on the server now';
      $('#exportBtn').title = 'Download the server world as a file';
      $('#importBtn').title = 'Replace the server world with a file you exported';
      $('#chronicleLink').hidden = false;
      this.lapse = new Evo.LapsePlayer(this);
      $('#lapseBtn').addEventListener('click', () => this.lapse.toggle());
      try { this.trackVisits(); } catch (e) { console.warn('Visit tracking failed', e); } // never worth losing the viewer over
      $('#chronicleLink').href = this.remote.chronicleUrl();
      $('#speeds button[data-speed="32"]').title = 'As fast as the CPU budget allows';
      const budget = $('#cpuBudget');
      budget.addEventListener('input', () => { $('#cpuBudgetVal').textContent = budget.value + '%'; });
      budget.addEventListener('change', () => this.remote.cmd({ cmd: 'budget', value: Number(budget.value) / 100 }));
      document.title = 'Evolution · server';
    }

    // Remember when this viewer last watched the world; coming back after a
    // while opens "While you were away".
    trackVisits() {
      const KEY = 'evolution.lastVisit';
      let prev = null;
      try { prev = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { /* none */ }
      const sim = this.sim;
      if (prev && prev.seed === sim.seed && prev.t < sim.time) this.prevVisit = prev;
      const note = () => {
        if (document.visibilityState !== 'visible' || !this.sim) return;
        try { localStorage.setItem(KEY, JSON.stringify({ seed: this.sim.seed, t: this.sim.time, wall: Date.now() })); } catch (e) { /* ignore */ }
      };
      note();
      setInterval(note, 30000);
      document.addEventListener('visibilitychange', note);
      if (this.prevVisit && Date.now() - this.prevVisit.wall > 10 * 60000 && sim.time - this.prevVisit.t > 120) this.openDigest('visit', true);
    }

    // Show the server's speed, CPU use and saves; follow changes made from
    // another viewer.
    updateServerStatus() {
      const s = this.remote.status;
      if (!s) return;
      this.paused = s.paused;
      $('#playPause').textContent = s.paused ? '▶ Play' : '⏸ Pause';
      const target = s.speed === 'max' ? 32 : s.speed;
      document.querySelectorAll('#speeds button').forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === target));
      const budget = $('#cpuBudget');
      if (document.activeElement !== budget) { budget.value = Math.round(s.budget * 100); $('#cpuBudgetVal').textContent = budget.value + '%'; }
      const ago = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
      const up = s.uptime > 86400 ? `${Math.floor(s.uptime / 86400)} d ${Math.floor((s.uptime % 86400) / 3600)} h` : `${Math.floor(s.uptime / 3600)} h ${Math.floor((s.uptime % 3600) / 60)} min`;
      $('#serverStatus').innerHTML = (s.error ? `<span style="color:#e66">⚠️ ${esc(s.error)} (press Play to retry)</span><br>` : '') +
        `Running at <b>${fmt(s.actualSpeed, 1)}×</b> (target ${s.speed === 'max' ? 'max' : s.speed + '×'}) · CPU ${Math.round(s.cpu * 100)}% · ${fmt(s.stepMs, 1)} ms/step<br>` +
        `Up ${up} · ${s.memoryMB} MB · ${s.lastSave ? `saved ${ago(Date.now() - s.lastSave.at)} (${Math.round(s.lastSave.bytes / 1024)} KB)` : 'not saved yet'}` +
        (this.remote.connected ? '' : '<br><span style="color:#e66">Connection lost, reconnecting…</span>');
      this.setSaveStatus('The server saves every few minutes and keeps hourly, daily and weekly backups.');
    }

    // "Recap": compare the world now with your last visit, or N hours ago.
    async openDigest(range, welcome) {
      const sim = this.sim;
      const sel = $('#digestRange');
      sel.querySelector('option[value="visit"]').hidden = !this.prevVisit;
      if (range === 'visit' && !this.prevVisit) range = '24';
      sel.value = range;
      let from, wallMs = 0;
      if (range === 'visit') { from = this.prevVisit.t; wallMs = Date.now() - this.prevVisit.wall; }
      else if (Number(range) > 0) { wallMs = Number(range) * 3600000; from = Evo.Digest.timeAtWall(sim, Date.now() - wallMs); }
      else from = sim.history.length ? sim.history[0].t : 0;
      $('#digestTitle').textContent = welcome ? '🕰 While you were away' : '🕰 Recap';
      $('#digestView').hidden = false;
      let highlights;
      if (this.remote) {
        try {
          const r = await fetch(this.remote.api(`api/chronicle?important=1&limit=12&seed=${sim.seed}&since=${Math.floor(from)}`), { cache: 'no-store' });
          highlights = await r.json();
        } catch (e) { highlights = []; }
      } else highlights = sim.events.filter((e) => e.important && e.t > from);
      $('#digestBody').innerHTML = Evo.Digest.build(sim, from, wallMs, highlights);
    }

    newWorld() {
      this.useSim(new Evo.Simulation(Object.assign({}, this.cfg)), false);
      this.toast(`New world · seed ${this.sim.seed}`);
    }

    useSim(sim, fromSave) {
      this.sim = sim;
      this.renderer.attach(sim);
      this.selected = null;
      this.follow = false;
      this.acc = 0;
      this.simRate = { t: sim.time, at: performance.now(), rate: this.speed };
      if (fromSave) {
        // Show the loaded world's settings (the live ones keep applying to it).
        this.cfg = Object.assign({}, sim.cfg);
        saveSettings(this.cfg);
        this.buildSettings();
      }
      this.updateUI(true);
    }

    // ------------------------------------------------------------ save / load
    // Every side-panel section folds open/closed; remember which are open.
    bindPanels() {
      const KEY = 'evolution.panels';
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { /* defaults */ }
      for (const d of document.querySelectorAll('#side > details[id]')) {
        if (saved[d.id] !== undefined) d.open = saved[d.id];
        d.addEventListener('toggle', () => {
          saved[d.id] = d.open;
          try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) { /* ignore */ }
          if (d.open && this.sim) this.updateUI(true);
        });
      }
    }

    // Buttons that start a random event right away.
    bindDisasters() {
      const box = $('#disasterButtons');
      box.innerHTML = Evo.Events.KINDS.map((k) => `<button data-kind="${k}">${Evo.Events.TYPES[k].icon} ${Evo.Events.TYPES[k].label}</button>`).join('');
      box.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const kind = b.dataset.kind;
        if (this.remote) { this.remote.cmd({ cmd: 'event', kind }); return; }
        const ev = Evo.Events.start(this.sim, kind);
        if (!ev) this.toast(kind === 'plague' ? 'No species is big enough for a plague (20+ members)' : `A ${Evo.Events.TYPES[kind].label.toLowerCase()} is already happening`);
        this.updateUI(true);
      });
    }

    bindSave() {
      let auto = true;
      try { auto = localStorage.getItem('evolution.autosave') !== 'off'; } catch (e) { /* default on */ }
      $('#autosave').checked = auto;
      $('#autosave').addEventListener('change', (e) => {
        try { localStorage.setItem('evolution.autosave', e.target.checked ? 'on' : 'off'); } catch (err) { /* ignore */ }
      });
      $('#saveBtn').addEventListener('click', () => { if (this.remote) this.remote.cmd({ cmd: 'save' }); else this.save(false); });
      $('#loadBtn').addEventListener('click', () => this.loadSaved());
      $('#exportBtn').addEventListener('click', () => {
        if (this.remote) { window.location.href = this.remote.exportUrl(); return; }
        Evo.Save.exportFile(this.sim);
        this.toast('World exported as a file');
      });
      $('#importBtn').addEventListener('click', () => $('#importFile').click());
      $('#importFile').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
          if (this.remote) {
            if (!window.confirm(`Replace the world on the server with ${file.name}? (The old one stays in the server backups.)`)) return;
            const r = await this.remote.importFile(file);
            this.toast(r.ok ? `Loaded ${file.name} on the server` : `The server refused it: ${r.message}`);
            return;
          }
          this.useSim(await Evo.Save.importFile(file), true);
          this.toast(`Loaded ${file.name}`);
        } catch (err) {
          console.warn(err);
          this.toast("That file isn't a saved world");
        }
      });
      setInterval(() => { if (!this.remote && $('#autosave').checked) this.save(true); }, 60000);
      document.addEventListener('visibilitychange', () => {
        if (!this.remote && document.visibilityState === 'hidden' && $('#autosave').checked) this.save(true);
      });
      const info = Evo.Save.storageInfo();
      this.setSaveStatus(info ? 'A saved world is stored in this browser.' : 'Nothing saved yet.');
    }

    async save(quiet) {
      if (this.saving || !this.sim) return;
      this.saving = true;
      try {
        const r = await Evo.Save.saveToStorage(this.sim);
        const when = r.savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        this.setSaveStatus(`${quiet ? 'Autosaved' : 'Saved'} at ${when} · ${Evo.fmtTime(this.sim.time)} into the run · ${Math.round(r.bytes / 1024)} KB`);
        if (!quiet) this.toast('World saved');
      } catch (e) {
        console.warn('Save failed', e);
        this.setSaveStatus('Could not save to browser storage (full or blocked). Use Export instead.');
        if (!quiet) this.toast('Browser storage is full or blocked, use Export to save a file');
      } finally {
        this.saving = false;
      }
    }

    async loadSaved() {
      if (!Evo.Save.storageInfo()) { this.toast('Nothing saved yet'); return; }
      if (!window.confirm('Replace the current world with your last save?')) return;
      try {
        const sim = await Evo.Save.loadFromStorage();
        this.useSim(sim, true);
        this.toast(`Loaded your save (${Evo.fmtTime(sim.time)} in)`);
      } catch (e) {
        console.warn(e);
        this.toast('Could not load the save');
      }
    }

    setSaveStatus(text) { $('#saveStatus').textContent = text; }

    // ------------------------------------------------------------ main loop
    frame(now) {
      const real = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      if (this.remote) this.remote.animate(now);
      else if (!this.paused) {
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
        if (this.remote) { this.remote.cmd({ cmd: 'spawn', kind: this.tool, x: q.x, y: q.y }); return; }
        const c = this.sim.spawnAt(this.tool, q.x, q.y);
        if (!c) this.toast("Can't place a creature in deep water or on peaks");
      }
    }

    applyBrush(p) {
      const q = this.wrapPoint(p);
      if (this.remote) {
        // At most ~8 brush strokes a second go to the server.
        const now = performance.now();
        if (now - (this.lastBrush || 0) < 120) return;
        this.lastBrush = now;
        this.remote.cmd({ cmd: 'brush', tool: this.tool, x: q.x, y: q.y });
        return;
      }
      if (this.tool === 'food') {
        this.sim.growFood(q.x, q.y, BRUSH);
        this.renderer.lastTerrain = -1;
      } else if (this.tool === 'smite') this.sim.smite(q.x, q.y, BRUSH);
    }

    // Select and follow a random living member of a species.
    followSpecies(id) {
      const members = this.sim.creatures.filter((c) => c.species === id);
      if (!members.length) return;
      this.select(members[Math.floor(Math.random() * members.length)]);
      this.follow = true;
      this.renderer.cam.zoom = Math.max(this.renderer.cam.zoom, 1.5);
    }

    select(c) {
      this.selected = c;
      if (!c) this.follow = false;
      if (c && this.remote) this.remote.refreshDetail(c).then(() => this.updateInspector());
      this.updateInspector();
    }

    setTool(t) {
      this.tool = t;
      document.querySelectorAll('#tools button').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
      this.canvas.classList.toggle('paint', t !== 'inspect');
    }

    setSpeed(s) {
      if (this.remote) {
        this.remote.cmd({ cmd: 'speed', speed: s >= 32 ? 'max' : s });
        this.remoteSpeed = s;
      }
      this.speed = s;
      document.querySelectorAll('#speeds button').forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === s));
      if (this.paused) this.togglePause();
    }

    fitMap() {
      this.follow = false;
      this.renderer.fit();
    }

    togglePause() {
      this.paused = !this.paused;
      if (this.remote) this.remote.cmd({ cmd: 'pause', paused: this.paused });
      $('#playPause').textContent = this.paused ? '▶ Play' : '⏸ Pause';
    }

    bindControls() {
      document.querySelectorAll('#tools button').forEach((b) => b.addEventListener('click', () => this.setTool(b.dataset.tool)));
      document.querySelectorAll('#speeds button').forEach((b) => b.addEventListener('click', () => this.setSpeed(Number(b.dataset.speed))));
      $('#playPause').addEventListener('click', () => this.togglePause());
      $('#fitMap').addEventListener('click', () => this.fitMap());
      $('#colorMode').addEventListener('change', (e) => {
        this.renderer.colorMode = e.target.value;
        this.updateMapLegend();
      });
      $('#showSense').addEventListener('change', (e) => { this.renderer.showSense = e.target.checked; });
      $('#heatMap').addEventListener('change', (e) => {
        this.renderer.heatMap = e.target.checked;
        this.renderer.lastTerrain = -1;
        this.updateMapLegend();
      });
      $('#chartMetric').addEventListener('change', (e) => this.chart.setMetric(e.target.value));
      // Chart range, remembered in this browser.
      let range = '0';
      try { range = localStorage.getItem('evolution.chartRange') || '0'; } catch (e) { /* default */ }
      $('#chartRange').value = range;
      this.chart.range = Number($('#chartRange').value) || 0;
      $('#chartRange').addEventListener('change', (e) => {
        this.chart.setRange(Number(e.target.value));
        try { localStorage.setItem('evolution.chartRange', e.target.value); } catch (err) { /* ignore */ }
      });
      $('#newWorld').addEventListener('click', () => {
        this.readSettings();
        if (this.remote) {
          if (window.confirm('Replace the world on the server with a new one? (The old one stays in the server backups.)')) this.remote.cmd({ cmd: 'newWorld', cfg: this.cfg });
          return;
        }
        this.newWorld();
      });
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
        if (this.remote && (act === 'clone' || act === 'kill')) {
          this.remote.cmd({ cmd: 'creature', id: c.id, act }).then((r) => { if (r.ok && act === 'clone') this.toast('Dropped 5 clones nearby'); });
          return;
        }
        if (act === 'clone' && c.alive) { this.sim.cloneNear(c, 5); this.toast('Dropped 5 clones nearby'); }
        if (act === 'kill' && c.alive) this.sim.kill(c, 'smitten');
        if (act === 'parent') {
          const p = this.sim.creatures.find((x) => c.parentIds.includes(x.id));
          if (p) this.select(p); else this.toast('Parents are no longer alive');
        }
        this.updateInspector();
      });

      $('#fame').addEventListener('click', (e) => {
        const row = e.target.closest('.fame-row.clickable');
        if (!row) return;
        const c = this.sim.creatures.find((x) => x.id === Number(row.dataset.id));
        if (!c) { this.toast('That record holder has died'); return; }
        this.select(c);
        this.follow = true;
        this.renderer.cam.zoom = Math.max(this.renderer.cam.zoom, 1.5);
      });

      $('#recapBtn').addEventListener('click', () => this.openDigest(this.prevVisit ? 'visit' : '24'));
      $('#digestRange').addEventListener('change', (e) => this.openDigest(e.target.value));
      $('#digestClose').addEventListener('click', () => { $('#digestView').hidden = true; });
      $('#speciesList').addEventListener('click', (e) => {
        const row = e.target.closest('.sp');
        if (row) this.followSpecies(Number(row.dataset.id));
      });
      this.tree = new Evo.Tree.TreeView(this);
      $('#treeBtn').addEventListener('click', () => this.tree.toggle());

      window.addEventListener('keydown', (e) => {
        if (e.target.closest && e.target.closest('input, select, textarea')) return;
        const key = e.key.toLowerCase();
        this.keys.add(key);
        if (key === ' ') { e.preventDefault(); this.togglePause(); }
        const speeds = [0.5, 1, 2, 4, 8, 32];
        if (key >= '1' && key <= '6') this.setSpeed(speeds[Number(key) - 1]);
        if (key === 'f' && this.selected) this.follow = !this.follow;
        if (key === 'escape') {
          if (!$('#digestView').hidden) $('#digestView').hidden = true;
          else if (this.lapse && this.lapse.open) this.lapse.toggle(false);
          else if (this.tree.open) this.tree.toggle(false);
          else this.select(null);
        }
        if (key === 't') this.tree.toggle();
        if (key === '0' || key === 'home') this.fitMap();
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
        const live = ['plantGrowth', 'mutationScale', 'seasonStrength', 'seasonLength', 'maxPopulation', 'allowAsexual', 'migration', 'neuralBrains', 'brainMutation', 'eventRate', 'climate', 'dayLength', 'climateSwing', 'climateCycle'];
        if (this.remote) { this.remote.cmd({ cmd: 'settings', cfg: this.cfg }); return; }
        for (const k of live) this.sim.cfg[k] = this.cfg[k];
      };
      form.onsubmit = (e) => e.preventDefault();
    }

    readSettings() {
      const adjusted = [];
      for (const f of Evo.CONFIG_SCHEMA) {
        const el = $('#cfg_' + f.key);
        if (!el) continue;
        if (f.type === 'bool') this.cfg[f.key] = el.checked;
        else {
          const typed = Number(el.value);
          let v = Number.isFinite(typed) ? typed : f.def;
          v = Evo.clamp(v, f.min, f.max);
          if (f.type === 'int') v = Math.round(v);
          this.cfg[f.key] = v;
          // Show the value actually used, and say so, instead of silently changing it.
          if (v !== typed) {
            el.value = v;
            adjusted.push(`${f.label.replace(/ \(.*\)$/, '')}: ${v} (allowed ${f.min}–${f.max})`);
          }
        }
      }
      if (adjusted.length) this.toast('Adjusted to the allowed range: ' + adjusted.join(', '));
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
          <li><b>Calories</b>: food is worth different amounts per bite — meat ${Evo.K.CAL.meat}, water plants ${Evo.K.CAL.algae},
          grass ${Evo.K.CAL.grass}, tree leaves ${Evo.K.CAL.leaves}. Food fills the <b>stomach</b> and is digested into energy
          over time, so a predator can gorge on one kill and rest for a long while, but plant-eaters must keep grazing.</li>
          <li><b>Hunger</b>: a creature only looks for food when its energy drops below its <b>Appetite</b> gene, and
          stops once it is full. A full predator ignores prey.</li>
          <li><b>Temperature</b>: warm in the middle band of the map, cold toward the top and bottom edges and on
          mountains, and it swings with the seasons (snow shows where it's freezing; tick <b>Heat map</b> to see it).
          Plants grow slower in the cold and stop in hard frost. The <b>Fur</b> gene sets the temperature a creature is
          comfortable at (big bodies hold heat better too); outside that range it burns extra energy, and extremes hurt.
          Uncomfortable creatures move somewhere better when they can. The <b>Climate</b> setting shifts the whole world
          warmer or colder.</li>
          <li><b>Food</b>: three kinds of plants regrow (faster in summer): <b>grass</b> on open land, <b>tree leaves</b>
          in forests, and <b>water plants</b> in the shallows. Dead creatures leave meat that rots.</li>
          <li><b>Niches</b>: small-mouthed <b>grazers</b> eat grass; big <b>browsers</b> reach tree leaves
          (the Browsing gene); <b>swimmers</b> feed in water, can cross deep water, and dry out on land, so they stay near (and flee into) water. Being good at one food makes
          a creature worse at the others, so plant-eaters can split into specialists that live side by side.</li>
          <li><b>Diet</b> is a sliding scale: good at digesting meat means bad at plants, and vice-versa. Omnivores sit
          in between, so plant-eaters can become meat-eaters (and back) one small step at a time.</li>
          <li><b>Brains</b>: each creature has a small neural network in its DNA. Its senses (hunger, energy,
          danger, being attacked, a mate nearby, how good the plants, carrion and prey around it are...) go in; out come
          scores for everything it could do (flee, fight, court, eat, hunt, rest...). It does the best-scoring action.
          Founders start with the classic rules, then babies inherit a mix of both parents' networks with mutations, so
          behaviour evolves. Click a creature to see its scores. Turn it off under World settings to compare.</li>
          <li><b>Breeding</b>: adults with enough energy look for a mate with similar DNA;
          if none is found for a while they may reproduce alone.</li>
          <li><b>Species</b>: a baby founds a new species (new name, new colour) when its DNA has drifted far from its
          species' average, or when it has clearly moved into a different niche, like a grazer's calf that has become a
          browser. Each species has one colour, so you can follow it on the map. Because mates must be similar,
          diverged species stop interbreeding and stay separate. ⭐ in the event log marks a brand-new niche.</li>
          <li><b>Day and night</b>: days last a minute by default (<b>Day length</b> in World settings; 0 = always
          day). Nights are dark and a little colder. The <b>Nocturnal</b> gene sets whether a creature's eyes are built for
          daylight or the dark, and when it gets sleepy. Sleepers tuck away (harder to spot) and save energy, but notice
          less. Since predators start out active by day, a plant-eater whose body clock flips to night can graze while they
          sleep — and then a predator may follow it into the night. Colour by <b>Day / night activity</b> to watch it.</li>
          <li><b>Random events</b> shake things up every year or two (<b>Random events ×</b> in World settings; 0 turns
          them off, and the buttons in the Events panel start one right away).
          🏜️ <b>Drought</b>: plants wither in a large region (orange circle), so animals must move or starve.
          ❄️ <b>Ice age</b>: the whole world cools by 6–10 °C for 2–3 years; fur pays off.
          ☄️ <b>Meteor</b>: kills everything in the crater and burns the plants; the ash later makes a lush ring (green).
          🦠 <b>Plague</b>: strikes the most numerous species (purple halo = sick) and spreads to close herd-mates;
          herding creatures catch it more, unusual DNA resists it, and survivors are immune.
          🐾 <b>Invaders</b>: a group of a brand-new, very different species walks in.</li>
          <li><b>Climate cycles</b>: over dozens of game-years the world slowly warms and cools, wet and dry regions
          drift across the map (plants grow faster or slower there), and the seas rise and fall, flooding coasts and
          uncovering new land. The corner shows where the cycle is now. Adjust or turn off in World settings.</li>
          <li><b>Eras</b>: the run is told in chapters. When the set of major niches changes for good, or a new species
          takes the lead, a new era begins, with a name like "The age of the night swimmers" (📖 Eras panel).
          <b>🕰 Recap</b> in the Events panel shows what changed over the last hour, day or week.</li>
        </ul>
        <p><b>Genes</b></p>
        <ul>${Evo.GENES.map((g) => `<li><b>${esc(g.label)}</b> — ${esc(g.desc)}</li>`).join('')}</ul>`;
    }

    // ------------------------------------------------------------ panels
    updateUI(force) {
      const sim = this.sim;
      const h = sim.history[sim.history.length - 1];
      const n = sim.creatures.length;
      const niches = { grazer: 0, browser: 0, swimmer: 0, omnivore: 0, carnivore: 0 };
      for (const c of sim.creatures) niches[Evo.niche(c.g)]++;
      const NC = Evo.NICHE_COLORS;
      const stat = (v, k, color) => `<div class="stat"><div class="v">${v}</div><div class="k">${color ? `<span class="swatch" style="background:${color}"></span>` : ''}${k}</div></div>`;
      $('#stats').innerHTML =
        stat(n, 'creatures') + stat(h ? h.species : 0, 'species') + stat(sim.stats.maxGeneration, 'max generation') +
        stat(niches.grazer, 'grazers', NC.grazer) + stat(niches.browser, 'browsers', NC.browser) + stat(niches.swimmer, 'swimmers', NC.swimmer) +
        stat(niches.omnivore, 'omnivores', NC.omnivore) + stat(niches.carnivore, 'carnivores', NC.carnivore) + stat(sim.world.corpses.length, 'carcasses');

      const season = sim.seasonName();
      const icon = { Spring: '🌱', Summer: '☀️', Autumn: '🍂', Winter: '❄️' }[season];
      let rate = this.paused ? 'paused' : `${fmt(this.simRate.rate, 1)}× speed`;
      if (this.remote) {
        this.updateServerStatus();
        const s = this.remote.status;
        rate = `🖥 ${!this.remote.connected ? 'reconnecting…' : s && s.paused ? 'paused' : `${fmt(s ? s.actualSpeed : 0, 1)}×`} on server`;
        // Keep the selected creature's details fresh (every ~½ s).
        if (this.selected && this.selected.alive && (this.detailTick = (this.detailTick || 0) + 1) % 2 === 0) this.remote.refreshDetail(this.selected);
      }
      $('#hud').innerHTML = `<b>${Evo.fmtTime(sim.time)}</b> · Year ${Math.floor(sim.time / sim.cfg.seasonLength) + 1} · ${icon} ${season}${this.dayHud(sim)}<br><span class="muted">${rate} · seed ${sim.seed}</span>${this.hover ? `<br>🌡 ${fmt(sim.world.tempAtPoint(this.wrapPoint(this.hover).x, this.wrapPoint(this.hover).y, sim.time))} °C here` : ''}${this.disasterHud(sim)}${Evo.Climate.describe(sim) ? '<br><span class="muted">' + Evo.Climate.describe(sim) + '</span>' : ''}<br><span class="muted small">v${Evo.VERSION.number} · ${Evo.VERSION.date}</span>`;

      // Closed panels aren't redrawn (they catch up when opened).
      const open = (id) => $('#' + id).open;
      if (open('panelHistory')) {
        this.chart.yearLength = sim.cfg.seasonLength;
        this.chart.dayLength = sim.cfg.dayLength;
        this.chart.draw(sim.history);
      }
      if (!this.pressing) {
        if (open('inspectorPanel')) this.updateInspector();
        this.updateSpecies();
        if (open('panelFame')) this.updateFame();
        if (open('panelEras')) this.updateEras();
      }
      this.tree.tick();
      if (open('panelEvents')) $('#events').innerHTML = sim.events.map((e) => `<div class="${e.important ? 'big' : ''}"><span class="t">${Evo.fmtTime(e.t)}</span>${e.important ? '⭐ ' : ''}${e.html}</div>`).join('') ||
        '<span class="muted">Nothing yet…</span>';

      if (n === 0 && !this.announcedExtinction) {
        this.announcedExtinction = true;
        this.toast('Everything died out. Start a new world from the settings panel.');
      } else if (n > 0) this.announcedExtinction = false;
    }

    // Day or night, shown next to the season.
    dayHud(sim) {
      if (!(sim.cfg.dayLength > 0)) return '';
      const l = sim.world.light(sim.time);
      const label = l >= 1 ? 'Day' : l <= 0 ? 'Night' : Math.cos((2 * Math.PI * sim.time) / sim.cfg.dayLength) >= 0 ? 'Dawn' : 'Dusk';
      return ` · <span title="${label}">${{ Day: '☀️', Night: '🌙', Dawn: '🌅', Dusk: '🌇' }[label]}</span>`;
    }

    // Active random events with the time left, for the corner display.
    disasterHud(sim) {
      const act = sim.disasters ? sim.disasters.active : [];
      return act.map((e) => {
        const T = Evo.Events.TYPES[e.kind];
        const left = Math.max(0, e.end - sim.time);
        const extra = e.kind === 'iceAge' ? ` ${fmt(e.depth)} °C` : '';
        return `<br><span class="event-tag">${T.icon} ${T.label}${extra} · ${Evo.fmtTime(left)} left</span>`;
      }).join('');
    }

    // The chapters of the run, newest first.
    updateEras() {
      const sim = this.sim;
      const list = (sim.eras && sim.eras.list) || [];
      $('#eraCount').textContent = list.length ? `(${list.length})` : '';
      const year = sim.cfg.seasonLength;
      const yr = (t) => Math.floor(t / year) + 1;
      const span = (a, b) => { const y = (b - a) / year; return y < 1 ? `${Math.max(1, Math.round((b - a) / 60))} min` : `${fmt(y, y < 10 ? 1 : 0)} years`; };
      const icons = Evo.Events.TYPES;
      $('#eras').innerHTML = list.slice().reverse().slice(0, 50).map((e) => {
        const end = e.end === null ? sim.time : e.end;
        const d = e.dominant;
        const niches = e.niches.map((k) => {
          const base = k.replace('night ', '');
          return `<span class="chip"><span class="swatch" style="background:${Evo.NICHE_COLORS[base]}"></span>${esc(Evo.Eras.plural(k))}</span>`;
        }).join('');
        const ev = e.events.map((x) => icons[x.kind] ? icons[x.kind].icon : '').join('');
        return `<div class="era${e.end === null ? ' now' : ''}">
          <div><b>${e.n}. ${esc(e.name)}</b></div>
          <div class="meta">Year ${yr(e.start)} – ${e.end === null ? 'now' : 'year ' + yr(end)} · ${span(e.start, end)}</div>
          <div class="chips">${niches}</div>
          <div class="meta">${d ? `Led by <span class="swatch" style="background:${d.color}"></span>${esc(d.name)} · ` : ''}peak ${e.peak} creatures · ${e.newSpecies} new species${ev ? ' · ' + ev : ''}</div>
        </div>`;
      }).join('') || '<span class="muted">The first era begins after a minute…</span>';
    }

    updateFame() {
      const sim = this.sim;
      const alive = new Map();
      for (const c of sim.creatures) alive.set(c.id, c);
      const fmtValue = (r, v) => r.unit === 'time' ? Evo.fmtTime(v)
        : r.unit === 'speed' ? `${fmt(v)} u/s` : r.unit === 'tiles' ? `${fmt(v)} tiles`
        : r.unit === 'members' ? `${fmt(v)}` : fmt(v, r.digits || 0);
      const rows = Evo.Fame.RECORDS.map((r) => {
        const h = sim.fame[r.key];
        if (!h) return '';
        const sp = sim.species.get(h.species);
        const color = sp ? sp.color : '#999';
        const isCreature = h.id !== undefined;
        const living = isCreature ? alive.has(h.id) : !!(sp && sp.count > 0);
        const who = isCreature ? `${esc(h.name)} #${h.id}` : esc(h.name);
        const state = living ? '<span class="live">alive</span>' : '<span class="muted">†</span>';
        return `<div class="fame-row${isCreature && living ? ' clickable' : ''}" ${isCreature && living ? `data-id="${h.id}" title="Click to follow"` : ''}>
          <span class="fame-icon">${r.icon}</span>
          <div><div>${esc(r.label)}</div><div class="meta"><span class="swatch" style="background:${color}"></span>${who} · ${h.niche} ${state}</div></div>
          <span class="n">${fmtValue(r, h.value)}</span></div>`;
      }).join('');
      $('#fame').innerHTML = rows || '<span class="muted">No records yet…</span>';
    }

    updateSpecies() {
      const living = this.sim.species.living().sort((a, b) => b.count - a.count);
      $('#speciesCount').textContent = `(${living.length} alive)`;
      $('#speciesList').innerHTML = living.slice(0, 12).map((sp) => {
        const parent = sp.parentId ? this.sim.species.get(sp.parentId) : null;
        return `<div class="sp" data-id="${sp.id}" title="Click to follow a member">
          <span class="dot" style="background:${sp.color}"></span>
          <div><div>${esc(sp.name)}</div><div class="meta"><span class="swatch" style="background:${Evo.NICHE_COLORS[sp.niche]}"></span>${sp.niche} · size ${fmt(sp.avgSize, 2)}${parent ? ' · from ' + esc(parent.name) : ''}</div></div>
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
      const stress = c.thermalStress();
      const feel = stress < 0 ? ' · 🥶 cold' : stress > 0 ? ' · 🥵 hot' : '';
      const status = c.alive ? `${esc(c.state)} · ${c.hungry ? '😋 hungry' : '😌 not hungry'}${feel}` : `💀 Died (${esc(c.deathCause || 'unknown')})`;
      const genes = Evo.GENES.filter((g) => !g.neutral).map((g) => {
        const v = c.g[g.key];
        return bar(esc(g.label), v - g.min, g.max - g.min, 'var(--accent)', fmt(v, g.max > 10 ? 0 : 2));
      }).join('');
      el.innerHTML = `
        <div class="insp-head">
          <span class="dot" style="background:${sp ? sp.color : '#ccc'}"></span>
          <div><b>${esc(sp ? sp.name : '?')}</b> #${c.id} <span class="muted">· ${Evo.niche(c.g)}${c.grow < 1 ? ' · baby' : ''}</span><br>
          <span class="muted">${status}</span></div>
        </div>
        <div class="bars">
          ${bar('Health', c.health, p.maxHealth, '#199e70', fmt(Math.max(0, c.health)))}
          ${bar('Energy', c.energy, p.maxEnergy, '#c98500', fmt(c.energy))}
          ${bar('Stamina', c.stamina, p.maxStamina, '#3987e5', fmt(c.stamina, 1))}
          ${bar('Stomach', c.stomach, p.stomachCap, '#8a6d3b', fmt((100 * c.stomach) / p.stomachCap) + '%')}
        </div>
        <div class="kv">
          <span class="k">Age</span><span>${fmt(c.age)}s / ${fmt(c.g.lifespan)}s</span>
          <span class="k">Generation</span><span>${c.generation}</span>
          <span class="k">Children · kills</span><span>${c.children} · ${c.kills}</span>
          <span class="k">Mass · top speed</span><span>${fmt(p.mass, 2)} · ${fmt(p.maxSpeed)}</span>
          <span class="k">Strength</span><span>${fmt(p.strength, 1)}/s</span>
          <span class="k">Digests grass · leaves</span><span>${fmt(p.eat.grass * 100)}% · ${fmt(p.eat.leaves * 100)}%</span>
          <span class="k">Water plants · meat</span><span>${fmt(p.eat.algae * 100)}% · ${fmt(p.meatEff * 100)}%</span>
          <span class="k">Upkeep</span><span>${fmt(p.basal, 2)} energy/s</span>
          <span class="k">Temperature · comfy at</span><span>${fmt(c.temp)} °C · ${fmt(p.comfortTemp)} °C (±8)</span>
          <span class="k">Active · sight now</span><span>${c.g.nocturnal > 0.66 ? '🌙 at night' : c.g.nocturnal < 0.33 ? '☀️ by day' : '🌅 dusk & dawn'} · ${Math.round(c.sight * 100)}%</span>
          <span class="k">Gets hungry below</span><span>${fmt(c.g.appetite * 100)}% energy</span>
          <span class="k">Meal in stomach</span><span>${fmt(c.stomachCal)} calories</span>
        </div>
        ${this.brainHtml(c)}
        <p class="muted small" style="margin:8px 0 0">DNA</p>
        <div class="bars">${genes}</div>
        <div class="row">
          <button data-act="follow" class="${this.follow ? 'active' : ''}">🎥 Follow</button>
          <button data-act="parent">👪 Parent</button>
          <button data-act="clone">🧬 Clone ×5</button>
          <button data-act="kill">⚡ Kill</button>
        </div>`;
    }

    // Legend for the map colors when they encode niche or diet.
    updateMapLegend() {
      const el = $('#mapLegend');
      const mode = this.renderer.colorMode;
      let items = [];
      if (mode === 'niche') items = Object.entries(Evo.NICHE_COLORS);
      if (mode === 'active') items = [['active by day', Evo.ACTIVE_COLORS.day], ['dusk & dawn', Evo.ACTIVE_COLORS.twilight], ['active at night', Evo.ACTIVE_COLORS.night]];
      if (mode === 'diet') items = [['plants', 'hsl(120,75%,45%)'], ['mixed', 'hsl(60,75%,45%)'], ['meat', 'hsl(0,75%,45%)']];
      if (this.renderer.heatMap) items = items.concat([['−15 °C', 'rgb(40,80,200)'], ['5', 'rgb(150,190,235)'], ['15', 'rgb(235,232,215)'], ['25', 'rgb(240,160,90)'], ['35 °C', 'rgb(200,50,40)']]);
      el.style.display = items.length ? 'flex' : 'none';
      el.innerHTML = items.map(([k, c]) => `<span><span class="dot" style="background:${c}"></span>${k}</span>`).join('');
    }

    // What the creature's neural network scored each possible action at its
    // last decision; the chosen one is highlighted.
    brainHtml(c) {
      const B = Evo.Brain;
      if (!c.util || !c.avail) return '';
      const rows = [];
      for (let a = 0; a < B.NA; a++) if (c.avail[a]) rows.push([a, c.util[a]]);
      rows.sort((x, y) => y[1] - x[1]);
      const top = Math.max(1, ...rows.map((r) => r[1]));
      const fixed = !this.sim.cfg.neuralBrains;
      const bars = rows.map(([a, u]) => {
        const chosen = a === c.choice;
        const label = (chosen ? '▶ ' : '') + B.ACTION_LABELS[B.ACTIONS[a]];
        return `<div class="label${chosen ? ' chosen' : ''}">${esc(label)}</div><div class="bar"><span style="width:${Evo.clamp((u / top) * 100, 0, 100)}%;background:${chosen ? '#c98500' : '#5b6b7e'}"></span></div><div class="num">${fmt(u, 1)}</div>`;
      }).join('');
      return `
        <p class="muted small" style="margin:8px 0 0">Brain · last decision${fixed ? ' (fixed rules)' : ''} · drift from founders ${fmt(B.drift(c.g.brain), 2)}</p>
        <div class="bars">${bars}</div>`;
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
