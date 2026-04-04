# @opendungeon/providers-llm

LLM provider abstractions and implementations for OpenDungeon.

## Features

- **Standard Interface**: Common abstractions for LLM interaction.
- **Provider Support**: Ready-to-use providers for popular LLM APIs.
- **Prompt Engineering**: Managed system prompts for OpenDungeon's specific use cases.

## Installation

```bash
npm install @opendungeon/providers-llm
```

## Usage

```typescript
import { createLlmProvider } from '@opendungeon/providers-llm';

const provider = createLlmProvider({
  type: 'openai',
  apiKey: process.env.OPENAI_API_KEY
});

const response = await provider.complete('Hello, Dungeon Master!');
```
