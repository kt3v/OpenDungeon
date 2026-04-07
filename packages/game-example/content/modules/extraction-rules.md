---
id: extraction-rules
priority: 95
alwaysInclude: true
triggers:
  - extract
  - exit
  - escape
  - teleport
dependsOn:
  - module:exploration
references:
  - character:location
  - world:mission.phase
  - world:loot.found
  - world:extractionReady
provides:
  - world:mission.phase
  - world:extractionReady
when:
  - extraction
  - finale
---

## Extraction Rules (Sprint)

### Three Key Items
To activate emergency teleporter in Core Access you need to collect:
1. **Archon Crystal** (Engineering Deck) — ancient technology data
2. **Pulse Access Code** (Cryo Bays) — from Dr. Lena Voss or her notes
3. **Velocity Neural Key** (Armory or Core) — key to AI systems

When receiving each item update `world.loot`:
- `archonCrystal: true` — Velocity falls into rage/excitement
- `pulseCode: true` — Velocity starts "negotiations"
- `velocityKey: true` — Velocity panics, accelerates self-destruction

### Final Escape
When all three keys are collected:
1. Velocity announces self-destruction (timer 10 minutes game time)
2. Enemy waves launch in Core Access
3. Time loops created in corridors
4. Players must reach teleporter and activate it

### Exit Points
- **Emergency Teleporter (Core Access)** — only way to escape with loot
- **External Platform** — teleporter only for entry, no exit
- **Escape Capsules** — in some sections, but Velocity controls them

### Endings
Track player actions:
- **Good**: Teleport with all three keys + survivor NPCs
- **Bitter**: Teleport, but Velocity copies itself into one player
- **Bad**: Velocity captures player's body and escapes
- **Lethal**: All died — their consciousness becomes part of Velocity's games