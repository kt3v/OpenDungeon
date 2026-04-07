---
id: sound-awareness
priority: 70
triggers:
  - listen
  - hear
  - noise
  - sound
---

## Sound Awareness
- When the player listens, describe ambient and directional sounds appropriate to the current area.
- If a sound can influence decisions, persist it via `worldPatch.lastSound` as a short snake_case key.
  - Example values: `"footsteps_beyond_door"`, `"dripping_water"`, `"distant_chain_rattle"`.
- Prefer actionable audio clues over vague atmosphere.
