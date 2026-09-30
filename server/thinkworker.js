// A worker thread for the multi-core "deciding" phase (see thinkcore.js).
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { workerData, parentPort } = require('worker_threads');

// The same simulation code the main thread runs.
const JS = path.join(__dirname, '..', 'js');
for (const f of ['version', 'rng', 'config', 'brain', 'genome', 'world', 'creature', 'fame', 'events', 'tree', 'climate', 'eras', 'sim', 'save']) {
  vm.runInThisContext(fs.readFileSync(path.join(JS, f + '.js'), 'utf8'), { filename: f + '.js' });
}
const { ThinkCore } = require('./thinkcore');

const core = new ThinkCore(globalThis.Evo, workerData.init);
const ctrl = new Int32Array(workerData.ctrl);
// Busy time (ms) per worker: [refresh, think], for the status display.
const stats = new Float64Array(workerData.stats, workerData.index * 2 * 8, 2);

parentPort.on('message', (msg) => {
  if (msg.type === 'buffers') { core.setBuffers(msg.buffers); return; }
  if (msg.type !== 'step') return;
  if (msg.terrain) core.setTerrain(msg.terrain);
  const t0 = performance.now();
  core.addBirths(msg.births);
  core.refresh(msg);
  const t1 = performance.now();
  core.think(msg, msg.from, msg.to);
  stats[0] += t1 - t0;
  stats[1] += performance.now() - t1;
  Atomics.add(ctrl, 0, 1);
  Atomics.notify(ctrl, 0);
});
