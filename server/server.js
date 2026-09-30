#!/usr/bin/env node
// Evolution server: runs one world around the clock and serves the viewer.
//
//   node server/server.js [--port 8080] [--host 0.0.0.0] [--data ./data]
//                         [--speed 1|max] [--budget 0.5] [--snapshot 5]
//                         [--timelapse 5]   (minutes between frames, 0 = off)
//                         [--threads N]     (worker threads for deciding; default
//                                            cores - 1, at most 4; 0 = one core)
//
// Open http://<server>:8080/ in a browser (e.g. on the Raspberry Pi) to watch
// and control the world. Set EVO_TOKEN=<secret> to require ?token=<secret>.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Runner, Evo, log } = require('./runner');

// ------------------------------------------------------------ options
function option(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i > 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  const env = process.env['EVO_' + name.toUpperCase()];
  return env !== undefined ? env : def;
}
const PORT = Number(option('port', 8080));
const HOST = option('host', '0.0.0.0');
const DATA = option('data', path.join(__dirname, '..', 'data'));
const TOKEN = process.env.EVO_TOKEN || '';
const speedOpt = option('speed', undefined);
const budgetOpt = option('budget', undefined);

const runner = new Runner({
  dataDir: DATA,
  snapshotMinutes: Number(option('snapshot', 5)),
  timelapseMinutes: Number(option('timelapse', 5)),
  threads: option('threads', undefined) === undefined ? undefined : Number(option('threads', undefined)),
  speed: speedOpt === undefined ? undefined : speedOpt === 'max' ? Infinity : Number(speedOpt),
  budget: budgetOpt === undefined ? undefined : Number(budgetOpt),
});

