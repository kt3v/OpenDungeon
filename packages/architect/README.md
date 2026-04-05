# @opendungeon/architect

Campaign generation and world-building engine for OpenDungeon.

## Features

- **World Builder**: Procedural and LLM-assisted creation of RPG worlds.
- **Campaign Management**: Dynamic story generation based on player actions.
- **Chronicler**: Record and maintain the history and lore of the generated world.

## Installation

```bash
pnpm add @opendungeon/architect
```

## Usage

```typescript
import { WorldBuilder } from '@opendungeon/architect';

const builder = new WorldBuilder(llmProvider, dbClient);
const campaign = await builder.generateCampaign('the-lost-kingdom');
```
