# Resource Indicators

Resource indicators are UI tiles displayed in the game client during an active session. They show character or world data — HP, gold, inventory, location — dynamically bound to the current state.

Resources are declared in JSON files. Drop a file into your game's `resources/` directory — it's picked up automatically for both declarative and TypeScript modules.

```
my-game/
  resources/
    hp.json
    gold.json
    inventory.json
    stamina.json     ← add this, and it appears in the UI
```

---

## Quick start

**`resources/hp.json`**
```json
{
  "id": "hp",
  "label": "HP",
  "source": "characterState",
  "stateKey": "hp",
  "type": "number"
}
```

For declarative modules, resources are loaded automatically. For TypeScript modules using `defineMechanics()`, resources also come from the declarative module base — no explicit loader needed.

The engine passes the schema to the client via the session state API. On every poll, the client resolves each resource's value from the live state and re-renders the indicator strip.

---

## ResourceSchema fields

```typescript
interface ResourceSchema {
  id:           string;   // unique key, used as React key
  label:        string;   // text shown in the indicator tile: "HP", "Gold"
  source:       "characterState" | "worldState";
  stateKey:     string;   // dot-path into the source object
  type:         "number" | "text" | "list" | "boolean";
  defaultValue?: string | number | boolean | unknown[];
  display?:     "compact" | "badge";
}
```

### `source`

Where the value lives in the session state response:

| Value | Reads from | Use for |
|-------|-----------|---------|
| `"characterState"` | `characterState` | Session-local data: hp, level, gold, inventory, personal flags |
| `"worldState"` | `worldState` | Shared campaign data visible to all players |

### `stateKey`

Dot-path to the value. Supports nested access and `.length`:

```
"hp"                  → characterState.hp
"gold"                → characterState.gold
"inventory.length"    → characterState.inventory.length
"location.name"       → characterState.location.name
```

### `type`

Controls how the value is displayed in the UI:

| Type | Input | Rendered as |
|------|-------|-------------|
| `"number"` | `42` | `42` |
| `"text"` | `"Fortress Gate"` | `Fortress Gate` |
| `"boolean"` | `true` | `yes` / `no` |
| `"list"` | `["sword", "torch"]` | `sword, torch` |
| `"list"` | `[{ label: "Iron Shield" }]` | `Iron Shield` |

For `"list"`, arrays of objects are formatted using the `.label` field if present, otherwise `String(item)`.

### `defaultValue`

Shown when the key doesn't exist yet — for example, before `onCharacterCreated` runs, or on the first session of a fresh campaign.

```json
{ "defaultValue": 0 }       // number resource shows 0 instead of "—"
{ "defaultValue": [] }      // list resource shows "empty" instead of "—"
{ "defaultValue": "unknown" } // text resource shows "unknown"
```

If omitted, the indicator shows `—` when the value is missing.

---

## Examples

### HP

```json
{
  "id": "hp",
  "label": "HP",
  "source": "characterState",
  "stateKey": "hp",
  "type": "number"
}
```

`hp` is initialized via `onCharacterCreated` from the character's class template. Mechanics update it via `characterState` patches.

---

### Gold counter

```json
{
  "id": "gold",
  "label": "Gold",
  "source": "characterState",
  "stateKey": "gold",
  "type": "number",
  "defaultValue": 0
}
```

**Initialize in a mechanic:**

```typescript
hooks: {
  onCharacterCreated: async (ctx) => ({
    characterState: { gold: 10 }
  })
}
```

**Update when the player finds coins:**

```typescript
hooks: {
  onActionResolved: async (result, ctx) => {
    const found = result.worldPatch?.goldFound;
    if (typeof found === "number" && found > 0) {
      const current = typeof ctx.worldState.gold === "number" ? ctx.worldState.gold : 0;
      return {
        ...result,
        characterState: { ...result.characterState, gold: current + found }
      };
    }
    return result;
  }
}
```

---

### Inventory list

```json
{
  "id": "inventory",
  "label": "Inventory",
  "source": "characterState",
  "stateKey": "inventory",
  "type": "list",
  "defaultValue": []
}
```

