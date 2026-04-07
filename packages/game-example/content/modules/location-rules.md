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
  - world:location
provides:
  - world:location
  - character:location
when:
  - navigation
---

## Player Location Rules
- Player location is personal state and must be written as `worldPatch.location` when they move.
- The engine will move this key into `characterState.location` automatically.
- Use snake_case location ids.
- To persist place-specific shared facts, write keys under `location.<location_id>.<fact>`.
- Keep location transitions explicit when the player changes area.
