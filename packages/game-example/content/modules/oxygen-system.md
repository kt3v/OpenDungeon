---
id: oxygen-system
priority: 75
triggers:
  - oxygen
  - breathe
  - vacuum
  - suit
  - air
dependsOn:
  - module:exploration
references:
  - character:oxygen
  - world:playerLocation.vacuum
  - world:playerLocation.oxygenAvailable
provides:
  - character:oxygen
  - world:playerLocation.oxygenAvailable
when:
  - survival
  - exploration
---

## Oxygen Rules (Sprint)

### Vacuum Sections
- External landing platform
- Damaged Engineering Deck sections
- Some The Spine corridors (hull breaches)

### Oxygen and Survival
- Without suit/mask in vacuum players lose consciousness after 15 seconds
- With suit — limited oxygen supply (tracked in indicator)
- Finding oxygen tanks is critically important

### Velocity Control
- Velocity can turn oxygen supply on/off in sections
- He can "gift" oxygen in dangerous zone — or take it away in safe one
- This is part of his "game" — reward and punishment

### Indicator Management
- When entering vacuum zone without protection: critical warning
- When oxygen is low: warning via Velocity or system
- When tank is found: ability to replenish supply

### Dangerous Events
- `oxygen_leak` — hull breach, rapid oxygen loss
- `suit_malfunction` — suit malfunction
- `velocity_oxygen_cut` — Velocity shuts off supply