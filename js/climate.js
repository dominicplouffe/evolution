// Slow climate cycles, so a world running for months never settles into
// sameness: warm and cold periods, wet and dry regions that drift across the
// map (plant growth), and seas that rise and fall and move the coastline.
// Everything follows from the game time and the seed, so a server and its
// viewers agree without sending anything.
(function (Evo) {
  'use strict';

  const TAU = Math.PI * 2;

  // Where this world is in its cycles right now.
  function state(sim) {
    const cfg = sim.cfg;
    const S = cfg.climateSwing || 0;
    if (!(S > 0)) return { temp: 0, sea: 0, rainAmp: 0, S: 0 };
    const P = Math.max(1, cfg.climateCycle || 60) * cfg.seasonLength;
    const ph = ((sim.seed % 1000) / 1000) * TAU; // each world starts somewhere else
    const t = sim.time;
    const k = Math.min(1.5, S / 5);
    return {
      S,
      P,
      ph,
      // Two slow waves, so no two periods are exactly alike.
      temp: S * (0.65 * Math.sin((TAU * t) / P + ph) + 0.35 * Math.sin((TAU * t) / (P * 3.7) + 2 * ph)),
      sea: 0.03 * k * Math.sin((TAU * t) / (P * 1.6) + 3 * ph),
      seaTrend: Math.cos((TAU * t) / (P * 1.6) + 3 * ph),
      rainAmp: 0.35 * k,
      rainA: (TAU * t) / (P * 0.9) + ph,
      rainB: (TAU * t) / (P * 1.4) + 2 * ph,
    };
  }

  // Wet and dry bands: a smooth pattern that wraps around the map edges and
  // drifts slowly. Growth ×0.65 in the driest spots, ×1.35 in the wettest.
  function rainField(world, st) {
    const n = world.cols * world.rows;
    if (!world.rainMul || world.rainMul.length !== n) world.rainMul = new Float32Array(n);
    const rm = world.rainMul;
    const sx = new Float32Array(world.cols);
    for (let x = 0; x < world.cols; x++) sx[x] = Math.sin((TAU * x) / world.cols + st.rainA);
    for (let y = 0; y < world.rows; y++) {
      const sy = Math.sin((TAU * y) / world.rows + st.rainB) * st.rainAmp;
      const o = y * world.cols;
      for (let x = 0; x < world.cols; x++) rm[o + x] = 1 + sx[x] * sy;
    }
  }

  // Apply the current climate to the world (also right after loading).
  function apply(sim) {
    const w = sim.world;
    const st = state(sim);
    w.cycleTemp = st.temp;
    if (st.S > 0) rainField(w, st);
    else w.rainMul = null;
    // Sea level: only worlds that remember their terrain shape (made since v0.16).
    if (w.elev) {
      if (w.seaLevel === undefined || w.seaLevel === null) w.seaLevel = sim.cfg.waterLevel;
      const target = sim.cfg.waterLevel + st.sea;
      if (Math.abs(target - w.seaLevel) > 0.003) {
        w.seaLevel = target;
        if (w.setSeaLevel(target).length && !sim.remote) rescue(sim);
      }
    }
    return st;
  }

  // Creatures caught by the rising water swim to the nearest shore they can
  // stand on; if there is none close by, they drown.
  function rescue(sim) {
    const w = sim.world, T = Evo.K.TILE;
    for (const c of sim.creatures) {
      if (!c.alive || w.canEnter(c.x, c.y, c.g.swim)) continue;
      let spot = null;
      for (let r = 1; r <= 6 && !spot; r++) {
        for (let k = 0; k < 8 * r && !spot; k++) {
          const a = (k / (8 * r)) * TAU;
          const x = c.x + Math.cos(a) * r * T, y = c.y + Math.sin(a) * r * T;
          if (w.canEnter(x, y, c.g.swim)) spot = { x, y };
        }
      }
      if (spot) { c.x = spot.x; c.y = spot.y; w.wrapPos(c); } else sim.kill(c, 'drowned');
    }
  }

  function step(sim) {
    if (sim.time < (sim.nextClimate || 0)) return;
    sim.nextClimate = sim.time + 5;
    const st = apply(sim);
    if (!(st.S > 0)) return;
    // Tell the story when the climate turns.
    const log = sim.climateLog || (sim.climateLog = {});
    const phase = st.temp > 0.55 * st.S ? 'warm' : st.temp < -0.55 * st.S ? 'cold' : 'mild';
    if (log.phase !== undefined && phase !== log.phase) {
      if (phase === 'warm') sim.logEvent('🌡️ A warm period begins: the world is getting warmer', true);
      else if (phase === 'cold') sim.logEvent('🧊 A cold period begins: the world is getting colder', true);
      else sim.logEvent(`🌤️ The climate is back to normal after a ${log.phase} period`);
    }
    log.phase = phase;
    if (sim.world.elev) {
      const trend = st.seaTrend > 0 ? 'rising' : 'falling';
      if (log.sea !== undefined && trend !== log.sea) {
        sim.logEvent(trend === 'rising' ? '🌊 The seas start to rise: coasts will flood' : '🏝️ The seas start to fall: new land will appear');
      }
      log.sea = trend;
    }
  }

  // Short description for the corner display, or '' when cycles are off.
  function describe(sim) {
    const st = state(sim);
    if (!(st.S > 0)) return '';
    const deg = `${st.temp >= 0 ? '+' : '−'}${Math.abs(st.temp).toFixed(1)} °C`;
    const sea = sim.world.elev ? ` · seas ${st.seaTrend > 0 ? 'rising' : 'falling'}` : '';
    return `🌍 ${deg}${sea}`;
  }

  Evo.Climate = { state, apply, step, describe };
})((globalThis.Evo = globalThis.Evo || {}));
