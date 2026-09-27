# Ideas & roadmap

A brainstorm of features, roughly ordered from "small and fun" to "big project".
Inspirations: *The Bibites*, *Species: Artificial Life, Real Evolution*,
carykh's *evolv.io*, Primer's evolution videos, *Equilinox*, Spore's creature stage.

## Already in v1

- Configurable map size, water level, and wrap-around edges (a torus, so no borders)
- 16 evolvable genes plus a neutral color gene; mutation rate is itself a gene
- Size/mass trade-offs based on real scaling laws (Kleiber's law, strength ~ mass^0.67)
- Herbivores, omnivores and carnivores on one diet slider, with a digestion trade-off
- Fleeing, hunting, fighting back, scavenging, herding, resting, stamina and sprinting
- Sexual reproduction with crossover, and asexual budding as a fallback
- Speciation with generated names, extinction tracking, and an event log
- Reproductive isolation (mates must look alike and be genetically close)
- Three plant foods (grass, tree leaves, water plants), so herbivores can split into grazers, browsers and swimmers
- Seasons, carcasses that rot, camouflage that works best in forests
- God tools: drop creatures, grow food, smite, clone a creature

## Next: small additions

- **Save/load**: export the world as JSON (or save to localStorage) so a run can go on for days.
- **Hall of fame**: oldest creature, most kills, most children, longest-lived species.
- **Heatmap overlays**: where creatures die, where predators hunt, plant density.
- **Random events**: drought, ice age, meteor strike, plague, an invasive species arrives.
- **Day/night cycle** plus a `nocturnal` gene: night hunters see better in the dark.
- **Temperature**: colder toward the poles and on mountains, plus a `fur` gene (costly in the heat, vital in the cold). This drives species apart geographically.

## Medium: richer biology

- **Evolving brains**: replace the hand-written priority list with a small neural
  network whose weights live in the DNA (this is how The Bibites and evolv.io work).
  Behaviour itself evolves, and it's a lot more surprising.
- **Pack hunting and kin recognition**: use the color gene to recognise relatives
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
