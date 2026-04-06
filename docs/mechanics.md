# Mechanics

> **vNext architecture (breaking change):** gameplay no longer runs through `skills/*.json`, `hooks/*.json`, or `rules/*.json`.
> Use routed Markdown context modules (`modules/*.md` / `contexts/*.md`) for narrative/gameplay guidance,
> and TypeScript mechanics (`src/mechanics/*.ts`) for deterministic logic.

## Control Plane

- `modules/*.md` + `dm.md`: LLM context and narrative policy (selected per turn by router)
- `src/mechanics/*.ts`: deterministic actions and lifecycle hooks executed by `EngineRuntime`
- `EngineRuntime`: orchestration authority (routing, execution order, patch merging)
- `Archivist`: post-DM curation stage for structured world/summary patch normalization

## Migration Note

If you still have legacy `skills`, `hooks`, or `rules` files, treat them as deprecated content and migrate behavior to:
- markdown modules for instruction/context,
- TypeScript mechanics for exact state transitions.

Gameplay now uses two primary layers:

1. **Markdown context modules** (`modules/*.md` / `contexts/*.md`) — guidance, policy, and narrative rules selected by router.
2. **TypeScript mechanics** (`src/mechanics/*.ts`) — deterministic actions and lifecycle hooks executed by runtime.

Use Markdown for flexible content behavior and TypeScript whenever correctness or branching rules must be exact.

---

## TypeScript mechanics

Use a TypeScript mechanic when JSON isn't enough: cross-session persistence, intercepting DM output, stateful multi-step logic.

A mechanic is a plain object with an `id` and optional `hooks`, `actions`, and `dmPromptExtension`. Use `defineMechanic()` for full type inference:

```typescript
import { defineMechanic } from "@opendungeon/content-sdk";

export const myMechanic = defineMechanic({
  id: "my-mechanic",
  hooks: { … },
  actions: { … },
  dmPromptExtension: ({ worldState }) => "…"
});
```

### Hooks

| Hook | When it runs | What it can do |
|------|-------------|----------------|
| `onCharacterCreated` | Once, when player joins a campaign | Give starting gear, init per-player state |
| `onSessionStart` | Start of each session | Reset session-scoped state |
| `onActionSubmitted` | Before every action | Modify or block the action |
| `onActionResolved` | After every action (mechanic or DM) | Post-process result, add suggested actions |
| `onSessionEnd` | When session ends | Persist loot, record stats |

Hooks from all mechanics run in the order mechanics appear in `mechanics: []`. Each hook receives the accumulated output of previous mechanics.

#### `onCharacterCreated`

```typescript
onCharacterCreated: async (ctx) => {
  const gear = { Warrior: [{ id: "shield", label: "Iron Shield" }] };
  const startingGear = gear[ctx.character.className] ?? [];
  return {
    worldPatch: { [`persistedLoot_${ctx.playerId}`]: startingGear }
  };
}
```

No session exists yet at this point. Patch `worldPatch` to set up per-player persistent state.

#### `onSessionStart`

```typescript
onSessionStart: async (ctx) => ({
  worldPatch: { sessionLoot: [], nearExit: false }
})
```

#### `onActionSubmitted`

Return the action (possibly modified) to continue, or `null` to block:

```typescript
onActionSubmitted: async (action, ctx) => {
  if (ctx.worldState.playerStunned) return null; // blocked, generic message shown
  return action; // continue
}
```

#### `onActionResolved`

Runs after every turn — regardless of whether a mechanic or the DM handled it. This is the best hook for interpreting DM output:

```typescript
onActionResolved: async (result, ctx) => {
  // The DM wrote lootFound into worldPatch — collect it
  const lootFound = result.worldPatch?.lootFound;
  if (Array.isArray(lootFound) && lootFound.length > 0) {
    const current = Array.isArray(ctx.worldState.sessionLoot) ? ctx.worldState.sessionLoot : [];
    const { lootFound: _, ...restPatch } = result.worldPatch ?? {};
    return { ...result, worldPatch: { ...restPatch, sessionLoot: [...current, ...lootFound] } };
  }
  return result;
}
```

#### `onSessionEnd`

```typescript
onSessionEnd: async (ctx) => {
  if (ctx.reason !== "extraction_success") return;
  const sessionLoot = Array.isArray(ctx.worldState.sessionLoot) ? ctx.worldState.sessionLoot : [];
  return {
    worldPatch: {
      sessionLoot: [],
      [`persistedLoot_${ctx.playerId}`]: [...(ctx.worldState[`persistedLoot_${ctx.playerId}`] as unknown[] ?? []), ...sessionLoot]
    }
  };
}
```

