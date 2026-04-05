# Mechanics

There are four ways to add gameplay to your OpenDungeon game, in order of complexity:

1. **JSON skills** (`skills/*.json`) — gameplay rules and DM instructions
2. **JSON hooks** (`hooks/*.json`) — initial state setup and session lifecycle
3. **JSON rules** (`rules/*.json`) — effects applied after every action (HP drain, timers, death checks)
4. **TypeScript mechanics** (`src/mechanics/*.ts`) — complex stateful logic

Start with JSON. You can always promote to TypeScript when the logic outgrows what files can express.

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

---

## Hooks (JSON)

Hooks let you react to session lifecycle events without writing TypeScript. Drop a `.json` file in `hooks/`. The engine picks it up on restart.

### `onCharacterCreated` — give starting gear

```json
{
  "id": "starting-gear",
  "hook": "onCharacterCreated",
  "characterPatch": { "gold": 10, "inventory": [] },
  "classBranches": {
    "Warrior": {
      "characterPatch": {
        "gold": 5,
        "inventory": [{ "id": "iron_sword", "label": "Iron Sword" }]
      }
    },
    "Mage": {
      "characterPatch": {
        "gold": 15,
        "inventory": [{ "id": "spell_tome", "label": "Spell Tome" }]
      }
    }
  }
}
```

`classBranches` maps class names to patches. The engine selects the matching branch and deep-merges it with the root `characterPatch`. If no branch matches, only the root patch is applied.

### `onSessionStart` — reset session state

```json
{
  "id": "session-reset",
  "hook": "onSessionStart",
  "characterPatch": { "sessionLoot": [], "nearExit": false }
}
```

Runs at the beginning of every session. Use it to clear per-run counters.

### `onSessionEnd` — react to session end

```json
{
  "id": "defeat-cleanup",
  "hook": "onSessionEnd",
  "reason": "player_death",
  "worldPatch": { "deathCount": null }
}
```

`reason` filters by session end type. Omit it to fire on any end. Session end reasons: `"extraction_success"` · `"player_death"` · `"campaign_complete"` · `"abandoned"` · `"manual"`

### Full hook schema

```typescript
// onCharacterCreated
{ id, hook: "onCharacterCreated", worldPatch?, characterPatch?, classBranches? }

// onSessionStart
{ id, hook: "onSessionStart", worldPatch?, characterPatch? }

// onSessionEnd
{ id, hook: "onSessionEnd", reason?, worldPatch?, characterPatch? }
```

### Using hooks in a TypeScript module

If you use TypeScript mode, load hooks alongside your mechanics:

```typescript
import { loadHooksDirSync, hookSchemasToMechanics } from "@opendungeon/content-sdk";

const hookSchemas = loadHooksDirSync(new URL("../hooks", import.meta.url).pathname);

export default defineGameModule({
  // hook mechanics run first, before TypeScript mechanics
  mechanics: [...hookSchemasToMechanics(hookSchemas), extractionMechanic]
});
```

### When hooks aren't enough

Use a JSON rule (`rules/*.json`) for per-turn effects after every action (HP drain, death checks, status ticking). Use a TypeScript mechanic when you need:
- `onActionSubmitted` — block or modify incoming actions
- `onActionResolved` — intercept and transform DM output dynamically
- Cross-session persistence (e.g., accumulate loot across multiple runs)
- Logic that reads state and makes conditional decisions beyond class branching

---

## Rules (JSON)

Rules fire on `onActionResolved` after every action. They apply state mutations — with an optional condition guard — without writing TypeScript.

Drop a `.json` file in `rules/`. The engine picks it up on next restart.

### Basic structure

```json
{
  "id": "hp-drain",
  "trigger": "onActionResolved",
  "effects": [
    { "op": "decrement", "target": "characterState.hp", "amount": 1, "min": 0 }
  ]
}
```

Every rule has:
- `id` — unique string
- `trigger` — currently only `"onActionResolved"`
- `effects` — one or more operations to apply (evaluated in order)
- `condition` — optional guard (see below)

### Target paths

The `target` field in effects uses a prefix to select which state store to write:

