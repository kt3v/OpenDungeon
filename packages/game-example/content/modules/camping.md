---
id: camping
priority: 60
triggers:
  - camp
  - rest
  - campfire
dependsOn:
  - module:exploration
references:
  - world:safeToRest
  - world:camp.lastOutcome
provides:
  - world:safeToRest
  - world:camp.lastOutcome
when:
  - survival
  - recovery
---

## Camping Guidance
- Camping is only valid in safe areas.
- Mark `safeToRest: true` in `worldPatch` when the player reaches a defensible rest spot.
- Track recent camp resolution in `worldPatch.camp.lastOutcome` using compact values like `safe_rest`, `disturbed`, `forced_move`.
- Keep rest opportunities scarce in dangerous zones to preserve tension.
- If a camp is disturbed, clear `safeToRest` and narrate the threat.
