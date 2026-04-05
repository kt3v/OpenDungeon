# Mechanics

There are two ways to add gameplay to your OpenDungeon game: **JSON skills** and **TypeScript mechanics**. Start with JSON — it covers most cases without any code.

---

## Skills (JSON)

A skill is a `.json` file in your game's `skills/` directory. The engine picks it up automatically on start.

### `resolve: "ai"` — let the DM handle it

Use this when the outcome depends on context and creative interpretation. The skill tells the DM the concept exists and provides rules — the DM handles the rest.

```json
{
  "id": "bargain",
  "description": "Negotiate prices or terms with an NPC",
  "resolve": "ai",
  "dmPromptExtension": "## Bargaining\nPlayers can haggle with merchants and NPCs.\nOn success: set merchantRelation +1 in worldPatch. On failure: -1."
}
```

The `description` is shown to the DM as a tool label. The `dmPromptExtension` is appended to the system prompt every turn — use it to teach the DM your mechanic's rules and any relevant `worldState` fields.

### `resolve: "deterministic"` — fixed outcome, no LLM

Use this when the outcome is always the same. The engine applies it without an LLM call.

```json
{
  "id": "rest",
  "description": "Rest at a campfire to recover HP",
  "resolve": "deterministic",
  "outcome": {
    "message": "You rest by the fire. The warmth eases your wounds.",
    "worldPatch": { "campfireActive": false },
    "characterPatch": { "hp": 100 }
  }
}
```

### Validation

Optionally require a worldState condition before the skill can be used:

```json
"validate": {
  "worldStateKey": "campfireActive",
  "failMessage": "You need a campfire to rest."
}
```

Supported operators — add `"operator"` and `"value"` for more than a truthy check:

```json
{ "worldStateKey": "gold",             "operator": ">=", "value": 50,   "failMessage": "Need 50 gold." }
{ "worldStateKey": "level",            "operator": ">=", "value": 3,    "failMessage": "Need level 3." }
{ "worldStateKey": "inventory.length", "operator": ">",  "value": 0,    "failMessage": "Empty-handed." }
{ "worldStateKey": "bossDefeated",     "operator": "==", "value": true, "failMessage": "Defeat the boss first." }
```

All operators: `truthy` (default), `falsy`, `==`, `!=`, `>`, `>=`, `<`, `<=`

### Template interpolation

Both `dmPromptExtension` and `outcome.message` support `{{worldState.*}}` expressions. They're evaluated against the current world state every turn:

```json
"dmPromptExtension": "## Inventory\nCurrent gold: {{worldState.gold}}\nItems carried: {{worldState.inventory.length}}"
```

Unknown paths silently resolve to empty string — the DM prompt stays clean.

### Full skill schema reference

```typescript
interface SkillSchema {
  id: string;                    // unique, snake_case
  description: string;           // shown to DM as tool label (keep it short)
  resolve: "ai" | "deterministic";
  dmPromptExtension?: string;    // markdown appended to DM system prompt, supports {{worldState.*}}
  paramSchema?: object;          // JSON Schema for args the DM can pass
  validate?: {
    worldStateKey: string;       // dot-path: "gold", "player.level", "inventory.length"
    operator?: SkillValidationOperator;  // default: "truthy"
    value?: unknown;
    failMessage: string;
  };
  outcome?: {                    // required for resolve: "deterministic"
    message: string;             // supports {{worldState.*}}
    worldPatch?: Record<string, unknown>;
    characterPatch?: Record<string, unknown>;
    suggestedActions?: SuggestedAction[];
    endSession?: SessionEndReason;
  };
}
```

### Loading skills in your game module

```typescript
import { defineGameModule, loadSkillsDirSync } from "@opendungeon/content-sdk";

export default defineGameModule({
  // ...
  skills: loadSkillsDirSync(new URL("../skills", import.meta.url).pathname)
});
```

`loadSkillsDirSync` reads all `*.json` files from the directory. Each file can be a single skill object or an array of skills. Invalid files are skipped with a console warning.

> The `skills/` directory sits at your **package root** (sibling of `src/` and `dist/`), not inside `src/`. The path `"../skills"` resolves correctly from both `src/index.ts` (dev) and `dist/index.js` (production).

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
  message: string;                      // player-facing narration (required)
  worldPatch?: Record<string, unknown>; // merged into shared world state
  characterPatch?: Record<string, unknown>; // merged into this session's character state only
  suggestedActions?: SuggestedAction[]; // replaces current suggested action buttons
  summaryPatch?: { shortSummary: string; latestBeat?: string };
  endSession?: SessionEndReason;        // triggers the session-end pipeline
  handledByMechanic?: boolean;          // set by engine; true when a mechanic handled this turn
}
```

`worldPatch` is **shared** — all players in the campaign see it. `characterPatch` is **private** — only visible to this session. Use `characterPatch` for session-local state like `nearExit`, `sessionLoot`, personal flags.

---

## Choosing between skills and mechanics

| Situation | Use |
|-----------|-----|
| Teaching the DM a concept (stealth, bargaining, diplomacy) | JSON skill, `resolve: "ai"` |
| Simple action with a predictable outcome (rest, pick up item) | JSON skill, `resolve: "deterministic"` |
| Cross-session persistence (loot that survives between runs) | TypeScript mechanic |
| Intercepting and modifying DM output | TypeScript mechanic (`onActionResolved`) |
| Blocking or modifying incoming actions | TypeScript mechanic (`onActionSubmitted`) |
| Giving starting gear by character class | TypeScript mechanic (`onCharacterCreated`) |

When in doubt, start with a JSON skill. You can always promote it to a TypeScript mechanic later if the logic grows complex.

---

## Tips

**Namespace your worldState keys.** Multiple mechanics share the same flat object. Use prefixes: `persistedLoot_<playerId>`, `extraction_nearExit`, `location_current`.

**Use `dmPromptExtension` to close the loop.** If your mechanic reads `worldState.nearExit`, teach the DM to write it. Otherwise the field will never appear.

**`onActionResolved` is your most powerful hook.** It runs after every turn, from both mechanics and the DM. Use it to interpret DM output and translate it into mechanic state.

**Keep mechanics focused.** One mechanic = one system. Don't put combat, inventory, and extraction in the same file.
