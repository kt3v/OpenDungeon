# Skill: Game Content Creator (OpenDungeon)

Expertise in creating gameplay content for OpenDungeon, covering declarative (JSON/Markdown) and programmatic (TypeScript) mechanics.

## 🏗️ Project Structure
Games (modules) reside in `games/` or standalone directories. The engine expects a `content/` folder (or root fallback).

```
my-game/
  manifest.json         # REQUIRED: id, version, entry ("declarative" or path to .ts)
  content/
    setting.json        # World Bible: era, tone, themes, taboos
    classes.json        # Character classes (hp, attributes)
    dm.md               # Base DM system prompt
    dm-config.json      # DM guardrails & context router settings
    initial-state.json  # Starting worldState (global flags)
    lore/               # .md files: Persistent world-building
    modules/            # .md files: Dynamic DM context (routed by engine)
    indicators/         # .json files: UI bars (HP, Gold) mapping state to UI
    mechanics/          # .ts files: Complex deterministic logic
```

## 📜 File Roles & Best Practices

### 1. `setting.json` (The Vibe)
Defines the baseline constraints injected into every DM prompt.
- **Tip:** Be specific about **taboos** (e.g., "No guns", "Magic always has a price") to prevent LLM hallucinations.

### 2. `modules/*.md` (Context Routing)
Used for focused gameplay instructions (Stealth, Combat, Trade).
- **Frontmatter is CRITICAL for the Context Router:**
  - `triggers`: Keywords in player action (e.g., `sneak`, `hide`).
  - `references`: Matches `worldState` keys (e.g., `world:location.dark`).
  - `provides`: Keys this module modifies (for ranking).
  - `priority`: Fallback ranking (0-100).
  - `alwaysInclude`: Use for core rules.

### 3. `dm.md` & `dm-config.json`
`dm.md` is the "Voice". `dm-config.json` is the "Rules".
- **Guardrails:** Set `maxSummaryChars` (~200) and `maxSuggestedActions` (3-4) to keep UI clean.
- **Tool Policy:** Control if the DM *must* provide a summary or suggested actions.

### 4. `initial-state.json`
Defines the keys available in `worldState`.
- **Note:** If a module `references` a key not in `initial-state`, it might never trigger until the DM creates that key.

### 5. `mechanics/index.ts` (The Brain)
Use for logic that requires math, persistence, or strict validation.
- **Hooks:**
  - `onActionResolved`: Intercept DM output to enforce rules (e.g., "If HP <= 0, force Death screen").
  - `onSessionStart/End`: Setup/Cleanup (e.g., reset inventory).
- **Actions:** Deterministic commands the DM can call (e.g., `extraction.extract`).
  - `description`: Helps the DM understand *when* to use it.
  - `validate`: Prevent invalid moves (e.g., "Not enough gold").

## 🧠 Engine Logic Reference

### Context Router
1. **Keyword Match:** Scans player input for `triggers`.
2. **State Match:** Scans `worldState` for `references`.
3. **LLM Refinement:** If heuristics are weak, a fast LLM call picks modules.
4. **Budgeting:** Truncates content to fit `contextTokenBudget`.

### Dungeon Master (DM)
1. **Input:** System Prompt (`dm.md`) + Setting + Active Modules + History + WorldState.
2. **Output:** Strict JSON:
   - `message`: Narrative response.
   - `worldPatch`: Changes to global state (reputations, locations).
   - `summaryPatch`: Updates to the campaign summary.
   - `location`: Current player sub-location.
   - `mechanicCall`: Invoke a TS action.

## 🚀 Workflow for Adding Content
1. **Define State:** Add new keys to `initial-state.json`.
2. **Create Module:** Add `content/modules/new-feature.md` with appropriate `triggers`.
3. **Add Indicator:** If state should be visible, add `content/indicators/new-feature.json`.
4. **Validate:** Use `pnpm od validate-module <path>` to check references.
