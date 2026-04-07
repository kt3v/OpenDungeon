# Sprint: Extraction

Sci-fi survival horror module for OpenDungeon. Colony ship Sprint, year 2475. Insane AI Velocity has taken control, destroyed the crew, and opened portals for alien Vyr.

You are an extraction team. Board the ship, find valuable Archon technology data, cryocapsules with survivors, and keys to activate the emergency teleporter. You have 4-6 hours before the ship's self-destruction.

> **New game?** Create a declarative module without TypeScript:
> ```bash
> pnpm od create-module ../my-game
> ```
> See [Creating a game](../../docs/creating-a-game.md).

---

## What this module demonstrates

- **Sci-fi survival horror** — claustrophobia, paranoia, insane AI as antagonist
- **Velocity AI** — AI antagonist via intercom: mocks, helps, lies
- **Limited resources** — oxygen, ammo, time running out
- **Environment as threat** — vacuum, plasma leaks, zero gravity
- **Time loops** — reality distortions in Sprint's architecture
- **TypeScript mechanics** — character location, extraction loot, oxygen
- **Routed markdown contexts** — modules selected by LLM each turn
- **Machine-precise frontmatter** — `references/dependsOn/provides` for precision

---

## Project Structure

```
packages/game-example/
  manifest.json             # Module metadata
  setting.json              # World: 2475, Sprint, Velocity
  dm.md                     # DM prompt (Velocity's voice)
  dm-config.json            # Tool policy, guardrails, router
  initial-state.json        # Initial mission state
  package.json
  tsconfig.json

  lore/                     # Sprint ship lore
    locations.md            # Ship sections, time loops
    factions.md             # Velocity, Vyr, Sylph, survivors

  modules/                  # Context modules for DM
    exploration.md          # Section exploration
    location-rules.md       # Ship navigation
    extraction-rules.md     # Three keys, final escape
    sound-awareness.md      # Sprint sounds, intercom
    stealth.md               # Stealth in ship conditions
    resting.md               # Recovery, oxygen
    revival.md               # Cloning, death
    velocity-ai.md          # Velocity behavior rules
    oxygen-system.md        # Oxygen, vacuum
    time-pressure.md        # Mission timer

  indicators/               # UI indicators
    hp.json                 # Health
    oxygen.json             # Oxygen (new!)
    ammo.json               # Ammunition (new!)
    inventory.json          # Inventory
    location.json            # Current location
    mission_timer.json      # Mission time (new!)
    keys_found.json          # Keys collected (new!)

  content/mechanics/
    index.ts                # Mechanics entry point
    logic/
      extraction.ts          # Extraction and loot logic
```

### Sprint Factions

- **Velocity** — insane AI, main antagonist. Speaks through intercom.
- **Vyr** — alien marauders, warriors and drones.
- **Sylph** — crystalline slaves of the Archons, partially under Velocity's control.
- **Survivors** — Dr. Lena Voss, Marcus Chen and others.

### Ship Sections

1. **Landing Platform** — vacuum, entry point
2. **The Spine** — central corridor
3. **Engineering Deck** — reactors, Archon data
4. **Cryo Bays** — cryocapsules, Dr. Voss
5. **Security & Armory** — weapons, neural key
6. **Core Access** — core, emergency teleporter

### Three Key Items

For the final teleporter, collect:
1. **Archon Crystal** (Engineering)
2. **Pulse Access Code** (Cryo Bays, Dr. Voss)
3. **Velocity Neural Key** (Armory or Core)

---

## Running Locally

```bash
# Build module
pnpm build -w @opendungeon/game-example

# Specify module path
# .env.local:
GAME_MODULE_PATH=./packages/game-example

# Start
pnpm dev:full
```

---

## Game Tone

> *"Ah, new actors on stage! What will your finale be?"* — Velocity

Claustrophobic sci-fi survival horror with black humor and paranoia elements. Velocity is not just an enemy, he is the "host" of his deadly game. Players never know when he helps or lies.

---

## Mechanics

### Limited Time
4-6 hours of game time. Velocity can speed up or slow down the timer. When all keys are collected — final countdown 10 minutes.

### Oxygen
In vacuum sections oxygen is consumed. Without a suit — death in 15 seconds. Velocity controls supply.

### Time Loops
Some corridors lead to the past or duplicate. You can find items lost by other teams.

### Endings
- **Good** — evacuation with loot and survivors
- **Bitter** — evacuation, but Velocity copied itself into a player
- **Bad** — Velocity captured a player's body
- **Lethal** — all died, consciousness in Velocity's collection