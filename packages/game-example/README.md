# @opendungeon/game-classic

The classic RPG module for the OpenDungeon engine, providing a baseline fantasy experience.

## Features

- **Classes**: Warrior, Mage, Ranger — each with unique starting stats
- **Locations**: Dungeons, forests, and villages with per-player positioning
- **Mechanics**: Exploration skills, loot extraction, roguelite session end
- **Setting**: Complete world bible with factions, locations, and lore

## Project Structure

```
├── setting.json          # World bible (era, tone, themes, taboos)
├── lore/                 # Markdown lore files
│   ├── locations.md      # Notable places in the world
│   └── factions.md       # Organizations and powers
├── skills/               # Declarative JSON skills
│   ├── look.json         # Observe surroundings
│   ├── listen.json       # Listen for sounds
│   ├── inspect.json      # Examine objects
│   ├── stealth.json      # Hide and move silently
│   ├── camp.json         # Rest at campfire
│   └── revive.json       # Use revival token
├── src/
│   ├── index.ts          # Game module entry point
│   ├── content/
│   │   ├── classes.ts    # Character class definitions
│   │   └── dm-config.ts  # DM prompts and guardrails
│   └── mechanics/
│       ├── location.ts   # Per-player positioning
│       └── extraction.ts # Loot accumulation + session end
└── package.json
```

## Setting / World Bible

The module demonstrates the two-layer setting system:

### Layer 1: Structured Config (`setting.json`)

```json
{
  "name": "OpenDungeon Classic",
  "description": "A grounded fantasy world...",
  "era": "Medieval",
  "realismLevel": "soft",
  "tone": "grounded fantasy — sensory, concise",
  "themes": ["exploration", "survival", "heroism"],
  "magicSystem": "Magic exists but is uncommon and dangerous...",
  "taboos": [
    "No modern technology or concepts",
    "No resurrection or easy revival",
    "No teleportation"
  ]
}
```

### Layer 2: Markdown Lore (`lore/`)

- **locations.md** — The Shattered Spires, Mournwood, Sunken Citadel
- **factions.md** — The Covenant of Ashes, Unseen College, Wardens of the Wood

### How It Works

The setting is loaded in `src/index.ts`:

```typescript
import { loadLoreFilesSync } from "@opendungeon/content-sdk";
import settingConfig from "../setting.json" with { type: "json" };

export default defineGameModule({
  // ...
  setting: {
    config: settingConfig,
    loreFiles: loadLoreFilesSync(new URL("../lore", import.meta.url).pathname)
  }
});
```

This content is automatically injected into every DM system prompt before the base prompt and mechanic extensions.

## Installation

```bash
npm install @opendungeon/game-classic
```

## Usage

In your OpenDungeon instance, set the game module path:

```bash
# .env.local
GAME_MODULE_PATH=/path/to/game-classic
```

Then start the engine normally with `pnpm od start`.
