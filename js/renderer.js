// Canvas renderer with a pan/zoom camera. When the world wraps, it draws the
// neighbouring copies of the map so you can scroll forever in any direction.
(function (Evo) {
  'use strict';

  // Bright on the map so they stand out against grass and water.
  // "Active time" colour mode, from the Nocturnal gene.
  const ACTIVE_COLORS = { day: 'hsl(48, 95%, 60%)', twilight: 'hsl(320, 70%, 65%)', night: 'hsl(210, 95%, 70%)' };
  const NICHE_COLORS = {
    grazer: 'hsl(55, 90%, 60%)',
    browser: 'hsl(25, 90%, 58%)',
    swimmer: 'hsl(190, 95%, 62%)',
    omnivore: 'hsl(285, 70%, 65%)',
    carnivore: 'hsl(350, 85%, 55%)',
  };

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.cam = { x: 0, y: 0, zoom: 1 };
      this.colorMode = 'species'; // 'species' | 'diet'
      this.showSense = false;
      this.terrainCanvas = document.createElement('canvas');
      this.lastTerrain = -1;
    }

    attach(sim) {
      this.sim = sim;
      const w = sim.world;
      this.terrainCanvas.width = w.cols;
      this.terrainCanvas.height = w.rows;
      this.tctx = this.terrainCanvas.getContext('2d');
      this.image = this.tctx.createImageData(w.cols, w.rows);
      this.lastTerrain = -1;
      this.fit();
    }

    fit() {
      const w = this.sim.world;
      this.resize();
      this.cam.x = w.width / 2;
      this.cam.y = w.height / 2;
      this.cam.zoom = Math.min(this.cw / w.width, this.ch / w.height) * 0.98;
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const r = this.canvas.getBoundingClientRect();
      this.cw = r.width;
      this.ch = r.height;
      this.dpr = dpr;
      const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
      if (this.canvas.width !== W || this.canvas.height !== H) {
        this.canvas.width = W;
        this.canvas.height = H;
      }
    }

    screenToWorld(sx, sy) {
      return {
        x: (sx - this.cw / 2) / this.cam.zoom + this.cam.x,
        y: (sy - this.ch / 2) / this.cam.zoom + this.cam.y,
      };
    }

    zoomAt(sx, sy, factor) {
      const before = this.screenToWorld(sx, sy);
      this.cam.zoom = Evo.clamp(this.cam.zoom * factor, 0.05, 8);
      const after = this.screenToWorld(sx, sy);
      this.cam.x += before.x - after.x;
      this.cam.y += before.y - after.y;
      this.normalizeCamera();
    }

    pan(dxScreen, dyScreen) {
      this.cam.x -= dxScreen / this.cam.zoom;
      this.cam.y -= dyScreen / this.cam.zoom;
      this.normalizeCamera();
    }

    normalizeCamera() {
      const w = this.sim.world;
      if (w.wrap) {
        this.cam.x = ((this.cam.x % w.width) + w.width) % w.width;
        this.cam.y = ((this.cam.y % w.height) + w.height) % w.height;
      } else {
        this.cam.x = Evo.clamp(this.cam.x, 0, w.width);
        this.cam.y = Evo.clamp(this.cam.y, 0, w.height);
      }
    }

    // Terrain colors blend from bare to lush with the amount of plant food.
    updateTerrain() {
      Evo.paintTerrain(this.sim.world, this.sim.time, this.heatMap, this.image.data);
      this.tctx.putImageData(this.image, 0, 0);
    }

    creatureColor(c) {
      if (this.colorMode === 'niche') return NICHE_COLORS[Evo.niche(c.g)];
      if (this.colorMode === 'active') return ACTIVE_COLORS[c.g.nocturnal < 0.33 ? 'day' : c.g.nocturnal > 0.66 ? 'night' : 'twilight'];
      if (this.colorMode === 'diet') {
        // green (plants) -> yellow -> red (meat)
        const d = c.g.diet;
        return `hsl(${Math.round(120 - 120 * d)}, 75%, ${45 + 10 * (1 - c.grow)}%)`;
      }
      const sp = this.sim.species.get(c.species);
      return sp ? sp.color : '#ccc';
    }

    drawDisaster(e, ox, oy, time, z) {
      const ctx = this.ctx;
      if (e.x === undefined) return; // world-wide (ice age) or no place (plague)
      const x = e.x + ox, y = e.y + oy;
      const age = time - e.start;
      ctx.save();
      ctx.lineWidth = 2 / z;
      ctx.setLineDash([10 / z, 6 / z]);
      if (e.kind === 'drought') {
        ctx.fillStyle = 'rgba(230, 140, 40, 0.22)';
        ctx.beginPath(); ctx.arc(x, y, e.r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(240, 170, 70, 0.7)';
        ctx.beginPath(); ctx.arc(x, y, e.r, 0, Math.PI * 2); ctx.stroke();
      } else if (e.kind === 'meteor') {
        const fade = Math.max(0, 1 - age / (e.end - e.start));
        // Fires for the first 20 s, then a dark crater with a fertile ring.
        ctx.fillStyle = age < 20 ? `rgba(255, ${Math.floor(90 + 60 * Math.sin(age * 6))}, 20, ${0.55 * (1 - age / 20) + 0.2})` : `rgba(40, 30, 25, ${0.5 * fade})`;
        ctx.beginPath(); ctx.arc(x, y, e.r, 0, Math.PI * 2); ctx.fill();
        if (age >= 20) {
          ctx.strokeStyle = `rgba(120, 230, 90, ${0.3 + 0.5 * fade})`;
          ctx.beginPath(); ctx.arc(x, y, e.fertileR, 0, Math.PI * 2); ctx.stroke();
        }
      } else if (e.kind === 'invaders') {
        const f = age / 30;
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.8 * (1 - f)})`;
        ctx.beginPath(); ctx.arc(x, y, 60 + 80 * f, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }

    draw(selected, hoverWorld) {
      const ctx = this.ctx;
      const sim = this.sim;
      const w = sim.world;
      this.resize();
      const now = performance.now();
      if (now - this.lastTerrain > 250) {
        this.updateTerrain();
        this.lastTerrain = now;
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#0d1420';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

      const z = this.cam.zoom;
      ctx.setTransform(this.dpr * z, 0, 0, this.dpr * z,
        this.dpr * (this.cw / 2 - this.cam.x * z), this.dpr * (this.ch / 2 - this.cam.y * z));

      // Visible world rect.
      const vx0 = this.cam.x - this.cw / 2 / z, vx1 = this.cam.x + this.cw / 2 / z;
      const vy0 = this.cam.y - this.ch / 2 / z, vy1 = this.cam.y + this.ch / 2 / z;

      const offsets = [];
      const range = w.wrap ? [-1, 0, 1] : [0];
      for (const oy of range) {
        for (const ox of range) {
          const x0 = ox * w.width, y0 = oy * w.height;
          if (x0 + w.width < vx0 || x0 > vx1 || y0 + w.height < vy0 || y0 > vy1) continue;
          offsets.push([x0, y0]);
        }
      }

      ctx.imageSmoothingEnabled = false;
      for (const [ox, oy] of offsets) {
        ctx.drawImage(this.terrainCanvas, ox, oy, w.width, w.height);
      }
      if (!w.wrap) {
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 2 / z;
        ctx.strokeRect(0, 0, w.width, w.height);
      }

      // Night: darken the land (creatures stay bright so you can still watch).
      const dark = 1 - w.light(sim.time);
      if (dark > 0 && !this.heatMap) {
        ctx.fillStyle = `rgba(8, 14, 45, ${0.5 * dark})`;
        ctx.fillRect(vx0, vy0, vx1 - vx0, vy1 - vy0);
      }

      const detailed = z > 0.35;
      const disasters = sim.disasters ? sim.disasters.active : [];
      for (const [ox, oy] of offsets) {
        // Random events: drought zones, meteor craters, invader landings.
        for (const e of disasters) this.drawDisaster(e, ox, oy, sim.time, z);

        // Corpses.
        ctx.fillStyle = 'rgba(120, 30, 30, 0.85)';
        for (const c of w.corpses) {
          const x = c.x + ox, y = c.y + oy;
          if (x < vx0 - 20 || x > vx1 + 20 || y < vy0 - 20 || y > vy1 + 20) continue;
          const r = 2 + 4 * Math.sqrt(c.meat / 25);
          if (detailed) {
            ctx.beginPath();
            ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
            ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
            ctx.strokeStyle = 'rgba(150, 30, 30, 0.9)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          } else ctx.fillRect(x - r, y - r, r * 2, r * 2);
        }

        // Creatures.
        for (const c of sim.creatures) {
          const x = c.x + ox, y = c.y + oy;
          // Keep creatures visible when zoomed out.
          const r = Math.max(c.phen.radius, 3.5 / z);
          if (x < vx0 - r || x > vx1 + r || y < vy0 - r || y > vy1 + r) continue;
          if (c.infected) { // plague: purple halo
            ctx.beginPath();
            ctx.arc(x, y, r + 3 / z + 1, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(190, 90, 255, 0.95)';
            ctx.lineWidth = 2 / z;
            ctx.stroke();
          }
          ctx.fillStyle = this.creatureColor(c);
          if (!detailed) {
            ctx.fillRect(x - r, y - r, r * 2, r * 2);
            ctx.lineWidth = 1 / z;
            ctx.strokeStyle = 'rgba(0,0,0,0.7)';
            ctx.strokeRect(x - r, y - r, r * 2, r * 2);
            continue;
          }
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
          // Outline: thicker for armor.
          ctx.lineWidth = Math.max(0.6 + c.g.armor * 2, 1 / z);
          ctx.strokeStyle = c.state === Evo.Creature.STATE.FLEE ? '#fff' : 'rgba(0,0,0,0.6)';
          ctx.stroke();
          // Mouth/nose: red fangs for meat-eaters, pale for plant-eaters.
          const hx = Math.cos(c.heading), hy = Math.sin(c.heading);
          ctx.beginPath();
          ctx.moveTo(x + hx * (r + 3 + c.g.diet * 3), y + hy * (r + 3 + c.g.diet * 3));
          ctx.lineTo(x + Math.cos(c.heading + 0.7) * r, y + Math.sin(c.heading + 0.7) * r);
          ctx.lineTo(x + Math.cos(c.heading - 0.7) * r, y + Math.sin(c.heading - 0.7) * r);
          ctx.closePath();
          ctx.fillStyle = c.g.diet > 0.66 ? '#e33' : c.g.diet > 0.33 ? '#eb3' : '#dfd';
          ctx.fill();
          if (this.showSense) {
            ctx.beginPath();
            ctx.arc(x, y, c.phen.senseRadius, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255,255,255,0.07)';
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }

        if (selected && selected.alive) {
          const x = selected.x + ox, y = selected.y + oy;
          ctx.lineWidth = 2 / z;
          ctx.strokeStyle = '#fff';
          ctx.beginPath();
          ctx.arc(x, y, selected.phen.radius + 5 / z + 2, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([6 / z, 6 / z]);
          ctx.strokeStyle = 'rgba(255,255,255,0.35)';
          ctx.beginPath();
          ctx.arc(x, y, selected.phen.senseRadius, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
          const t = selected.target;
          if (t && t.x !== undefined) {
            ctx.strokeStyle = selected.state === Evo.Creature.STATE.HUNT ? 'rgba(255,80,80,0.8)' : 'rgba(255,255,255,0.5)';
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + w.dx(selected.x, t.x), y + w.dy(selected.y, t.y));
            ctx.stroke();
          }
        }
      }

      if (hoverWorld && this.brushRadius) {
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1.5 / z;
        ctx.beginPath();
        ctx.arc(hoverWorld.x, hoverWorld.y, this.brushRadius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  Evo.Renderer = Renderer;
  Evo.NICHE_COLORS = NICHE_COLORS;
  Evo.ACTIVE_COLORS = ACTIVE_COLORS;
})((globalThis.Evo = globalThis.Evo || {}));
