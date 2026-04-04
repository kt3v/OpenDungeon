# Mechanics

A **Mechanic** is the core extension primitive in OpenDungeon. It is a self-contained gameplay system that plugs into the engine's lifecycle without modifying any engine code.

Think of it like a Unity `MonoBehaviour` or an Unreal `ActorComponent` — you define the behavior, the engine calls your hooks at the right moments.

---

## Interface

```typescript
interface Mechanic {
  id: string;

  hooks?: {
    onCharacterCreated?(ctx: CharacterCreatedContext): Promise<StatePatch | void>;
    onSessionStart?(ctx: BaseContext): Promise<StatePatch | void>;
    onSessionEnd?(ctx: SessionEndContext): Promise<StatePatch | void>;
    onActionSubmitted?(action: PlayerAction, ctx: ActionContext): Promise<PlayerAction | null>;
    onActionResolved?(result: ActionResult, ctx: ActionContext): Promise<ActionResult>;
  };

  actions?: Record<string, {
    description: string;
    validate?(ctx: ActionContext): true | string;
    resolve(ctx: ActionContext): Promise<ActionResult>;
  }>;

  dmPromptExtension?(ctx: { worldState: Record<string, unknown> }): string;
}
```

Use `defineMechanic()` for full type inference:

```typescript
import { defineMechanic } from "@opendungeon/content-sdk";

export const myMechanic = defineMechanic({
  id: "my-mechanic",
  // ...
});
```

---

## Hooks

### `onCharacterCreated`

Called once when a player creates a character for a campaign. There is no session yet at this point.

Use it to give starting equipment, initialize per-player persistent state, or apply class-specific world patches before the first run.

```typescript
onCharacterCreated: async (ctx) => {
  const gear: Record<string, { id: string; label: string }[]> = {
    Warrior: [{ id: "iron_shield", label: "Iron Shield" }],
    Mage:    [{ id: "spell_tome",  label: "Worn Spell Tome" }],
    Ranger:  [{ id: "quiver",     label: "Quiver of Arrows" }]
  };

  const startingGear = gear[ctx.character.className] ?? [];
  if (startingGear.length === 0) return;

  const persistedKey = `persistedLoot_${ctx.playerId}`;
  const existing = Array.isArray(ctx.worldState[persistedKey])
    ? ctx.worldState[persistedKey] as unknown[]
    : [];

  return {
    worldPatch: {
      [persistedKey]: [...existing, ...startingGear]
    }
  };
}
```

**Context:**
```typescript
{
  tenantId: string;
  campaignId: string;
  playerId: string;
  character: CharacterInfo;  // id, name, className, level, hp
  worldState: Record<string, unknown>;
}
```

Note: no `sessionId` — character creation happens outside of a session.

---

### `onSessionStart`

Called once when a session is created. Use it to initialize session-scoped state.

```typescript
onSessionStart: async (ctx) => {
  return {
    worldPatch: {
      sessionLoot: [],
      monstersDefeated: 0
    }
  };
}
```

Return a `StatePatch` (with optional `worldPatch`) to apply changes to the world state before the session begins. Return nothing or `void` if no changes are needed.

The engine applies patches from all mechanics in order, so each mechanic sees the accumulated state from previous ones.

---

### `onSessionEnd`

Called when a session ends — either via a mechanic action (`result.endSession`), or via `POST /sessions/:id/end`.

The `ctx.reason` tells you why the session ended:

| Reason | Description |
|---|---|
| `"extraction_success"` | Player successfully extracted from the dungeon |
| `"player_death"` | Player died |
| `"campaign_complete"` | Campaign objectives met |
| `"abandoned"` | Session abandoned |
| `"manual"` | Owner ended the session manually |

```typescript
onSessionEnd: async (ctx) => {
  if (ctx.reason !== "extraction_success") {
    return; // Lost run — no loot transfer
  }

  // Transfer session loot to persistent storage
  const sessionLoot = Array.isArray(ctx.worldState.sessionLoot)
    ? ctx.worldState.sessionLoot : [];
  const persistedKey = `persistedLoot_${ctx.playerId}`;
  const existing = Array.isArray(ctx.worldState[persistedKey])
    ? ctx.worldState[persistedKey] as unknown[] : [];

  return {
    worldPatch: {
      sessionLoot: [],
      [persistedKey]: [...existing, ...sessionLoot]
    }
  };
}
```

