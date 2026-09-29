# Ideas & roadmap

A brainstorm of features, roughly ordered from "small and fun" to "big project".
Inspirations: *The Bibites*, *Species: Artificial Life, Real Evolution*,
carykh's *evolv.io*, Primer's evolution videos, *Equilinox*, Spore's creature stage.

## Already in v1

- Configurable map size, water level, and wrap-around edges (a torus, so no borders)
- 20 evolvable genes; mutation rate is itself a gene
- One colour per species; a new species gets a new colour
- Size/mass trade-offs based on real scaling laws (Kleiber's law, strength ~ mass^0.67)
- Herbivores, omnivores and carnivores on one diet slider, with a digestion trade-off
- Fleeing, hunting, fighting back, scavenging, herding, resting, stamina and sprinting
- Sexual reproduction with crossover, and asexual budding as a fallback
- Speciation with generated names, extinction tracking, and an event log
- Reproductive isolation (mates must look alike and be genetically close)
- Three plant foods (grass, tree leaves, water plants), so herbivores can split into grazers, browsers and swimmers
- Calories per food (meat is dense, plants are bulky), a stomach that digests over time, and an evolvable Appetite (hunger threshold)
- Seasons, carcasses that rot, camouflage that works best in forests
- God tools: drop creatures, grow food, smite, clone a creature
- Day/night cycle and a Nocturnal gene: night eyes, sleep, and night-active species that dodge day-hunting predators
- Random events: droughts, ice ages, meteor strikes, plagues and invading species (automatic or on demand)
- Hall of fame: all-time records for creatures and species, click a living holder to follow it
- Save/load: autosave to the browser, continue on reload, export/import as a file
- Evolving neural-network brains: DNA-encoded networks score the possible actions; founders start with the classic rules and behaviour evolves from there
- Cannibalism is a hard-to-evolve gene: nobody eats their own species' carcasses until it passes 0.7
- Temperature (latitude, altitude, seasons, Climate setting) with snow and a heat map, and a Fur gene
- Counterweights between genes: speed peaks at medium size, heavy bodies accelerate slowly, small bodies hide better, sprinters tire, prey fight back, long life costs upkeep, slow growth gives stronger young

## Next: small additions

- **Heatmap overlays**: where creatures die, where predators hunt, plant density.

## Medium: richer biology

- **Pack hunting and kin recognition**: recognise relatives
  and hunt together.
- **Sexual selection**: an "ornament" gene and a "pickiness" gene. Flashy creatures
  attract mates but are easier for predators to spot.
- **Plant evolution**: several plant types (grass, berries, toxic shrubs). Herbivores
  evolve toxin resistance and plants evolve stronger toxins, an arms race.
- **Disease and parasites** that spread in dense herds, which pays off for loners and immune genes.
- **Memory and scent**: remember good feeding spots; predators follow scent trails.
- **Eggs vs live birth, parental care**: parents that guard their babies.
- **Phylogenetic tree view**: the full family tree of species over time.

## Big: the endless map

The current wrap mode feels endless, but the world is still finite. A truly
infinite world could work like this:

1. **Chunks**: split the world into chunks (for example 64×64 tiles). The terrain
   is already built from seeded noise, so any chunk can be regenerated from
   `(seed, chunkX, chunkY)` on demand, with no storage needed for untouched land.
2. **Active region**: fully simulate only the chunks near the camera or near
   creatures. Chunks with no creatures can be frozen, remembering only their
   plant levels and the time they were last updated.
3. **Catch-up**: when a frozen chunk wakes up, regrow its plants in one step using
   the time that has passed.
4. **Sparse storage**: keep plants and carcasses per chunk in a `Map` keyed by
   `"cx,cy"`, and unload chunks nobody has visited in a while.
5. **Coordinates**: keep float precision safe by storing positions as
   (chunk, local offset), or by re-centering the origin now and then.

## Performance, if populations need to reach 10k+

- Move the simulation to a **Web Worker** so the UI never stutters.
- Store creatures in typed arrays (struct-of-arrays) instead of objects.
- Render with **WebGL** (or PixiJS) instead of Canvas 2D.
