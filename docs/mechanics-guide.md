# Creating Mechanics for OpenDungeon

> A step-by-step guide for game developers. Even if you've never written TypeScript before — you'll understand this.

---

## What is a "mechanic"?

A **mechanic** = a game rule written in code.

Examples of mechanics:
- Player finds a chest → gets loot
- Player rests → recovers health
- Player reaches the exit → can end the run

Mechanics live in the `src/mechanics/*.ts` folder of your game.

---

## Minimal mechanic (Hello World)

```typescript
// src/mechanics/hello.ts
import { defineMechanic } from "@opendungeon/content-sdk";

export const helloMechanic = defineMechanic({
  id: "hello",  // unique mechanic name
  
  actions: {
    // Action "greet"
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
1. Player types "greet the world" or clicks a button
2. DM (LLM) sees the available action `hello.greet`
3. DM decides to invoke this action → `resolve` runs
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
      paramSchema: {...},   // parameters (optional)
      validate: (ctx) => ..., // validation (optional)
      resolve: async (ctx) => ({ ... })  // logic
    }
  }
});
```

---

## Hooks: when things fire

### 1. onCharacterCreated — starting inventory

Called **once** when the player creates a character.

```typescript
hooks: {
  onCharacterCreated: async (ctx) => {
    // ctx.characterClass — selected class (Warrior, Mage...)
    // ctx.playerId — unique player ID
    
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
      
      // worldPatch — shared world (visible to all players)
      worldPatch: {
        [`player_${ctx.playerId}_joined`]: true
      }
    };
  }
}
```

**What's available in ctx:**
- `ctx.characterClass` — class name (string)
- `ctx.playerId` — player ID
- `ctx.campaignId` — campaign ID
- `ctx.worldState` — current world state (read-only)

**What you can return:**
- `characterState` — personal state (inventory, HP, location)
- `worldPatch` — changes to shared world

---

### 2. onSessionStart — start of a run

Called at the beginning of each game session.

```typescript
hooks: {
  onSessionStart: async (ctx) => {
    // Reset temporary loot for a new run
    return {
      worldPatch: {
        sessionLoot: [],      // loot found this run
        dangerLevel: 1,       // danger level
        roomsExplored: 0
      }
    };
  }
}
```

**Difference from onCharacterCreated:**
- `onCharacterCreated` — once when character is created
- `onSessionStart` — every time the player starts a new run

---

### 3. onSessionEnd — end of a run

Called when session ends (death, victory, exit).

```typescript
hooks: {
  onSessionEnd: async (ctx) => {
    // ctx.reason — why it ended
    // "extraction_success" — successful exit
    // "player_death" — death
    // "abandoned" — player left
    
    if (ctx.reason === "extraction_success") {
      // Save loot permanently
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
    
    // On death, loot is not saved — do nothing
    return {};
  }
}
```

**End reasons (ctx.reason):**
- `"extraction_success"` — successfully exited
- `"player_death"` — died
- `"abandoned"` — abandoned the game
- `"campaign_complete"` — campaign completed
- `"manual"` — manual end

---

### 4. onActionSubmitted — intercept actions

Called **before each action**. Can modify or block it.

```typescript
hooks: {
  onActionSubmitted: async (action, ctx) => {
    // action.text — what the player wrote
    
    // If player is stunned — block the action
    if (ctx.characterState.stunned) {
      return null;  // null = action blocked
    }
    
    // If player types "rest" in a dangerous zone — change to "panic"
    if (action.text.includes("rest") && ctx.worldState.inCombat) {
      return {
        ...action,
        text: "panic and look for cover"
      };
    }
    
    // Pass action through unchanged
    return action;
  }
}
```

**What to return:**
- `action` (modified or not) — continue
- `null` — block (player sees standard block message)

---

### 5. onActionResolved — process results

**The most powerful hook.** Called **after every turn** — whether from mechanic or DM.

Use for:
- Intercepting DM results
- Counting found loot
- Updating location
- Adding action buttons