---

### `onActionSubmitted`

Called before the action reaches the DM or any mechanic action resolver. Runs for every action.

**Return the action** (possibly modified) to let it continue:

```typescript
onActionSubmitted: async (action, ctx) => {
  // Normalize action text
  return { ...action, text: action.text.trim().toLowerCase() };
}
```

**Return `null`** to block the action entirely:

```typescript
onActionSubmitted: async (action, ctx) => {
  if (ctx.worldState.playerStunned) {
    return null; // Engine returns a generic "blocked" message
  }
  return action;
}
```

Multiple mechanics can chain this hook. The output of each becomes the input of the next.

---

### `onActionResolved`

Called after every resolved action — whether it was handled by a mechanic or the DM. Use it to post-process results.

```typescript
onActionResolved: async (result, ctx) => {
  // Collect loot the DM found during this turn
  const lootFound = result.worldPatch?.lootFound;
  if (Array.isArray(lootFound) && lootFound.length > 0) {
    const current = Array.isArray(ctx.worldState.sessionLoot)
      ? ctx.worldState.sessionLoot : [];

    const { lootFound: _, ...restPatch } = result.worldPatch ?? {};
    return {
      ...result,
      worldPatch: {
        ...restPatch,
        sessionLoot: [...current, ...lootFound]
      }
    };
  }
  return result;
}
```

Multiple mechanics chain this hook. Each gets the result of the previous one.

---

## Named actions

Mechanics can register named actions. The engine routes to these **before calling the DM**, so they are fast (no LLM call) and deterministic.

```typescript
actions: {
  extract: {
    description: "Exit the dungeon and keep your session loot",

    // validate() runs first — return true to allow, string to reject
    validate: (ctx) => {
      if (ctx.worldState.nearExit !== true) {
        return "You must reach an exit point before you can extract.";
      }
      return true;
    },

    resolve: async (ctx) => {
      const loot = Array.isArray(ctx.worldState.sessionLoot)
        ? ctx.worldState.sessionLoot : [];

      return {
        message: `You escape with ${loot.length} item(s).`,
        endSession: "extraction_success"  // ← triggers onSessionEnd pipeline
      };
    }
  }
}
```

### How routing works

When a player submits an action, the engine checks in this order:

1. **Explicit routing** — `mechanicActionId` in the request body, e.g. `"extraction.extract"` (format: `"<mechanicId>.<actionId>"`). The client sends this when the player clicks a suggested action button.
2. **Text match** — `actionText` exactly matches a registered action id (case-insensitive).
3. **DM** — no match → send to LLM.

Mechanics earlier in the `mechanics: []` array take priority for text-match routing.

---

## DM prompt extension

Every mechanic can append text to the DM system prompt. This is called every turn and receives the current world state.

```typescript
dmPromptExtension: ({ worldState }) => {
  const loot = Array.isArray(worldState.sessionLoot)
    ? worldState.sessionLoot : [];

  return [
    "## Extraction Rules",
    "- Exit points exist in the dungeon. When the player reaches one, include `\"nearExit\": true` in worldPatch.",
    "- When the player finds an item, add it to `lootFound` array in worldPatch.",
    `- Current session loot: ${loot.length} item(s).`
  ].join("\n");
}
```

The final system prompt is:
```
<base prompt from dm-config>

<mechanic 1 extension>

