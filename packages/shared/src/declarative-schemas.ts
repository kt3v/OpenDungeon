import { z } from "zod";

// ---------------------------------------------------------------------------
// Character Classes (classes.json)
// ---------------------------------------------------------------------------

export const characterClassSchema = z.object({
  name: z.string().min(1),
  level: z.number().int().positive().default(1),
  hp: z.number().int().positive(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  /**
   * When true, this class is used as the fallback when an unknown class name
   * is requested. If none is marked, the first class in the array is used.
   */
  isDefault: z.boolean().optional()
});

export const classesFileSchema = z.object({
  classes: z.array(characterClassSchema).min(1)
});

export type CharacterClassEntry = z.infer<typeof characterClassSchema>;
export type ClassesFile = z.infer<typeof classesFileSchema>;

// ---------------------------------------------------------------------------
// DM Configuration (dm-config.json + dm.md)
// ---------------------------------------------------------------------------

const dungeonMasterToolNameSchema = z.enum([
  "update_world_state",
  "set_summary",
  "set_suggested_actions"
]);

const suggestedActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  prompt: z.string().min(1)
});

const dmGuardrailsSchema = z.object({
  maxToolCalls: z.number().int().positive().optional(),
  maxSuggestedActions: z.number().int().positive().optional(),
  maxWorldPatchKeys: z.number().int().positive().optional(),
  maxWorldPatchJsonChars: z.number().int().positive().optional(),
  maxSummaryChars: z.number().int().positive().optional(),
  maxLatestBeatChars: z.number().int().positive().optional(),
  maxActionIdChars: z.number().int().positive().optional(),
  maxActionLabelChars: z.number().int().positive().optional(),
  maxActionPromptChars: z.number().int().positive().optional()
});

const dmToolPolicySchema = z.object({
  allowedTools: z.array(dungeonMasterToolNameSchema).optional(),
  requireSummary: z.boolean().optional(),
  requireSuggestedActions: z.boolean().optional()
});

const dmPromptTemplateSchema = z.object({
  lines: z.array(z.string())
});

const dmContextRouterSchema = z.object({
  enabled: z.boolean().optional(),
  contextTokenBudget: z.number().int().positive().optional(),
  maxCandidates: z.number().int().positive().optional(),
  maxSelectedModules: z.number().int().positive().optional()
});

/**
 * Schema for dm-config.json.
 *
 * The system prompt can also be provided as a separate `dm.md` file —
 * the loader merges both: `dm.md` becomes `systemPrompt`, `dm-config.json`
 * supplies the rest. If `systemPrompt` is present in both, the JSON field wins.
 *
 * Note: `suggestedActionStrategy` (a TypeScript function) is intentionally
 * absent — it cannot be serialized to JSON and remains a TypeScript escape hatch.
 */
export const dmConfigFileSchema = z.object({
  systemPrompt: z.string().optional(),
  promptTemplate: dmPromptTemplateSchema.optional(),
  guardrails: dmGuardrailsSchema.optional(),
  toolPolicy: dmToolPolicySchema.optional(),
  defaultSuggestedActions: z.array(suggestedActionSchema).optional(),
  contextRouter: dmContextRouterSchema.optional()
});

export type DmConfigFile = z.infer<typeof dmConfigFileSchema>;

// ---------------------------------------------------------------------------
// Initial World State (initial-state.json)
// ---------------------------------------------------------------------------

/**
 * Schema for initial-state.json.
 * Arbitrary key-value pairs — the initial `worldState()` for a new campaign.
 */
export const initialStateFileSchema = z.record(z.string(), z.unknown());

export type InitialStateFile = z.infer<typeof initialStateFileSchema>;

// ---------------------------------------------------------------------------
// Declarative Hook Schemas (hooks/*.json)
// ---------------------------------------------------------------------------

const staticPatchSchema = z.object({
  worldPatch: z.record(z.string(), z.unknown()).optional(),
  characterPatch: z.record(z.string(), z.unknown()).optional()
});

/**
 * Schema for a hooks/*.json file.
 *
 * Supported hooks:
 * - onCharacterCreated: apply patches when a character joins a campaign.
 *   Supports `classBranches` for class-specific patches.
 * - onSessionStart: apply patches at the beginning of each session.
 * - onSessionEnd: apply patches when a session ends (optionally filtered by reason).
 *
 * Complex hooks (onActionSubmitted, onActionResolved with conditional logic)
 * require a TypeScript mechanic — these are the TypeScript escape hatch.
 */
export const hookSchema = z.discriminatedUnion("hook", [
  z.object({
    id: z.string().min(1),
    hook: z.literal("onCharacterCreated"),
    worldPatch: z.record(z.string(), z.unknown()).optional(),
    characterPatch: z.record(z.string(), z.unknown()).optional(),
    /**
     * Class-specific patches. The engine reads character.className and applies
     * the matching branch. If no branch matches, falls back to root patches.
     */
    classBranches: z.record(z.string(), staticPatchSchema).optional()
  }),
  z.object({
    id: z.string().min(1),
    hook: z.literal("onSessionStart"),
    worldPatch: z.record(z.string(), z.unknown()).optional(),
    characterPatch: z.record(z.string(), z.unknown()).optional()
  }),
  z.object({
    id: z.string().min(1),
    hook: z.literal("onSessionEnd"),
    /**
     * When set, this hook only fires when the session ends with this reason
     * (e.g. "extraction_success"). Omit to fire on any session end.
     */
    reason: z.string().optional(),
    worldPatch: z.record(z.string(), z.unknown()).optional(),
    characterPatch: z.record(z.string(), z.unknown()).optional()
  })
]);

