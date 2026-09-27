// World settings. Everything here is editable from the "World settings" panel.
(function (Evo) {
  'use strict';

  Evo.CONFIG_SCHEMA = [
    { key: 'seed', label: 'Seed (0 = random)', type: 'int', min: 0, max: 999999999, def: 0 },
    { key: 'worldWidth', label: 'Width (tiles)', type: 'int', min: 40, max: 600, def: 160 },
    { key: 'worldHeight', label: 'Height (tiles)', type: 'int', min: 30, max: 400, def: 100 },
    { key: 'wrap', label: 'Wrap edges (no borders)', type: 'bool', def: true },
    { key: 'waterLevel', label: 'Water level', type: 'float', min: 0, max: 0.7, step: 0.02, def: 0.3 },
    { key: 'initialHerbivores', label: 'Starting herbivores', type: 'int', min: 0, max: 2000, def: 140 },
    { key: 'initialCarnivores', label: 'Starting carnivores', type: 'int', min: 0, max: 500, def: 16 },
    { key: 'plantGrowth', label: 'Plant growth ×', type: 'float', min: 0.1, max: 5, step: 0.1, def: 1 },
    { key: 'mutationScale', label: 'Mutation ×', type: 'float', min: 0, max: 5, step: 0.1, def: 1 },
    { key: 'seasonStrength', label: 'Season strength', type: 'float', min: 0, max: 0.9, step: 0.05, def: 0.3 },
    { key: 'seasonLength', label: 'Year length (s)', type: 'int', min: 30, max: 2000, def: 240 },
    { key: 'maxPopulation', label: 'Population cap (big = slower)', type: 'int', min: 50, max: 20000, def: 1500 },
    { key: 'neuralBrains', label: 'Evolving brains (off = fixed rules)', type: 'bool', def: true },
    { key: 'migration', label: 'Migrants replace extinct groups', type: 'bool', def: true },
    { key: 'allowAsexual', label: 'Allow asexual fallback', type: 'bool', def: true },
  ];

  Evo.defaultConfig = function () {
    const c = {};
    for (const f of Evo.CONFIG_SCHEMA) c[f.key] = f.def;
    return c;
  };

  // Simulation constants (not exposed in the UI, but easy to tweak here).
  Evo.K = {
    TILE: 16,              // world units per tile
    DT: 1 / 30,            // fixed simulation step (seconds)
    PLANT_MAX: 5,          // plant energy on a fully fertile tile
    PLANT_REGROW: 0.08,    // plant energy/sec per tile at fertility 1
    // Calories per unit of food eaten. Meat is dense; plants are bulky, so
    // plant-eaters must fill their stomach far more often.
    CAL: { grass: 1, leaves: 0.8, algae: 1.1, meat: 4 },
    MEAT_PER_MASS: 18,     // units of meat in a carcass per unit of body mass
    CORPSE_DECAY: 0.025,   // fraction of a corpse that rots per second
    SPECIES_THRESHOLD: 0.17, // genetic distance that founds a new species
    MATE_THRESHOLD: 0.12,  // max genetic distance for two creatures to mate
    PREDATOR_DIET: 0.35,   // diet value above which a creature can hunt
  };
})((globalThis.Evo = globalThis.Evo || {}));
