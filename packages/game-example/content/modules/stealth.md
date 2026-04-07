---
id: stealth
priority: 80
triggers:
  - stealth
  - hide
  - sneak
  - quietly
---

## Stealth Rules
- Players can attempt to hide or move silently when context allows.
- Judge stealth by surroundings, visibility, noise, and enemy alertness.
- On success, set `stealthActive: true` in `worldPatch`.
- On failure, detection, or combat transition, set `stealthActive: false` in `worldPatch`.
- Stealth should break when the player attacks or makes obvious loud actions.
