# @opendungeon/shared

Shared schemas, constants, and utilities for the OpenDungeon RPG engine.

## Features

- **Zod Schemas**: Robust validation for game manifests, events, and state.
- **TypeScript Types**: Shared type definitions used across the entire ecosystem.
- **Constants**: Centralized configuration for the OpenDungeon framework.

## Installation

```bash
npm install @opendungeon/shared
```

## Usage

```typescript
import { moduleManifestSchema } from '@opendungeon/shared';

// Validate a game module manifest
const result = moduleManifestSchema.safeParse(myManifest);
```
