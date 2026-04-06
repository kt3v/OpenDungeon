# Architect

The Architect is an AI assistant built into the `od` CLI that knows the OpenDungeon engine in full detail. Use it to build and evolve your game module through conversation: ask questions, request new skills, configure the DM, seed lore — and let it write the files.

---

## Launching the chat

```bash
od architect
```

That's it. The Architect finds your game automatically.

On startup it scans for game directories and campaigns, then asks you to pick:

```
Discovering your game setup…

  Available game directories:
    1) OpenDungeon Classic    packages/game-example
    2) My Fantasy World       ../my-game
    0) None — advisory mode only

  Choose game (number, Enter = none): 1

  Campaigns (for seeding lore and world facts):
    1) The Shadow Run    3 sessions
    2) Test Campaign     1 session
    0) None — skip database operations

  Choose campaign (number, Enter = none): 1
```

Then it starts the chat:

```
╔══════════════════════════════════════════════╗
║  OpenDungeon Architect                       ║
╚══════════════════════════════════════════════╝

  Provider : openai-compatible / gpt-4o-mini
  Campaign : The Shadow Run (abc123)
  Game     : OpenDungeon Classic  (packages/game-example)
  Files    : skills/look.json, skills/camp.json, hooks/starting-gear.json

  Type your request, 'help' for examples, 'exit' to quit.

>
```

### Override flags

Skip the discovery UI by providing paths and IDs directly:

```bash
od architect --module ../my-game
od architect --campaign <campaignId>
od architect --module ../my-game --campaign <campaignId>
od architect --module ../my-game --apply   # skip confirmation prompts
```

---

## What is a game directory?

A **game directory** (also called a game module) is the folder that contains your game's content — the world, characters, rules, and DM instructions. It's what you point `GAME_MODULE_PATH` at in `.env.local`.

Typical structure:

```
my-game/
  manifest.json       ← required marker file
  setting.json        ← world name, era, tone, taboos
  classes.json        ← character classes and starting stats
  dm.md               ← DM system prompt
  dm-config.json      ← guardrails and action buttons
  initial-state.json  ← starting world state
  skills/             ← gameplay rules (JSON)
  hooks/              ← lifecycle events (JSON)
  rules/              ← per-turn effects (JSON)
  lore/               ← world lore (Markdown)
```

When you ask the Architect to "create a skill" or "add a rule", it writes files directly into this folder.

---

## What you can ask

The Architect knows the full engine — turn pipeline, module loading order, all file schemas — and can answer questions or produce changes on request.

### Creating game content

```
> create a 'meditate' skill that lets players recover 10 HP — deterministic, only if hp < 50
> add a starting-gear hook that gives Warriors a sword and Mages a staff
> write a death-check rule that ends the session when HP reaches 0
> add a poison rule that drains 2 HP per turn while worldState.poisoned is true
> update dm.md to make the DM more terse and punishing
> add a lore file about the four noble factions
```

### Configuring the module

```
> add "Paladin" as a new class with hp 120 and high charisma
> set the default suggested actions to: look, listen, and sneak
> add "no time travel" to the taboos in setting.json
> increase maxSuggestedActions to 5 in dm-config.json
```

### Seeding campaign data (requires --campaign)

```
> add an NPC: Gorm the blacksmith, neutral, runs the forge in Ironhold
> set the starting location to the ruins at the edge of the forest
> record that the first act ends when the cultist leader is captured
```

### Asking questions

```
> how does the turn pipeline work?
> what's the difference between hooks and rules?
> when should I use resolve: "ai" vs resolve: "deterministic"?
> explain how routing keys work
> what does dmPromptExtension do?
```

---

## How operations work

When the Architect proposes a change, it shows you the pending operations before applying them:

```
Architect: I'll create a deterministic meditate skill with an HP check.

Pending operations (1):
  1. write_file skills/meditate.json — Add meditate skill (resolve: deterministic)
     {
       "id": "meditate",
       "description": "Meditate to recover 10 HP",
       "resolve": "deterministic",
       ...

Apply these operations? [y/N]
```

Type `y` to write the files. Type anything else (or just press Enter) to skip.

The Architect updates its file list on each turn, so if you create a skill and then ask to modify it in the next message, it already knows the file exists.

---

## Multi-turn workflow

The Architect remembers the full conversation within a session. You can refine incrementally:

```
> create a 'flee' skill for deterministic escape

Architect: Here's a flee skill — validates nearExit, patches escapedSuccessfully.

Pending operations (1): ...
Apply? [y/N] y
  Applied 1 operation(s).

> also make it end the session with reason "fled"

Architect: Updated — flee now calls endSession: "fled".

Pending operations (1): ...
Apply? [y/N] y
```

Each file write replaces the entire file. If you want to partially edit an existing file, describe the change and the Architect will read the current file list context and produce the complete updated version.

---

## Commands

| Input | Action |
|---|---|
| `help` | Show available commands and example requests |
| `exit` / `quit` | Exit the chat |
| anything else | Sent to the Architect as a request |

---

## File operations reference

The Architect can create or overwrite any of these files inside your module root:

| Path pattern | Purpose |
|---|---|
| `skills/<id>.json` | JSON skill (resolve: ai or deterministic) |
| `hooks/<id>.json` | Lifecycle hook (onCharacterCreated, onSessionStart, onSessionEnd) |
| `rules/<id>.json` | Per-turn rule (onActionResolved, increment/decrement/endSession) |
| `dm.md` | DM system prompt |
| `dm-config.json` | Tool policy, guardrails, default action buttons |
| `setting.json` | World bible (era, tone, taboos) |
| `classes.json` | Character classes and starting stats |
| `initial-state.json` | Starting world state for new campaigns |
| `lore/<topic>.md` | Lore markdown files |

The Architect will never write outside your module root, and will never touch engine packages or gateway internals.

---

## Other architect commands

The `od architect` chat is for interactive development. Two additional subcommands handle specific one-shot tasks:

```bash
# Generate declarative files from setting.json (classes, dm, hooks, etc.)
od architect scaffold --module ../my-game

# Find player actions that no mechanic handled, suggest new skills
od architect analyze --campaign <campaignId> --min-count 3
```

See `od help` for flags on each subcommand.
