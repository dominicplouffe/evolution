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
| Save / continue later | **💾 Save** in the side panel (autosaves every minute and when you leave). Reopening the page continues your world. **Export**/**Import** save it as a `.json` file |
| Fit whole map | <kbd>0</kbd> (or <kbd>Home</kbd>), or the **Fit map** button |

The side panel shows live stats, a history chart (population by diet, or the
average of any gene over time), the selected creature's DNA, the list of living
species (click one to follow a member), a **Hall of fame** (oldest creature, most
children, most kills, deepest generation, biggest, fastest, farthest travelled,
longest-lasting and biggest species; click a living record holder to follow it)
and an event log (new species, extinctions, new record holders).
**World settings** lets you change the map size, water level, wrap-around edges,
starting populations, plant growth, mutation rate, seasons and more.

## How the simulation works

- **Map**: tile-based terrain generated from seamless noise (deep water, shallows,
  beach, plains, grassland, forest, rock, peaks). Each tile has a fertility and a
  plant food that regrows (faster in summer). With **wrap
  edges** on, the map is a torus: no borders, you can scroll forever.
- **Temperature**: each tile's temperature depends on latitude (warm in the
  middle band of the map, cold toward the top and bottom edges, continuous
  across wrap-around) and altitude (mountains are colder), plus the seasons
  (about ±12 °C) and the **Climate** setting. Plants grow slower in the cold and
  stop in hard frost. Snow shows on frozen ground; **Heat map** shows
  temperature directly, and the corner shows the temperature under the cursor.
- **DNA** (`js/genome.js`): size, muscle, stamina, senses, diet (0 = plants,
  1 = meat), browsing (grass vs. tree leaves), swimming, fur, appetite, cannibalism, aggression, fear, armor,
  camouflage, herding, litter size, maturity age, lifespan, mutation rate (itself
  evolvable).
- **Plant food & niches**: tiles grow three foods: grass (open land), tree leaves
  (forests) and water plants (shallows and deep water). Small grazers crop grass
  best; leaves need the Browsing gene *and* a big body to reach; swimmers feed in
  water and can cross deep water (swimming ≥ 0.5). Big bodies also feed from the
  surrounding tiles. Swimmers digest land plants poorly, are clumsy and dry out
  on land, so they stay in (and flee into) the water. Specializing costs
  efficiency on the other foods, so plant
  eaters can split into grazer, browser and swimmer species that coexist.
- **Calories & digestion**: each food has a calorie value per bite (meat 4,
  water plants 1.1, grass 1, tree leaves 0.8). Food fills a stomach (sized with
  metabolism) and is digested into energy over time. A creature only looks for
  food when its energy drops below its **Appetite** gene and stops when full, so
  predators gorge on a kill and then rest for a long time while plant-eaters
  graze most of the day.
- **Body from DNA**: mass = size³. Bigger means more health, strength and fat
  storage, but hungrier. Resting cost scales with mass^0.75 (Kleiber's law),
  movement costs mass × speed². Every "good" gene has an upkeep cost.
- **Fur**: sets the temperature a creature is comfortable at (about 26 °C with no
  fur, -12 °C with thick fur; big bodies hold heat better). More than 8 °C off
  costs extra energy, and extremes hurt (deaths show as "cold" / "heat").
  Uncomfortable creatures move to a better spot when idle. Fur has a small
  upkeep cost, so warm-climate animals lose it.
- **Trade-offs between genes**: top speed peaks at medium size (Hirt et al. 2017)
  and heavy bodies accelerate slowly; small bodies are harder to spot; more
  Muscle drains stamina faster when sprinting; struggling prey injure their
  attacker; a longer Lifespan costs upkeep; a longer Maturity gives
  better-developed babies and sturdier adults. Tree leaves need a specialised
  (high Browsing) gut.
- **Evolving brains** (`js/brain.js`): every creature carries a small neural
  network in its DNA (17 senses → 6 hidden neurons → 10 action scores, plus
  direct connections). Senses include hunger, energy, health, stamina, stomach,
  danger, being attacked (and whether it can win), a mate nearby, the best
  plants / carrion / prey around, herd size and being out of its habitat. The
  creature does the best-scoring action that's possible right now: flee, fight
  back, court, eat here, go to plants, scavenge, hunt, go home, rest or wander.
  Founders are wired to reproduce the original rules (flee › fight back › court ›
  food › home › rest/wander); babies inherit whole neurons from either parent,
  and mutations make behaviour drift. The inspector shows each creature's
  scores. **World settings → Evolving brains** turns it off (everyone uses the
  founder rules) for comparison, and **Brain mutation ×** sets how fast brains
  change (1 = default; higher = faster, more surprising behaviour but more
  badly-wired babies; 0 = brains no longer mutate). Sprinting burns stamina; exhausted creatures
  can't sprint.
- **Diet** is a trade-off: digesting meat well means digesting plants badly.
  Predators hunt prey they think they can take (never their own species); dead
  creatures leave carcasses that rot.
- **Cannibalism**: carcasses remember their species, and a creature can't eat
  its own species' dead unless its **Cannibalism** gene is above 0.7 (fully at
  1). It starts at 0, gives no benefit below the threshold, and has a small
  upkeep cost (disease risk), so evolution pushes it back down; only a lineage
  under real pressure to eat its own dead is likely to get there.
- **Reproduction**: mature, well-fed adults find a genetically similar mate
  (crossover + mutation). If none is found for a while they can bud asexually.
  Litter size trades many small babies vs. few well-fed ones.
- **Species**: a baby founds a new named species when its DNA drifts far from its
  species' current average (niche genes: diet, browsing, swimming and size weigh
  more), or when it has clearly moved into another niche (grazer → browser,
  land → water, plants → meat). Every species has one colour, and a new species
  gets a clearly different one. Mates must be genetically close (all genes
  weighed equally, so a creature drifting toward a new niche can still find
  mates), so once groups diverge they stop interbreeding and stay separate. Predators compete for prey
  and herds spot danger earlier ("many eyes"), which keeps predator booms from
  wiping out every herbivore type.
- **Migration** (optional): if all plant-eaters or all meat-eaters die out, a small
  group wanders in after 30 s so the world can recover.

## Files

```
index.html          page layout
js/version.js       version label shown in the corner (bump on every change)
css/style.css       styles
js/rng.js           seeded RNG + seamless noise
js/config.js        world settings + simulation constants (tuning knobs)
js/brain.js         evolving neural-network brains (weights live in the DNA)
js/genome.js        genes, mutation, crossover, DNA -> body, species
js/world.js         terrain, plants, carcasses, spatial hash, wrap-around
js/creature.js      creature state + behaviour
js/sim.js           simulation loop, births, deaths, stats, migration
js/fame.js          Hall of fame records
js/save.js          save/load: browser storage (gzipped) and .json files
js/renderer.js      canvas drawing + camera
js/chart.js         history chart
js/ui.js            input, panels, game loop
tools/headless.js   run the sim in Node without a browser (for balancing)
```

Balancing tip: `node tools/headless.js 1200 42` runs 20 simulated minutes with
seed 42 and prints population and average genes every 30 s.

See [IDEAS.md](IDEAS.md) for where this could go next.