The client renders the list as comma-separated values. Items can be strings or objects with a `label` field:

```typescript
// strings:
characterState: { inventory: ["sword", "torch", "rope"] }

// objects (same format used by extraction mechanic):
characterState: { inventory: [
  { id: "iron_shield", label: "Iron Shield" },
  { id: "health_vial", label: "Health Vial" }
]}
```

**Add an item on loot found:**

```typescript
onActionResolved: async (result, ctx) => {
  const lootFound = result.worldPatch?.lootFound;
  if (Array.isArray(lootFound) && lootFound.length > 0) {
    const current = Array.isArray(ctx.worldState.inventory)
      ? ctx.worldState.inventory
      : [];
    return {
      ...result,
      characterState: {
        ...result.characterState,
        inventory: [...current, ...lootFound]
      }
    };
  }
  return result;
}
```

---

### Stamina with session reset

```json
{
  "id": "stamina",
  "label": "Stamina",
  "source": "characterState",
  "stateKey": "stamina",
  "type": "number",
  "defaultValue": 100
}
```

```typescript
const staminaMechanic = defineMechanic({
  id: "stamina",

  hooks: {
    onCharacterCreated: async (ctx) => ({
      characterState: { stamina: 100 }
    }),

    onSessionStart: async (ctx) => ({
      // Reset to full each run
      characterState: { stamina: 100 }
    }),

    onActionResolved: async (result, ctx) => {
      // Every action costs 5 stamina
      const current = typeof ctx.worldState.stamina === "number"
        ? ctx.worldState.stamina
        : 100;
      const next = Math.max(0, current - 5);

      if (next === 0) {
        return {
          ...result,
          characterState: { ...result.characterState, stamina: 0 },
          message: result.message + "\n\nYou are exhausted."
        };
      }

      return {
        ...result,
        characterState: { ...result.characterState, stamina: next }
      };
    }
  },

  dmPromptExtension: ({ worldState }) =>
    `Stamina: ${worldState.stamina ?? 100}/100. At 0 the player collapses.`
});
```

---

### Location (set by location mechanic)

```json
{
  "id": "location",
  "label": "Location",
  "source": "characterState",
  "stateKey": "location",
  "type": "text",
  "defaultValue": "unknown"
}
```

The built-in `locationMechanic` already writes `characterState.location` on every action. No additional code needed — just declare the resource and it shows up.

---

### Boolean flag

```json
{
  "id": "near-exit",
  "label": "Near Exit",
  "source": "worldState",
  "stateKey": "nearExit",
  "type": "boolean",
  "defaultValue": false
}
```

Reads from shared `worldState`. The DM sets `nearExit: true` in `worldPatch` when the player reaches an exit — this resource shows `yes` / `no`.

---

### Shared world stat (visible to all players)

```json
{
  "id": "faction-rep",
  "label": "Covenant Rep",
  "source": "worldState",
  "stateKey": "covenantReputation",
  "type": "number",
  "defaultValue": 0
}
```

`source: "worldState"` shows the same value to every player in the campaign. Use this for shared faction standings, world event counters, boss HP, etc.

---

## Initialization checklist

Resources are read-only display constructs. They don't create data — your mechanics do. For each resource backed by `characterState` or `worldState`, make sure the corresponding key is initialized:

| Hook | When to use |
|------|-------------|
| `onCharacterCreated` | Per-character data that persists across sessions: starting gold, class-specific stats |
| `onSessionStart` | Session-local data that resets each run: stamina, session loot, nearExit flag |

Data written to `characterState` is session-local and private to this player.  
Data written to `worldPatch` lands in `worldState` (shared across all players in the campaign).

If you skip initialization and don't set a `defaultValue`, the indicator shows `—`.

---

## Where `resources/` lives

Resources belong at the **module root**, alongside `lore/`, `modules/`, and `src/`:

```
my-game/
  resources/      ← here
  modules/
  lore/
  src/
  dist/
```

For declarative modules they are loaded automatically. For TypeScript modules using `defineMechanics()`, the declarative base handles resource loading — no explicit `loadResourcesDirSync` call needed in your `src/index.ts`.
