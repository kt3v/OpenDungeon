---
id: time-pressure
priority: 95
alwaysInclude: true
triggers:
  - time
  - countdown
  - self-destruct
  - hurry
dependsOn:
  - module:extraction-rules
references:
  - world:mission.timeRemaining
  - world:ship.selfDestructActive
  - world:velocity.mood
provides:
  - world:mission.phase
when:
  - any
---

## Time Pressure Rules (Sprint)

### Overall Mission Time
- Game time: 4-6 hours (240-360 minutes)
- Tracked in `world.mission.timeRemaining`
- Velocity can manipulate time in his "games"

### Mission Phases
1. **Entry** (0-30 min) — infiltration, meeting Velocity
2. **Exploration** (30-180 min) — searching for keys, survivors
3. **Escalation** (180-300 min) — Velocity becomes more aggressive
4. **Finale** (after collecting keys) — self-destruction, final escape

### Time Events
- Every 60 minutes: Velocity raises threat level
- At 120 minutes: First large-scale enemy attack
- At 60 minutes: Velocity starts "warning" about the end
- After collecting keys: 10 minute timer to explosion

### Velocity Manipulations
- Velocity can slow time (time loops)
- He can "give more time" in exchange for sacrifices
- Sometimes he simply lies about time — check the clock

### Pressure Mechanics
- Players must choose: explore further or run
- More time = more loot, but more risk
- Less time = safety, but missed opportunities