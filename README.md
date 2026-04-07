# OpenDungeon

The AI-Native Engine for Emergent Tabletop Worlds.

The engine handles the hard parts — LLM orchestration, multiplayer world state, session management, persistence. You handle the fun parts — mechanics, lore, characters, rules.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## How it works

Your game is a **game module** — a directory of JSON and Markdown files (optionally with TypeScript). The engine loads your module at startup and runs the turn pipeline.

```
OpenDungeon engine  ←  games/your-game/
   (this repo)            manifest.json
                          content/
                            modules/     ← Routed Markdown gameplay context
                            mechanics/   ← TypeScript for complex logic (optional)
                            lore/        ← Static world-building
                            indicators/  ← UI resource tiles
```

The AI Dungeon Master receives the player's action, sees the list of available mechanics as tools, and decides: invoke a mechanic deterministically, or narrate freely. Players can write in any language or phrasing — the DM understands intent, not keywords.

---

## Quick start

**Prerequisites:** Node.js 20+, Docker, pnpm

```bash
git clone https://github.com/kt3v/OpenDungeon.git
cd OpenDungeon
pnpm install
pnpm build

pnpm od setup        # Interactive! Pick 'game-example' or create a clean project
pnpm od start        # Launches gateway (:3001) and web UI (:3000)
```

`pnpm od configure llm` includes presets for `Ollama`, `OpenAI`, `Anthropic`, `OpenRouter`, `Groq`, and `Together`.
You can also copy ready-to-use provider templates from `env-profiles/`.

---

## Building a game

OpenDungeon supports a **content-first control plane**: routed markdown context modules + deterministic TypeScript mechanics. Game modules live in the `games/` directory:

1. Run `pnpm od setup` and choose "Create a clean project".
2. Add markdown guidance modules to `content/modules/`:

```markdown
---
id: bargain
priority: 80
triggers: [bargain, haggle]
---

## Bargaining Rules
- Players can negotiate prices and terms with NPCs.
- Success depends on reputation and roleplay quality.
```

3. For exact logic, add TypeScript mechanics to `content/mechanics/`:

```ts
export const campMechanic = defineMechanic({
  id: "camp",
  actions: {
    rest: {
      description: "Rest at a campfire to recover",
      validate: (ctx) => ctx.worldState.campfireActive ? true : "No campfire nearby.",
      resolve: async () => ({ message: "You rest by the fire and recover your strength." })
    }
  }
});
```

See [Creating a Game](docs/game-dev/creating-a-game.md) and [Mechanics Guide](docs/game-dev/mechanics-guide.md).

---

## Setting / World Bible

Define your world's lore, tone, and constraints in `content/setting.json`. This establishes the base world before any instructions:

```json
{
  "name": "Shadowrealm",
  "era": "Medieval",
  "realismLevel": "hard",
  "tone": "dark and mysterious",
  "taboos": ["No modern technology", "No resurrections"],
  "custom": { "currency": "Gold crowns" }
}
```

The setting is automatically injected into every DM prompt. For detailed world building, add Markdown files to `content/lore/`.

---

## Developer tooling (`pnpm od <command>`)

```bash
pnpm od setup                               First-time setup
pnpm od start [full|gateway|web]            Start services
pnpm od stop                                Stop services
pnpm od status                              Show running services and config
pnpm od logs [gateway|web] [-f]             View service logs
pnpm od realtime                            Stream gateway logs in real-time
pnpm od configure [llm|ports|module]        Change settings
pnpm od reset                               Wipe all local state (DB + logs)

pnpm od architect analyze --campaign <id>   Find unhandled intents, suggest mechanics
pnpm od architect scaffold --module <dir>   AI-generate module content from setting
pnpm od create-module <dir>                 Scaffold a new game module
pnpm od validate-module <dir>               Check module JSON/frontmatter integrity
```

---

## Documentation

- **Game Development**
  - [Creating a Game](docs/game-dev/creating-a-game.md) — structure and manifest
  - [Mechanics Guide](docs/game-dev/mechanics-guide.md) — hooks and actions
  - [Resource Indicators](docs/game-dev/resource-indicators.md) — UI tiles
- **Engine Internals**
  - [Architecture](docs/engine-dev/architecture.md) — turn pipeline and context routing
  - [LLM Gateway](docs/engine-dev/llm-gateway.md) — resilience and production settings

---

## Packages

| Package | Purpose |
|---------|---------|
| `@opendungeon/content-sdk` | API for module and mechanic development |
| `@opendungeon/engine-core` | Turn pipeline, DM orchestration, context router, archivist |
| `@opendungeon/providers-llm` | Resilience layer (Retry, Circuit Breaker, Fallback) |
| `@opendungeon/architect` | Lore extraction and intent analysis |
| `@opendungeon/devtools` | The `od` CLI |

---

Built with ❤️ by [indie indie](https://x.com/1hrOk) · [MIT License](LICENSE)
