# Contributing to OpenDungeon

Welcome! We are excited to have you contribute to the open-source platform for AI-powered RPGs.

## 🛠 Local Development Setup

OpenDungeon is a monorepo managed with **pnpm** and **Turbo**.

1. **Fork and Clone**:
   ```bash
   git clone https://github.com/your-username/OpenDungeon.git
   cd OpenDungeon
   ```
2. **Install Dependencies**:
   ```bash
   pnpm install
   ```
3. **Environment Setup**:
   Ensure Docker is running (for PostgreSQL), then run:
   ```bash
   pnpm od setup
   pnpm od configure llm
   ```
4. **Run Development Mode**:
   ```bash
   pnpm dev:full
   ```

## 🏗 Repository Structure

- `apps/`: Gateway (Stateful API) and Web (Next.js UI).
- `packages/`:
  - `engine-core/`: Turn pipeline, DM logic, and context routing.
  - `content-sdk/`: Public API for mechanics and module development.
  - `providers-llm/`: Resilience layer (Retry, Circuit Breaker, Fallback).
  - `shared/`: Shared schemas and types.
  - `devtools/`: The `od` CLI and architect tools.
- `docs/`: 
  - `engine-dev/`: Engine architecture and internal systems.
  - `game-dev/`: Guides for creating games, mechanics, and indicators.

## 📝 Guidelines

### 1. Code Style & Quality
- Follow existing TypeScript conventions.
- Use **pnpm** for package management.
- **Verify before submitting**:
  ```bash
  pnpm lint      # Check code style
  pnpm typecheck # Check TypeScript types
  pnpm build     # Ensure all packages build correctly
  ```

### 2. Pull Requests
- Keep PRs focused on a single feature or bug fix.
- **Documentation**: Update relevant files in `docs/` if you change any APIs or engine behavior.
- Provide a clear description of the changes and how you verified them.

### 3. Adding Game Modules
If you are developing a new game module, follow the [Creating a Game](docs/game-dev/creating-a-game.md) guide. We encourage sharing modules as separate repositories or pull requests if they serve as quality examples.

## ⚖️ License
By contributing, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
