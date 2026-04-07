# Creating Mechanics for OpenDungeon

> A step-by-step guide for game developers. Even if you've never written TypeScript before — you'll understand this.

---

## What is a "mechanic"?

A **mechanic** = a game rule written in code.

Examples of mechanics:
- Player finds a chest → gets loot
- Player rests → recovers health
- Player reaches the exit → can end the run

Mechanics live in the `src/mechanics/*.ts` folder of your game (or wherever you define your logic).

---

## Minimal mechanic (Hello World)

```typescript
// src/mechanics/hello.ts
import { defineMechanic } from "@opendungeon/content-sdk";

export const helloMechanic = defineMechanic({
  id: "hello",  // unique mechanic name
  
  actions: {
    // Action "greet"
    // Triggered if player types "greet" or "hello.greet"
    greet: {
      description: "Greet the world",  // DM will see this description
      resolve: async () => ({
        message: "You shout loudly: 'Hello, world!'"
      })
    }
  }
});
```

**What happens:**
1. Player types "greet" or clicks a button with ID `hello.greet`
2. DM (LLM) sees the available action `hello.greet` in its tool list
3. If the intent matches, the engine invokes `resolve`
4. Player sees the message: "You shout loudly..."

---

## Anatomy of a mechanic

```typescript
defineMechanic({
  id: "unique-name",     // ← required
  
  hooks: {               // ← hooks (optional)
    onCharacterCreated, // when character is created
    onSessionStart,     // when game session starts
    onSessionEnd,       // when session ends
    onActionSubmitted,  // before each action
    onActionResolved    // after each action
  },
  
  actions: {           // ← actions (optional)
    actionName: {
      description: "...",   // description for DM
      // paramSchema is supported by engine but args are not yet 
      // passed to resolve in SDK v0.1.x
      validate: (ctx) => ..., // validation (optional)
      resolve: async (ctx) => ({ ... })  // logic
    }
  }
});
```

---

## Hooks: when things fire

### 1. onCharacterCreated — starting setup

Called **once** when the player creates a character. Used for starting gear and initial location.

```typescript
hooks: {
  onCharacterCreated: async (ctx) => {
    // ctx.characterClass — selected class (Warrior, Mage...)
    
    const startingGear = {
      Warrior: [{ id: "sword", label: "Rusty Sword" }],
      Mage: [{ id: "staff", label: "Ancient Staff" }]
    };
    
    const gear = startingGear[ctx.characterClass] ?? [];
    
    return {
      // characterState — personal character state
      characterState: {
        inventory: gear,
        gold: 10
      },
      
      // Starting location for this player
      location: "dungeon_entrance",
      
      // worldPatch — shared world (visible to all players)
      worldPatch: {
        [`player_${ctx.playerId}_joined`]: true
      }
    };
  }
}
```

---

### 2. onSessionStart — start of a run

Called at the beginning of each game session.

```typescript
hooks: {
  onSessionStart: async (ctx) => {
    return {
      worldPatch: {
        sessionLoot: [],      // loot found this run
        dangerLevel: 1
      }
    };
  }
}
```

---

### 3. onSessionEnd — end of a run

Called when session ends (death, victory, exit).

```typescript
hooks: {
  onSessionEnd: async (ctx) => {
    // ctx.reason: "extraction_success", "player_death", "abandoned", "manual"
    
    if (ctx.reason === "extraction_success") {
      const sessionLoot = ctx.worldState.sessionLoot ?? [];
      const key = `permanentLoot_${ctx.playerId}`;
      const existing = ctx.worldState[key] ?? [];
      
      return {
        worldPatch: {
          [key]: [...existing, ...sessionLoot],
          sessionLoot: []  // clear temporary
        }
      };
    }
    
    return {};
  }
}
```

---

### 4. onActionSubmitted — intercept actions

Called **before each action**. Can modify or block it.

