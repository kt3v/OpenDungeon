# Creating a Game

A game in OpenDungeon is a separate package that exports a `GameModule`. Game modules are stored in the `games/` directory at the project root. This directory is ignored by git, allowing you to develop your game without affecting the engine repository.

---

## Quick start

```bash
# Scaffold a new game workspace
pnpm od setup        # and choose "Create a clean project"
# OR manually:
pnpm od create-module games/game-my-adventure --name @my-org/my-game

cd games/game-my-adventure
pnpm install

# Point the engine at your game
# In the engine's .env:
GAME_MODULE_PATH=./games/game-my-adventure

# Run from the project root
pnpm od start
```

---

## File structure

```
games/my-game/             ← Your game workspace
  skills/                  ← JSON skill files — no TypeScript needed
    look.json
    bargain.json
  src/
    index.ts               ← root export: defineGameModule(...)
    content/
      classes.ts           ← character templates
      dm-config.ts         ← DM prompts, guardrails, tool policy
    mechanics/             ← TypeScript mechanics (complex logic)
  manifest.json
  package.json
  tsconfig.json
```

> `skills/` lives at the **package root**, not inside `src/`. This way the same path works from both source (`src/index.ts`) and compiled (`dist/index.js`) entry points — no build step needed for JSON files.

---

## Two ways to add gameplay

### Option A — JSON skills (recommended for most things)

Drop a `.json` file in `skills/`. No imports, no compilation, no restart in dev mode.

**`resolve: "ai"`** — tell the DM this concept exists; the DM handles outcomes narratively:

```json
{
  "id": "bargain",
  "description": "Negotiate prices or terms with an NPC",
  "resolve": "ai",
  "dmPromptExtension": "## Bargaining\nPlayers can haggle with merchants and NPCs.\nOn success set merchantRelation +1 in worldPatch, on failure -1."
}
```

**`resolve: "deterministic"`** — fixed outcome, no LLM call:

```json
{
  "id": "rest",
  "description": "Rest to recover HP",
  "resolve": "deterministic",
  "validate": {
    "worldStateKey": "campfireActive",
    "failMessage": "You need a campfire to rest."
  },
  "outcome": {
    "message": "You rest by the fire and feel restored.",
    "worldPatch": { "campfireActive": false },
    "characterPatch": { "hp": 100 }
  }
}
```

