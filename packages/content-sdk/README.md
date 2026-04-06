# @opendungeon/content-sdk

The only package your game needs to install. Provides all types and helpers for building OpenDungeon games.

## Installation

```bash
pnpm add @opendungeon/content-sdk
```

---

## Quick start

Most games are fully declarative — no TypeScript needed. Add a `src/index.ts` only when you need custom mechanics:

```typescript
// src/index.ts — only needed for TypeScript mechanics
import { defineMechanics, defineMechanic } from "@opendungeon/content-sdk";

const startingGearMechanic = defineMechanic({
  id: "starting-gear",
  hooks: {
    onCharacterCreated: async (ctx) => {
      const gear: Record<string, unknown> = {
        Soldier: [{ id: "iron_sword", label: "Iron Sword" }],
        Scholar: [{ id: "codex", label: "Worn Codex" }],
      };
      return {
        characterState: {
          gold: 10,
          inventory: gear[ctx.characterClass] ?? []
        }
      };
    }
  }
});

export default defineMechanics({
  mechanics: [startingGearMechanic]
});
```

All other module data (classes, DM config, setting, resources) is loaded from JSON/Markdown files in the module root.

---

## Setting / World Bible

Define your world's base lore, tone, and constraints. This is injected into every DM system prompt before the base prompt and mechanic extensions.

### Structured configuration (`setting.json`)

```json
{
  "name": "Shadowrealm",
  "description": "A grim fantasy world where magic is rare and dangerous...",
  "era": "Medieval",
  "realismLevel": "hard",
  "tone": "dark and mysterious",
  "themes": ["survival", "exploration", "moral ambiguity"],
  "magicSystem": "Magic is scarce and corrupting...",
  "taboos": [
    "No resurrections or revivals",
    "No modern technology or concepts"
  ],
  "custom": {
    "currency": "Gold crowns and silver marks"
  }
}
```

- `realismLevel`: `"hard"` (gritty), `"soft"` (heroic), `"cinematic"` (larger than life)
- `taboos`: Things the DM should NEVER include in responses
- `custom`: Additional arbitrary key-value pairs

### Markdown lore files (`lore/`)

For detailed world building that doesn't fit in JSON:

```markdown
// lore/factions.md
# Factions and Powers

## The Covenant of Ashes
A loose alliance of city-states...
```

### Loading in your module

```typescript
import { defineGameModule, loadLoreFilesSync } from "@opendungeon/content-sdk";
import settingConfig from "../setting.json" with { type: "json" };

export default defineGameModule({
  // ... other properties
  setting: {
    config: settingConfig,
    loreFiles: loadLoreFilesSync(new URL("../lore", import.meta.url).pathname)
  }
});
```

---

## TypeScript mechanics

For logic that can't be expressed in JSON — cross-session persistence, intercepting DM output, stateful multi-step flows.

```typescript
import { defineMechanic } from "@opendungeon/content-sdk";

export const extractionMechanic = defineMechanic({
  id: "extraction",
  hooks: {
    onSessionStart: async () => ({
      worldPatch: { sessionLoot: [], nearExit: false }
    }),
    onActionResolved: async (result, ctx) => {
      // interpret DM output, update mechanic state
      return result;
    },
    onSessionEnd: async (ctx) => {
      if (ctx.reason !== "extraction_success") return;
      // persist loot to world state
    }
  },
  actions: {
    extract: {
      description: "Exit the dungeon and keep your loot",
      validate: (ctx) => ctx.worldState.nearExit === true || "Reach an exit first.",
      resolve: async (ctx) => ({
        message: "You escape with your loot.",
        endSession: "extraction_success"
      })
    }
  },
  dmPromptExtension: ({ worldState }) => {
    const loot = Array.isArray(worldState.sessionLoot) ? worldState.sessionLoot : [];
    return `## Extraction\n- Set nearExit: true when player reaches an exit.\n- Session loot: ${loot.length} item(s).`;
  }
});
```

### Hooks

| Hook | When it runs |
|------|-------------|
| `onCharacterCreated` | Once, when player joins a campaign |
| `onSessionStart` | Start of each session |
| `onActionSubmitted` | Before every action — can modify or block |
| `onActionResolved` | After every action — can modify result |
| `onSessionEnd` | When session ends |

### `ActionResult`

```typescript
interface ActionResult {
  message: string;
  worldPatch?: Record<string, unknown>;       // shared — all players see it
  characterState?: Record<string, unknown>;   // private — this session only
  suggestedActions?: SuggestedAction[];
  endSession?: SessionEndReason;              // "extraction_success" | "player_death" | ...
}
```

---

## Exports

| Export | Description |
|--------|-------------|
| `defineMechanics` | Export TypeScript mechanics from `src/index.ts` |
| `defineMechanic` | Define a TypeScript mechanic with full type inference |
| `defineResource` | Define a typed resource schema object |
| `loadDeclarativeGameModule` | Load a full declarative game module from a directory |
| `loadContextModulesDirSync` | Load all `*.md` context modules from `modules/` or `contexts/` |
| `loadLoreFilesSync` | Load all `*.md` lore files from a directory |
| `loadClassesFileSync` | Load `classes.json` |
| `loadDmConfigFileSync` | Load `dm-config.json` |
| `loadDmPromptFileSync` | Load `dm.md` |
| `loadInitialStateFileSync` | Load `initial-state.json` |
| `loadResourcesDirSync` | Load all `*.json` resource files from `resources/` |
| `GameModule` | Interface for the game module |
| `TypeScriptModuleExtension` | Interface for TypeScript-only mechanic exports |
| `Mechanic` | Interface for a TypeScript mechanic |
| `ResourceSchema` | Interface for a UI resource indicator |
| `SettingConfig` | Interface for setting.json configuration |
| `ActionResult` | Interface for action results |
| `CharacterTemplate` | Interface for character class templates |
| `DungeonMasterModuleConfig` | Interface for DM configuration |
| `SessionEndReason` | Union type of session end reasons |
