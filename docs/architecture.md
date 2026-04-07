# Architecture

OpenDungeon separates engine runtime from game content. The engine loads your game at startup and runs it — your game never touches engine internals.

---

## The big picture

```
┌──────────────────────────────────────────────────────┐
│                   games/your-game/                   │
│                                                      │
│  classes.json        modules/*.md    lore/           │
│  dm.md               indicators/    factions.md      │
│  dm-config.json      hp.json        locations.md     │
│  initial-state.json  gold.json                       │
│                                                      │
│  src/index.ts  ← optional TypeScript mechanics       │
│  dist/index.js                                       │
└──────────────────────────┬───────────────────────────┘
                           │  GAME_MODULE_PATH
┌──────────────────────────▼───────────────────────────┐
│                   apps/gateway                       │
│   module-loader · HTTP API · action queue · world store │
├──────────────────────────────────────────────────────┤
│               packages/engine-core                   │
│   EngineRuntime · DungeonMasterRuntime               │
│   ContextRouterRuntime · turn pipeline               │
├──────────────────────────────────────────────────────┤
│               packages/content-sdk                   │
│   GameModule · Mechanic · defineMechanics            │
│   loadDeclarativeGameModule · loadContextModulesDirSync │
│   (the only package your game installs)              │
└──────────────────────────────────────────────────────┘
```

### Module loading

The gateway always loads the declarative base (JSON/Markdown files), then optionally merges TypeScript mechanics on top. There is a single unified pipeline — the engine runtime receives the same `GameModule` interface regardless.

`manifest.json#entry` controls whether TypeScript is loaded:

- `"declarative"` (or omitted, no TS file found) → declarative-only, no `import()` needed
- `"dist/index.js"` (or any path) → dynamic `import()` of the compiled entry, its `mechanics` array is merged with any declarative mechanics

---

## Turn pipeline

Every player action flows through the same pipeline:

```
Player action
      │
      ▼
onActionSubmitted hooks  ← all mechanics in order; can modify or block
      │
      ▼
 explicit mechanicActionId? ──yes──► mechanic.validate → mechanic.resolve
      │ no
      ▼
 DM (LLM) receives:
   • action text
   • worldState
   • list of available mechanic tools   ← each mechanic's actions
   • setting / world bible (from setting.json + lore/)
   • system prompt + skill extensions
      │
      ├── mechanicCall → mechanic.validate → mechanic.resolve
      │
      └── free narration → message + worldPatch
      │
      ▼
onActionResolved hooks  ← all mechanics in order; can modify result
      │
      ▼
if endSession → onSessionEnd hooks → persist
      │
      ▼
ActionResult → player
```

**Key property:** the DM is the router. It sees all registered mechanic tools and decides whether to invoke one or handle the action narratively. This means players can write in any language or phrasing — the DM understands intent, not keywords.

### MD-first context routing (machine references)

Context modules in `modules/*.md` can include machine-precise frontmatter (`references`, `dependsOn`, `provides`, `when`).
These fields are optional and soft-validated: invalid entries are ignored with warnings, not runtime crashes.

```
Player action + worldState
        │
        ▼
Keyword prefilter (triggers + when + world reference matches)
        │
        ▼
LLM candidate selection
        │
        ▼
Dependency expansion (dependsOn)
        │
        ▼
Reference-aware ranking
  • priority
  • references:world:* matches current worldState paths
  • references:module:* matches selected module set
  • provides:* gives a small boost
        │
        ▼
Token budget cut
        │
        ▼
Injected into DM prompt:
  1) Active Context Modules
  2) Active References (compact machine ref summary)
```

| Reference type | Runtime effect |
|---|---|
| `world:<path>` | Increases candidate/rank score when path matches current `worldState` keys (exact or prefix match). |
| `module:<id>` | Increases rank if referenced module is already selected in the same turn. |
| `character:<path>` | Included in `Active References` prompt section for DM precision (no direct state-path scoring yet). |
| `resource:<id>` | Included in `Active References` prompt section for DM/UI alignment (no direct state-path scoring yet). |
| `dependsOn` | Expands selected module set with linked modules before final ranking (within max module cap). |
| `provides` | Adds small rank boost when provided world refs match active `worldState` paths. |

### DM system prompt structure

The DM system prompt is built in layers, injected in this order:

