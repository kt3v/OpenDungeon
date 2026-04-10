# Mechanics Guide (Strict StateOps)

Mechanics are deterministic TypeScript logic. In strict mode, mechanics mutate game state only via `stateOps`.

## Core principle

- Do not return `worldPatch` or free-form state objects.
- Return `stateOps` with valid `varId` values declared in `content/state/*.json`.

## Minimal action example

```ts
actions: {
  rest: {
    description: "Rest and recover health",
    validate: (ctx) => (Number(ctx.characterState.hp) >= 100 ? "You are already fully rested." : true),
    resolve: async () => ({
      message: "You rest. Health restored.",
      stateOps: [{ op: "set", varId: "hp", value: 100 }]
    })
  }
}
```

## Hooks

### `onCharacterCreated`

```ts
onCharacterCreated: async (ctx) => ({
  stateOps: [
    { op: "set", varId: "inventory", value: [{ id: "sword", label: "Rusty Sword" }] },
    { op: "set", varId: "gold", value: 10 },
    { op: "set", varId: "location", value: "dungeon_entrance" }
  ]
})
```

### `onSessionStart`

```ts
onSessionStart: async () => ({
  stateOps: [
    { op: "set", varId: "sessionLoot", value: [] },
    { op: "set", varId: "nearExit", value: false }
  ]
})
```

### `onActionResolved`

```ts
onActionResolved: async (result, ctx) => {
  const hp = Number(ctx.characterState.hp ?? 0);
  if (hp <= 0) {
    return {
      ...result,
      endSession: "player_death"
    };
  }
  return result;
}
```

### `onSessionEnd`

```ts
onSessionEnd: async () => ({
  stateOps: [
    { op: "set", varId: "sessionLoot", value: [] },
    { op: "set", varId: "nearExit", value: false }
  ]
})
```

## ActionResult reference

```ts
resolve: async () => ({
  message: "Text the player sees",
  stateOps: [
    { op: "inc", varId: "stress", value: 10 },
    { op: "dec", varId: "oxygen", value: 5 }
  ],
  suggestedActions: [{ id: "explore", label: "Explore", prompt: "look around" }],
  summaryPatch: { latestBeat: "You entered the Dark Forest." },
  endSession: "manual"
})
```

## Operation semantics

- `set`: assign exact value
- `inc`: add numeric delta
- `dec`: subtract numeric delta
- `append`: push item to list
- `remove`: remove matching item from list

## Best practices

- Keep variable IDs stable and explicit (`mission.timeRemaining`, `playerLocation.current`).
- Keep `writableBy` minimal for safety.
- Keep narrative and mutations aligned (if text says oxygen dropped, emit corresponding `dec oxygen`).
- Use mechanics for deterministic math/rules; let DM handle narrative and tool routing.

## Checklist

- [ ] Variable exists in `content/state/*.json`
- [ ] `stateOps.varId` matches declared ID exactly
- [ ] Actor is allowed by `writableBy`
- [ ] `resolve()` always returns `message`
- [ ] `validate()` returns `true` or string error
