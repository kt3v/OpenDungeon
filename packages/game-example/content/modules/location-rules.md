---
id: location-rules
priority: 100
alwaysInclude: true
triggers:
  - move
  - go
  - travel
  - location
---

## Player Location Rules
- Player location is personal state and must be written as `worldPatch.location` when they move.
- The engine will move this key into `characterPatch.location` automatically.
- Use snake_case location ids.
- To persist place-specific shared facts, write keys under `location.<location_id>.<fact>`.
- Keep location transitions explicit when the player changes area.
