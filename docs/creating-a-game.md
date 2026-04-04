# Creating a Game

A game in OpenDungeon is a separate package that implements the `GameModule` interface from `@opendungeon/content-sdk`. The engine loads it at startup and runs it — your game never needs to touch the engine internals.

---

## Quick start

### 1. Scaffold a new game workspace

```bash
# From the engine root
pnpm create:game-module -- ../my-game

# Or interactive mode
pnpm create:game-module
```

This generates a starter project at the target path.

### 2. Install dependencies

```bash
cd ../my-game
pnpm install
```

### 3. Point the engine at your game

In the engine's `.env.local`:

```env
GAME_MODULE_PATH=../my-game
```

### 4. Run

```bash
# From the engine root
pnpm start
```

The engine validates your `GameModule` at startup and fails fast with a clear error if the shape is wrong.

---

## File structure

A minimal game looks like this:

```
my-game/
  src/
    index.ts               ← root export (defineGameModule)
    content/
      classes.ts           ← character templates
      dm-config.ts         ← DM prompts, guardrails, tool policy
    mechanics/
      my-mechanic.ts       ← gameplay systems
  manifest.json
  package.json
  tsconfig.json
```

---

## manifest.json

Every game must have a manifest:

```json
{
  "name": "@my-org/my-game",
  "version": "0.1.0",
  "engine": "^1.0.0",
  "contentApi": "^2.0.0",
  "capabilities": ["map.v1", "inventory.v1"],
  "entry": "dist/index.js",
  "stateVersion": 1
}
```

| Field | Description |
|---|---|
| `name` | Unique identifier for your game |
| `version` | Your game's version |
| `engine` | Compatible engine version range |
| `contentApi` | Compatible content-sdk version range |
| `capabilities` | Feature flags your game supports (informational) |
| `entry` | Built entry point, relative to the package root |
| `stateVersion` | Increment when your world state schema changes |

---

## package.json

```json
{
  "name": "@my-org/my-game",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@opendungeon/content-sdk": "^2.0.0"
  }
}
```

If developing alongside the engine repo, use a local path reference:

```json
"@opendungeon/content-sdk": "file:../opendungeon/packages/content-sdk"
```

---

## Implementing GameModule

`src/index.ts` is the root export. Use `defineGameModule()` for full TypeScript type checking:

```typescript
import { defineGameModule } from "@opendungeon/content-sdk";
import { dmConfig } from "./content/dm-config.js";
import { availableClasses, getCharacterTemplate } from "./content/classes.js";
import { combatMechanic } from "./mechanics/combat.js";
import { extractionMechanic } from "./mechanics/extraction.js";

import manifest from "../manifest.json" assert { type: "json" };

export default defineGameModule({
  manifest,

  initial: {
    // World state for a brand-new campaign
    worldState: () => ({
      location: "dungeon_entrance",
      floor: 1,
      sessionLoot: [],
      nearExit: false
    })
  },

  characters: {
    availableClasses: ["Warrior", "Mage", "Ranger"],
    getTemplate: getCharacterTemplate
  },

  dm: dmConfig,

  // Mechanics are evaluated in order
  mechanics: [combatMechanic, extractionMechanic]
});
```

---

## DM config (`content/dm-config.ts`)

The DM config controls how the LLM behaves for your game:

```typescript
import type { DungeonMasterModuleConfig } from "@opendungeon/content-sdk";

export const dmConfig: DungeonMasterModuleConfig = {
  // Use a template for dynamic values (e.g. campaignTitle)
  promptTemplate: {
    lines: [
      "You are the Dungeon Master for {{campaignTitle}}.",
      "Tone: dark fantasy, terse, no mercy.",
      "",
      "Output: valid JSON only.",
      "Required: message (string).",
      "Optional: toolCalls, worldPatch, summaryPatch, suggestedActions."
    ]
  },

  // Or use a static string
  // systemPrompt: "You are the Dungeon Master...",

  toolPolicy: {
    allowedTools: ["update_world_state", "set_summary", "set_suggested_actions"],
    requireSummary: true,
    requireSuggestedActions: true
  },

  guardrails: {
    maxSuggestedActions: 4,
    maxSummaryChars: 220,
    maxWorldPatchKeys: 20
  },

  // Fallback actions when DM provides none
  defaultSuggestedActions: [
    { id: "look", label: "Look Around", prompt: "look around" },
    { id: "advance", label: "Advance", prompt: "move forward" }
  ],

  // Dynamic suggested actions based on world state
  suggestedActionStrategy: ({ state }) => {
    const actions = [
      { id: "advance", label: "Advance", prompt: "move forward" }
    ];
    if (state.nearExit) {
      actions.unshift({ id: "extraction.extract", label: "Extract", prompt: "exit the dungeon" });
    }
    return actions.slice(0, 4);
  }
};
```

### DM tool calls

The LLM can invoke three tools in its response:

| Tool | Purpose | Key args |
|---|---|---|
| `update_world_state` | Patch the world state | `patch: Record<string, unknown>` |
| `set_summary` | Update the session summary | `shortSummary: string`, `latestBeat?: string` |
| `set_suggested_actions` | Set the next suggested actions | `actions: SuggestedAction[]` |

The engine applies guardrails to all tool call output before touching state.

---

## Character classes (`content/classes.ts`)

```typescript
import type { CharacterTemplate } from "@opendungeon/content-sdk";

export const availableClasses = ["Warrior", "Mage", "Ranger"];

const templates: Record<string, CharacterTemplate> = {
  Warrior: { level: 1, hp: 130, attributes: { strength: 14, agility: 8 } },
  Mage:    { level: 1, hp:  80, attributes: { strength:  7, intellect: 14 } },
  Ranger:  { level: 1, hp: 110, attributes: { agility: 12, strength: 10 } }
};

const fallback: CharacterTemplate = {
  level: 1, hp: 100, attributes: { strength: 10, agility: 10 }
};

export const getCharacterTemplate = (className: string): CharacterTemplate =>
  templates[className] ?? fallback;
```

---

## Keeping engine and game in sync

Since your game is a separate repo, you can update the engine independently:

```bash
# In the engine repo
git pull

# Bump content-sdk version if the interface changed
# In your game's package.json, update the version and reinstall
npm install
```

The engine validates your `manifest.json` at startup against `moduleManifestSchema`. If the `contentApi` version is incompatible, it fails with a clear message.

---

## Reference implementation

`packages/game-classic` in this repo is the reference game. Study it to understand:
- How to structure content files
- How to write mechanics (exploration, extraction)
- How the DM config interacts with mechanics via `dmPromptExtension`

See [mechanics.md](./mechanics.md) for a full guide on writing mechanics.
