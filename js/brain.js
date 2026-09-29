// Evolving brains: a small neural network, stored in the DNA, that scores the
// actions a creature could take right now. The creature does the best-scoring
// action it can; the rest of the game (movement, eating, fighting) carries it
// out. Founder brains are wired to reproduce the original hand-written rules,
// so the world starts sane and behaviour drifts from there by mutation.
//
//   score[action] = direct[action]·senses + out[action]·tanh(hidden·senses)
(function (Evo) {
  'use strict';

  const INPUTS = [
    'bias', 'hungry', 'energy', 'health', 'stamina', 'stomach', 'threat', 'attacked',
    'canWin', 'readyToMate', 'mateNearby', 'prey', 'carrion', 'plantsHere', 'plantsNearby', 'herd', 'homesick', 'sleepy',
  ];
  const ACTIONS = ['flee', 'fight', 'mate', 'eat', 'graze', 'scavenge', 'hunt', 'home', 'rest', 'wander'];
  const ACTION_LABELS = {
    flee: 'Flee', fight: 'Fight back', mate: 'Court', eat: 'Eat here', graze: 'Go to plants',
    scavenge: 'Scavenge', hunt: 'Hunt', home: 'Go home', rest: 'Rest', wander: 'Wander',
  };
  const NI = INPUTS.length, NA = ACTIONS.length, NH = 6;
  const SIZE = NA * NI + NH * NI + NA * NH;
  const OFF_W1 = NA * NI, OFF_W2 = OFF_W1 + NH * NI;
  const I = Object.fromEntries(INPUTS.map((k, i) => [k, i]));
  const A = Object.fromEntries(ACTIONS.map((k, i) => [k, i]));

  // The original rules, written as direct weights (see creature.think history):
  // flee > fight back > court > food (when hungry) > go home > rest / wander.
  const RULES = {
    flee: { bias: 4, threat: 4 },
    fight: { bias: 2, canWin: 7 },
    mate: { bias: 3 },
    eat: { hungry: 1.2, plantsHere: 1.3 },
    graze: { hungry: 1.2, plantsNearby: 1.3 },
    scavenge: { hungry: 1.2, carrion: 1.3 },
    hunt: { hungry: 1.2, prey: 1.04 },
    home: { bias: 1.1 },
    rest: { bias: 1, hungry: -1, readyToMate: -0.6, sleepy: 0.5 },
    wander: { bias: 0.6 },
  };

  // Hidden-layer input weights start random (but reproducible) so mutations to
  // the output weights have something to work with. Output weights start at 0,
  // so the founders behave exactly like the rules.
  function initial() {
    const w = new Array(SIZE).fill(0);
    for (const a of ACTIONS) for (const k in RULES[a]) w[A[a] * NI + I[k]] = RULES[a][k];
    let s = 12345;
    for (let i = OFF_W1; i < OFF_W2; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      w[i] = ((s / 4294967296) * 2 - 1) * 0.8;
    }
    return w;
  }
  const DEFAULT = initial();

  const hidden = new Float64Array(NH);
  // Scores all actions into `out` (length NA).
  function run(w, x, out) {
    for (let h = 0; h < NH; h++) {
      let s = 0;
      const o = OFF_W1 + h * NI;
      for (let i = 0; i < NI; i++) s += w[o + i] * x[i];
      hidden[h] = Math.tanh(s);
    }
    for (let a = 0; a < NA; a++) {
      let s = 0;
      const o = a * NI;
      for (let i = 0; i < NI; i++) s += w[o + i] * x[i];
      const o2 = OFF_W2 + a * NH;
      for (let h = 0; h < NH; h++) s += w[o2 + h] * hidden[h];
      out[a] = s;
    }
  }

  // Each weight has a small chance to shift; rarely one takes a big jump.
  function mutate(w, rng, rate) {
    const out = w.slice();
    const p = Math.min(1, rate * 0.3);
    for (let i = 0; i < SIZE; i++) {
      if (rng.next() < p) out[i] += rng.gauss() * (rng.next() < 0.05 ? 1.5 : 0.25);
    }
    return out;
  }

  // Inherit whole units from one parent or the other: each action's direct
  // weights, and each hidden neuron (its inputs and its outputs) together.
  function crossover(a, b, rng) {
    const out = a.slice();
    for (let act = 0; act < NA; act++) {
      if (rng.next() < 0.5) for (let i = 0; i < NI; i++) out[act * NI + i] = b[act * NI + i];
    }
    for (let h = 0; h < NH; h++) {
      if (rng.next() < 0.5) {
        for (let i = 0; i < NI; i++) out[OFF_W1 + h * NI + i] = b[OFF_W1 + h * NI + i];
        for (let act = 0; act < NA; act++) out[OFF_W2 + act * NH + h] = b[OFF_W2 + act * NH + h];
      }
    }
    return out;
  }

  // How far a brain has drifted from the founders' (RMS weight difference).
  function drift(w) {
    let s = 0;
    for (let i = 0; i < SIZE; i++) { const d = w[i] - DEFAULT[i]; s += d * d; }
    return Math.sqrt(s / SIZE);
  }

  // Compact save format: weights as 16-bit integers (1/1000 steps), base64.
  function encode(w) {
    const q = new Int16Array(SIZE);
    for (let i = 0; i < SIZE; i++) q[i] = Math.max(-32767, Math.min(32767, Math.round(w[i] * 1000)));
    const bytes = new Uint8Array(q.buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function decode(b64) {
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    const q = new Int16Array(bytes.buffer);
    const w = new Array(SIZE);
    // Older saves have brains with fewer senses (inputs were only ever added
    // at the end): copy each block, and give new inputs the founder weights
    // (direct) or 0 (hidden layer, so behaviour doesn't change).
    const ni = (q.length - NA * NH) / (NA + NH);
    if (ni < NI && Number.isInteger(ni)) {
      for (let i = 0; i < SIZE; i++) w[i] = i < OFF_W1 ? DEFAULT[i] : i < OFF_W2 ? 0 : q[i - OFF_W2 + (NA + NH) * ni] / 1000;
      for (let r = 0; r < NA + NH; r++) for (let i = 0; i < ni; i++) w[r * NI + i] = q[r * ni + i] / 1000;
      return w;
    }
    for (let i = 0; i < SIZE; i++) w[i] = i < q.length ? q[i] / 1000 : DEFAULT[i];
    return w;
  }

  // Accepts a weight array, a saved string, or nothing (older saves).
  function from(x) {
    if (typeof x === 'string') return decode(x);
    if (Array.isArray(x) && x.length === SIZE) return x.slice();
    return DEFAULT.slice();
  }

  Evo.Brain = { INPUTS, ACTIONS, ACTION_LABELS, NI, NA, SIZE, I, A, DEFAULT, initial, run, mutate, crossover, drift, encode, from };
})((globalThis.Evo = globalThis.Evo || {}));
