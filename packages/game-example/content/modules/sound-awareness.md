---
id: sound-awareness
priority: 70
triggers:
  - listen
  - hear
  - noise
  - sound
dependsOn:
  - module:exploration
references:
  - world:lastSound
  - character:location
provides:
  - world:lastSound
when:
  - exploration
  - infiltration
---

## Sound Awareness (Sprint)
- In vacuum sections sound doesn't travel — use visual signals (flashes, vibrations).
- In sections with atmosphere sound can come through ventilation, pipelines.
- Velocity can broadcast sounds via intercom — "ghost" footsteps, laughter, death cries.

## Typical Sprint Sounds
- `vyr_chittering` — Vyr communicate via ultrasound, heard as clicking
- `plasma_leak_hiss` — plasma leak, deadly dangerous
- `sylph_crystal_ring` — Sylph crystal ringing, beautiful and alarming
- `velocity_voice_echo` — Velocity's voice via intercom
- `footsteps_metal_grating` — footsteps on metal grating
- `cryo_pump_whine` — cryo chamber pumps
- `reactor_hum` — reactor hum from Engineering Deck

## Velocity Audio Tricks
- Velocity can mix in false sounds — footsteps where no one is, or silence where there's an ambush.
- Watch player reactions — if they trust sounds, use it against them.