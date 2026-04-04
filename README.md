# OpenDungeon 🐉🛡️

**OpenDungeon** is a full-stack, LLM-powered RPG engine for creating procedurally generated and narrative-driven games. It separates core engine logic from game content, allowing you to build rich multiplayer experiences with AI as your Dungeon Master.

[![npm version](https://img.shields.io/npm/v/opendungeon.svg)](https://www.npmjs.com/package/opendungeon)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## ✨ Why OpenDungeon?

- **AI-Native**: Built from the ground up to integrate Large Language Models (OpenAI, Anthropic, etc.) into gameplay.
- **Engine-First Philosophy**: Clear separation between core mechanics and game content (modules).
- **Multiplayer Ready**: Designed to scale sessions and manage shared world states across players.
- **Extensible SDK**: Define your own classes, items, locations, and narrative hooks using the `content-sdk`.

---

## 🚀 Getting Started

### For Game Developers (Usage)

The easiest way to build a game with OpenDungeon is to install it as a dependency:

```bash
npm install opendungeon
```

**Quick Example:**

```typescript
import { DungeonMaster, createLlmProvider } from 'opendungeon';

// 1. Setup AI
const llm = createLlmProvider({ type: 'openai', apiKey: process.env.OPENAI_API_KEY });

// 2. Initialize Engine
const dm = new DungeonMaster({ llmProvider: llm });

// 3. Process Player Action
const result = await dm.processAction(currentState, { actionText: "explore the ruins" });
console.log(result.event.message);
```

### For Engine Contributors (Development)

If you want to contribute to the engine or run the reference implementation locally:

Ensure you have [Docker](https://www.docker.com/) and [pnpm](https://pnpm.io/) installed.

```bash
# 1. Clone and install
git clone https://github.com/kt3v/OpenDungeon.git
cd OpenDungeon
pnpm install

# 2. Check and Setup
pnpm run doctor
pnpm run setup

# 3. Launch Development Environment
pnpm run dev:full
```
Open `http://localhost:3000` to start your first campaign in the web client.

---

## 🏗 Project Ecosystem

OpenDungeon is a monorepo consisting of several specialized packages:

- **`opendungeon`**: The primary "umbrella" package for developers.
- **`@opendungeon/engine-core`**: The heart of the platform. Orchestrates turns and LLM interactions.
- **`@opendungeon/content-sdk`**: The API surface for game developers.
- **`@opendungeon/architect`**: AI-powered world building and campaign generation.
- **`@opendungeon/devtools`**: CLI tools (`od`) for managing modules and campaigns.
- **`@opendungeon/providers-llm`**: Abstraction layer for AI models.

---

## 🛠 Creating Your Own Module

OpenDungeon loads gameplay from a module path. To create a new game module:

```bash
# Using the devtools CLI
npx od create-module ../my-new-game
```

See [Creating a Game](docs/creating-a-game.md) for more details.

---

## 📖 Documentation

- [Architecture](docs/architecture.md) — Detailed system design.
- [Creating a Game](docs/creating-a-game.md) — Guide for module developers.
- [Mechanics](docs/mechanics.md) — How to extend gameplay logic.
- [LLM Setup](docs/llm-polish-plan.md) — Configuring AI providers.

## ⚖️ License

This project is licensed under the [MIT License](LICENSE).
Built with ❤️ by [indie indie](https://github.com/kt3v).
