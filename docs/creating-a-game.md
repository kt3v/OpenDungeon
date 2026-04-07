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
  modules/              ← per-turn context modules (LLM-routed)
    stealth.md
    trading.md
  indicators/           ← UI indicators (HP bar, gold counter, etc.)
    hp.json
    gold.json
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
  "contextRouter": {
    "enabled": true,
    "contextTokenBudget": 1200,
    "maxCandidates": 8,
    "maxSelectedModules": 4
  },
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

`contextRouter` controls per-turn selection of Markdown context modules:
- `enabled` — default router state in config.
- `contextTokenBudget` — global token budget for all selected modules in one turn.
- `maxCandidates` — max modules after keyword pre-filter.
- `maxSelectedModules` — hard cap of selected modules included into DM prompt.

Environment flag override:
- `DM_CONTEXT_ROUTER_ENABLED=true` forces router on.
- `DM_CONTEXT_ROUTER_ENABLED=false` (or unset with `enabled: false`) keeps router off.

> Note: `suggestedActionStrategy` (a dynamic TypeScript function for computed action buttons) is not supported in JSON. If you need it, use TypeScript mode instead.

---

### `modules/*.md` or `contexts/*.md` — routed DM context modules

Use Markdown files for focused gameplay instructions that should be included only when relevant.

Each module supports optional frontmatter:

```markdown
---
id: trading
priority: 80
alwaysInclude: false
triggers:
  - buy
  - sell
  - merchant
---

## Trading Rules
- Let players negotiate prices with merchants.
- Better terms require leverage, reputation, or strong roleplay.
```

Frontmatter fields:
- `id` (string, optional) — stable module id. If omitted, filename is used.
- `priority` (number, optional) — higher priority wins during ranking.
- `alwaysInclude` (boolean, optional) — always include this module before optional modules.
- `triggers` (string[], optional) — keywords for fast pre-filter before LLM selection.

Notes:
- Store modules in either `modules/` or `contexts/` near `dm-config.json`.
- Do not set per-module token limits; router uses the global `contextTokenBudget`.
- Keep modules short and narrowly scoped to one mechanic/domain.

---

### `initial-state.json` — starting world state

The initial `worldState` for brand-new campaigns. Flat key-value JSON:

```json
{
  "act": 1,
  "fortressBreached": false
}
```

Per-character state (gold, inventory, location) is initialized in TypeScript mechanics via `onCharacterCreated`.

---

### `indicators/*.json` — UI indicators

Map world/character state to visible indicators in the game UI:

```json
{
  "id": "hp",
  "label": "HP",
  "source": "characterState",
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
| `"characterState"` | Session character state | hp, level, gold, inventory, personal flags |
| `"worldState"` | Shared campaign state | faction reputation, boss HP, global flags |

Types: `"number"`, `"text"`, `"list"`, `"boolean"`

See [Resource Indicators](./resource-indicators.md) for full reference.

---

---

## Let the Architect generate your content

Once your `setting.json` exists, you can ask the Architect to generate the rest:

```bash
pnpm od architect scaffold --module ../my-game --type all
```

The Architect reads your setting, then generates `classes.json`, `dm.md`, `dm-config.json`, `initial-state.json`, and starter `modules/`. Review the output, adjust, and you're playing.

---

## Grow your game over time

### Discover missing mechanics

After players have been playing, the Architect can find patterns in what they tried to do that no mechanic handled:

```bash
pnpm od architect analyze --campaign <id> --min-count 3
```

This reads session logs, groups unhandled player intents, and suggests new context modules or TypeScript mechanics to add.

### Validate your files

```bash
pnpm od validate-module ../my-game
```

Checks all JSON files against their schemas and reports every error at once.

---

## TypeScript mode (advanced)

For mechanics that require real code — cross-session loot accumulation, intercepting DM output, complex conditional logic — add a `src/index.ts` that exports additional mechanics.

```bash
pnpm od create-module ../my-game --typescript
# Generates src/index.ts with a defineMechanics() scaffold
# Requires pnpm install && pnpm build before running
```

The manifest `entry` points to `"dist/index.js"`. Your `src/index.ts` only exports mechanics — all other data (classes, DM config, setting, indicators) continues to come from JSON/Markdown files in the module root:

```typescript
// src/index.ts
import { defineMechanics, defineMechanic } from "@opendungeon/content-sdk";
import { extractionMechanic } from "./mechanics/extraction.js";

export default defineMechanics({
  mechanics: [extractionMechanic]
});
```

The engine merges these mechanics with the declarative base at runtime. No need to re-declare classes, DM config, or any other declarative data in TypeScript.

See [Mechanics](./mechanics.md) for a full guide on TypeScript mechanics.

---

## Reference implementation

`packages/game-example` is a full TypeScript game module with complex mechanics (per-player location, cross-session loot extraction). It shows what's possible with TypeScript mode, and demonstrates how TypeScript mechanics coexist with declarative modules and indicators.

For a simpler reference, run `pnpm od create-module` and look at the generated declarative module scaffold.