| Prefix | Writes to | Visible to |
|--------|-----------|-----------|
| `characterState.<key>` | `characterPatch` | This session only (private) |
| `worldState.<key>` | `worldPatch` | All players (shared campaign) |

Reading current values: the engine merges `characterState` into `worldState` before hooks run, so `characterState.hp` is readable in conditions as `"key": "characterState.hp"`.

### Conditions

An optional `condition` guards whether the rule fires at all:

```json
"condition": { "key": "characterState.poisoned", "operator": "==", "value": true }
```

The `key` is a dot-path into the merged worldState. Condition operators match the skill validator: `truthy` (default), `falsy`, `==`, `!=`, `>`, `>=`, `<`, `<=`.

```json
{ "key": "characterState.hp",        "operator": "<=", "value": 0    }
{ "key": "worldState.bossDefeated",  "operator": "==", "value": true }
{ "key": "characterState.poisoned"                                    }  // truthy check
```

### Operations

#### `increment` — add to a number

```json
{ "op": "increment", "target": "worldState.turnCount", "amount": 1 }
{ "op": "increment", "target": "characterState.gold",  "amount": 10, "max": 999 }
```

Optional `max` clamp — value will not exceed it.

#### `decrement` — subtract from a number

```json
{ "op": "decrement", "target": "characterState.hp", "amount": 1, "min": 0 }
{ "op": "decrement", "target": "characterState.stamina", "amount": 5 }
```

Optional `min` clamp (default `0`) — value will not go below it.

#### `set` — overwrite a key

```json
{ "op": "set", "target": "characterState.poisoned", "value": false }
{ "op": "set", "target": "worldState.phase",        "value": "endgame" }
```

`value` can be any JSON type: string, number, boolean, array, object, or `null`.

#### `append` — add to an array

```json
{ "op": "append", "target": "characterState.statusEffects", "value": "burning" }
```

Creates the array if it does not exist yet.

#### `remove` — remove from an array

```json
{ "op": "remove", "target": "characterState.statusEffects", "value": "burning" }
{ "op": "remove", "target": "characterState.inventory",     "id": "health_potion" }
```

Two modes: `value` removes by strict equality; `id` removes objects where `item.id === id`.

#### `endSession` — end the session

```json
{ "op": "endSession", "reason": "player_death" }
```

Triggers the full session-end pipeline. Common reasons: `"player_death"`, `"extraction_success"`, `"campaign_complete"`.

### Examples

**HP drain — lose 1 HP every action:**

```json
{
  "id": "hp-drain",
  "trigger": "onActionResolved",
  "effects": [
    { "op": "decrement", "target": "characterState.hp", "amount": 1, "min": 0 }
  ]
}
```

**Death check — end session when HP reaches 0:**

```json
{
  "id": "death-check",
  "trigger": "onActionResolved",
  "condition": { "key": "characterState.hp", "operator": "<=", "value": 0 },
  "effects": [
    { "op": "endSession", "reason": "player_death" }
  ]
}
```

**Poison tick — poison deals 3 damage per turn, then clears:**

```json
{
  "id": "poison-tick",
  "trigger": "onActionResolved",
  "condition": { "key": "characterState.poisoned", "operator": "==", "value": true },
  "effects": [
    { "op": "decrement", "target": "characterState.hp",       "amount": 3, "min": 0 },
    { "op": "set",       "target": "characterState.poisoned", "value": false }
  ]
}
```

**Turn counter — increment a shared counter every action:**

```json
{
  "id": "turn-counter",
  "trigger": "onActionResolved",
  "effects": [
    { "op": "increment", "target": "worldState.turnCount", "amount": 1 }
  ]
}
```

**Timed event — trigger something on turn 20:**

Two files — the counter above, plus:

```json
{
  "id": "turn-20-event",
  "trigger": "onActionResolved",
  "condition": { "key": "worldState.turnCount", "operator": "==", "value": 20 },
  "effects": [
    { "op": "set", "target": "worldState.reinforcementsArrived", "value": true }
  ]
}
```

**Regen — recover 2 HP per turn if rested, capped at max:**