export type HookSchema = z.infer<typeof hookSchema>;

// ---------------------------------------------------------------------------
// Rule Schemas (rules/*.json)
// ---------------------------------------------------------------------------

/**
 * A condition that guards whether a rule fires.
 * Reuses the same operator set as SkillValidation.
 *
 * `key` is a dot-path into the merged world+character state context:
 *   "characterState.hp"   — character's HP (written by patches)
 *   "worldState.turnCount" — shared campaign counter
 *   "character.className"  — the character's class name
 */
const ruleConditionSchema = z.object({
  key: z.string().min(1),
  operator: z
    .enum(["truthy", "falsy", "==", "!=", ">", ">=", "<", "<="])
    .optional(),
  value: z.unknown().optional()
});

/**
 * A single state mutation applied when a rule fires.
 *
 * Target paths:
 *   "characterState.<key>" — writes to characterPatch (session-local)
 *   "worldState.<key>"     — writes to worldPatch (shared campaign state)
 */
const ruleEffectSchema = z.discriminatedUnion("op", [
  /** Add `amount` to a numeric value. Clamps at `max` if provided. */
  z.object({
    op: z.literal("increment"),
    target: z.string().min(1),
    amount: z.number().positive(),
    max: z.number().optional()
  }),
  /** Subtract `amount` from a numeric value. Clamps at `min` if provided (default 0). */
  z.object({
    op: z.literal("decrement"),
    target: z.string().min(1),
    amount: z.number().positive(),
    min: z.number().optional()
  }),
  /** Set a state key to a fixed value. */
  z.object({
    op: z.literal("set"),
    target: z.string().min(1),
    value: z.unknown()
  }),
  /** Append a value to an array. Creates the array if it doesn't exist. */
  z.object({
    op: z.literal("append"),
    target: z.string().min(1),
    value: z.unknown()
  }),
  /**
   * Remove items from an array.
   * If `id` is given: removes objects where item.id === id.
   * If `value` is given: removes items by strict equality.
   */
  z.object({
    op: z.literal("remove"),
    target: z.string().min(1),
    id: z.string().optional(),
    value: z.unknown().optional()
  }),
  /** End the current session with the given reason. */
  z.object({
    op: z.literal("endSession"),
    reason: z.string().min(1)
  })
]);

/**
 * Schema for a rules/*.json file.
 *
 * A rule watches a trigger event and applies effects when an optional condition
 * is met. Rules are evaluated after every action — use them for:
 *   - Resource drain/regen per turn (HP, stamina, mana, hunger)
 *   - Turn counters and timers
 *   - Death checks (HP ≤ 0 → endSession)
 *   - Status effect ticking (poison, burn, regeneration)
 *
 * Targets use a "store.key" prefix to specify where to write:
 *   "characterState.hp"    → characterPatch  (session-local, private)
 *   "worldState.turnCount" → worldPatch      (shared campaign state)
 *
 * Reading current values: the engine merges characterState into worldState
 * before calling hooks, so `characterState.hp` is readable as `ctx.worldState.hp`.
 * Condition keys follow the same dot-path convention.
 *
 * Currently supported trigger: "onActionResolved"
 *
 * @example
 * // rules/hp-drain.json — lose 1 HP every action
 * { "id": "hp-drain", "trigger": "onActionResolved",
 *   "effects": [{ "op": "decrement", "target": "characterState.hp", "amount": 1, "min": 0 }] }
 *
 * @example
 * // rules/death-check.json — end session when HP hits 0
 * { "id": "death-check", "trigger": "onActionResolved",
 *   "condition": { "key": "characterState.hp", "operator": "<=", "value": 0 },
 *   "effects": [{ "op": "endSession", "reason": "player_death" }] }
 *
 * @example
 * // rules/poison-tick.json — poison deals 3 damage per turn
 * { "id": "poison-tick", "trigger": "onActionResolved",
 *   "condition": { "key": "characterState.poisoned", "operator": "==", "value": true },
 *   "effects": [{ "op": "decrement", "target": "characterState.hp", "amount": 3, "min": 0 }] }
 */
export const ruleSchema = z.object({
  id: z.string().min(1),
  trigger: z.enum(["onActionResolved"]),
  condition: ruleConditionSchema.optional(),
  effects: z.array(ruleEffectSchema).min(1)
});

export type RuleSchema = z.infer<typeof ruleSchema>;
export type RuleEffect = z.infer<typeof ruleEffectSchema>;
export type RuleCondition = z.infer<typeof ruleConditionSchema>;
