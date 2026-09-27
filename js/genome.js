// DNA: the list of genes, how they mutate/recombine, and how a genome turns
// into a body (the "phenotype"). The trade-offs live in phenotype().
(function (Evo) {
  'use strict';

  const GENES = [
    { key: 'size', label: 'Size', min: 0.5, max: 3, weight: 3, desc: 'Body size. Mass grows with size³: more health, strength and fat storage, but slower and hungrier.' },
    { key: 'speed', label: 'Muscle', min: 0.2, max: 3, desc: 'Top speed. Costs upkeep energy.' },
    { key: 'stamina', label: 'Stamina', min: 0.2, max: 3, desc: 'How long it can sprint, and how fast it recovers.' },
    { key: 'sense', label: 'Senses', min: 0.3, max: 3, desc: 'Vision/smell range. Big brains are expensive.' },
    { key: 'diet', label: 'Diet', min: 0, max: 1, weight: 3, desc: '0 = herbivore, 1 = carnivore. Digestion is a trade-off: good at one means bad at the other.' },
    { key: 'feeding', label: 'Browsing', min: 0, max: 1, weight: 3, desc: '0 = grazes low grass, 1 = browses tree leaves. Leaves are only reachable with a big body.' },
    { key: 'swim', label: 'Swimming', min: 0, max: 1, weight: 3, desc: 'Fast in water, eats water plants, crosses deep water above 0.5. Clumsy on land and costs upkeep.' },
    { key: 'appetite', label: 'Appetite', min: 0.2, max: 0.95, desc: 'Energy level (fraction of its reserves) below which it gets hungry and looks for food.' },
    { key: 'aggression', label: 'Aggression', min: 0, max: 1, desc: 'Willingness to attack bigger prey and to fight back.' },
    { key: 'fear', label: 'Fear', min: 0, max: 1, desc: 'How early it runs away from predators.' },
    { key: 'armor', label: 'Armor', min: 0, max: 1, desc: 'Shell/hide. Reduces damage taken, but is heavy (slower) and costly.' },
    { key: 'camo', label: 'Camouflage', min: 0, max: 1, desc: 'Harder to spot, especially in forests. Small upkeep cost.' },
    { key: 'social', label: 'Herding', min: 0, max: 1, desc: 'Tendency to stay with its own species.' },
    { key: 'litter', label: 'Litter size', min: 1, max: 6, desc: 'Babies per birth. Many small babies vs few well-fed ones.' },
    { key: 'maturity', label: 'Maturity (s)', min: 6, max: 60, desc: 'Time to grow up before it can breed.' },
    { key: 'lifespan', label: 'Lifespan (s)', min: 60, max: 400, desc: 'Age at which it starts dying of old age.' },
    { key: 'mutation', label: 'Mutation rate', min: 0.01, max: 0.4, desc: 'Chance each gene mutates in its offspring. Evolvable!' },
    { key: 'hue', label: 'Color', min: 0, max: 360, neutral: true, desc: 'Neutral marker gene that drifts over time: related creatures look alike.' },
  ];
  const GENE_BY_KEY = {};
  for (const g of GENES) GENE_BY_KEY[g.key] = g;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function makeGenome(base) {
    const g = {};
    for (const gene of GENES) g[gene.key] = base[gene.key] !== undefined ? base[gene.key] : (gene.min + gene.max) / 2;
    return g;
  }

  function cloneGenome(g) { return Object.assign({}, g); }

  function mutate(g, rng, scale) {
    const out = cloneGenome(g);
    const p = clamp(g.mutation * scale, 0, 1);
    for (const gene of GENES) {
      if (gene.key === 'hue') {
        out.hue = (out.hue + rng.gauss() * 5 * scale + 360) % 360;
        continue;
      }
      if (rng.chance(p)) {
        const span = gene.max - gene.min;
        // Mostly small steps, occasionally a big jump.
        const step = rng.chance(0.1) ? 0.25 : 0.07;
        out[gene.key] = clamp(out[gene.key] + rng.gauss() * span * step, gene.min, gene.max);
      }
    }
    return out;
  }

  function crossover(a, b, rng) {
    const out = {};
    for (const gene of GENES) {
      const r = rng.next();
      if (gene.key === 'hue') {
        // Average hue on the circle.
        let d = b.hue - a.hue;
        if (d > 180) d -= 360;
        if (d < -180) d += 360;
        out.hue = (a.hue + d * rng.next() + 360) % 360;
      } else if (r < 0.4) out[gene.key] = a[gene.key];
      else if (r < 0.8) out[gene.key] = b[gene.key];
      else {
        const t = rng.next();
        out[gene.key] = a[gene.key] * t + b[gene.key] * (1 - t);
      }
    }
    return out;
  }

  // Weighted root-mean-square difference over non-neutral genes
  // (0 = identical, 1 = opposite). Genes that decide how a creature makes a
  // living weigh more, so a change of niche is enough to split a species.
  function distance(a, b) {
    let sum = 0, n = 0;
    for (const gene of GENES) {
      if (gene.neutral) continue;
      const w = gene.weight || 1;
      const d = (a[gene.key] - b[gene.key]) / (gene.max - gene.min);
      sum += w * d * d;
      n += w;
    }
    return Math.sqrt(sum / n);
  }

  // Turn DNA into body stats. `grow` goes 0 -> 1 from birth to adulthood.
  // Scaling laws are loosely inspired by biology: metabolism ~ mass^0.75
  // (Kleiber's law), strength ~ muscle cross-section ~ mass^0.67.
  function phenotype(g, grow) {
    const s = g.size * (0.4 + 0.6 * grow);
    const mass = s * s * s;
    const adultMass = g.size * g.size * g.size;
    const armorSlow = 1 - 0.35 * g.armor;
    const upkeep = 0.5 + 0.17 * g.speed + 0.1 * g.stamina + 0.15 * g.sense + 0.3 * g.armor + 0.12 * g.camo + 0.15 * g.swim;
    const plantEff = Math.pow(1 - g.diet, 1.4);
    // Reaching tree leaves needs height; small mouths crop short grass best.
    // Young browsers get a head start (think of parents bending branches down),
    // otherwise their calves would starve in the forest.
    const reach = clamp((g.size * (0.75 + 0.25 * grow) - 0.45) / 0.8, 0, 1);
    const grassMouth = 1.1 - 0.25 * clamp((s - 0.5) / 2.5, 0, 1);
    return {
      s,
      mass,
      radius: 2 + 4 * s,
      maxHealth: 30 * Math.pow(mass, 0.8) * (1 + g.armor),
      strength: 11 * Math.pow(mass, 0.67) * (0.25 + 0.75 * g.diet) * (0.6 + 0.6 * g.aggression),
      maxSpeed: (55 * Math.sqrt(g.speed) * armorSlow) / Math.pow(s, 0.3),
      turnRate: 5 / Math.sqrt(s),
      maxStamina: 2 + 5 * g.stamina,
      staminaRegen: 0.3 + 0.5 * g.stamina,
      senseRadius: 40 + 75 * g.sense + 8 * s,
      // Energy storage scales gently with growth so babies aren't starving at birth.
      maxEnergy: 100 * adultMass * (0.3 + 0.7 * grow),
      // + a fixed overhead so being tiny isn't free (organs, brain...)
      basal: 0.9 * (Math.pow(mass, 0.75) + 0.35) * upkeep,
      moveCost: 0.55 * mass,
      // Food units it can swallow per second.
      biteRate: 22 * Math.pow(mass, 0.7),
      // Stomach: holds food until digested. Sized with metabolism so small and
      // big creatures can both keep up; digests a fixed share of it per second.
      stomachCap: 40 * (Math.pow(mass, 0.75) + 0.35),
      digestRate: 0.06,
      plantEff,
      // How much of the 8 surrounding tiles a big body can feed from in place.
      footprint: clamp((s - 0.8) / 1.0, 0, 1),
      // Digestive efficiency per plant food: specializing in one costs the others.
      eat: {
        // A water-adapted body is poor at digesting land plants.
        grass: plantEff * (1 - 0.8 * g.feeding) * grassMouth * (1 - 0.6 * g.swim),
        leaves: plantEff * (0.1 + 0.9 * g.feeding) * reach * (1 - 0.6 * g.swim),
        algae: plantEff * (0.05 + 0.95 * g.swim),
      },
      meatEff: Math.pow(g.diet, 1.1),
    };
  }

  // ---------------------------------------------------------------- species
  const SYL_A = ['gr', 'z', 'k', 'm', 'v', 'th', 'sn', 'b', 'l', 'r', 'dr', 'qu', 'p', 'sh', 'n', 'fl', 't'];
  const SYL_V = ['a', 'o', 'u', 'i', 'e', 'ae', 'oo', 'y', 'ia'];
  const SYL_E = ['x', 'rr', 'n', 'th', 'z', 'k', 'l', 'sk', 'm', 'r', 'd', 's'];

  function speciesName(rng) {
    let n = '';
    const parts = rng.int(2, 3);
    for (let i = 0; i < parts; i++) n += rng.pick(SYL_A) + rng.pick(SYL_V);
    n += rng.pick(SYL_E);
    return n[0].toUpperCase() + n.slice(1);
  }

  class SpeciesRegistry {
    constructor(rng) {
      this.rng = rng;
      this.byId = new Map();
      this.nextId = 1;
    }
    create(genome, parentId, time) {
      const sp = {
        id: this.nextId++,
        name: speciesName(this.rng),
        founder: cloneGenome(genome),
        parentId: parentId || null,
        born: time,
        count: 0,
        peak: 0,
        extinctAt: null,
        avgDiet: genome.diet,
        avgSize: genome.size,
        centroid: cloneGenome(genome), // average DNA of living members
        niche: niche(genome),
      };
      this.byId.set(sp.id, sp);
      return sp;
    }
    // A baby stays in its parent's species unless it has drifted too far from
    // the species' current average DNA, in which case a new species branches
    // off. `sibling` is a species a littermate just founded, which it may join.
    assign(genome, parentSpeciesId, time, sibling) {
      const parent = this.byId.get(parentSpeciesId);
      if (parent && distance(genome, parent.centroid) <= Evo.K.SPECIES_THRESHOLD) return parent;
      if (sibling && distance(genome, sibling.founder) <= Evo.K.SPECIES_THRESHOLD) return sibling;
      return this.create(genome, parentSpeciesId, time);
    }
    get(id) { return this.byId.get(id); }
    living() { return [...this.byId.values()].filter((s) => s.count > 0); }
  }

  // Ecological role, from a genome (or a species' average genome).
  function niche(g) {
    if (g.diet >= 0.66) return 'carnivore';
    if (g.diet >= 0.33) return 'omnivore';
    if (g.swim >= 0.5) return 'swimmer';
    return g.feeding >= 0.5 ? 'browser' : 'grazer';
  }

  Evo.GENES = GENES;
  Evo.niche = niche;
  Evo.GENE_BY_KEY = GENE_BY_KEY;
  Evo.clamp = clamp;
  Evo.Genome = { make: makeGenome, clone: cloneGenome, mutate, crossover, distance, phenotype };
  Evo.SpeciesRegistry = SpeciesRegistry;
})((globalThis.Evo = globalThis.Evo || {}));
