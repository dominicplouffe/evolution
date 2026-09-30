// Soak test: run a world as fast as possible for many simulated hours and
// report what grows (memory, save size, species archive, history) and how the
// step time evolves. Anything that keeps growing would eventually break a
// months-long server run.
//   node tools/soak.js [simulatedHours=6] [seed=1] [reportEveryMinutes=30]
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
for (const f of ['version', 'rng', 'config', 'brain', 'genome', 'world', 'creature', 'fame', 'events', 'tree', 'climate', 'eras', 'sim', 'save']) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'js', f + '.js'), 'utf8'), { filename: f + '.js' });
}
const Evo = globalThis.Evo;
const hours = Number(process.argv[2] || 6);
const seed = Number(process.argv[3] || 1);
const every = Number(process.argv[4] || 30) * 60;
const sim = new Evo.Simulation({ seed });
const t0 = Date.now();
let next = every, steps = 0, stepStart = Date.now();
console.log('sim_h  creatures species(alive/archived) history save_KB heap_MB ms/step events_log disasters_log wall_min');
while (sim.time < hours * 3600) {
  sim.step();
  steps++;
  if (sim.time >= next) {
    next += every;
    if (global.gc) global.gc();
    const json = JSON.stringify(Evo.Save.serialize(sim));
    const kb = Math.round(zlib.gzipSync(json).length / 1024);
    const ms = (Date.now() - stepStart) / steps;
    steps = 0; stepStart = Date.now();
    console.log([
      (sim.time / 3600).toFixed(1).padStart(5), String(sim.creatures.length).padStart(9),
      `${sim.species.living().length}/${sim.species.byId.size}`.padStart(22), String(sim.history.length).padStart(7),
      String(kb).padStart(7), String(Math.round(process.memoryUsage().heapUsed / 1048576)).padStart(7), ms.toFixed(2).padStart(7),
      String(sim.events.length).padStart(10), String(sim.disasters ? sim.disasters.log.length : 0).padStart(13),
      ((Date.now() - t0) / 60000).toFixed(1).padStart(8),
    ].join(' '));
  }
}
