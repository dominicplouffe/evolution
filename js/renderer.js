// Canvas renderer with a pan/zoom camera. When the world wraps, it draws the
// neighbouring copies of the map so you can scroll forever in any direction.
(function (Evo) {
  'use strict';

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
      const w = this.sim.world;
      const d = this.image.data;
      const B = Evo.BIOMES;
      const winter = Evo.clamp((1 - w.season(this.sim.time)) * 0.8, 0, 0.5);
      for (let i = 0; i < w.plant.length; i++) {
        const b = B[w.biome[i]];
        const max = w.plantMax[i];
        let t = max > 0 ? w.plant[i] / max : 0;
        t *= 1 - winter * 0.6;
        const o = i * 4;
        d[o] = b.color[0] + (b.lush[0] - b.color[0]) * t;
        d[o + 1] = b.color[1] + (b.lush[1] - b.color[1]) * t;
        d[o + 2] = b.color[2] + (b.lush[2] - b.color[2]) * t;
        d[o + 3] = 255;
      }
      this.tctx.putImageData(this.image, 0, 0);
    }

    creatureColor(c) {
      if (this.colorMode === 'diet') {
        // green (plants) -> yellow -> red (meat)
        const d = c.g.diet;
        return `hsl(${Math.round(120 - 120 * d)}, 75%, ${45 + 10 * (1 - c.grow)}%)`;
      }
      return `hsl(${Math.round(c.g.hue)}, 80%, ${56 + 12 * (1 - c.grow)}%)`;
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

      const detailed = z > 0.35;
      for (const [ox, oy] of offsets) {
        // Corpses.
        ctx.fillStyle = 'rgba(120, 30, 30, 0.85)';
        for (const c of w.corpses) {
          const x = c.x + ox, y = c.y + oy;
          if (x < vx0 - 20 || x > vx1 + 20 || y < vy0 - 20 || y > vy1 + 20) continue;
          const r = 2 + 4 * Math.sqrt(c.energy / 100);
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
})((globalThis.Evo = globalThis.Evo || {}));
