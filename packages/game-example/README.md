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
- **Mechanics-first gameplay actions** — gameplay actions (`extract`, `camp`, `revive`) live in TypeScript mechanics
- **Routed markdown context modules** — DM guidance lives in `modules/*.md` and is selected per action
- **Machine-precise module references** — frontmatter `references/dependsOn/provides` boosts routing precision without TypeScript
- **State/reference integrity defaults** — `initial-state.json` mirrors `world:*` references for safer authoring and validation
- **Setting system** — structured `setting.json` + rich markdown lore in `lore/`
- **Resource indicators** — HP, gold, inventory, location mapped to UI via `indicators/*.json`

---

## Project structure

```
packages/game-example/
  manifest.json             # Module metadata (entry: "dist/index.js")
  setting.json              # World bible (era, tone, themes, taboos)
  dm.md                     # Base DM prompt
  dm-config.json            # DM tool policy + guardrails + context router config
  initial-state.json        # Default world state keys aligned with world:* references
  package.json
  tsconfig.json

  lore/                     # Markdown lore — auto-injected into DM
    locations.md
    factions.md

  modules/                  # Routed Markdown DM context modules
    exploration.md
    location-rules.md
    extraction-rules.md
    sound-awareness.md
    stealth.md
    camping.md
    revival.md

  indicators/               # UI indicators — no TypeScript needed
    hp.json
    gold.json
    inventory.json
    location.json

  src/
    index.ts                # defineMechanics() extension entry point
    mechanics/
      location.ts           # Moves location from worldPatch into characterState (per-player)
      extraction.ts         # Accumulates session loot, surfaces Extract action at exits
```

### Context frontmatter contract

Each `modules/*.md` file in this example uses machine-readable frontmatter fields:

- `dependsOn` (`module:<id>`) for dependency expansion
- `references` (`world:`, `character:`, `module:`, `resource:`) for routing and prompt alignment
- `provides` for expected state updates
- `when` for lightweight routing tags

This is the recommended md+json-first authoring style for new modules.

---

## Why TypeScript mechanics here?

### `location.ts`

The location mechanic intercepts every action result (`onActionResolved`) and moves the `location` key from `worldPatch` (shared) to `characterState` (private). This keeps each player's position hidden from others — a behaviour that requires reading and modifying the DM's output dynamically, which only a TypeScript mechanic can do.

### `extraction.ts`

The extraction mechanic:
1. Resets session state on start (`onSessionStart`): clears `sessionLoot`, `nearExit`
2. Intercepts action results (`onActionResolved`): collects `lootFound` from DM output
3. Surfaces the Extract action only when `nearExit === true`
4. On session end (`onSessionEnd`): transfers `sessionLoot` to `persistedLoot` only on `"extraction_success"`

This cross-session accumulation logic requires reading dynamic state and making conditional decisions — beyond what declarative files can express.

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