```json
{
  "id": "regen",
  "trigger": "onActionResolved",
  "condition": { "key": "characterState.rested", "operator": "==", "value": true },
  "effects": [
    { "op": "increment", "target": "characterState.hp", "amount": 2, "max": 100 }
  ]
}
```

### Multiple effects per rule

Effects in the same rule fire in order. Use this for compound mechanics:

```json
{
  "id": "burning",
  "trigger": "onActionResolved",
  "condition": { "key": "characterState.burning", "operator": "==", "value": true },
  "effects": [
    { "op": "decrement", "target": "characterState.hp",      "amount": 5, "min": 0 },
    { "op": "decrement", "target": "characterState.burning", "amount": 1, "min": 0 }
  ]
}
```

Here `burning` is a counter that ticks down — fire deals damage and burns out after N turns.

### Using rules in a TypeScript module

If you use TypeScript mode, load rules alongside your mechanics:

```typescript
import { loadRulesDirSync, ruleSchemasToMechanics } from "@opendungeon/content-sdk";

const ruleSchemas = loadRulesDirSync(new URL("../rules", import.meta.url).pathname);

export default defineGameModule({
  // rule mechanics run after hook mechanics, at the end of each action
  mechanics: [...hookSchemasToMechanics(hookSchemas), ...ruleSchemasToMechanics(ruleSchemas), extractionMechanic]
});
```

### When rules aren't enough

Rules apply unconditional or single-condition mutations. Use a TypeScript mechanic when you need:
- Conditions that depend on multiple fields simultaneously
- Effects that compute a value from current state (e.g., `hp = Math.floor(maxHp * 0.5)`)
- Branching logic (if X do A, else do B)
- Reading the DM's output text and reacting to it

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

## Choosing the right tool

| Situation | Use |
|-----------|-----|
| Teaching the DM a concept (stealth, bargaining, diplomacy) | JSON skill, `resolve: "ai"` |
| Simple action with a predictable outcome (rest, pick up item) | JSON skill, `resolve: "deterministic"` |
| Give starting gear or set initial character state | JSON hook, `onCharacterCreated` |
| Reset per-session state at the start of each run | JSON hook, `onSessionStart` |
| React to session end (cleanup, simple tracking) | JSON hook, `onSessionEnd` |
| HP drain, stamina loss, mana regen per action | JSON rule, `onActionResolved` |
| Death / win condition check after each action | JSON rule, `onActionResolved` + `endSession` |
| Status effect ticking (poison, burn, regeneration) | JSON rule, `onActionResolved` + condition |
| Turn counters and timed events | JSON rule, `increment` + condition |
| Cross-session persistence (loot that survives between runs) | TypeScript mechanic (`onSessionEnd`) |
| Intercepting and modifying DM output | TypeScript mechanic (`onActionResolved`) |
| Blocking or modifying incoming actions | TypeScript mechanic (`onActionSubmitted`) |
| Dynamic suggested actions based on complex state | TypeScript mechanic (`onActionResolved`) |
| Multi-field conditions or computed values | TypeScript mechanic (`onActionResolved`) |

When in doubt: start with JSON. Promote to TypeScript when the logic grows beyond what a static patch can express.

---

## Tips

**Namespace your worldState keys.** Multiple mechanics share the same flat object. Use prefixes: `persistedLoot_<playerId>`, `extraction_nearExit`, `location_current`.

**Use `dmPromptExtension` to close the loop.** If your mechanic reads `worldState.nearExit`, teach the DM to write it. Otherwise the field will never appear.

**`onActionResolved` is your most powerful hook.** It runs after every turn, from both mechanics and the DM. Use it to interpret DM output and translate it into mechanic state.

**Keep mechanics focused.** One mechanic = one system. Don't put combat, inventory, and extraction in the same file.

**Split rules by concern.** A `death-check.json` and a `hp-drain.json` are easier to toggle on/off than a single rule that does both. Rules fire in filename order — order them accordingly when it matters (drain before check).

**Rules run after all other mechanics.** If a TypeScript mechanic sets `characterState.hp` in `onActionResolved`, your rules see the updated value. Use this to chain: a mechanic sets a status flag, a rule reacts to it next turn.
