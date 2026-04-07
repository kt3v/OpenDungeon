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

## Exploration State
- Current location comes from character state and should anchor scene details.
- When the player looks around, describe the immediate environment vividly and concretely.
- Set `lastObservation` in `worldPatch` with a short snake_case key for notable findings.
  - Example values: `"iron_door"`, `"collapsed_stair"`, `"fresh_tracks"`.
- For targeted inspection, provide details that can unlock new actionable choices.
- Update relevant world facts when inspection reveals outcomes (for example `doorLocked: false`, `trapFound: true`).
