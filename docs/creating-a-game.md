# Creating a Game

A game in OpenDungeon is a **game module** — a directory of files that tells the engine what world to run, how characters work, and what rules the DM follows. You point the engine at your module via `GAME_MODULE_PATH`, and it does the rest.

There are two ways to build a game module. Start with the default (declarative).

---

## Modes at a glance

| | Declarative (default) | TypeScript |
|---|---|---|
| Files | JSON + Markdown | TypeScript + JSON + Markdown |
| Build step | None | `pnpm build` |
| Entry in manifest | `"declarative"` | `"dist/index.js"` |
| Best for | Most games | Complex stateful mechanics |
| Escape hatch | Add `src/` + switch to TypeScript mode | — |

---

## Quick start (declarative)

```bash
# Scaffold a new module — declarative by default
pnpm od create-module ../my-game --name @me/my-game

# Point the engine at it
# .env.local:
GAME_MODULE_PATH=../my-game

# Start
pnpm dev:full
\`\`\`

No `pnpm install`, no compilation. Edit files, restart engine.

---

## Declarative module structure

```
my-game/
  manifest.json         ← module identity, sets entry: "declarative"
  setting.json          ← world config: era, tone, themes, taboos
  classes.json          ← character classes and starting stats
  dm.md                 ← DM system prompt (plain Markdown)
  dm-config.json        ← guardrails, tool policy, default actions
  initial-state.json    ← starting worldState for new campaigns
  lore/                 ← markdown world-building (auto-injected into DM)
    factions.md
    locations.md
  skills/               ← gameplay rules as JSON (no code needed)
    bargain.json
    rest.json
  resources/            ← UI indicators (HP bar, gold counter, etc.)
    hp.json
    gold.json
  hooks/                ← mechanic hooks as JSON (initial state, session reset)
    starting-gear.json
  rules/                ← declarative effects fired after every action
    hp-drain.json