```typescript
hooks: {
  onActionResolved: async (result, ctx) => {
    // result — turn result (what DM or mechanic returned)
    
    // DM put lootFound in world? Collect it into sessionLoot!
    const lootFound = result.worldPatch?.lootFound;
    if (Array.isArray(lootFound) && lootFound.length > 0) {
      const currentLoot = ctx.worldState.sessionLoot ?? [];
      
      // Remove lootFound from worldPatch (to not clutter)
      const { lootFound: _, ...cleanPatch } = result.worldPatch ?? {};
      
      return {
        ...result,
        worldPatch: {
          ...cleanPatch,
          sessionLoot: [...currentLoot, ...lootFound]
        }
      };
    }
    
    // DM moved the player? Move from shared world to personal state
    const newLocation = result.worldPatch?.location;
    if (typeof newLocation === "string") {
      const { location: _, ...rest } = result.worldPatch ?? {};
      return {
        ...result,
        worldPatch: rest,
        characterState: {
          ...result.characterState,
          location: newLocation
        }
      };
    }
    
    return result;
  }
}
```

**Important:** this hook sees DM results. If DM wrote "You found a golden sword" and put `lootFound` in the world — your mechanic can intercept and process it.

---

## Actions

Actions = what DM can invoke based on player intent.

### Simple action

```typescript
actions: {
  rest: {
    description: "Rest and recover health",
    resolve: async (ctx) => ({
      message: "You rest. Health restored.",
      characterState: { hp: 100 }
    })
  }
}
```

### Action with validation

```typescript
actions: {
  openChest: {
    description: "Open the chest",
    
    // Check before executing
    validate: (ctx) => {
      // Return true or error text
      if (ctx.worldState.chestOpen) {
        return "The chest is already open.";
      }
      if (ctx.characterState.keys < 1) {
        return "Need a key.";
      }
      return true;  // all good
    },
    
    resolve: async (ctx) => ({
      message: "Chest opened! Treasures inside.",
      worldPatch: { chestOpen: true },
      characterState: {
        keys: (ctx.characterState.keys ?? 1) - 1,
        gold: (ctx.characterState.gold ?? 0) + 50
      }
    })
  }
}
```

### Action with parameters

```typescript
actions: {
  attack: {
    description: "Attack selected target",
    
    // Parameter schema for DM
    paramSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Who to attack" },
        weapon: { type: "string", description: "Which weapon to use" }
      },
      required: ["target"]
    },
    
    resolve: async (ctx) => {
      // Parameters chosen by DM
      const args = ctx.actionArgs as { target: string; weapon?: string };
      const damage = Math.floor(Math.random() * 10) + 5;
      
      return {
        message: `You attack ${args.target} with ${args.weapon ?? "your weapon"} and deal ${damage} damage!`,
        worldPatch: {
          [`enemy_${args.target}_hp`]: (ctx.worldState[`enemy_${args.target}_hp`] as number ?? 20) - damage
        }
      };
    }
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
    chestOpen: true,
    enemyCount: 5
  },
  
  characterState: {          // personal changes
    hp: 80,
    gold: 150
  },
  
  suggestedActions: [        // quick action buttons
    { id: "flee", label: "Run away", prompt: "flee from enemy" },
    { id: "fight", label: "Fight", prompt: "attack the enemy" }
  ],
  
  endSession: "player_death" // end the session
});
```

---

## Full example: loot collection mechanic

```typescript
// src/mechanics/loot.ts
import { defineMechanic } from "@opendungeon/content-sdk";

export const lootMechanic = defineMechanic({
  id: "loot",
  
  // Initial state at run start
  hooks: {
    onSessionStart: async () => ({
      worldPatch: {
        sessionLoot: [],
        totalLootValue: 0
      }
    })
  },
  
  actions: {
    // Pick up item from ground
    pickup: {
      description: "Pick up an item from the ground",
      
      paramSchema: {
        type: "object",
        properties: {
          itemId: { type: "string" },
          itemName: { type: "string" }
        }
      },
      
      resolve: async (ctx) => {
        const args = ctx.actionArgs as { itemId: string; itemName: string };
        const currentLoot = (ctx.worldState.sessionLoot as any[]) ?? [];
        
        return {
          message: `You pick up ${args.itemName} and put it in your bag.`,
          worldPatch: {
            sessionLoot: [...currentLoot, { id: args.itemId, name: args.itemName }]
          },
          suggestedActions: [
            { id: "continue", label: "Move on", prompt: "continue on your path" }
          ]
        };
      }
    },
    
    // Check inventory
    checkInventory: {
      description: "Look inside your bag",
      resolve: async (ctx) => {
        const loot = (ctx.worldState.sessionLoot as any[]) ?? [];
        const itemNames = loot.map(i => i.name).join(", ") || "empty";
        
        return {
          message: `In your bag: ${itemNames}.`,
          suggestedActions: [
            { id: "continue", label: "Close bag", prompt: "continue" }
          ]
        };
      }
    }
  }
});
```

