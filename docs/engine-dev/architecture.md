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
│   ContextRouterRuntime · turn pipeline · Archivist   │
├──────────────────────────────────────────────────────┤
│               packages/content-sdk                   │
│   GameModule · Mechanic · defineMechanics            │
│   loadDeclarativeGameModule · loadContextModulesDirSync │
│   (the only package your game installs)              │
└──────────────────────────┬───────────────────────────┘
                           ▼
              ┌──────────────────────────┐
              │      providers-llm       │
              │  OpenAI · Anthropic · Mock │
              └──────────────────────────┘
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
   • available mechanic tools   ← each mechanic's actions
   • setting / world bible (from setting.json + lore/)
   • system prompt (layered)
      │
      ├── mechanicCall → mechanic.validate → mechanic.resolve
      │
      └── free narration → message + worldPatch + location
      │
      ▼
Archivist post-process   ← auto-updates worldState/summary based on narrative
      │
      ▼
onActionResolved hooks   ← all mechanics in order; can modify result
      │
      ▼
if endSession → onSessionEnd hooks
      │
      ▼
ActionResult → player
```

**Key property:** the DM is the router. It sees all registered mechanic tools and decides whether to invoke one or handle the action narratively. This means players can write in any language or phrasing — the DM understands intent, not keywords.

---

## Context routing (Machine References)

Context modules in `modules/*.md` can include machine-precise frontmatter (`references`, `dependsOn`, `provides`, `triggers`, `when`).

```
Player action + worldState
        │
        ▼
Keyword prefilter (triggers + when + world reference matches)
        │
        ▼
LLM candidate selection (pick top relevant candidates)
        │
        ▼
Dependency expansion (dependsOn)
        │
        ▼
Reference-aware ranking
  • world matches (+30 score)
  • module matches (+20 score)
  • provides matches (+6 score)
  • priority (base score)
        │
        ▼
Token budget cut
        │
        ▼
Injected into DM prompt:
  1) Active Context Modules (content)
  2) Active References (machine ref summary)
```

| Reference type | Runtime effect |
|---|---|
| `world:<path>` | Heavy score boost when path matches current `worldState` keys. |
| `module:<id>` | Rank boost if referenced module is already selected. |
| `character:<path>` | Included in `Active References` section for DM precision. |
| `resource:<id>` | Included in `Active References` section for DM/UI alignment. |
| `dependsOn` | Pulls in linked modules before final ranking. |
| `provides` | Small score boost when provided world refs match active state. |

---

## DM system prompt structure

The DM system prompt is built in layers in `EngineRuntime.buildSystemPrompt`:

1.  **Setting / World Bible**: Era, realism, tone, themes, taboos (from `setting.json` + `lore/*.md`).
2.  **Base Instructions**: Core DM persona + **Language Instruction** (auto-detect or player preference).
3.  **Narrator Guidelines**: Injected based on `narratorStyle` (collaborative, balanced, or strict).
4.  **Active Context Modules**: Content of `.md` modules selected by the Context Router.
5.  **Active References**: Machine-readable summary of `references` and `provides` from active modules.

---

## Package roles

| Package | What it does |
|---------|-------------|
| `shared` | Zod schemas, shared types (`SessionEndReason`, `ModuleManifest`, event schemas) |
| `content-sdk` | Public API for game developers: `GameModule`, `Mechanic`, `defineMechanics`, loaders |
| `providers-llm` | LLM abstraction: OpenAI-compat, Anthropic-compat, mock |
| `engine-core` | Turn pipeline, `EngineRuntime`, `DungeonMasterRuntime`, `ContextRouterRuntime`, `ArchivistRuntime` |
| `architect` | Lore extraction, session chronicler, game scaffolder |
| `devtools` | `od` CLI: setup, start/stop, architect tools (scaffold, analyze) |
| `gateway` | HTTP API, action queue, world store, persistence (Prisma + PostgreSQL) |
| `web` | Next.js frontend (MVP) |

---

## State model

### World state vs character state

**World state** (`worldPatch`) — shared across all players. Stored in `WorldFact` rows. Used for doors opened, global flags, persistent NPCs.

**Character state** (`characterState`) — private to one player/character. Contains hp, level, inventory, and ephemeral run data like `nearExit` or `sessionLoot`.

### Session vs campaign

- **Campaign**: shared world, multiple players over time.
- **Session**: one character's current run.
- One campaign → many sessions; each session has its own character state.

---

## Concurrent multi-player

Multiple sessions in the same campaign can execute LLM calls in parallel. World state commits are serialised per-campaign via a mutex in the gateway. This prevents conflicting patches:

```
Session A: LLM call ─────────────────────► commit (acquires lock)
Session B: LLM call ──────────────────────────────► commit (waits, then applies to fresh state)
```

---

## Architect

The Architect is a background system for lore and automation:

- **Chronicler**: Extracts named entities and milestones after sessions for future RAG retrieval.
- **Game scaffolder**: `pnpm od architect scaffold` generates declarative game module files using LLM.
- **Intent analyzer**: Identifies unhandled player intents and suggests new mechanics or context modules.
