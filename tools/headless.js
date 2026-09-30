// Runs the simulation without a browser, for balancing:
//   node tools/headless.js [seconds] [seed]
const fs = require('fs');
const path = require('path');
const vm = require('vm');
for (const f of ['rng', 'config', 'brain', 'genome', 'world', 'creature', 'fame', 'events', 'tree', 'climate', 'eras', 'sim']) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'js', f + '.js'), 'utf8'), { filename: f + '.js' });
}
const Evo = globalThis.Evo;
const seconds = Number(process.argv[2] || 600);
const sim = new Evo.Simulation({ seed: Number(process.argv[3] || 1234) });
const t0 = Date.now();
let lastLog = 0;
while (sim.time < seconds && sim.creatures.length > 0) {
  sim.step();
  if (sim.time - lastLog >= Number(process.env.EVERY || 30)) {
    lastLog = sim.time;
    const h = sim.history[sim.history.length - 1];
    const a = h.avg;
    console.log(
      `t=${sim.time.toFixed(0).padStart(5)} n=${String(h.n).padStart(4)} H/O/C=${h.herbivore}/${h.omnivore}/${h.carnivore}` +
      ` graze/browse/swim=${h.niches.grazer}/${h.niches.browser}/${h.niches.swimmer} sp=${h.species} plants=${h.plants.toFixed(1)} gen=${sim.stats.maxGeneration}` +
      ` | size=${a.size.toFixed(2)} spd=${a.speed.toFixed(2)} sense=${a.sense.toFixed(2)} diet=${a.diet.toFixed(2)} litter=${a.litter.toFixed(1)} mut=${a.mutation.toFixed(2)}`
    );
  }
}
for (const sp of sim.species.living().sort((a, b) => b.count - a.count).slice(0, 8)) {
  console.log(`   ${sp.name.padEnd(14)} ${sp.niche.padEnd(9)} n=${String(sp.count).padStart(4)} size=${sp.centroid.size.toFixed(2)} browse=${sp.centroid.feeding.toFixed(2)} swim=${sp.centroid.swim.toFixed(2)}`);
}
console.log('causes', sim.stats.causes, 'births', sim.stats.births, `(${((Date.now() - t0) / 1000).toFixed(1)}s wall)`);
