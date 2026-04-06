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
   Ensure Docker is running, then run:
   ```bash
   pnpm od setup
   pnpm od configure llm
   ```
4. **Run Development Mode**:
   ```bash
   pnpm dev:full
   ```

## 🏗 Repository Structure

- `apps/`: Gateway (API) and Web (UI).
- `packages/`: Core engine, SDK, LLM providers, and shared types.
- `docs/`: In-depth documentation for architecture and mechanics.

## 📝 Guidelines

### 1. Code Style
- Follow existing TypeScript conventions.
- Use **pnpm** for package management.
- Ensure all packages build before submitting a PR (`pnpm build`).

### 2. Pull Requests
- Keep PRs focused on a single feature or bug fix.
- Update documentation if you are changing the SDK or Engine API.
- Provide a clear description of the change.

### 3. Adding Game Modules
If you are developing a new game module, follow the [Creating a Game](docs/creating-a-game.md) guide. We encourage you to share your modules as separate repositories or pull requests if they serve as good examples.

## ⚖️ License
By contributing, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