1. **Setting / World Bible** (`setting.json` + `lore/*.md`)
   - Defines era, realism level, tone, themes
   - Establishes taboos (things to NEVER include)
   - Provides magic system description
   - Adds custom key-value pairs

2. **DM Configuration** (`dm.systemPrompt` or `dm.promptTemplate`)
   - Base instructions and tone
   - Tool policy (which tools are allowed)
   - Guardrails (output limits)

3. **Mechanic Extensions** (`dmPromptExtension` hooks)
   - Dynamic context based on current world state
   - Skill-specific rules and constraints

```
┌─────────────────────────────────────────────────────────────┐
│ System Prompt                                               │
├─────────────────────────────────────────────────────────────┤
│ ## Setting                                                  │
│ Name: Shadowrealm                                           │
│ Era: Medieval                                               │
│ Realism: hard                                               │
│ Taboos: - No resurrections                                  │
│         - No modern tech                                    │
├─────────────────────────────────────────────────────────────┤
│ You are the Dungeon Master... (from dmConfig)               │
├─────────────────────────────────────────────────────────────┤
│ ## Extraction                                               │
│ - Set nearExit when player reaches exit                     │
│ - Session loot: 3 items                                     │
│                                                             │
│ ## Location                                                 │
│ - Current location: dungeon_depths                          │
└─────────────────────────────────────────────────────────────┘
```

---

---

## Package roles

| Package | What it does |
|---------|-------------|
| `shared` | Zod schemas, shared types (`SessionEndReason`, `ModuleManifest`, declarative file schemas) |
| `content-sdk` | Public API for game developers: `GameModule`, `Mechanic`, `defineMechanics`, all loaders, `loadDeclarativeGameModule`, `loadContextModulesDirSync` |
| `providers-llm` | LLM abstraction: OpenAI-compat, Anthropic-compat, mock |
| `engine-core` | Turn pipeline, `EngineRuntime`, `DungeonMasterRuntime`, skill-loader |
| `architect` | Lore extraction, session chronicler, skill suggestion, game scaffolder |
| `devtools` | `od` CLI: setup, start/stop, validate-module, architect tools (scaffold, analyze, worldbuilder) |
| `gateway` | HTTP API, action queue, world store, multi-player locking, declarative module loading |
| `web` | Next.js frontend (MVP) |

Dependency graph (arrows = "depends on"):

```
shared ──► content-sdk ──► engine-core ──► gateway
       ──► providers-llm ──► engine-core
                         ──► architect ──► devtools
```

---

## State model

### World state vs character state

Two kinds of mutable state exist per campaign:

**World state** (`worldPatch`) — shared across all players. Stored in `WorldFact` rows per key. Examples: doors opened, bosses defeated, world lore, global quest flags.

**Character state** (`characterState`) — private to one session. Stored in `Session.characterState`. Examples: `nearExit`, `sessionLoot`, personal buffs.

Mechanics choose which they write to by returning `worldPatch` or `characterState` in their results.

### Session vs campaign

- **Campaign**: shared world, multiple players over time
- **Session**: one character's current run — can end via death, extraction, or manually
- One campaign → many sessions; each session has its own character state

---

---

## Concurrent multi-player

Multiple sessions in the same campaign can execute LLM calls in parallel (no lock). World state commits are serialised per-campaign via a promise-chain mutex. This prevents conflicting patches:

```
Session A: LLM call ─────────────────────► commit (acquires lock)
Session B: LLM call ──────────────────────────────► commit (waits, then applies to fresh state)
```

---

## Architect

The Architect is a background system for lore and analytics. It runs on two modes:

**Chronicler** — fires after sessions, extracts named entities, writes to `LoreEntry` and `Milestone` tables. Future turns can retrieve relevant lore via RAG and inject it into the DM context.

**Worldbuilder** — interactive CLI (`pnpm od architect`) for seeding campaign lore before launch.

**Intent analyzer** — reads `EventLog` for `type: "intent.unhandled"` entries (written when DM narrates freely without a mechanic), groups by pattern, and suggests new context modules or mechanics for the game developer to review.

**Game scaffolder** — `pnpm od architect scaffold` generates declarative game module files (classes.json, dm.md, dm-config.json, initial-state.json, modules/) using an LLM.

---

## Gateway

**`apps/gateway`** — stateful server. Manages users, campaigns, sessions, persistence (Prisma + PostgreSQL). The only server app in the repo.
