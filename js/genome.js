// DNA: the list of genes, how they mutate/recombine, and how a genome turns
// into a body (the "phenotype"). The trade-offs live in phenotype().
(function (Evo) {
  'use strict';

  const GENES = [
    { key: 'size', label: 'Size', min: 0.5, max: 3, weight: 3, desc: 'Body size. Mass grows with size³: more health, strength and fat storage, but hungrier and slower to accelerate. Top speed peaks at medium size; small bodies are harder to spot.' },
    { key: 'speed', label: 'Muscle', min: 0.2, max: 3, desc: 'Top speed. Costs upkeep, and fast-twitch muscle tires sooner when sprinting.' },
    { key: 'stamina', label: 'Stamina', min: 0.2, max: 3, desc: 'How long it can sprint, and how fast it recovers.' },
    { key: 'sense', label: 'Senses', min: 0.3, max: 3, desc: 'Vision/smell range. Big brains are expensive.' },
    { key: 'diet', label: 'Diet', min: 0, max: 1, weight: 3, desc: '0 = herbivore, 1 = carnivore. Digestion is a trade-off: good at one means bad at the other.' },
    { key: 'feeding', label: 'Browsing', min: 0, max: 1, weight: 3, desc: '0 = grazes low grass, 1 = browses tree leaves. Leaves are only reachable with a big body.' },
    { key: 'swim', label: 'Swimming', min: 0, max: 1, weight: 3, desc: 'Fast in water, eats water plants, crosses deep water above 0.5. Clumsy on land and costs upkeep.' },
    { key: 'appetite', label: 'Appetite', min: 0.2, max: 0.95, desc: 'Energy level (fraction of its reserves) below which it gets hungry and looks for food.' },
    { key: 'aggression', label: 'Aggression', min: 0, max: 1, desc: 'Willingness to attack bigger prey and to fight back. Struggling prey injure their attacker.' },
    { key: 'fear', label: 'Fear', min: 0, max: 1, desc: 'How early it runs away from predators.' },
    { key: 'armor', label: 'Armor', min: 0, max: 1, desc: 'Shell/hide. Reduces damage taken, but is heavy (slower) and costly.' },
    { key: 'camo', label: 'Camouflage', min: 0, max: 1, desc: 'Harder to spot, especially in forests. Small upkeep cost.' },
    { key: 'social', label: 'Herding', min: 0, max: 1, desc: 'Tendency to stay with its own species.' },
    { key: 'litter', label: 'Litter size', min: 1, max: 6, desc: 'Babies per birth. Many small babies vs few well-fed ones.' },
    { key: 'maturity', label: 'Maturity (s)', min: 6, max: 60, desc: 'Time to grow up before it can breed. Slow growers have better-developed babies and sturdier adults.' },
    { key: 'lifespan', label: 'Lifespan (s)', min: 60, max: 400, desc: 'Age at which it starts dying of old age. A body built to last costs more upkeep (repair).' },
    { key: 'mutation', label: 'Mutation rate', min: 0.01, max: 0.4, desc: 'Chance each gene mutates in its offspring. Evolvable!' },
  ];
  const GENE_BY_KEY = {};
  for (const g of GENES) GENE_BY_KEY[g.key] = g;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function makeGenome(base) {
    const g = {};
    for (const gene of GENES) g[gene.key] = base[gene.key] !== undefined ? base[gene.key] : (gene.min + gene.max) / 2;
    g.brain = Evo.Brain.from(base.brain); // neural-network weights (see brain.js)
    return g;
  }

  function cloneGenome(g) {
    const out = Object.assign({}, g);
    out.brain = g.brain ? g.brain.slice() : Evo.Brain.from(null);
    return out;
  }

  // `brainScale` multiplies how often brain weights mutate (the Brain mutation
  // setting); body genes only use `scale`.
  function mutate(g, rng, scale, brainScale = 1) {
    const out = cloneGenome(g);
    const p = clamp(g.mutation * scale, 0, 1);
    for (const gene of GENES) {
      if (rng.chance(p)) {
        const span = gene.max - gene.min;
        // Mostly small steps, occasionally a big jump.
        const step = rng.chance(0.1) ? 0.25 : 0.07;
        out[gene.key] = clamp(out[gene.key] + rng.gauss() * span * step, gene.min, gene.max);
      }
    }
    out.brain = Evo.Brain.mutate(g.brain || Evo.Brain.DEFAULT, rng, p * brainScale);
    return out;
  }

  function crossover(a, b, rng) {
    const out = {};
    for (const gene of GENES) {
      const r = rng.next();
      if (r < 0.4) out[gene.key] = a[gene.key];
      else if (r < 0.8) out[gene.key] = b[gene.key];
      else {
        const t = rng.next();
        out[gene.key] = a[gene.key] * t + b[gene.key] * (1 - t);
      }
    }
    out.brain = Evo.Brain.crossover(a.brain || Evo.Brain.DEFAULT, b.brain || Evo.Brain.DEFAULT, rng);
    return out;
  }

  // Weighted root-mean-square difference over non-neutral genes
  // (0 = identical, 1 = opposite). Genes that decide how a creature makes a
  // living weigh more, so a change of niche is enough to split a species.
  // With `plain` set every gene counts equally (used for mate choice, so a
  // creature drifting toward a new niche isn't shunned by potential mates).
  function distance(a, b, plain) {
    let sum = 0, n = 0;
    for (const gene of GENES) {
      if (gene.neutral) continue;
      const w = plain ? 1 : gene.weight || 1;
      const d = (a[gene.key] - b[gene.key]) / (gene.max - gene.min);
      sum += w * d * d;
      n += w;
    }
    return Math.sqrt(sum / n);
  }

  // Turn DNA into body stats. `grow` goes 0 -> 1 from birth to adulthood.
  // Scaling laws are loosely inspired by biology: metabolism ~ mass^0.75
  // (Kleiber's law), strength ~ muscle cross-section ~ mass^0.67.
  function speedCurve(M) {
    return Math.pow(M, 0.26) * (1 - Math.exp(-1.2 * Math.pow(M, -0.6)));
  }

  // How developed a baby is at birth (0..0.35): slow-maturing species have
  // fewer, better-developed young.
  function birthGrowth(g) {
    return 0.35 * clamp((g.maturity - 6) / 54, 0, 1);
  }

  function phenotype(g, grow) {
    const s = g.size * (0.4 + 0.6 * grow);
    const mass = s * s * s;
    const adultMass = g.size * g.size * g.size;
    const armorSlow = 1 - 0.35 * g.armor;
    // Long life isn't free: a body built to last spends more on repair.
    const repair = 0.2 * clamp((g.lifespan - 60) / 340, 0, 1);
    const upkeep = 0.5 + 0.17 * g.speed + 0.1 * g.stamina + 0.15 * g.sense + 0.3 * g.armor + 0.12 * g.camo + 0.15 * g.swim + repair;
    // Slow-maturing species grow into sturdier adults.
    const matFrac = clamp((g.maturity - 6) / 54, 0, 1);
    // Diet: a straight trade-off, so omnivores are workable stepping stones
    // between plant-eaters and meat-eaters (both directions) without being
    // better than the specialists.
    const plantEff = 1 - g.diet;
    // Reaching tree leaves needs height; small mouths crop short grass best.
    // Young browsers get a head start (think of parents bending branches down),
    // otherwise their calves would starve in the forest.
    const reach = clamp(0.6 + 0.4 * (g.size * (0.75 + 0.25 * grow) - 0.5), 0, 1);
    const grassMouth = 1.1 - 0.25 * clamp((s - 0.5) / 2.5, 0, 1);
    // A water-adapted body is poor at digesting land plants (only when very aquatic).
    const landGut = 1 - 0.6 * g.swim * g.swim;
    return {
      s,
      mass,
      radius: 2 + 4 * s,
      maxHealth: 30 * Math.pow(mass, 0.8) * (1 + g.armor) * (1 + 0.3 * matFrac),
      strength: 11 * Math.pow(mass, 0.67) * (0.25 + 0.75 * g.diet) * (0.6 + 0.6 * g.aggression),
      // Top speed peaks at medium size (Hirt et al. 2017): short legs limit
      // small bodies, and heavy ones can't reach their potential.
      maxSpeed: (55 * Math.sqrt(g.speed) * armorSlow * speedCurve(mass)) / speedCurve(1),
      // Heavy bodies take longer to get up to speed.
      accel: 2 / Math.pow(mass, 0.25),
      turnRate: 5 / Math.sqrt(s),
      maxStamina: 2 + 5 * g.stamina,
      staminaRegen: 0.3 + 0.5 * g.stamina,
      // Fast-twitch muscle burns out quickly: sprinters tire sooner.
      sprintDrain: 0.6 + 0.4 * g.speed,
      // Small bodies are harder to spot.
      visibility: 0.75 + 0.25 * clamp(s, 0, 1),
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
        // Each small step toward a niche pays off: the new food's benefit rises
        // quickly at first, while the loss on the old food only bites once a
        // creature is well specialised. (Otherwise evolution can't cross over.)
        grass: plantEff * (1 - 0.8 * g.feeding * g.feeding) * grassMouth * landGut,
        leaves: plantEff * (0.03 + 0.97 * Math.pow(g.feeding, 0.75)) * reach * landGut,
        // Water plants: useless to a plain land animal (swim ~0.05), but every
        // step toward swimming pays off quickly.
        algae: plantEff * Math.sqrt(clamp((g.swim - 0.05) / 0.95, 0, 1)),
      },
      meatEff: g.diet,
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

  // Each species gets one flat colour; a new species gets a clearly different
  // one. Hues are spread by the golden angle and skip the greens of the map.
  function speciesColor(id, parent) {
    if (id === 1) return 'hsl(50, 90%, 58%)';  // the founding grazers
    if (id === 2) return 'hsl(355, 80%, 56%)'; // the founding predators
    let h = ((id * 137.508) % 360) * (275 / 360); // spread over 275 degrees...
    if (h >= 65) h += 85; // ...skipping 65-150 (the grass and forest greens)
    if (parent) {
      // Keep it well away from the parent's colour so the split is obvious.
      const m = /hsl\((\d+)/.exec(parent.color || '');
      if (m && Math.abs(((h - Number(m[1]) + 540) % 360) - 180) < 40) h = (h + 110) % 360;
      if (h >= 65 && h < 150) h += 85;
    }
    const light = 52 + ((id * 7) % 3) * 8; // vary lightness too: 52 / 60 / 68%
    return `hsl(${Math.round(h % 360)}, 85%, ${light}%)`;
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
        color: null,
      };
      sp.color = speciesColor(sp.id, parentId ? this.byId.get(parentId) : null);
      this.byId.set(sp.id, sp);
      return sp;
    }
    // A baby stays in its parent's species unless it has drifted too far from
    // the species' current average DNA, in which case a new species branches
    // off. `sibling` is a species a littermate just founded, which it may join.
    // A baby that has clearly moved into a different niche (grazer -> browser,
    // land -> water, plants -> meat...) also founds a new species.
    assign(genome, parentSpeciesId, time, sibling) {
      const fits = (sp, ref) => {
        if (distance(genome, ref) > Evo.K.SPECIES_THRESHOLD) return false;
        const clear = clearNiche(genome);
        return !clear || clear === sp.niche;
      };
      const parent = this.byId.get(parentSpeciesId);
      if (parent && fits(parent, parent.centroid)) return parent;
      if (sibling && fits(sibling, sibling.founder)) return sibling;
      return this.create(genome, parentSpeciesId, time);
    }
    get(id) { return this.byId.get(id); }
    living() { return [...this.byId.values()].filter((s) => s.count > 0); }
  }

  // The niche only when a genome is safely past the boundaries (margin 0.07),
  // so creatures sitting on a boundary don't flip species back and forth.
  function clearNiche(g) {
    const m = 0.07;
    const near = (v, edge) => Math.abs(v - edge) < m;
    if (near(g.diet, 0.33) || near(g.diet, 0.66)) return null;
    if (g.diet < 0.33 && (near(g.swim, 0.5) || (g.swim < 0.5 && near(g.feeding, 0.5)))) return null;
    return niche(g);
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
  Evo.speciesColor = speciesColor;
  Evo.Genome = { make: makeGenome, clone: cloneGenome, mutate, crossover, distance, phenotype, birthGrowth };
  Evo.SpeciesRegistry = SpeciesRegistry;
})((globalThis.Evo = globalThis.Evo || {}));
