// Time-lapse player (viewer mode): plays back the map images the server keeps
// every few minutes, so days or months of evolution run by in a minute.
(function (Evo) {
  'use strict';

  const $ = (s) => document.querySelector(s);

  class LapsePlayer {
    constructor(app) {
      this.app = app;
      this.el = $('#lapseView');
      this.img = $('#lapseImg');
      this.frames = [];
      this.i = 0;
      this.playing = false;
      this.cache = new Map();
      $('#lapseClose').addEventListener('click', () => this.toggle(false));
      $('#lapseRange').addEventListener('change', () => this.load());
      $('#lapsePlay').addEventListener('click', () => this.setPlaying(!this.playing));
      $('#lapseSlider').addEventListener('input', (e) => { this.setPlaying(false); this.show(Number(e.target.value)); });
    }

    get open() { return !this.el.hidden; }

    toggle(on = !this.open) {
      this.el.hidden = !on;
      if (on) this.load();
      else this.setPlaying(false);
    }

    async load() {
      const days = Number($('#lapseRange').value);
      const since = days ? Date.now() - days * 86400000 : 0;
      $('#lapseCaption').textContent = 'Loading…';
      try {
        const r = await fetch(this.app.remote.api(`api/timelapse?since=${since}`), { cache: 'no-store' });
        this.frames = (await r.json()).filter((f) => f.seed === this.app.sim.seed);
      } catch (e) {
        this.frames = [];
      }
      const slider = $('#lapseSlider');
      slider.max = Math.max(0, this.frames.length - 1);
      if (!this.frames.length) {
        this.img.removeAttribute('src');
        $('#lapseCaption').textContent = 'No frames yet: the server saves one every few minutes.';
        return;
      }
      this.show(0);
      this.setPlaying(true);
    }

    url(f) { return this.app.remote.api(`api/timelapse/frame?f=${encodeURIComponent(f.f)}`); }

    // Keep a few frames ahead loaded so playback doesn't stutter.
    preload(from) {
      for (let k = from; k < Math.min(this.frames.length, from + 8); k++) {
        const f = this.frames[k];
        if (this.cache.has(f.f)) continue;
        const im = new Image();
        im.src = this.url(f);
        this.cache.set(f.f, im);
        if (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value);
      }
    }

    show(i) {
      if (!this.frames.length) return;
      this.i = Math.max(0, Math.min(this.frames.length - 1, i));
      const f = this.frames[this.i];
      this.img.src = this.url(f);
      $('#lapseSlider').value = this.i;
      const when = new Date(f.wall).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      $('#lapseCaption').textContent = `${when} · year ${f.year} · ${f.n} creatures · frame ${this.i + 1} of ${this.frames.length}`;
      this.preload(this.i + 1);
    }

    setPlaying(on) {
      this.playing = on && this.frames.length > 1;
      $('#lapsePlay').textContent = this.playing ? '⏸' : '▶';
      clearTimeout(this.timer);
      if (this.playing) this.tick();
    }

    tick() {
      if (!this.playing) return;
      const next = this.i + 1 >= this.frames.length ? 0 : this.i + 1;
      const im = this.cache.get(this.frames[next].f);
      // Wait for the next image to arrive rather than skipping it.
      if (im && !im.complete) { this.timer = setTimeout(() => this.tick(), 30); return; }
      this.show(next);
      this.timer = setTimeout(() => this.tick(), 1000 / Number($('#lapseFps').value));
    }
  }

  Evo.LapsePlayer = LapsePlayer;
})((globalThis.Evo = globalThis.Evo || {}));
