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
