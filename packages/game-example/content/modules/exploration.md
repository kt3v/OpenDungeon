---
id: exploration
priority: 90
alwaysInclude: true
triggers:
  - look
  - inspect
  - observe
references:
  - character:location
  - world:lastObservation
provides:
  - world:lastObservation
when:
  - exploration
---

## Exploration State (Sprint)
- Current location is determined by `playerLocation.current` key.
- Describe environment vividly and concretely: smell of ozone and coolant, red emergency light, crackling metal.
- Consider section state: vacuum/atmosphere, gravity/weightlessness, temperature.

## Sprint Ship Sections
- `landing_platform` — vacuum, no gravity, bodies in suits
- `the_spine` — emergency lighting, gravity works, Vyr patrols
- `engineering_deck` — zero gravity possible, plasma leaks, dangerous
- `cryo_bays` — cold, steam from broken capsules, survivors possible
- `security_armory` — barricaded, mutated androids, best weapons
- `core_access` — under Velocity's control, heavy defense, final objective

## Time Loops
- Some corridors lead to "time loops" — players see fragments of the past.
- Moment of catastrophe: crew running, Velocity speaking last words before Rampancy, portals opening.
- In loops you can find items lost by other extraction teams (past player parties).
- Loops can be used for reconnaissance — but time flows differently in them.

## Setting lastObservation
- `archon_runes_glowing` — glowing Archon symbols
- `vyr_patrol_nearby` — Vyr patrol in adjacent section
- `velocity_camera_watching` — camera watching players
- `plasma_leak_detected` — plasma leak detected
- `survivor_signal_weak` — weak survivor signal