# @opendungeon/game-classic

The classic RPG module for the OpenDungeon engine, providing a baseline fantasy experience.

## Features

- **Classes**: Fighter, Mage, Thief, and more.
- **Locations**: Dungeons, forests, and villages.
- **Mechanics**: Exploration, combat, and lore extraction.

## Installation

```bash
npm install @opendungeon/game-classic
```

## Usage

In your OpenDungeon instance, register the classic module:

```typescript
import classicModule from '@opendungeon/game-classic';

// Add to your engine's module list
engine.registerModule(classicModule);
```