See [Mechanics → Skills](./mechanics.md#skills-json) for the full schema reference.

### Option B — TypeScript mechanics

For complex stateful logic that can't be expressed as a fixed outcome — cross-session persistence, multi-step state machines, intercepting DM output:

```typescript
// src/mechanics/extraction.ts
export const extractionMechanic = defineMechanic({
  id: "extraction",
  hooks: {
    onSessionStart: async () => ({ worldPatch: { sessionLoot: [], nearExit: false } }),
    onActionResolved: async (result, ctx) => { /* collect loot from DM output */ },
    onSessionEnd: async (ctx) => { /* persist loot on extraction_success */ }
  },
  actions: {
    extract: {
      description: "Exit the dungeon and keep your session loot",
      validate: (ctx) => ctx.worldState.nearExit === true || "Reach an exit first.",
      resolve: async () => ({ message: "You escape!", endSession: "extraction_success" })
    }
  }
});
```

See [Mechanics → TypeScript mechanics](./mechanics.md#typescript-mechanics) for the full guide.

---

## `src/index.ts`

The root export wires everything together:

```typescript
import { defineGameModule, loadSkillsDirSync } from "@opendungeon/content-sdk";
import { dmConfig } from "./content/dm-config.js";
import { availableClasses, getCharacterTemplate } from "./content/classes.js";
import { extractionMechanic } from "./mechanics/extraction.js";

export default defineGameModule({
  manifest: {
    name: "@my-org/my-game",
    version: "0.1.0",
    engine: "^1.0.0",
    contentApi: "^2.0.0",
    capabilities: ["extraction.v1"],
    entry: "dist/index.js",
    stateVersion: 1
  },

  initial: {
    worldState: () => ({}) // shared world starts empty; mechanics set their own keys
  },

  characters: {
    availableClasses,
    getTemplate: getCharacterTemplate
  },

  dm: dmConfig,

  // TypeScript mechanics — for stateful, complex logic
  mechanics: [extractionMechanic],

  // JSON skills — auto-loaded from skills/ at the package root
  skills: loadSkillsDirSync(new URL("../skills", import.meta.url).pathname)
});
```

---

## `manifest.json`

```json
{
  "name": "@my-org/my-game",
  "version": "0.1.0",
  "engine": "^1.0.0",
  "contentApi": "^2.0.0",
  "capabilities": ["extraction.v1"],
  "entry": "dist/index.js",
  "stateVersion": 1
}
```

| Field | Description |
|---|---|
| `name` | Unique identifier |
| `version` | Your game's version |
| `engine` | Compatible engine version range |
| `contentApi` | Compatible content-sdk version range |
| `capabilities` | Feature flags (informational, used by clients) |
| `entry` | Compiled entry point, relative to package root |
| `stateVersion` | Increment when your world state schema changes |

---

## `content/dm-config.ts`

Controls how the LLM Dungeon Master behaves:

```typescript
import type { DungeonMasterModuleConfig } from "@opendungeon/content-sdk";

export const dmConfig: DungeonMasterModuleConfig = {
  promptTemplate: {
    lines: [
      "You are the Dungeon Master for {{campaignTitle}}.",
      "Tone: dark fantasy, terse, no mercy.",
      "",
      "Respond with valid JSON only. Required field: message (string).",
      "Optional: toolCalls, worldPatch, summaryPatch, suggestedActions, mechanicCall."
    ]
  },

  toolPolicy: {
    allowedTools: ["update_world_state", "set_summary", "set_suggested_actions"],
    requireSummary: true,
    requireSuggestedActions: true
  },

  guardrails: {
    maxSuggestedActions: 4,
    maxSummaryChars: 220
  },

  defaultSuggestedActions: [
    { id: "look", label: "Look Around", prompt: "look around carefully" }
  ],

  // Dynamic suggestions based on world state
  suggestedActionStrategy: ({ state }) => {
    const actions = [{ id: "look", label: "Look Around", prompt: "look around" }];
    if (state.nearExit) {
      actions.unshift({ id: "skills.extract", label: "Extract", prompt: "exit the dungeon" });
    }
    return actions;
  }
};
```

---

## `content/classes.ts`

```typescript
import type { CharacterTemplate } from "@opendungeon/content-sdk";

export const availableClasses = ["Warrior", "Mage", "Ranger"];

const templates: Record<string, CharacterTemplate> = {
  Warrior: { level: 1, hp: 130, attributes: { strength: 14 } },
  Mage:    { level: 1, hp:  80, attributes: { intellect: 14 } },
  Ranger:  { level: 1, hp: 110, attributes: { agility: 12 } }
};

export const getCharacterTemplate = (className: string): CharacterTemplate =>
  templates[className] ?? { level: 1, hp: 100 };
```

---

## Growing your game over time

After players have been playing, use the Architect to discover what they're trying to do that no mechanic handles:

```bash
od architect analyze --campaign <id> --min-count 3
```

This reads session logs, groups unhandled player intents by pattern, and generates suggested `SkillSchema` JSON files. Review the suggestions, move the ones you like to `skills/`, and they're live on next restart.

---

## Reference

`game-example` in `packages/` is the reference implementation. It shows:
- A complete `defineGameModule` with skills + mechanics
- The extraction mechanic (cross-session loot persistence)
- The location mechanic (per-player position in a shared world)
- DM config with `suggestedActionStrategy`

See [Mechanics](./mechanics.md) for a full guide on both JSON skills and TypeScript mechanics.