---

## Best practices

### 1. Namespace your world keys

```typescript
// BAD — conflicts between mechanics:
worldPatch: { count: 5 }

// GOOD — mechanic prefix:
worldPatch: { "loot_count": 5 }

// EVEN BETTER — with playerId if personal:
worldPatch: { [`loot_${ctx.playerId}_count`]: 5 }
```

### 2. Always check for data existence

```typescript
// BAD — can be undefined:
const loot = ctx.worldState.sessionLoot;

// GOOD — default value:
const loot = (ctx.worldState.sessionLoot as any[]) ?? [];
```

### 3. Use characterState for personal data

```typescript
// Personal (other players don't see):
characterState: { hp: 100, location: "room_5" }

// Shared (everyone sees):
worldPatch: { bossDefeated: true }
```

### 4. Teach DM via dmPromptExtension

```typescript
export const myMechanic = defineMechanic({
  id: "my-mechanic",
  
  // This text is added to DM prompt every turn
  dmPromptExtension: ({ worldState }) => {
    const loot = (worldState.sessionLoot as any[]) ?? [];
    return `
## Loot Mechanic Rules
- When player finds an item: add it to lootFound in worldPatch
- When player reaches exit: set nearExit: true
- Current player loot: ${loot.length} items
    `.trim();
  },
  
  // ... hooks and actions
});
```

---

## Checklist before testing

- [ ] Mechanic is exported in `src/index.ts`
- [ ] `id` has no spaces or special characters
- [ ] All `validate` functions return `true` or error string
- [ ] All `resolve` functions return an object with `message`
- [ ] Default values checked for `worldState`/`characterState`
- [ ] DM knows about your fields via `dmPromptExtension`

---

## Examples from real games

### Simple: health recovery
```typescript
export const healMechanic = defineMechanic({
  id: "heal",
  actions: {
    rest: {
      description: "Rest by the campfire",
      validate: (ctx) => ctx.worldState.nearCampfire 
        ? true 
        : "Need a campfire to rest",
      resolve: async (ctx) => ({
        message: "The campfire warmth restores your strength.",
        characterState: { hp: ctx.characterState.maxHp }
      })
    }
  }
});
```

### Medium: door with code
```typescript
export const doorMechanic = defineMechanic({
  id: "door",
  hooks: {
    onSessionStart: async () => ({
      worldPatch: { doorCode: "7842", doorOpen: false }
    })
  },
  actions: {
    enterCode: {
      description: "Enter the door code",
      paramSchema: {
        type: "object",
        properties: { code: { type: "string" } }
      },
      resolve: async (ctx) => {
        const args = ctx.actionArgs as { code: string };
        if (args.code === ctx.worldState.doorCode) {
          return {
            message: "Correct code! The door opens.",
            worldPatch: { doorOpen: true }
          };
        }
        return { message: "Wrong code. Click — the door stays closed." };
      }
    }
  }
});
```

### Complex: permanent upgrades
```typescript
export const upgradeMechanic = defineMechanic({
  id: "upgrade",
  hooks: {
    onSessionEnd: async (ctx) => {
      // Save character level between runs
      if (ctx.reason === "extraction_success") {
        const key = `player_${ctx.playerId}_level`;
        const currentLevel = (ctx.worldState[key] as number) ?? 1;
        return {
          worldPatch: { [key]: currentLevel + 1 }
        };
      }
      return {};
    },
    onCharacterCreated: async (ctx) => {
      // Restore level on character creation
      const key = `player_${ctx.playerId}_level`;
      const savedLevel = (ctx.worldState[key] as number) ?? 1;
      return {
        characterState: { 
          level: savedLevel,
          maxHp: 50 + savedLevel * 10
        }
      };
    }
  }
});
```
