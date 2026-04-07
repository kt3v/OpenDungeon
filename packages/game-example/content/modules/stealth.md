---
id: stealth
priority: 80
triggers:
  - stealth
  - hide
  - sneak
  - quietly
dependsOn:
  - module:sound-awareness
references:
  - world:stealthActive
  - world:lastSound
provides:
  - world:stealthActive
when:
  - infiltration
  - exploration
---

## Stealth Rules (Sprint)
- Players can try to hide or move quietly in suitable conditions.
- Evaluate stealth by environment: lighting (red emergency light vs darkness), noise (plasma pipes, enemy footsteps), zero gravity.
- In zero gravity movement is quieter but harder to control direction.
- On success set `stealthActive: true` in `worldPatch`.
- On failure, detection, or entering combat set `stealthActive: false`.
- Stealth is interrupted by attacking, shooting, or loud actions.
- Velocity can detect players through cameras — but sometimes he "closes his eyes" for entertainment.

## Vyr Awareness
- Vyr Warriors rely on hearing and smell
- Vyr Drones have thermal vision — stealth less effective
- Sylph sense vibrations — movement in zero gravity harder to detect