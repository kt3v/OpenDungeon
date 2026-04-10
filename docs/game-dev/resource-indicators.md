# Resource Indicators (Strict State)

Resource indicators are UI tiles shown during an active session. In strict mode, indicators are bound to a canonical state variable ID (`varId`).

## Quick start

1) Declare variable in `content/state/*.json`:

```json
{
  "id": "hp",
  "scope": "character",
  "type": "number",
  "defaultValue": 100,
  "writableBy": ["mechanic"]
}
```

2) Bind indicator in `content/indicators/hp.json`:

```json
{
  "id": "hp",
  "label": "HP",
  "varId": "hp",
  "type": "number"
}
```

That is enough. Gateway resolves values server-side and returns `resolvedIndicators` to the client.

## Schema

```ts
interface ResourceSchema {
  id: string;
  label: string;
  varId: string;
  type: "number" | "text" | "list" | "boolean";
  defaultValue?: string | number | boolean | unknown[];
  display?: "compact" | "badge";
}
```

## Rules

- `varId` must exist in `content/state/*.json`.
- Do not use `source` or `stateKey` (legacy fields).
- For location, use a declared variable (commonly `location`, scope `session`) and bind indicator to that `varId`.

## Examples

```json
{
  "id": "oxygen",
  "label": "Oxygen",
  "varId": "oxygen",
  "type": "number",
  "defaultValue": 100
}
```

```json
{
  "id": "inventory",
  "label": "Inventory",
  "varId": "inventory",
  "type": "list",
  "defaultValue": []
}
```

```json
{
  "id": "location",
  "label": "Location",
  "varId": "location",
  "type": "text",
  "defaultValue": "unknown"
}
```

## Where files live

```
my-game/
  content/
    state/
    indicators/
```

Indicators are auto-loaded for declarative and TypeScript modules.
