# OpenDungeon

OpenDungeon is an engine-first, open-source platform for building and running AI-powered multiplayer tabletop RPG campaigns.

The core philosophy: **Separation of Engine and Content**. You develop game rules, classes, and prompts in a separate module without touching the engine internals.

## 🏗 Project Structure

### Apps
- **`apps/gateway`**: Primary API server with persistence (Prisma/Postgres). Handles auth, campaigns, and session management.
- **`apps/orchestrator`**: Stateless engine runtime. Designed to scale multiplayer sessions (one instance per session) without DB overhead.
- **`apps/web`**: Next.js reference client for playable flows.

### Engine (Core Packages)
- **`packages/engine-core`**: The heart of the platform. Orchestrates turns, mechanics, and LLM interactions.
- **`packages/content-sdk`**: The API surface for game developers. Types and helpers to build game modules.
- **`packages/providers-llm`**: Abstraction layer for AI models (OpenAI, Anthropic, Mock).
- **`packages/shared`**: Shared Zod schemas and TypeScript types.

### Tools & Content
- **`packages/game-classic`**: Reference game module implementation.
- **`packages/architect`**: AI-powered content generation tool for developers (module design-time).
- **`packages/devtools`**: CLI tools for managing the OpenDungeon workspace.

## 🚀 Quick Start

Ensure you have [Docker](https://www.docker.com/) and [pnpm](https://pnpm.io/) installed.

```bash
# 1. Install dependencies
pnpm install

# 2. Check environment and ports
pnpm doctor

# 3. Setup local database and environment
pnpm setup

# 4. Configure LLM provider
pnpm llm:setup

# 5. Launch Gateway and Web Client
pnpm dev:full
```
Open `http://localhost:3000` to start your first campaign.

## 🛠 Developing Modules

OpenDungeon loads gameplay from the path specified in `GAME_MODULE_PATH` (defaults to `./packages/game-classic`).

To create your own module:
```bash
pnpm run create:game-module -- ../my-dungeon-module
```

## 📖 Documentation
- [Architecture](docs/architecture.md) — Detailed system design.
- [Creating a Game](docs/creating-a-game.md) — Guide for module developers.
- [Mechanics](docs/mechanics.md) — How to extend gameplay logic.

## ⚖️ License
This project is licensed under the [MIT License](LICENSE).