```

Every file is optional except `manifest.json`. The engine falls back gracefully when a file is missing.

---

## File reference

### `manifest.json`

```json
{
  "name": "@me/my-game",
  "version": "0.1.0",
  "engine": "^1.0.0",
  "contentApi": "^1.0.0",
  "capabilities": [],
  "entry": "declarative",
  "stateVersion": 1
}
```

`entry: "declarative"` tells the engine to load all game content from files in this directory rather than importing a TypeScript entry point.

---

### `setting.json` — world config

Defines the baseline world injected into every DM prompt before any other instructions:

```json
{
  "name": "Ashenfell",
  "description": "A dying empire where magic is forbidden and survival is everything.",
  "era": "Medieval",
  "realismLevel": "hard",
  "tone": "grim and tense",
  "themes": ["survival", "betrayal", "the cost of power"],
  "magicSystem": "Magic exists but is outlawed. Users are hunted by the Inquisition.",
  "taboos": [
    "No resurrections — death is permanent",
    "No modern technology or concepts",
    "No comic relief or whimsy"
  ],
  "custom": {
    "currency": "Iron marks and copper bits",
    "calendar": "The empire counts years from the Founding"
  }
}
```

| Field | Type | Notes |
|-------|------|-------|
| `name` | `string` | World name |
| `description` | `string` | Brief overview shown in the prompt |
| `era` | `string` | Historical period (Medieval, Victorian, Cyberpunk…) |
| `realismLevel` | `"hard" \| "soft" \| "cinematic"` | Gritty / heroic / larger-than-life |
| `tone` | `string` | Narrative mood |
| `themes` | `string[]` | Core story themes |
| `magicSystem` | `string` | How magic works (omit if no magic) |
| `taboos` | `string[]` | Things the DM should **never** do |
| `custom` | `Record<string, string>` | Any extra key-value pairs |

---

### `lore/*.md` — markdown world-building

Drop `.md` files into `lore/`. Each is loaded and injected into the DM system prompt automatically. Write as much or as little as you like.

```markdown
<!-- lore/factions.md -->
# Factions

## The Inquisition
The empire's secret police. They hunt magic users...

## The Ember Brotherhood
An underground resistance. They believe magic is humanity's birthright...
```

---

### `classes.json` — character classes

```json
{
  "classes": [
    {
      "name": "Soldier",
      "level": 1,
      "hp": 130,
      "attributes": { "strength": 14, "agility": 8, "intellect": 6 }
    },
    {
      "name": "Scholar",
      "level": 1,
      "hp": 80,
      "attributes": { "strength": 6, "agility": 8, "intellect": 14 }
    },
    {
      "name": "Scout",
      "level": 1,
      "hp": 100,
      "attributes": { "strength": 8, "agility": 14, "intellect": 8 },
      "isDefault": true
    }
  ]
}
```

`isDefault: true` marks the fallback class for unknown class names. If none is marked, the first class is the fallback.

---

### `dm.md` — DM system prompt

The entire file becomes the DM's system prompt. Write it in Markdown:

```markdown
You are the Dungeon Master for {{campaignTitle}}.

## Output format
Return valid JSON. Required field: `message` (player-facing narration, 1–4 sentences).
Optional: `toolCalls`, `worldPatch`, `summaryPatch`, `suggestedActions`.

## Rules
- Keep the tone grim and terse. No jokes.
- Prefer small, targeted worldPatch updates.
- Suggested actions must be concrete and immediately playable.
- Never reveal hidden state or internal planning.
- This is a shared world: multiple players exist in the same campaign.
  Do NOT mention other players unless the current player explicitly encounters them.
```

`{{campaignTitle}}` is replaced with the actual campaign title at runtime.

---

### `dm-config.json` — DM guardrails

Controls how the DM responds: which tools it can use, output limits, default action buttons:

```json
{
  "toolPolicy": {
    "allowedTools": ["update_world_state", "set_summary", "set_suggested_actions"],
    "requireSummary": true,
    "requireSuggestedActions": true
  },
  "guardrails": {
    "maxSuggestedActions": 4,
    "maxSummaryChars": 220,
    "maxWorldPatchKeys": 20
  },
  "defaultSuggestedActions": [
    { "id": "look", "label": "Look Around", "prompt": "look around carefully" },
    { "id": "listen", "label": "Listen", "prompt": "listen for sounds" },
    { "id": "advance", "label": "Advance", "prompt": "move cautiously forward" }
  ]
}
```

All fields are optional. The engine uses sensible defaults when `dm-config.json` is absent.

> Note: `suggestedActionStrategy` (a dynamic TypeScript function for computed action buttons) is not supported in JSON. If you need it, use TypeScript mode instead.

---

### `initial-state.json` — starting world state

The initial `worldState` for brand-new campaigns. Flat key-value JSON:

```json
{
  "act": 1,
  "fortressBreached": false
}
```

Per-character state (gold, inventory, location) is set in `hooks/`.

---

### `skills/*.json` — gameplay rules

The most powerful declarative feature. Drop a `.json` file in `skills/` — the engine picks it up on next restart.

**`resolve: "ai"` — teach the DM a concept:**

```json
{
  "id": "bargain",
  "description": "Negotiate with an NPC over price or terms",
  "resolve": "ai",
  "dmPromptExtension": "## Bargaining\nPlayers can haggle with merchants. Success depends on charisma and context.\nOn success: set `merchantRelation` +1 in worldPatch. On failure: -1."
}
```

The DM sees this skill in its tool list and knows the rules. No fixed outcome — the DM writes the result narratively.

**`resolve: "deterministic"` — fixed outcome, no LLM call:**

```json
{
  "id": "rest",
  "description": "Rest at a campfire to recover",
  "resolve": "deterministic",
  "validate": {
    "worldStateKey": "campfireActive",
    "failMessage": "You need an active campfire to rest."
  },
  "outcome": {
    "message": "You rest by the fire. The warmth slowly restores you.",
    "worldPatch": { "campfireActive": false },
    "characterPatch": { "hp": 100 }
  }
}
```

**Validation operators:**

```json
{ "worldStateKey": "gold",             "operator": ">=", "value": 50,   "failMessage": "Need 50 gold." }
{ "worldStateKey": "inventory.length", "operator": ">",  "value": 0,    "failMessage": "Empty-handed." }
{ "worldStateKey": "bossDefeated",     "operator": "==", "value": true, "failMessage": "Defeat the boss first." }
```

Supported: `truthy` (default), `falsy`, `==`, `!=`, `>`, `>=`, `<`, `<=`

**Template interpolation in messages and `dmPromptExtension`:**

```json
"dmPromptExtension": "Player gold: {{worldState.gold}}. Inventory: {{worldState.inventory.length}} items."
```

Unknown paths resolve to empty string — the DM prompt stays clean.

See [Mechanics → Skills](./mechanics.md#skills-json) for the full schema reference.

---

### `resources/*.json` — UI indicators

Map world/character state to visible indicators in the game UI:

```json
{
  "id": "hp",
  "label": "HP",
  "source": "character",
  "stateKey": "hp",
  "type": "number"
}
```

```json
{
  "id": "gold",
  "label": "Gold",
  "source": "characterState",
  "stateKey": "gold",
  "type": "number",
  "defaultValue": 0
}
```

| `source` | Reads from | Use for |
|----------|-----------|---------|
| `"character"` | Session character info | `hp`, `level`, `name`, `className` |
| `"characterState"` | Session-local state | gold, inventory, personal flags |
| `"worldState"` | Shared campaign state | faction reputation, boss HP |

Types: `"number"`, `"text"`, `"list"`, `"boolean"`

See [Resource Indicators](./resource-indicators.md) for full reference.

---

### `hooks/*.json` — declarative mechanic hooks

The most common mechanic pattern — setting initial state when a character joins or a session starts — expressed as JSON:

**Give starting gear by class (`hooks/starting-gear.json`):**

```json
{
  "id": "starting-gear",
  "hook": "onCharacterCreated",
  "characterPatch": { "gold": 10, "inventory": [] },
  "classBranches": {
    "Soldier": {
      "characterPatch": {
        "gold": 5,
        "inventory": [{ "id": "iron_sword", "label": "Iron Sword" }]
      }
    },
    "Scholar": {
      "characterPatch": {
        "gold": 15,
        "inventory": [{ "id": "codex", "label": "Worn Codex" }]
      }
    }
  }
}
```

The engine reads `character.className`, picks the matching branch, and merges the patches. If no branch matches, it falls back to the root `characterPatch`.

**Reset session state on each run (`hooks/session-reset.json`):**

```json
{
  "id": "session-reset",
  "hook": "onSessionStart",
  "characterPatch": { "sessionLoot": [], "nearExit": false }
}
```

**React to session end (`hooks/extraction-cleanup.json`):**

```json
{
  "id": "extraction-cleanup",
  "hook": "onSessionEnd",
  "reason": "extraction_success",
  "worldPatch": { "totalExtractions": null }
}
```

`reason` is optional — omit to fire on any session end.

**Supported hooks in JSON:** `onCharacterCreated`, `onSessionStart`, `onSessionEnd`

For `onActionSubmitted`, `onActionResolved`, and complex stateful logic → use a TypeScript mechanic or `rules/*.json` (see below).

---

### `rules/*.json` — declarative effects after every action

Rules fire on `onActionResolved` and apply state mutations when an optional condition is met. They cover the most common "every-turn mechanic" patterns without TypeScript.

**Targets** — prefix determines which state store is written to:
- `"characterState.<key>"` → session-local character state (private)
- `"worldState.<key>"` → shared campaign state

**Condition** — optional guard that reads from merged worldState (characterState is merged in):

```json
{ "key": "characterState.poisoned", "operator": "==", "value": true }
{ "key": "characterState.hp",       "operator": "<=", "value": 0    }
{ "key": "worldState.bossDefeated", "operator": "==", "value": true }
```

**Examples:**

```json
// rules/hp-drain.json — lose 1 HP every action
{
  "id": "hp-drain",
  "trigger": "onActionResolved",
  "effects": [
    { "op": "decrement", "target": "characterState.hp", "amount": 1, "min": 0 }
  ]
}
```

```json
// rules/death-check.json — end session when HP hits 0
{
  "id": "death-check",
  "trigger": "onActionResolved",
  "condition": { "key": "characterState.hp", "operator": "<=", "value": 0 },
  "effects": [
    { "op": "endSession", "reason": "player_death" }
  ]
}
```

```json
// rules/poison-tick.json — poison deals 3 damage per turn
{
  "id": "poison-tick",
  "trigger": "onActionResolved",
  "condition": { "key": "characterState.poisoned", "operator": "==", "value": true },
  "effects": [
    { "op": "decrement", "target": "characterState.hp", "amount": 3, "min": 0 }
  ]
}
```

**Available ops:**

| op | What it does |
|----|-------------|
| `increment` | Add `amount` to a number. Optional `max` clamp. |
| `decrement` | Subtract `amount` from a number. Optional `min` clamp (default 0). |
| `set` | Set a key to a fixed value. |
| `append` | Append a value to an array (creates array if absent). |
| `remove` | Remove from array: by `id` (object match) or `value` (strict equality). |
| `endSession` | End the session with the given `reason`. |

Rules run **after** all other mechanics on every action. Multiple rules can fire per turn.

For conditional logic that reads DM output dynamically, or effects that depend on the previous turn's computed result → use a TypeScript mechanic.

---

## Let the Architect generate your content

Once your `setting.json` exists, you can ask the Architect to generate the rest:

```bash
pnpm od architect scaffold --module ../my-game --type all
```

The Architect reads your setting, then generates `classes.json`, `dm.md`, `dm-config.json`, `initial-state.json`, and starter `hooks/`. Review the output, adjust, and you're playing.

To migrate existing TypeScript files:

```bash
pnpm od architect scaffold --module ../my-game --migrate
# Reads src/content/classes.ts → generates classes.json
# Reads src/content/dm-config.ts → generates dm.md + dm-config.json
```

---

## Grow your game over time

### Discover missing skills

After players have been playing, the Architect can find patterns in what they tried to do that no mechanic handled:

```bash
pnpm od architect analyze --campaign <id> --min-count 3
```

This reads session logs, groups unhandled player intents, and generates suggested `skills/*.json` files. Review them, drop the ones you like into `skills/`, restart.

### Validate your files

```bash
pnpm od validate-module ../my-game
```

Checks all JSON files against their schemas and reports every error at once.

---

## TypeScript mode (advanced)

For mechanics that require real code — cross-session loot accumulation, intercepting DM output, complex conditional logic — use TypeScript mode.

\`\`\`bash
pnpm od create-module ../my-game --typescript
# Generates src/index.ts, src/content/classes.ts, src/content/dm-config.ts
# Requires pnpm install && pnpm build before running
\`\`\`

In TypeScript mode you write `src/index.ts` that calls `defineGameModule({...})`, and the manifest `entry` points to `"dist/index.js"`.

You can also **mix both modes**: keep TypeScript for mechanics that need code, and use the new declarative loaders for everything else:

```typescript
// src/index.ts — hybrid module
import {
  defineGameModule,
  loadSkillsDirSync,
  loadResourcesDirSync,
  loadClassesFileSync,       // replaces classes.ts
  loadDmConfigFileSync,      // replaces dm-config.ts
  loadInitialStateFileSync,  // replaces worldState: () => ({...})
  loadHooksDirSync,
  hookSchemasToMechanics
} from "@opendungeon/content-sdk";
import { extractionMechanic } from "./mechanics/extraction.js"; // TypeScript for complex logic

const classData  = loadClassesFileSync(new URL("../classes.json", import.meta.url).pathname);
const dmConfig   = loadDmConfigFileSync(new URL("../dm-config.json", import.meta.url).pathname) ?? {};
const initState  = loadInitialStateFileSync(new URL("../initial-state.json", import.meta.url).pathname) ?? {};
const hookSchemas = loadHooksDirSync(new URL("../hooks", import.meta.url).pathname);

export default defineGameModule({
  manifest,
  initial: { worldState: () => ({ ...initState }) },
  characters: {
    availableClasses: classData?.classes.map(c => c.name) ?? ["Adventurer"],
    getTemplate: (cls) => classData?.classes.find(c => c.name === cls) ?? classData?.fallback ?? { level: 1, hp: 100 }
  },
  dm: dmConfig,
  mechanics: [...hookSchemasToMechanics(hookSchemas), extractionMechanic],
  skills: loadSkillsDirSync(new URL("../skills", import.meta.url).pathname),
  resources: loadResourcesDirSync(new URL("../resources", import.meta.url).pathname)
});
```

In a hybrid module, `setting.json` and `lore/*.md` are still loaded automatically by the engine from the module root. Only `classes.json`, `dm.md`, `dm-config.json`, `initial-state.json`, and `hooks/*.json` need the explicit loaders.

See [Mechanics](./mechanics.md) for a full guide on TypeScript mechanics.

---

## Reference implementation

`packages/game-example` is a full TypeScript game module with complex mechanics (per-player location, cross-session loot extraction). It shows what's possible with TypeScript mode, and demonstrates how declarative skills and resources coexist with TypeScript mechanics.

For a simpler reference, run `pnpm od create-module` and look at the generated declarative module scaffold.
