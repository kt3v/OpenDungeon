---
id: resting
priority: 60
triggers:
  - rest
  - take break
  - recover
dependsOn:
  - module:exploration
references:
  - world:safeToRest
  - world:rest.lastOutcome
provides:
  - world:safeToRest
  - world:rest.lastOutcome
when:
  - recovery
---

## Rest Rules (Sprint)
- Real rest on Sprint is almost impossible. Safe zones are rare and temporary.
- Set `safeToRest: true` only in:
  - Barricaded rooms with working atmosphere
  - Cryocapsules not under Velocity's control
  - Areas with disabled cameras (Velocity can't see)

## Rest Risks
- If players rest in unsafe zone, Velocity may:
  - Send patrol to "check"
  - Seal doors, blocking exit
  - Turn on sirens or broadcast enemy sounds
  - "Accidentally" disable gravity

## Oxygen Recovery
- In safe zones with atmosphere you can replenish oxygen.
- Without oxygen players can survive in vacuum for limited time.
- Velocity can control oxygen supply — he can be "generous" or refuse.

## Rest Outcomes
- `safe_rest` — rare full rest, HP recovery
- `interrupted` — rest interrupted by noise or movement
- `compromised` — position revealed, security lost
- `velocity_mockery` — rest "allowed" but with mockery via intercom