```typescript
hooks: {
  onActionSubmitted: async (action, ctx) => {
    // action.text — what the player wrote
    
    if (ctx.characterState.hp <= 0) {
      return null;  // null = action blocked
    }
    
    // Auto-route specific phrases to mechanics
    if (action.text.toLowerCase() === "i want to rest") {
      return {
        ...action,
        mechanicActionId: "rest.rest"
      };
    }
    
    return action;
  }
}
```

---

### 5. onActionResolved — process results

Called **after every turn** (both mechanic actions and DM narrations).

```typescript
hooks: {
  onActionResolved: async (result, ctx) => {
    // If DM put lootFound in worldPatch, move it to our sessionLoot
    const lootFound = result.worldPatch?.lootFound;
    
    if (Array.isArray(lootFound) && lootFound.length > 0) {
      const currentLoot = ctx.worldState.sessionLoot ?? [];
      
      // Clean up the patch and update sessionLoot
      const { lootFound: _, ...cleanPatch } = result.worldPatch ?? {};
      
      return {
        ...result,
        worldPatch: {
          ...cleanPatch,
          sessionLoot: [...currentLoot, ...lootFound]
        }
      };
    }
    
    return result;
  }
}
```

---

## Actions

### Simple action

```typescript
actions: {
  rest: {
    description: "Rest and recover health",
    validate: (ctx) => {
      if (ctx.characterState.hp >= 100) return "You are already fully rested.";
      return true;
    },
    resolve: async (ctx) => ({
      message: "You rest. Health restored.",
      characterState: { hp: 100 }
    })
  }
}
```

### Action with result summary

You can update the game's "Latest Beat" or "Short Summary" which the DM uses for context.

```typescript
actions: {
  killBoss: {
    description: "Deliver the final blow to the boss",
    resolve: async () => ({
      message: "The Great Dragon falls with a thunderous crash!",
      worldPatch: { dragonDead: true },
      summaryPatch: {
        shortSummary: "The Dragon of Shadow has been defeated.",
        latestBeat: "The party stands victorious over the dragon's corpse."
      }
    })
  }
}
```

---

## ActionResult: what to return from resolve

```typescript
resolve: async (ctx) => ({
  // REQUIRED:
  message: "Text the player will see",
  
  // OPTIONAL:
  worldPatch: {               // shared world changes
    doorOpen: true
  },
  
  characterState: {          // personal changes (hp, inventory, etc)
    hp: 80
  },
  
  location: "dark_forest",   // move player to new location
  
  suggestedActions: [        // quick action buttons
    { id: "explore", label: "Explore", prompt: "look around the forest" }
  ],
  
  summaryPatch: {            // update adventure summary
    latestBeat: "You entered the Dark Forest."
  },
  
  endSession: "player_death" // end the session with a reason
});
```

---

## Best practices

### 1. Namespace your world keys
Avoid generic keys like `count`. Use `mechanicId_key` or `mechanicId_playerId_key`.

### 2. Default values
Always provide defaults when reading from state:
`const loot = (ctx.worldState.sessionLoot as any[]) ?? [];`

### 3. Teaching the DM
Since mechanics don't have a `dmPromptExtension` hook, use these methods to tell the DM how to use your mechanic:
- **`description`**: Keep action descriptions clear.
- **`dm.md`**: Add global rules to your game's main DM prompt.
- **Context Modules**: Create markdown files in `modules/` that are injected when specific keywords or world states are active.

Example `modules/loot-rules.md`:
```markdown
# Looting Rules
When the player finds an item, always add it to `lootFound` array in `worldPatch`.
Example: `{"lootFound": [{"id": "gold_coin", "label": "Gold Coin"}]}`
```

---

## Checklist before testing

- [ ] Mechanic is exported in your entry point
- [ ] `id` is unique and contains no dots (dots are used for routing: `mechanic.action`)
- [ ] All `validate` functions return `true` or an error string
- [ ] All `resolve` functions return an object with a `message`
- [ ] `worldState` keys are namespaced to avoid conflicts