// ------------------------------------------------------------ live stream
// Viewers get server-sent events: 'frame' (every creature's position, ~5/s),
// 'meta' (time, stats, species, records, log... every second), 'food' (plant
// levels, every 4 s), and 'reset' when the whole world was replaced.
const clients = new Set();
let lastSpeciesSig = new Map();
let lastEventsJson = '', lastFameJson = '', lastErasJson = '';

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${data}\n\n`);
}
function broadcast(event, data) {
  for (const res of clients) send(res, event, data);
}

const FLEE = Evo.Creature.STATE.FLEE, SLEEP = Evo.Creature.STATE.SLEEP;
// 20 bytes per creature: id, species, x, y (float), heading, growth, flags.
function frameData() {
  const sim = runner.sim;
  const cs = sim.creatures;
  const buf = Buffer.alloc(cs.length * 20);
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i], o = i * 20;
    buf.writeUInt32LE(c.id, o);
    buf.writeUInt32LE(c.species, o + 4);
    buf.writeFloatLE(c.x, o + 8);
    buf.writeFloatLE(c.y, o + 12);
    const h = ((c.heading % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    buf.writeUInt8(Math.round((h / (2 * Math.PI)) * 255), o + 16);
    buf.writeUInt8(Math.round(Math.min(1, c.grow) * 255), o + 17);
    buf.writeUInt8((c.state === FLEE ? 1 : 0) | (c.infected ? 2 : 0) | (c.state === SLEEP ? 4 : 0), o + 18);
  }
  return JSON.stringify({ t: sim.time, b: buf.toString('base64') });
}

function packSpecies(sp) {
  const o = Object.assign({}, sp);
  delete o._sum;
  delete o.founder;
  o.centroid = Object.assign({}, sp.centroid);
  delete o.centroid.brain;
  return o;
}

// `full`: every living species (a new viewer); otherwise only the species
// that changed since the last broadcast.
function metaData(full) {
  const sim = runner.sim;
  const sig = new Map();
  const changed = [];
  for (const sp of sim.species.byId.values()) {
    if (sp.count === 0 && !lastSpeciesSig.has(sp.id)) continue;
    const s = `${sp.count}|${sp.niche}|${sp.extinctAt}|${sp.peak}|${sp.pop ? sp.pop.i0 + ':' + sp.pop.v.length : ''}`;
    if (sp.count > 0) sig.set(sp.id, s);
    if (full ? sp.count > 0 : lastSpeciesSig.get(sp.id) !== s) changed.push(packSpecies(sp));
  }
  if (!full) lastSpeciesSig = sig;
  // The log and records are only sent when they changed.
  const eventsJson = JSON.stringify(sim.events), fameJson = JSON.stringify(sim.fame), erasJson = JSON.stringify(sim.eras);
  const sendEvents = full || eventsJson !== lastEventsJson, sendFame = full || fameJson !== lastFameJson;
  const sendEras = full || erasJson !== lastErasJson;
  if (!full) { lastEventsJson = eventsJson; lastFameJson = fameJson; lastErasJson = erasJson; }
  const corpses = [];
  for (const c of sim.world.corpses) corpses.push(Math.round(c.x), Math.round(c.y), Math.round(c.meat * 10) / 10, c.species || 0);
  return JSON.stringify({
    t: sim.time,
    tick: sim.tick,
    seed: sim.seed,
    cfg: sim.cfg,
    stats: sim.stats,
    history: sim.history.slice(-3),
    species: changed,
    speciesNextId: sim.species.nextId,
    fame: sendFame ? sim.fame : undefined,
    events: sendEvents ? sim.events : undefined,
    eras: sendEras ? sim.eras : undefined,
    disasters: sim.disasters ? { active: sim.disasters.active } : null,
    extraTemp: sim.world.extraTemp || 0,
    corpses,
    treeEvery: sim.treeEvery,
    historyOldEvery: sim.historyOldEvery,
    runner: runner.status(),
  });
}

function foodData() {
  const w = runner.sim.world;
  const out = { t: runner.sim.time };
  for (const f of Evo.FOODS) {
    const { amt, max } = w.food[f.key];
    const q = Buffer.alloc(amt.length);
    for (let i = 0; i < amt.length; i++) q[i] = max[i] > 0 ? Math.round(Math.min(1, amt[i] / max[i]) * 255) : 0;
    out[f.key] = q.toString('base64');
  }
  return JSON.stringify(out);
}

setInterval(() => { if (clients.size) broadcast('frame', frameData()); }, 200);
setInterval(() => { if (clients.size) broadcast('meta', metaData()); }, 1000);
setInterval(() => { if (clients.size) broadcast('food', foodData()); }, 4000);
setInterval(() => { for (const res of clients) res.write(': keep-alive\n\n'); }, 15000);
runner.onReset = () => { lastSpeciesSig = new Map(); lastEventsJson = lastFameJson = lastErasJson = ''; broadcast('reset', '{}'); };

// ------------------------------------------------------------ HTTP
const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8' };

function sendJson(req, res, obj, status = 200) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (body.length > 20000 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(status, headers);
    res.end(zlib.gzipSync(body));
  } else {
    res.writeHead(status, headers);
    res.end(body);
  }
}

function readBody(req, limit = 200 * 1048576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const allowed = pathname === '/index.html' || /^\/(js|css)\/[\w.-]+$/.test(pathname) || /^\/[\w.-]+\.(md|png|ico|svg)$/.test(pathname);
  const file = path.join(ROOT, path.normalize(pathname));
  if (!allowed || !file.startsWith(ROOT)) { res.writeHead(404); res.end('Not found'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function creatureDetail(c) {
  const g = Object.assign({}, c.g);
  delete g.brain;
  return {
    id: c.id, alive: c.alive, species: c.species, g, grow: c.grow, x: c.x, y: c.y, generation: c.generation, parentIds: c.parentIds,
    bornAt: c.bornAt, energy: c.energy, health: c.health, stamina: c.stamina, stomach: c.stomach, stomachCal: c.stomachCal,
    hungry: c.hungry, state: c.state, age: c.age, children: c.children, kills: c.kills, temp: c.temp, sight: c.sight,
    util: c.util ? Array.from(c.util) : null, avail: c.avail ? Array.from(c.avail) : null, choice: c.choice,
    brain: Evo.Brain.encode(c.g.brain), deathCause: c.deathCause, travelled: c.travelled,
  };
}

function chroniclePage(entries) {
  const esc = (s) => String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  const fmt = (t) => { const m = Math.floor(t / 60); return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}:${String(Math.floor(t % 60)).padStart(2, '0')}`; };
  const rows = entries.map((e) => `<tr class="${e.important ? 'big' : ''}"><td>${esc(e.wall.slice(0, 16).replace('T', ' '))}</td><td>${fmt(e.t)}</td><td>${e.html}</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Chronicle</title>
<style>body{background:#0d1420;color:#aab6c5;font:13px/1.5 system-ui,sans-serif;margin:16px}h1{color:#e8edf3;font-size:18px}
table{border-collapse:collapse;width:100%}td{padding:3px 8px;border-bottom:1px solid #1e2734;vertical-align:top}td:nth-child(-n+2){white-space:nowrap;color:#7d8a9b;font-variant-numeric:tabular-nums}
tr.big td:last-child{color:#e8edf3}b{color:#e8edf3}a{color:#3987e5}</style>
<h1>📜 Chronicle</h1><p>Every event of this server's worlds, newest first (last ${entries.length}). <a href="./">Back to the world</a></p>
<table><tr><td>Real time</td><td>Game time</td><td></td></tr>${rows}</table>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/') || p === '/chronicle') {
      if (TOKEN && url.searchParams.get('token') !== TOKEN && req.headers['x-evo-token'] !== TOKEN) {
        sendJson(req, res, { ok: false, message: 'Wrong or missing token' }, 403);
        return;
      }
    }
    if (p === '/api/status') return sendJson(req, res, { server: true, runner: runner.status() });
    if (p === '/api/snapshot') return sendJson(req, res, Evo.Save.serialize(runner.sim));
    if (p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      send(res, 'meta', metaData(true));
      send(res, 'frame', frameData());
      send(res, 'food', foodData());
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/creature') {
      const id = Number(url.searchParams.get('id'));
      const c = runner.sim.creatures.find((x) => x.id === id);
      return sendJson(req, res, c ? creatureDetail(c) : { id, alive: false });
    }
    if (p === '/api/creatures' && req.method === 'POST') {
      const { ids } = JSON.parse((await readBody(req, 1048576)).toString('utf8') || '{}');
      const want = new Set(ids || []);
      return sendJson(req, res, runner.sim.creatures.filter((c) => want.has(c.id)).map(creatureDetail));
    }
    if (p === '/api/cmd' && req.method === 'POST') {
      const cmd = JSON.parse((await readBody(req, 65536)).toString('utf8') || '{}');
      return sendJson(req, res, runner.command(cmd));
    }
    if (p === '/api/export') {
      const gz = zlib.gzipSync(JSON.stringify(Evo.Save.serialize(runner.sim)));
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="evolution-${runner.sim.seed}-${Math.round(runner.sim.time)}s.json.gz"` });
      res.end(gz);
      return;
    }
    if (p === '/api/import' && req.method === 'POST') {
      let body = await readBody(req);
      if (body[0] === 0x1f && body[1] === 0x8b) body = zlib.gunzipSync(body);
      runner.importWorld(JSON.parse(body.toString('utf8')));
      return sendJson(req, res, { ok: true });
    }
    if (p === '/api/chronicle') {
      const q = url.searchParams;
      return sendJson(req, res, runner.readChronicle(Math.min(5000, Number(q.get('limit')) || 500), {
        seed: q.has('seed') ? Number(q.get('seed')) : undefined,
        since: q.has('since') ? Number(q.get('since')) : undefined,
        important: q.get('important') === '1',
      }));
    }
    if (p === '/api/timelapse') {
      const since = Number(url.searchParams.get('since')) || 0;
      return sendJson(req, res, runner.lapse ? runner.lapse.list().filter((e) => e.wall >= since) : []);
    }
    if (p === '/api/timelapse/frame') {
      const img = runner.lapse && runner.lapse.file(url.searchParams.get('f') || '');
      if (!img) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' });
      res.end(img);
      return;
    }
    if (p === '/chronicle') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(chroniclePage(runner.readChronicle(2000)));
      return;
    }
    if (req.method === 'GET') return serveStatic(req, res, p);
    res.writeHead(405); res.end();
  } catch (e) {
    log('Request failed', p, e.message);
    if (!res.headersSent) sendJson(req, res, { ok: false, message: e.message }, 500);
    else res.end();
  }
});

// ------------------------------------------------------------ lifecycle
function shutdown(sig) {
  log(`${sig}: saving and stopping`);
  if (!runner.validate(runner.sim)) runner.snapshot();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => {
  log('Unexpected error:', e.stack || e.message);
  // Save only if the world still looks sane; the service manager restarts us.
  try { if (runner.sim && !runner.validate(runner.sim)) runner.snapshot(); } catch (err) { /* ignore */ }
  process.exit(1);
});

runner.start();
server.listen(PORT, HOST, () => {
  const s = runner.status();
  log(`Evolution server v${s.version} on http://${HOST === '0.0.0.0' ? '<this machine>' : HOST}:${PORT}/ · data in ${path.resolve(DATA)} · speed ${s.speed}, CPU budget ${Math.round(s.budget * 100)}% · ${s.threads ? s.threads + ' worker threads' : 'one core'}${TOKEN ? ' · token required' : ''}`);
});
