# @opendungeon/engine-core

The core gameplay engine for OpenDungeon, responsible for managing the state, actions, and events of the game.

## Features

- **Dungeon Master**: Orchestrates game logic and narrative progression.
- **Event Compressor**: Aggregates game events for optimized transmission.
- **Lore Extractor**: Extracts relevant information from gameplay for persistent world memory.

## Installation

```bash
npm install @opendungeon/engine-core
```

## Usage

```typescript
import { DungeonMaster } from '@opendungeon/engine-core';

// Initialize the core engine
const dm = new DungeonMaster(config);
const newState = await dm.processAction(currentState, action);
```
