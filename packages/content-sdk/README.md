# @opendungeon/content-sdk

SDK for creating game content, classes, locations, and mechanics for the OpenDungeon engine.

## Features

- **Class Definition**: Tools to define RPG classes, stats, and abilities.
- **Location Mapping**: Framework for defining world structures and exploration logic.
- **Mechanics Hooking**: Standard interfaces for custom game logic.

## Installation

```bash
npm install @opendungeon/content-sdk
```

## Usage

```typescript
import { createClass, createLocation } from '@opendungeon/content-sdk';

// Example: Define a new character class
const warrior = createClass({
  id: 'warrior',
  name: 'Warrior',
  baseStats: { strength: 10, agility: 5 }
});
```
