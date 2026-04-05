# OpenDungeon

An open-source engine for multiplayer, AI-powered tabletop RPG campaigns.

The engine handles the hard parts — LLM orchestration, multiplayer world state, session management, persistence. You handle the fun parts — mechanics, lore, characters, rules.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## How it works

Your game is a separate package (or folder) that you plug into the engine. The engine never touches your game code — it loads it at startup and calls well-defined hooks.

```
OpenDungeon engine  ←  your-game/
   (this repo)            skills/         ← JSON rules, no code needed
                          src/mechanics/  ← TypeScript for complex logic
                          src/index.ts    ← exports defineGameModule(...)
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
pnpm od configure llm # Pick your LLM provider interactively
pnpm od start        # Launches gateway (:3001) and web UI (:3000)
```

Your selected game module will be prepared in the `games/` directory. Open `http://localhost:3000` to create your first campaign.

---

## Building a game

OpenDungeon supports **AI-native declarative skills**. Game modules live in the `games/` directory (ignored by git), allowing you to evolve your game independently of the engine:

1. Run `pnpm od setup` and choose "Create a clean project" (e.g., `game-my-adventure`).
2. Your project is created in `games/game-my-adventure/`.
3. Drop a JSON file into your game's `skills/` folder:


```json
// skills/bargain.json
{
  "id": "bargain",
  "description": "Negotiate prices or terms with an NPC",
  "resolve": "ai",
  "dmPromptExtension": "## Bargaining\nPlayers can haggle. Track result in worldPatch: merchantRelation (+1/-1)."
}
```

Restart the engine — the skill is live. The DM now knows this mechanic exists and will invoke it when the player tries to negotiate, regardless of how they phrase it.

For more control, use `resolve: "deterministic"` with a fixed outcome:

```json
// skills/rest.json
{
  "id": "rest",
  "description": "Rest at a campfire to recover",
  "resolve": "deterministic",
  "validate": { "worldStateKey": "campfireActive", "failMessage": "No campfire nearby." },
  "outcome": {
    "message": "You rest by the fire and recover your strength.",
    "worldPatch": { "campfireActive": false },
    "characterPatch": { "hp": 100 }
  }
}
```

For stateful cross-session logic, write a TypeScript mechanic. See [Creating a Game](docs/creating-a-game.md) and [Mechanics](docs/mechanics.md).

---

## Developer tooling (`pnpm od <command>`)

```bash
pnpm od setup                               First-time setup
pnpm od start [full|gateway|web]            Start services
pnpm od stop                                Stop services
pnpm od status                              Show running services and config
pnpm od logs [gateway|web] [-f]             View logs
pnpm od configure [llm|ports|module]        Change settings
pnpm od reset                               Wipe all local state

pnpm od architect --campaign <id> [--apply] Seed world lore interactively
pnpm od architect analyze --campaign <id>   Find unhandled intents, suggest skills
pnpm od create-module <dir>                 Scaffold a new game workspace
```

### `pnpm architect analyze`

After your game has been played, discover what players are trying to do that no mechanic covers:

```bash
pnpm architect analyze --campaign abc123 --min-count 3
```

The command reads session logs, groups unhandled intents by pattern, and asks the Architect LLM to generate `SkillSchema` suggestions. Review them interactively, save the ones you like, move them to `skills/` — done.

---

## Documentation

- [Creating a Game](docs/creating-a-game.md) — full guide for game developers
- [Mechanics](docs/mechanics.md) — skills (JSON) and TypeScript mechanics
- [Architecture](docs/architecture.md) — system design and turn pipeline

---

## Packages

| Package | Purpose |
|---------|---------|
| `@opendungeon/content-sdk` | The only package your game needs to install |
| `@opendungeon/engine-core` | Turn pipeline, DM orchestration, skill loader |
| `@opendungeon/architect` | Lore extraction, chronicler, skill suggestion |
| `@opendungeon/providers-llm` | LLM abstraction (OpenAI-compat, Anthropic-compat, mock) |
| `@opendungeon/devtools` | `od` CLI |

---

Built with ❤️ by [indie indie](https://x.com/1hrOk) · [MIT License](LICENSE)



