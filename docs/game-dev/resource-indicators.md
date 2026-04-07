# Resource Indicators

Resource indicators are UI tiles displayed in the game client during an active session. They show character or world data — HP, gold, inventory, location — dynamically bound to the current state.

Resources are declared in JSON files. Drop a file into your game's `content/indicators/` directory — it's picked up automatically for both declarative and TypeScript modules.

```
my-game/
  content/
    indicators/
      hp.json
      gold.json
      inventory.json
      stamina.json     ← add this, and it appears in the UI
```

---

## Quick start

**`content/indicators/hp.json`**
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
  source:       "characterState" | "worldState" | "session";
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
| `"characterState"` | `characterState` | Unified character state: hp, level, gold, inventory, buffs |
| `"worldState"` | `worldState` | Shared campaign data visible to all players: global flags, boss HP |
| `"session"` | `session` | Session-level system fields like `location` |

### `stateKey`

Dot-path to the value. Supports nested access and `.length`:

```
"hp"                  → characterState.hp
"gold"                → characterState.gold
"inventory.length"    → characterState.inventory.length
"location"            → session.location
```

### `type`

| Type | Input | Rendered as |
|------|-------|-------------|
| `"number"` | `42` | `42` |
| `"text"` | `"Fortress Gate"` | `Fortress Gate` |
| `"boolean"` | `true` | `yes` / `no` |
| `"list"` | `["sword", "torch"]` | `sword, torch` |
| `"list"` | `[{ label: "Iron Shield" }]` | `Iron Shield` |

For `"list"`, arrays of objects are formatted using the `.label` field if present, otherwise `String(item)`.

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

Initialized via `onCharacterCreated` from class templates. Updated via `characterState` patches.

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

**Update when the player finds coins:**

```typescript
onActionResolved: async (result, ctx) => {
  const found = result.worldPatch?.goldFound;
  if (typeof found === "number" && found > 0) {
    const current = typeof ctx.characterState.gold === "number" ? ctx.characterState.gold : 0;
    
    // Clear the transient worldPatch key and update character gold
    const { goldFound: _, ...cleanPatch } = result.worldPatch ?? {};
    
    return {
      ...result,
      worldPatch: cleanPatch,
      characterState: { ...result.characterState, gold: current + found }
    };
  }
  return result;
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

**Add an item on loot found:**

```typescript
onActionResolved: async (result, ctx) => {
  const lootFound = result.worldPatch?.lootFound;
  if (Array.isArray(lootFound) && lootFound.length > 0) {
    const current = Array.isArray(ctx.characterState.inventory)
      ? ctx.characterState.inventory
      : [];
    
    const { lootFound: _, ...cleanPatch } = result.worldPatch ?? {};
    
    return {
      ...result,
      worldPatch: cleanPatch,
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

### Location

```json
{
  "id": "location",
  "label": "Location",
  "source": "session",
  "stateKey": "location",
  "type": "text",
  "defaultValue": "unknown"
}
```

Uses the `session` source to track the player's current location. No additional mechanic code is needed to expose this if the engine/DM updates the location.

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

`source: "worldState"` shows the same value to every player in the campaign. Use this for shared faction standings, world event counters, or global quest flags.

---

## Where `indicators/` lives

The engine looks for indicators in `content/indicators/` (recommended) or `indicators/` at the module root.

```
my-game/
  manifest.json
  content/
    indicators/      ← recommended
    modules/
    lore/
```

For declarative modules they are loaded automatically. For TypeScript modules, the declarative base handles resource loading — no explicit code is required in your entry point.
