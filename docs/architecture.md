# Architecture

OpenDungeon separates engine runtime from game content. The engine loads your game at startup and runs it — your game never touches engine internals.

---

## The big picture

```
┌─────────────────────────────────────────────┐
│             games/your-game/                │
│   skills/          mechanics/    index.ts   │
│   bargain.json     extraction.ts            │
│   rest.json        location.ts              │
└──────────────────────┬──────────────────────┘
                       │  GAME_MODULE_PATH
┌──────────────────────▼──────────────────────┐
│              apps/gateway                   │
│   HTTP API · action queue · world store     │
├─────────────────────────────────────────────┤
│           packages/engine-core              │
│   EngineRuntime · DungeonMasterRuntime      │
│   skill-loader · turn pipeline              │
├─────────────────────────────────────────────┤
│          packages/content-sdk               │
│   GameModule · Mechanic · SkillSchema       │
│   (the only package your game installs)     │
└─────────────────────────────────────────────┘
```

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
| `shared` | Zod schemas, shared types (`SessionEndReason`, `ModuleManifest`) |
| `content-sdk` | Public API for game developers: `GameModule`, `Mechanic`, `SkillSchema`, sanitizers |
| `providers-llm` | LLM abstraction: OpenAI-compat, Anthropic-compat, mock |
| `engine-core` | Turn pipeline, `EngineRuntime`, `DungeonMasterRuntime`, skill-loader |
| `architect` | Lore extraction, session chronicler, skill suggestion CLI |
| `devtools` | `od` CLI: setup, start/stop, configure, architect tools |
| `gateway` | HTTP API, action queue, world store, multi-player locking |
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

**Character state** (`characterPatch`) — private to one session. Stored in `Session.characterState`. Examples: `nearExit`, `sessionLoot`, personal buffs.

Mechanics choose which they write to by returning `worldPatch` or `characterPatch` in their results.

### Session vs campaign

- **Campaign**: shared world, multiple players over time
- **Session**: one character's current run — can end via death, extraction, or manually
- One campaign → many sessions; each session has its own character state

---

## Skill system

JSON skills and TypeScript mechanics coexist. At startup, `EngineRuntime` converts the `skills: SkillSchema[]` array into a single synthetic mechanic with id `"skills"`. This mechanic is appended after all TypeScript mechanics.

Routing keys for skills follow `"skills.<skillId>"`, e.g. `"skills.camp"`, `"skills.bargain"`.

`resolve: "ai"` skills only contribute `dmPromptExtension` (no action registered — DM narrates freely).  
`resolve: "deterministic"` skills register a named action and appear in the DM's tools list.

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

**Worldbuilder** — interactive CLI (`od architect`) for seeding campaign lore before launch.

**Skill analyzer** — reads `EventLog` for `type: "intent.unhandled"` entries (written when DM narrates freely without a mechanic), groups by pattern, and asks an LLM to suggest new `SkillSchema` files for the game developer to review.

---

## Gateway vs Orchestrator

The repo includes two server apps:

**`apps/gateway`** — stateful server. Manages users, campaigns, sessions, persistence (Prisma + PostgreSQL). Recommended for all deployments.

**`apps/orchestrator`** — stateless scaffold. No database dependency. Designed for horizontal scaling scenarios where each instance handles one session and reports state back to a coordinator. Not production-ready — exists as an architectural scaffold.
