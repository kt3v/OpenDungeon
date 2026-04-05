# @opendungeon/game-classic

The reference implementation for OpenDungeon. This module demonstrates **TypeScript mode** — the full-power approach for games that need complex stateful mechanics.

> **Starting a new game?** Use the declarative scaffold instead — no TypeScript required:
> ```bash
> pnpm od create-module ../my-game
> ```
> See [Creating a Game](../../docs/creating-a-game.md).

---

## What this module demonstrates

- **Per-player location** — each character has a private location in a shared world (`location.ts`)
- **Roguelite extraction** — session loot accumulates, only persists if you escape (`extraction.ts`)
- **Cross-session state** — loot survives across sessions when the player extracts successfully
- **TypeScript + JSON coexistence** — complex mechanics in `.ts`, simple rules in `skills/*.json`
- **Setting system** — structured `setting.json` + rich markdown lore in `lore/`
- **Resource indicators** — HP, gold, inventory, location mapped to UI via `resources/*.json`

---

## Project structure

```
packages/game-example/
  manifest.json             # Module metadata (entry: "dist/index.js")
  setting.json              # World bible (era, tone, themes, taboos)
  package.json
  tsconfig.json

  lore/                     # Markdown lore — auto-injected into DM
    locations.md
    factions.md

  skills/                   # JSON skills — no TypeScript needed
    look.json               # resolve: "ai" — DM describes surroundings
    listen.json             # resolve: "ai" — DM describes sounds
    inspect.json            # resolve: "ai" — DM examines objects
    stealth.json            # resolve: "ai" — stealth rules and context
    camp.json               # resolve: "deterministic" — rest action
    revive.json             # resolve: "deterministic" — revival token use

  resources/                # UI indicators — no TypeScript needed
    hp.json
    gold.json
    inventory.json
    location.json

  src/
    index.ts                # defineGameModule() entry point
    content/
      classes.ts            # Warrior, Mage, Ranger — starting stats
      dm-config.ts          # DM prompt, tool policy, guardrails
    mechanics/
      location.ts           # Hooks location from worldPatch into characterPatch (per-player)
      extraction.ts         # Accumulates session loot, surfaces Extract action at exits
```

---

## Why TypeScript mechanics here?

### `location.ts`

The location mechanic intercepts every action result (`onActionResolved`) and moves the `location` key from `worldPatch` (shared) to `characterPatch` (private). This keeps each player's position hidden from others — a behaviour that can't be expressed in a JSON hook because it requires reading and modifying the DM's output dynamically.

### `extraction.ts`

The extraction mechanic:
1. Resets session state on start (`onSessionStart`): clears `sessionLoot`, `nearExit`
2. Intercepts action results (`onActionResolved`): collects `lootFound` from DM output
3. Surfaces the Extract action only when `nearExit === true`
4. On session end (`onSessionEnd`): transfers `sessionLoot` to `persistedLoot` only on `"extraction_success"`

This cross-session accumulation logic requires reading dynamic state and making conditional decisions — beyond what a static JSON hook can express.

---

## Setting / World Bible

### `setting.json` (structured config)

```json
{
  "name": "OpenDungeon Classic",
  "era": "Medieval",
  "realismLevel": "soft",
  "tone": "grounded fantasy — sensory, concise",
  "themes": ["exploration", "survival", "heroism"],
  "taboos": ["No modern technology", "No resurrection", "No teleportation"]
}
```

### `lore/` (markdown)

- **`locations.md`** — The Shattered Spires, Mournwood, Sunken Citadel
- **`factions.md`** — The Covenant of Ashes, Unseen College, Wardens of the Wood

Both layers are automatically injected into every DM system prompt.

---

## Running locally

```bash
# Build the module
pnpm build -w @opendungeon/game-example

# Point the engine at it
# .env.local:
GAME_MODULE_PATH=./packages/game-example

# Start
pnpm dev:full
```
