# Evolution Sandbox

A browser game where creatures eat, run, hunt, breed and **evolve**. Nothing is
scripted: each creature carries DNA, babies inherit a mix of their parents' genes
plus mutations, and whatever survives becomes more common. Over time you'll see
herbivores shrink or grow, predators get faster, species split off and go extinct.

## Run it

No build step and no dependencies. Either:

- double-click `index.html`, or
- serve the folder: `python3 -m http.server 8000`, then open <http://localhost:8000>

## Controls

| Action | How |
|---|---|
| Pan | drag the map, or WASD / arrow keys |
| Zoom | mouse wheel |
| Pause / speed | <kbd>Space</kbd>, <kbd>1</kbd>–<kbd>6</kbd> (½× … max) |
| Inspect a creature | Inspect tool (<kbd>I</kbd>), click it. <kbd>F</kbd> follows it, <kbd>Esc</kbd> deselects |
| Drop creatures | Herbivore (<kbd>H</kbd>) / Carnivore (<kbd>C</kbd>) tool, click the map |
| Grow food / smite | <kbd>G</kbd> / <kbd>X</kbd>, click or drag |
| Fit whole map | <kbd>Home</kbd> |

The side panel shows live stats, a history chart (population by diet, or the
average of any gene over time), the selected creature's DNA, the list of living
species (click one to follow a member) and an event log (new species, extinctions).
**World settings** lets you change the map size, water level, wrap-around edges,
starting populations, plant growth, mutation rate, seasons and more.

## How the simulation works

- **Map**: tile-based terrain generated from seamless noise (deep water, shallows,
  beach, plains, grassland, forest, rock, peaks). Each tile has a fertility and a
  plant amount that regrows (logistic growth, faster in summer). With **wrap
  edges** on, the map is a torus: no borders, you can scroll forever.
- **DNA** (`js/genome.js`): size, muscle, stamina, senses, diet (0 = plants,
  1 = meat), aggression, fear, armor, camouflage, herding, litter size, maturity
  age, lifespan, mutation rate (itself evolvable), and a neutral color gene.
- **Body from DNA**: mass = size³. Bigger means more health, strength and fat
  storage, but slower and hungrier. Resting cost scales with mass^0.75 (Kleiber's
  law), movement costs mass × speed². Every "good" gene has an upkeep cost.
- **Brain** (`js/creature.js`): a priority list — flee predators › fight back ›
  court a mate › eat (graze / scavenge / hunt) › rest or wander with the herd.
  Sprinting burns stamina; exhausted creatures can't sprint.
- **Diet** is a trade-off: digesting meat well means digesting plants badly.
  Predators hunt prey they think they can take; dead creatures leave carcasses
  that rot.
- **Reproduction**: mature, well-fed adults find a genetically similar mate
  (crossover + mutation). If none is found for a while they can bud asexually.
  Litter size trades many small babies vs. few well-fed ones.
- **Species**: when a lineage drifts far enough from its species' founder it
  becomes a new named species.
- **Migration** (optional): if all plant-eaters or all meat-eaters die out, a small
  group wanders in after 30 s so the world can recover.

## Files

```
index.html          page layout
css/style.css       styles
js/rng.js           seeded RNG + seamless noise
js/config.js        world settings + simulation constants (tuning knobs)
js/genome.js        genes, mutation, crossover, DNA -> body, species
js/world.js         terrain, plants, carcasses, spatial hash, wrap-around
js/creature.js      creature state + behaviour
js/sim.js           simulation loop, births, deaths, stats, migration
js/renderer.js      canvas drawing + camera
js/chart.js         history chart
js/ui.js            input, panels, game loop
tools/headless.js   run the sim in Node without a browser (for balancing)
```

Balancing tip: `node tools/headless.js 1200 42` runs 20 simulated minutes with
seed 42 and prints population and average genes every 30 s.

See [IDEAS.md](IDEAS.md) for where this could go next.
