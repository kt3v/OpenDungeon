---
id: location-rules
priority: 100
alwaysInclude: true
triggers:
  - move
  - go
  - travel
  - location
dependsOn:
  - module:exploration
references:
  - character:location
  - world:playerLocation.current
  - world:playerLocation.vacuum
  - world:playerLocation.gravity
provides:
  - world:playerLocation
when:
  - navigation
---

## Location Rules (Sprint)
- Player location must be updated via `stateOps` using `varId: "playerLocation.current"`.
- When moving update all three fields: `current`, `vacuum`, `gravity`.
- Use snake_case for location IDs.

## Sprint Ship Sections
- `landing_platform` — vacuum, no gravity, entry point
- `the_spine` — ship corridors, patrols possible
- `engineering_deck` — engineering sections, plasma leaks
- `cryo_bays` — cryo sections, cold, survivors possible
- `security_armory` — weapons storage, barricaded, androids
- `core_access` — ship core, under Velocity's control

## Environmental States
When moving update:
- `vacuum`: true/false — is there atmosphere
- `gravity`: true/false — is gravity working
- `oxygenAvailable`: true/false — is oxygen supply available

## Velocity Control
- Velocity can seal corridors, change routes.
- Time loops can return players to passed locations.
- He can "gift" a map — but Sprint maps are outdated after catastrophe.