<mechanic 2 extension>
```

Use this to:
- Tell the DM about new world state fields your mechanic uses
- Provide the DM with mechanic-specific rules
- Give the DM current counts or status it should reference in narration

---

## Context types

### `BaseContext`

Available in `onSessionStart`:

```typescript
{
  tenantId: string;
  campaignId: string;
  sessionId: string;
  playerId: string;
  worldState: Record<string, unknown>;
}
```

### `ActionContext`

Available in `onActionSubmitted`, `onActionResolved`, and `actions.*.validate/resolve`:

```typescript
{
  // All BaseContext fields, plus:
  character: {
    id: string;
    name: string;
    className: string;
    level: number;
    hp: number;
  };
  actionText: string;   // the original submitted text
}
```

### `SessionEndContext`

Available in `onSessionEnd`:

```typescript
{
  // All BaseContext fields, plus:
  reason: SessionEndReason;
}
```

---

## ActionResult

Every action resolver (mechanic or DM) returns an `ActionResult`:

```typescript
{
  message: string;                      // player-facing narration (required)
  worldPatch?: Record<string, unknown>; // merged into session world state
  suggestedActions?: SuggestedAction[]; // replaces current suggested actions
  summaryPatch?: {
    shortSummary: string;               // one-sentence session summary
    latestBeat?: string;                // what just happened
  };
  endSession?: SessionEndReason;        // triggers session-end pipeline
}
```

---

## StatePatch

Returned by `onSessionStart` and `onSessionEnd`:

```typescript
{
  worldPatch?: Record<string, unknown>;
}
```

---

## Mechanic ordering

Mechanics in the `mechanics: []` array are evaluated in order for all hooks and routing. This means:

- **Hooks** run sequentially: mechanic 0 → mechanic 1 → ... Each gets the output of the previous one.
- **Action routing** tries mechanic 0 first, then mechanic 1, etc. The first match wins.
- **DM prompt extensions** are appended in array order.

Put more specific or high-priority mechanics first. In `game-classic`:

```typescript
mechanics: [explorationMechanic, extractionMechanic]
```

`exploration` handles `look`/`listen`/`inspect_door` without calling the LLM. `extraction` tracks loot in `onActionResolved` and surfaces the extract action near exits.

---

## Example: Full extraction mechanic

The extraction mechanic from `game-classic` demonstrates all four extension points:

```typescript
export const extractionMechanic = defineMechanic({
  id: "extraction",

  hooks: {
    // Reset session loot at the start of every run
    onSessionStart: async () => ({
      worldPatch: { sessionLoot: [], nearExit: false }
    }),

    // Collect loot the DM discovered, surface extract action near exits
    onActionResolved: async (result, ctx) => {
      // ... collect lootFound from worldPatch into sessionLoot
      // ... if nearExit, inject extract into suggestedActions
      return result;
    },

    // On successful extraction, persist loot across sessions
    onSessionEnd: async (ctx) => {
      if (ctx.reason !== "extraction_success") return;
      // ... move sessionLoot into persistedLoot_<playerId>
      return { worldPatch: { sessionLoot: [], [persistedKey]: [...] } };
    }
  },

  // Named action — runs without calling the DM
  actions: {
    extract: {
      description: "Exit the dungeon and keep your session loot",
      validate: (ctx) => ctx.worldState.nearExit === true || "Not near an exit",
      resolve: async (ctx) => ({
        message: "You escape with your loot.",
        endSession: "extraction_success"
      })
    }
  },

  // Teach the DM about extraction rules
  dmPromptExtension: ({ worldState }) => `
## Extraction Rules
- Include "nearExit": true in worldPatch when the player reaches an exit.
- Include "lootFound": [{id, label}] in worldPatch when the player finds items.
- Current session loot: ${(worldState.sessionLoot as unknown[] ?? []).length} item(s).
  `.trim()
});
```

---

## Example: Simple deterministic mechanic

Not every mechanic needs LLM involvement. The exploration mechanic handles `look`, `listen`, and `inspect_door` purely in code:

```typescript
export const explorationMechanic = defineMechanic({
  id: "exploration",

  actions: {
    look: {
      description: "Observe your surroundings",
      resolve: async (ctx) => ({
        message: "You scan the torchlit corridor...",
        worldPatch: { lastObservation: "iron_door" },
        suggestedActions: [
          { id: "exploration.inspect_door", label: "Inspect door", prompt: "inspect the iron door" },
          { id: "advance", label: "Move north", prompt: "push open the door" }
        ]
      })
    }
  }
});
```

When the player clicks "Look Around", the engine routes to `exploration.look` and returns immediately — no LLM call, no latency.

---

## Tips

**Keep mechanics focused.** One mechanic = one system. Don't put combat, inventory, and extraction in the same mechanic.

**Use `dmPromptExtension` to close the loop with the LLM.** If your mechanic reads `worldState.nearExit`, you need to tell the DM to write it. Otherwise the field will never appear.

**Mechanic actions are for explicit player choices.** Use them for actions the player deliberately triggers (extract, revive, open inventory). Let the DM handle free-text exploration and combat narration.

**World state is flat JSON.** Namespace your keys to avoid collisions between mechanics. Convention: `persistedLoot_<playerId>`, `lastObservation`, `nearExit`.

**`onActionResolved` is your best tool.** It runs after every turn — from both mechanics and the DM. Use it to interpret DM output and translate it into mechanic state.
