# Sprint: Extraction

Sci-fi survival horror module for OpenDungeon. Colony ship Sprint, year 2475. Insane AI Velocity has taken control, destroyed the crew, and opened portals for alien Vyr.

You are an extraction team. Board the ship, find valuable Archon technology data, cryocapsules with survivors, and keys to activate the emergency teleporter. You have 4-6 hours before the ship's self-destruction.

> **New game?** Create a declarative module without TypeScript:
> ```bash
> pnpm od create-module ../my-game
> ```
> See [Creating a game](../../docs/game-dev/creating-a-game.md).

---

## What this module demonstrates

- **Sci-fi survival horror** — claustrophobia, paranoia, insane AI as antagonist
- **Velocity AI** — AI antagonist via intercom: mocks, helps, lies
- **Limited resources** — oxygen, ammo, time running out
- **Environment as threat** — vacuum, plasma leaks, zero gravity
- **TypeScript mechanics** — character location, extraction loot, oxygen
- **Direct TS Loading** — No build step required for mechanics
- **Routed markdown contexts** — modules selected by LLM each turn
- **Machine-precise frontmatter** — `references/dependsOn/provides` for precision

---

## Project Structure

```
packages/game-example/
  manifest.json             # Module metadata (entry: content/mechanics/index.ts)
  content/
    setting.json            # World: 2475, Sprint, Velocity
    dm.md                   # DM prompt (Velocity's voice)
    dm-config.json          # Tool policy, guardrails, router
    initial-state.json      # Initial mission state
    
    lore/                   # Sprint ship lore
      locations.md          # Ship sections, time loops
      factions.md           # Velocity, Vyr, survivors

    modules/                # Context modules for DM
      extraction-rules.md   # Three keys, final escape
      oxygen-system.md      # Oxygen, vacuum
      time-pressure.md      # Mission timer
      ...

    indicators/             # UI indicators
      hp.json               # Health
      oxygen.json           # Oxygen
      ammo.json             # Ammunition
      inventory.json        # Inventory
      location.json         # Current location
      mission_timer.json    # Mission time
      keys_found.json       # Keys collected

    mechanics/
      index.ts              # Mechanics entry point (exports mechanics array)
      logic/
        extraction.ts       # Extraction and loot logic
```

---

## Running Locally

TypeScript mechanics are loaded **directly by the engine**. No compilation or build step is needed for module development.

```bash
# Specify module path (absolute path or relative to engine root)
# .env.local:
GAME_MODULE_PATH=./packages/game-example

# Start the engine
pnpm dev:full
```

Run `pnpm typecheck` in this directory to check types.

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
