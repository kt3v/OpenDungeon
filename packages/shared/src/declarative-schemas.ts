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
  "update_state",
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
  contextRouter: dmContextRouterSchema.optional(),
  narratorStyle: z.enum(["collaborative", "balanced", "strict"]).optional()
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