Session end reasons: `"extraction_success"` · `"player_death"` · `"campaign_complete"` · `"abandoned"` · `"manual"`

### Named actions

Mechanics can register actions that the engine invokes without an LLM call. The DM receives these as available tools and can call them when appropriate.

```typescript
actions: {
  extract: {
    description: "Exit the dungeon and keep your session loot",
    validate: (ctx) => ctx.worldState.nearExit === true || "Reach an exit first.",
    resolve: async (ctx) => {
      const count = (ctx.worldState.sessionLoot as unknown[] ?? []).length;
      return {
        message: `You escape with ${count} item(s).`,
        endSession: "extraction_success"
      };
    }
  }
}
```

The routing key for a named action is `"<mechanicId>.<actionId>"`, e.g. `"extraction.extract"`.

### How routing works

```
1. Client sends mechanicActionId (e.g. a UI button press)
        → mechanic runs directly, no LLM call

2. No explicit mechanicActionId
        → DM sees the player's action + list of all available mechanic tools
        → DM decides: call a mechanic (mechanicCall) or narrate freely

3. onActionResolved hooks run on the result, regardless of source
```

The DM understands intent — players can write in any language or phrasing. You don't need to register every possible synonym for "look around".

### `dmPromptExtension`

A function that receives the current `worldState` and returns a markdown string appended to the DM system prompt every turn. Use it to give the DM the context it needs:

```typescript
dmPromptExtension: ({ worldState }) => {
  const loot = Array.isArray(worldState.sessionLoot) ? worldState.sessionLoot : [];
  return [
    "## Extraction Rules",
    "- When player reaches an exit: set `nearExit: true` in worldPatch.",
    "- When player finds an item: add it to `lootFound` array in worldPatch.",
    `- Session loot so far: ${loot.length} item(s).`
  ].join("\n");
}
```

### `ActionResult`

```typescript
interface ActionResult {
  message: string;                       // player-facing narration (required)
  worldPatch?: Record<string, unknown>;  // merged into shared world state
  characterState?: Record<string, unknown>; // merged into this session's character state only
  suggestedActions?: SuggestedAction[];  // replaces current suggested action buttons
  summaryPatch?: { shortSummary: string; latestBeat?: string };
  endSession?: SessionEndReason;         // triggers the session-end pipeline
  handledByMechanic?: boolean;           // set by engine; true when a mechanic handled this turn
}
```

`worldPatch` is **shared** — all players in the campaign see it. `characterState` is **private** — only visible to this session. Use `characterState` for session-local state like `nearExit`, `sessionLoot`, personal flags.

---

## Choosing the right tool

| Situation | Use |
|-----------|-----|
| Teaching the DM a concept (stealth, bargaining, diplomacy) | Context module (`modules/*.md`) |
| Narrative guidance that applies only in certain situations | Context module with `triggers:` frontmatter |
| Give starting gear or set initial character state | TypeScript mechanic (`onCharacterCreated`) |
| Reset per-session state at the start of each run | TypeScript mechanic (`onSessionStart`) |
| Simple action with a fixed outcome (rest, pick up item) | TypeScript mechanic, named action |
| React to session end (cleanup, loot persistence) | TypeScript mechanic (`onSessionEnd`) |
| HP drain, stamina loss, status ticking per action | TypeScript mechanic (`onActionResolved`) |
| Death / win condition check after each action | TypeScript mechanic (`onActionResolved`) + `endSession` |
| Turn counters and timed events | TypeScript mechanic (`onActionResolved`) |
| Cross-session persistence (loot that survives between runs) | TypeScript mechanic (`onSessionEnd`) |
| Intercepting and modifying DM output | TypeScript mechanic (`onActionResolved`) |
| Blocking or modifying incoming actions | TypeScript mechanic (`onActionSubmitted`) |
| Dynamic suggested actions based on complex state | TypeScript mechanic (`onActionResolved`) |
| Multi-field conditions or computed values | TypeScript mechanic (`onActionResolved`) |

---

## Tips

**Namespace your worldState keys.** Multiple mechanics share the same flat object. Use prefixes: `persistedLoot_<playerId>`, `extraction_nearExit`, `location_current`.

**Use `dmPromptExtension` to close the loop.** If your mechanic reads `worldState.nearExit`, teach the DM to write it. Otherwise the field will never appear.

**`onActionResolved` is your most powerful hook.** It runs after every turn, from both mechanics and the DM. Use it to interpret DM output and translate it into mechanic state.

**Keep mechanics focused.** One mechanic = one system. Don't put combat, inventory, and extraction in the same file.
