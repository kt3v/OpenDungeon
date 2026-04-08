# OpenDungeon
**The AI-Native Engine for Emergent Tabletop Worlds.**

OpenDungeon is not just a wrapper for LLMs. It is a framework that treats game lore, rules, and state as a living API for an AI Dungeon Master. It transforms the act of world-building into the act of programming—where your narrative design becomes the engine's logic.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## ⚡️ The Core Concept: Lore as Code

In traditional games, you write rigid dialogue trees. In OpenDungeon, you define the **laws of your universe**. Your game is a **Module**—a collection of Markdown and JSON files that the AI "inhales" to govern the world.

The magic happens in the synergy of three layers:

1. **Static Lore (The World Bible):** Deeply embedded world-building in Markdown. The AI doesn't just "remember" your lore; it uses it as a strict constraint for consistency.
2. **Deterministic Mechanics (The Rules):** TypeScript tools for things that *must* be fair—combat calculations, loot tables, and XP. When the AI needs a "roll," it calls a real function, not a hallucination.
3. **Generative Narrative (The DM):** The LLM bridges the gap, translating player intent into mechanic calls and narrative responses.

### The Anatomy of a World
```
OpenDungeon engine  ←  games/your-game/
   (this repo)            manifest.json
                          content/
                            modules/     ← Routed Markdown gameplay context (The "How")
                            mechanics/   ← TypeScript logic for hard rules (The "Math")
                            lore/        ← Static world-building (The "What")
                            indicators/  ← UI resource tiles (The "View")
```

---

## 🚀 Quick Start

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

---

## 🛠 Building a Game

OpenDungeon uses a **content-first control plane**. You don't code the game loop; you design the context.

### 1. Narrative Guidance (Modules)
Define how specific scenarios work using routed markdown.
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

### 2. Hard Logic (Mechanics)
For exact results, use TypeScript.
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

### 3. World Identity (Setting)
Establish the base vibe and taboos in `content/setting.json`.
```json
{
  "name": "Shadowrealm",
  "tone": "dark and mysterious",
  "taboos": ["No modern technology", "No resurrections"],
  "custom": { "currency": "Gold crowns" }
}
```

See [Creating a Game](docs/game-dev/creating-a-game.md) and [Mechanics Guide](docs/game-dev/mechanics-guide.md).

---

## 🧰 Developer Tooling (`pnpm od <command>`)

```bash
pnpm od setup                               First-time setup
pnpm od setup web                           Scaffold/update only the web module path
pnpm od start [full|gateway|web]            Start services
pnpm od drain                               Graceful shutdown prep (see below)
pnpm od stop                                Stop services
pnpm od status                              Show running services and config
pnpm od logs [gateway|web] [-f]             View service logs
pnpm od realtime                            Stream gateway logs in real-time
pnpm od configure [llm|ports|module]        Change settings
pnpm od doctor env [--fix]                  Validate env (incl. WEB_MODULE_PATH)
pnpm od web sync [--force]                  Sync apps/web template into WEB_MODULE_PATH
pnpm od reset                               Wipe all local state (DB + logs)

pnpm od architect analyze --campaign <id>   Find unhandled intents, suggest mechanics
pnpm od architect scaffold --module <dir>   AI-generate module content from setting
pnpm od create-module <dir>                 Scaffold a new game module
pnpm od validate-module <dir>               Check module JSON/frontmatter integrity
```

### Web UI customization flow

- `apps/web` is the template source.
- `WEB_MODULE_PATH` points to your standalone web UI copy (usually `./web/<name>`).
- `pnpm od setup` and `od setup web` scaffold the full web app into `WEB_MODULE_PATH` and run `pnpm install` there automatically.
- `pnpm od start web` runs the app from `WEB_MODULE_PATH` when it contains a `package.json`.
- `pnpm od web sync` pulls template updates from `apps/web` into your module without overwriting changed files.
- `pnpmod web sync --force` also overwrites changed files.

### Updating the server without dropping players

Killing the server while players are mid-turn interrupts their LLM calls and leaves actions uncommitted. Use `od drain` to shut down cleanly:

```bash
# 1. Enter drain mode — the server stops accepting new actions.
#    Players who try to act see: "The server is preparing for a brief restart."
#    Players already waiting for a DM response keep waiting and get their answer.
pnpm od drain

# od drain polls until all in-flight actions complete, then prints:
#   ✓ All in-flight actions completed.
#   ✓ Server is ready to stop.

# 2. Now it's safe to stop, update, and restart.
pnpm od stop
git pull
pnpm install
pnpm build
pnpm od start
```

`od drain` signals the gateway via `SIGUSR2` (no auth token required). It times out after 5 minutes if an LLM call hangs.

---

## 📚 Documentation

- **Game Development**
  - [Creating a Game](docs/game-dev/creating-a-game.md) — structure and manifest
  - [Mechanics Guide](docs/game-dev/mechanics-guide.md) — hooks and actions
  - [Resource Indicators](docs/game-dev/resource-indicators.md) — UI tiles
- **Engine Internals**
  - [Architecture](docs/engine-dev/architecture.md) — turn pipeline and context routing
  - [LLM Gateway](docs/engine-dev/llm-gateway.md) — resilience and production settings

---

## 📦 Packages

| Package | Purpose |
|---------|---------|
| `@opendungeon/content-sdk` | API for module and mechanic development |
| `@opendungeon/engine-core` | Turn pipeline, DM orchestration, context router, archivist |
| `@opendungeon/providers-llm` | Resilience layer (Retry, Circuit Breaker, Fallback) |
| `@opendungeon/architect` | Lore extraction and intent analysis |
| `@opendungeon/devtools` | The `od` CLI |

---

Built with ❤️ by [indie indie](https://x.com/1hrOk) · [MIT License](LICENSE)
