---
id: revival
priority: 75
triggers:
  - revive
  - revival
  - token
  - death
dependsOn:
  - module:extraction-rules
references:
  - world:revival.tokens
  - world:revival.lastUse
provides:
  - world:revival.tokens
  - world:revival.lastUse
when:
  - failure-recovery
  - high-stakes
---

## Revival Tokens
- Revival tokens are limited and should be treated as high-stakes resources.
- When a player uses one, decrement `worldPatch.revival.tokens` and set `worldPatch.revival.lastUse` to a compact reason key.
- If tokens are depleted, frame lethal risk clearly and avoid softening consequences.
