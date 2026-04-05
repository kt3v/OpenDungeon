# OpenDungeon

The full-stack, LLM-powered RPG engine for creating procedurally generated and narrative-driven games.

## Why OpenDungeon?

OpenDungeon combines classic RPG mechanics with modern AI capabilities. It allows developers to build worlds that aren't just static maps, but living environments where narratives evolve based on player actions.

## Key Components

- **@opendungeon/engine-core**: The "Dungeon Master" logic.
- **@opendungeon/architect**: AI-assisted world building and campaign generation.
- **@opendungeon/content-sdk**: Tools for defining your own classes, items, and locations.
- **@opendungeon/providers-llm**: Ready-to-use abstractions for OpenAI, Anthropic, and other LLM providers.

## Quick Start

### Installation

```bash
pnpm add opendungeon
```

### Basic Example

```typescript
import { DungeonMaster, createLlmProvider } from 'opendungeon';

// 1. Setup AI
const llm = createLlmProvider({ type: 'openai', apiKey: '...' });

// 2. Initialize Engine
const dm = new DungeonMaster({
  llmProvider: llm,
  gameModulePath: './my-module'
});

// 3. Process Player Action
const result = await dm.processAction(currentState, { actionText: "explore the ruins" });
console.log(result.event.message);
```

## Community and Links

- **GitHub**: [kt3v/OpenDungeon](https://github.com/kt3v/OpenDungeon)
- **Issues**: [Bug Reports](https://github.com/kt3v/OpenDungeon/issues)
- **Author**: indie indie

## License

MIT
