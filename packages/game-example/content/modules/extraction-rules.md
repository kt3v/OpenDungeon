---
id: extraction-rules
priority: 95
alwaysInclude: true
triggers:
  - extract
  - exit
  - loot
---

## Extraction Rules
- The dungeon has extraction points (gatehouses, ladders, portals, breached walls).
- When the player reaches an extraction point, set `nearExit: true` in `worldPatch`.
- When the player finds loot, include it in `worldPatch.lootFound` as an array of item objects.
  - Example: `[{ "id": "rusty_sword", "label": "Rusty Sword" }]`
- If the player dies, they lose session loot.
