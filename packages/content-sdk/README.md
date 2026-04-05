# @opendungeon/content-sdk

The only package your game needs to install. Provides all types and helpers for building OpenDungeon games.

## Installation

```bash
pnpm add @opendungeon/content-sdk
```

---

## Quick start

```typescript
// src/index.ts
import { defineGameModule, loadSkillsDirSync } from "@opendungeon/content-sdk";
import { dmConfig } from "./content/dm-config.js";
import { availableClasses, getCharacterTemplate } from "./content/classes.js";

export default defineGameModule({
  manifest: {
    name: "@my-org/my-game",
    version: "0.1.0",
    engine: "^1.0.0",
    contentApi: "^2.0.0",
    capabilities: [],
    entry: "dist/index.js",
    stateVersion: 1
  },
  initial: {
    worldState: () => ({})
  },
  characters: {
    availableClasses,
    getTemplate: getCharacterTemplate
  },
  dm: dmConfig,
  mechanics: [],
  skills: loadSkillsDirSync(new URL("../skills", import.meta.url).pathname)
});
```

---

## JSON skills

The fastest way to add gameplay. Drop a `.json` file in your `skills/` directory (at the package root, sibling of `src/`).

### `resolve: "ai"` — DM handles the outcome

```json
{
  "id": "bargain",
  "description": "Negotiate prices or terms with an NPC",
  "resolve": "ai",
  "dmPromptExtension": "## Bargaining\nPlayers can haggle. On success set merchantRelation +1 in worldPatch, on failure -1."
}
```

### `resolve: "deterministic"` — fixed outcome, no LLM call

```json
{
  "id": "rest",
  "description": "Rest at a campfire to recover HP",
  "resolve": "deterministic",
  "validate": {
    "worldStateKey": "campfireActive",
    "failMessage": "You need a campfire to rest."
  },
  "outcome": {
    "message": "You rest by the fire. HP restored.",
    "worldPatch": { "campfireActive": false },
    "characterPatch": { "hp": 100 }
  }
}
```

### Validation operators

```json
{ "worldStateKey": "gold",    "operator": ">=", "value": 50,   "failMessage": "Need 50 gold." }
{ "worldStateKey": "level",   "operator": ">=", "value": 3,    "failMessage": "Need level 3." }
{ "worldStateKey": "bossDefeated", "operator": "==", "value": true, "failMessage": "Defeat the boss first." }
```

All operators: `truthy` (default), `falsy`, `==`, `!=`, `>`, `>=`, `<`, `<=`

### Template interpolation

Both `dmPromptExtension` and `outcome.message` support `{{worldState.*}}` expressions:

```json
"dmPromptExtension": "Current gold: {{worldState.gold}}\nItems: {{worldState.inventory.length}}"
```

### Load skills in your module

```typescript
import { loadSkillsDirSync } from "@opendungeon/content-sdk";

// In defineGameModule:
skills: loadSkillsDirSync(new URL("../skills", import.meta.url).pathname)
```

`loadSkillsDirSync` reads all `*.json` files from the directory. Each file can be a single skill object or an array. Invalid files are skipped with a warning.

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
  worldPatch?: Record<string, unknown>;      // shared — all players see it
  characterPatch?: Record<string, unknown>;  // private — this session only
  suggestedActions?: SuggestedAction[];
  endSession?: SessionEndReason;             // "extraction_success" | "player_death" | ...
}
```

---

## `SkillSchema` reference

```typescript
interface SkillSchema {
  id: string;
  description: string;
  resolve: "ai" | "deterministic";
  dmPromptExtension?: string;        // supports {{worldState.*}}
  paramSchema?: object;              // JSON Schema for DM args
  validate?: {
    worldStateKey: string;           // dot-path: "gold", "player.level"
    operator?: SkillValidationOperator;  // default: "truthy"
    value?: unknown;
    failMessage: string;
  };
  outcome?: {                        // required for resolve: "deterministic"
    message: string;                 // supports {{worldState.*}}
    worldPatch?: Record<string, unknown>;
    characterPatch?: Record<string, unknown>;
    suggestedActions?: SuggestedAction[];
    endSession?: SessionEndReason;
  };
}
```

---

## Exports

| Export | Description |
|--------|-------------|
| `defineGameModule` | Define your game module |
| `defineMechanic` | Define a TypeScript mechanic with full type inference |
| `defineSkill` | Define a typed skill schema object |
| `loadSkillsDirSync` | Load all `*.json` skill files from a directory |
| `loadLoreFilesSync` | Load all `*.md` lore files from a directory |
| `GameModule` | Interface for the game module |
| `Mechanic` | Interface for a TypeScript mechanic |
| `SkillSchema` | Interface for a JSON skill |
| `SettingConfig` | Interface for setting.json configuration |
| `GameModuleSetting` | Interface for the complete setting (config + lore) |
| `ActionResult` | Interface for action results |
| `CharacterTemplate` | Interface for character class templates |
| `DungeonMasterModuleConfig` | Interface for DM configuration |
| `SessionEndReason` | Union type of session end reasons |
