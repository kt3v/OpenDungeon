# Creating a Game

A game in OpenDungeon is a **game module** — a directory of files that tells the engine what world to run, how characters work, and what rules the DM follows. You point the engine at your module via `GAME_MODULE_PATH`, and it does the rest.

There are two ways to build a game module. Start with the default (declarative).

---

## Modes at a glance

| | Declarative (default) | TypeScript (advanced) |
|---|---|---|
| Files | JSON + Markdown | TypeScript + JSON + Markdown |
| Build step | None | None (direct TS loading) |
| Entry in manifest | `"declarative"` | `"content/mechanics/index.ts"` |
| Best for | Most games | Complex stateful mechanics |
| Escape hatch | Add `content/mechanics/index.ts` + switch entry | — |

---

## Quick start (declarative)

```bash
# Scaffold a new module — declarative by default
pnpm od create-module ../my-game --name @me/my-game

# Point the engine at it in .env.local:
GAME_MODULE_PATH=../my-game

# Start the engine
pnpm dev:full
```

No `pnpm install`, no compilation. Edit files, restart engine.

---

## Game module structure

The engine looks for content in a `content/` subdirectory first, falling back to the module root. Scaffolding uses the `content/` layout:

```
my-game/
  manifest.json         ← module identity, sets entry: "declarative"
  package.json          ← package metadata
  content/
    setting.json        ← world config: era, tone, themes, taboos
    classes.json        ← character classes and starting stats
    dm.md               ← DM system prompt (plain Markdown)
    dm-config.json      ← guardrails, tool policy, default actions
    initial-state.json  ← starting worldState for new campaigns
    lore/               ← markdown world-building (auto-injected into DM)
      factions.md
    modules/            ← per-turn context modules (LLM-routed)
      exploration.md
    indicators/         ← UI indicators (HP bar, gold counter, etc.)
      hp.json
    mechanics/          ← (optional) TypeScript mechanics entry
      index.ts
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

`entry: "declarative"` tells the engine to load all game content from files. For TypeScript mechanics, set this to the path of your entry file (e.g., `"content/mechanics/index.ts"`).

---

### `setting.json` — world config

Defines the baseline world injected into every DM prompt:

```json
{
  "name": "Ashenfell",
  "description": "A dying empire where magic is forbidden.",
  "era": "Medieval",
  "realismLevel": "hard",
  "tone": "grim and tense",
  "themes": ["survival", "betrayal"],
  "magicSystem": "Magic exists but is outlawed.",
  "taboos": [
    "No resurrections — death is permanent",
    "No modern technology"
  ],
  "custom": {
    "currency": "Iron marks"
  }
}
```

---

### `dm.md` — DM system prompt

The entire file becomes the base DM system prompt. 

```markdown
You are the Dungeon Master for {{campaignTitle}}.

## Rules
- Keep the tone grim and terse.
- Prefer small, targeted `stateOps` updates on declared `varId`s.
- Suggested actions must be concrete and immediately playable.
```

---

### `dm-config.json` — DM guardrails

Controls how the DM responds and how context modules are routed:

```json
{
  "contextRouter": {
    "enabled": true,
    "contextTokenBudget": 1200,
    "maxCandidates": 8,
    "maxSelectedModules": 4
  },
  "toolPolicy": {
    "allowedTools": ["update_state", "set_summary", "set_suggested_actions"],
    "requireSummary": true,
    "requireSuggestedActions": true
  },
  "guardrails": {
    "maxSuggestedActions": 4,
    "maxSummaryChars": 220
  },
  "defaultSuggestedActions": [
    { "id": "look", "label": "Look Around", "prompt": "look around carefully" }
  ]
}
```

---

### `modules/*.md` — routed DM context modules

Use Markdown files with frontmatter for focused gameplay instructions. The engine automatically scans `content/modules/` and `content/contexts/`.

```markdown
---
id: stealth
priority: 80
triggers:
  - sneak
  - hide
references:
  - world:light_level
  - character:visibility
provides:
  - world:detected
when:
  - infiltration
---

## Stealth Rules
- Success depends on light level and distance to enemies.
- If detected, trigger combat immediatey.
```

| Frontmatter | Description |
|-------------|-------------|
| `id` | Stable ID (defaults to filename) |
| `priority` | Higher priority modules are ranked higher |
| `triggers` | Keyword matches for fast pre-filtering |
| `references` | Machine refs (`world:`, `character:`, `resource:`, `module:`) |
| `dependsOn` | IDs of modules to include together |

---

### `initial-state.json` — starting world state

The initial `worldState` for brand-new campaigns. 

```json
{
  "act": 1,
  "lastObservation": "none"
}
```

---

### `state/*.json` — canonical state catalog (required)

Declare variables used by DM, mechanics, indicators, and persistence.

```json
[
  { "id": "hp", "scope": "character", "type": "number", "defaultValue": 100, "writableBy": ["mechanic"] },
  { "id": "location", "scope": "session", "type": "text", "defaultValue": "", "writableBy": ["dm", "mechanic"] },
  { "id": "act", "scope": "world", "type": "number", "defaultValue": 1, "writableBy": ["dm", "mechanic"] }
]
```

---

### `indicators/*.json` — UI indicators

Map state to visible UI elements.

```json
{
  "id": "hp",
  "label": "HP",
  "varId": "hp",
  "type": "number"
}
```

---

## Tooling

### Scaffolding
Ask the Architect to generate content based on your `setting.json`:
```bash
pnpm od architect scaffold --module ../my-game --type all
```

### Validation
Check your module for errors and reference integrity:
```bash
pnpm od validate-module ../my-game
```
Use `--strict` to fail on frontmatter warnings (e.g., world references missing from `initial-state.json`).

### Discovery
Find missing mechanics based on player history:
```bash
pnpm od architect analyze --campaign <id>
```

---

## TypeScript mode (advanced)

For complex logic, add a TypeScript entry point. Scaffolding with `--typescript` sets this up for you automatically.

```bash
pnpm od create-module ../my-game --typescript
```

Your `manifest.json` will point to `"content/mechanics/index.ts"`. TypeScript is loaded **directly by the engine** (no build step required). 

```typescript
// content/mechanics/index.ts
import { defineMechanics } from "@opendungeon/content-sdk";
import { myMechanic } from "./logic/my-mechanic.js";

export default defineMechanics({
  mechanics: [myMechanic]
});
```

All declarative data (classes, DM config, etc.) continues to be loaded from JSON/Markdown files. TypeScript is used only for the `mechanics` logic.
